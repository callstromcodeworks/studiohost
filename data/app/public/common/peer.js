// One WebRTC peer connection for a server-assigned link, using the
// "perfect negotiation" pattern so either side can add or remove tracks at any time.

export class PeerLink extends EventTarget {
  /**
   * @param {{linkId: string, polite: boolean, purpose: string, peer: string,
   *          iceServers: RTCIceServer[], client: import('./client.js').StudioClient}} opts
   */
  constructor({ linkId, polite, purpose, peer, iceServers, client }) {
    super();
    this.linkId = linkId;
    this.polite = polite;
    this.purpose = purpose;
    this.peer = peer;
    this.client = client;
    this.closed = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    /** @type {Map<string, MediaStream>} remote streams by id */
    this.streams = new Map();
    /** @type {Map<string, RTCRtpSender>} senders keyed by a caller-chosen name */
    this.senders = new Map();
    // Avoiding offer glare at setup: the polite side (the guest) makes the first offer and the
    // impolite side holds its own tracks until that first exchange is done (or a short timeout
    // passes). Simultaneous first offers make Chrome roll back the guest's offer, and it then
    // sometimes never sends its ICE candidates, leaving the link stuck.
    /** @type {(() => Promise<void>)[]} */
    this.heldTracks = [];
    this.holdTracks = !polite;

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    /** Verbose negotiation logging, enabled when the server runs with STUDIOHOST_DEBUG=1. */
    // Each line carries the page's own time since the link was created, since the server
    // stamps forwarded lines on arrival and a stalled page delivers them late, in a burst.
    const born = performance.now();
    this.log = (/** @type {any[]} */ ...args) => { if (client.debug) console.info(`[link ${purpose} ${String(peer).slice(0, 6)} +${Math.round(performance.now() - born)}ms]`, ...args); };
    pc.addEventListener('icecandidate', ({ candidate }) => this.log('local candidate', candidate ? `${candidate.type || '?'} ${candidate.protocol || ''} ${candidate.address && candidate.address.endsWith('.local') ? 'mdns' : 'ip'}` : 'end'));
    pc.addEventListener('connectionstatechange', () => this.log('connection', pc.connectionState, 'ice', pc.iceConnectionState));
    pc.addEventListener('icegatheringstatechange', () => this.log('gathering', pc.iceGatheringState));

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription });
      } catch (err) {
        console.warn('[peer] negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ candidate }); };
    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState === 'stable' && pc.remoteDescription) this.releaseTracks();
    });
    this.holdTimer = setTimeout(() => this.releaseTracks(), 1500);
    // Watchdog: if ICE never starts (stuck in "new") restart it, which renegotiates from scratch.
    // Only the impolite side does this: when both sides restart at once their offers collide,
    // and sorting that out cost the Guest Screen Share output several more seconds.
    this.iceRestarts = 0;
    this.watchdog = setInterval(() => {
      if (this.closed || polite) return;
      if (pc.signalingState === 'stable' && pc.remoteDescription && pc.connectionState === 'new' && this.iceRestarts < 3) {
        this.iceRestarts++;
        console.warn('[peer] connection did not start; restarting ICE');
        pc.restartIce();
      }
    }, 6000);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
      this.dispatchEvent(new CustomEvent('state', { detail: pc.iceConnectionState }));
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      this.streams.set(stream.id, stream);
      ev.track.addEventListener('ended', () => this.dispatchEvent(new CustomEvent('streams')));
      stream.addEventListener('removetrack', () => {
        if (!stream.getTracks().length) this.streams.delete(stream.id);
        this.dispatchEvent(new CustomEvent('streams'));
      });
      this.dispatchEvent(new CustomEvent('track', { detail: { track: ev.track, stream } }));
      this.dispatchEvent(new CustomEvent('streams'));
    };
  }

  /** @param {any} data */
  send(data) {
    if (this.closed) return;
    // RTCSessionDescription/RTCIceCandidate serialize via toJSON.
    this.client.post('signal', { linkId: this.linkId, data: JSON.parse(JSON.stringify(data)) }).catch((err) => {
      if (!this.closed) console.warn('[peer] signal failed', err.message);
    });
  }

  /** Handles a signaling message from the other side. @param {{description?: RTCSessionDescriptionInit, candidate?: RTCIceCandidateInit}} data */
  async handle({ description, candidate }) {
    const pc = this.pc;
    this.log('received', description ? description.type : `candidate ${candidate?.candidate?.split(' ')[7] || ''}`, 'in', pc.signalingState);
    try {
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ description: pc.localDescription });
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); }
        catch (err) { if (!this.ignoreOffer) throw err; }
      }
    } catch (err) {
      console.warn('[peer] signaling error', String(err));
    }
  }

  /**
   * Sends `track` under a stable name, replacing whatever was sent under that name before.
   * Passing null stops sending it.
   * Passing `codecs` sends it on its own transceiver with those codecs preferred, so the choice
   * doesn't also apply to what the other side sends.
   * @param {string} name @param {MediaStreamTrack|null} track @param {MediaStream} stream
   * @param {RTCRtpEncodingParameters} [encoding] @param {RTCRtpCodec[]} [codecs]
   */
  async setTrack(name, track, stream, encoding, codecs) {
    if (this.closed) return;
    if (this.holdTracks) {
      this.heldTracks.push(() => this.setTrack(name, track, stream, encoding, codecs));
      return;
    }
    const existing = this.senders.get(name);
    if (existing) {
      if (!track) {
        this.pc.removeTrack(existing);
        this.senders.delete(name);
        return;
      }
      if (existing.track !== track) await existing.replaceTrack(track);
      return;
    }
    if (!track) return;
    let sender;
    if (codecs) {
      const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      try { transceiver.setCodecPreferences(codecs); } catch (err) { console.warn('[peer] codec preference not applied', String(err)); }
      sender = transceiver.sender;
    } else {
      sender = this.pc.addTrack(track, stream);
    }
    this.senders.set(name, sender);
    if (encoding) await applyEncoding(sender, encoding);
  }

  releaseTracks() {
    if (!this.holdTracks) return;
    this.holdTracks = false;
    clearTimeout(this.holdTimer);
    for (const apply of this.heldTracks.splice(0)) apply();
  }

  close() {
    clearTimeout(this.holdTimer);
    clearInterval(this.watchdog);
    if (this.closed) return;
    this.closed = true;
    this.pc.close();
    this.dispatchEvent(new CustomEvent('closed'));
  }
}

/** @param {RTCRtpSender} sender @param {RTCRtpEncodingParameters} encoding */
export async function applyEncoding(sender, encoding) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    Object.assign(params.encodings[0], encoding);
    await sender.setParameters(params);
  } catch (err) {
    // Some browsers only accept setParameters after negotiation; retry once it is connected.
    setTimeout(() => {
      try {
        const params = sender.getParameters();
        if (params.encodings?.length) { Object.assign(params.encodings[0], encoding); sender.setParameters(params).catch(() => {}); }
      } catch { /* ignore */ }
    }, 2000);
  }
}

/**
 * Keeps a set of PeerLinks in sync with the server's link/unlink/signal messages.
 * @param {import('./client.js').StudioClient} client
 * @param {(link: PeerLink) => void} onLink called for each new link (attach tracks / listeners here)
 * @returns {Map<string, PeerLink>}
 */
export function manageLinks(client, onLink) {
  /** @type {Map<string, PeerLink>} */
  const links = new Map();
  /** @type {Map<string, any[]>} signals that arrived before their link (should be rare) */
  const early = new Map();
  client.on('link', (msg) => {
    links.get(msg.linkId)?.close();
    const link = new PeerLink({ ...msg, iceServers: client.iceServers, client });
    links.set(msg.linkId, link);
    onLink(link);
    for (const data of early.get(msg.linkId) || []) link.handle(data);
    early.delete(msg.linkId);
  });
  client.on('unlink', (msg) => {
    links.get(msg.linkId)?.close();
    links.delete(msg.linkId);
  });
  client.on('signal', (msg) => {
    const link = links.get(msg.linkId);
    if (link) link.handle(msg.data);
    else early.set(msg.linkId, [...(early.get(msg.linkId) || []), msg.data].slice(-50));
  });
  return links;
}

/**
 * Connection health for one link: state, the candidate types in use (host/srflx/relay),
 * and media counters. Used for the producer's connection indicators and troubleshooting.
 * @param {PeerLink} link
 */
export async function linkStats(link) {
  const pc = link.pc;
  const out = {
    peer: link.peer, purpose: link.purpose, state: pc.connectionState, ice: pc.iceConnectionState,
    local: null, remote: null, framesIn: 0, bytesIn: 0, bytesOut: 0, rtt: null,
    videoBytesIn: 0, audioBytesIn: 0, fps: null, width: null, height: null, audioEnergy: 0,
    /** @type {{codec: string|null, encoder: string|null, hardware: boolean|null, width: number, height: number, fps: number|null}|null} */
    sent: null,
  };
  try {
    const stats = await pc.getStats();
    /** @type {Map<string, any>} */
    const byId = new Map();
    stats.forEach((s) => byId.set(s.id, s));
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = byId.get(s.selectedCandidatePairId);
        if (pair) {
          out.local = byId.get(pair.localCandidateId)?.candidateType || null;
          out.remote = byId.get(pair.remoteCandidateId)?.candidateType || null;
          out.rtt = pair.currentRoundTripTime ?? null;
        }
      }
      if (s.type === 'inbound-rtp') {
        out.bytesIn += s.bytesReceived || 0;
        if (s.kind === 'video') {
          out.videoBytesIn += s.bytesReceived || 0;
          out.framesIn += s.framesDecoded || 0;
          // With a camera and a screen share, report the larger (camera is listed first).
          if (s.frameWidth && (!out.width || s.frameWidth > out.width)) { out.width = s.frameWidth; out.height = s.frameHeight; out.fps = s.framesPerSecond ?? null; }
        } else if (s.kind === 'audio') {
          out.audioBytesIn += s.bytesReceived || 0;
          out.audioEnergy += s.totalAudioEnergy || 0;
        }
      }
      if (s.type === 'outbound-rtp') {
        out.bytesOut += s.bytesSent || 0;
        // What this side encodes video with (the program page logs it for each guest).
        if (s.kind === 'video' && s.frameWidth) {
          out.sent = { codec: byId.get(s.codecId)?.mimeType?.replace(/^video\//, '') || null, encoder: s.encoderImplementation || null,
            hardware: s.powerEfficientEncoder ?? null, width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond ?? null };
        }
      }
    });
  } catch { /* stats are best-effort */ }
  return out;
}
