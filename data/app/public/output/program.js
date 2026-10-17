// Program output: load this page in an OBS Browser Source (1920x1080 by default,
// "Control audio via OBS" on). It is the hub every guest connects to: it composites
// the stage, plays the program audio for OBS, and sends each guest the program
// picture plus their mix-minus so they can see and hear the show. Inside OBS the plugin
// also sends the real OBS output (picture and audio), which guests get instead.
import { StudioClient, param, forwardConsoleToServer } from '../common/client.js';
import { manageLinks, linkStats, applyEncoding } from '../common/peer.js';
import { MediaBank } from '../common/media.js';
import { StageRenderer, REF_W, REF_H, drawContentPlaceholder } from '../common/render.js';
import { AudioMixer } from '../common/mixer.js';

const GUEST_FEED_WIDTH = 1280;
const GUEST_FEED_MIN_KBPS = 250;
// Each guest's copy is a separate encode, so encoding cost grows with the number of guests. Past
// this many pixels per frame across all guests (four 960x540 copies), each copy is scaled down.
const GUEST_FEED_PIXEL_BUDGET = 4 * 960 * 540;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const client = new StudioClient('program');
forwardConsoleToServer(client);
const bank = new MediaBank();
const mixer = new AudioMixer();
/** @type {HTMLVideoElement|null} */ let clipEl = null;
/** @type {string|null} */ let clipKey = null;

/**
 * Puts H.264 first for the guest feed when this browser reports a power-efficient (hardware)
 * H.264 encoder at this size, or always when `force` is set (H.264 chosen in the studio settings).
 * @param {number} width @param {number} height @param {boolean} force
 * @returns {Promise<{codecs: RTCRtpCodec[] | null, detail: string}>} codecs is null to keep the browser default
 */
async function hardwareH264Codecs(width, height, force) {
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  const detail = (info) => `H.264 in WebRTC: ${h264.length ? 'yes' : 'no'}, encode supported: ${info?.supported ?? 'unknown'}, `
    + `hardware: ${info?.powerEfficient ?? 'unknown'}; ${navigator.userAgent}`;
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc', video: { contentType: 'video/H264', width, height, bitrate: 3_000_000, framerate: 30 },
    });
    if (!h264.length || (!force && (!info.supported || !info.powerEfficient))) return { codecs: null, detail: detail(info) };
    return { codecs: [...h264, ...codecs.filter((c) => !h264.includes(c))], detail: detail(info) };
  } catch (err) {
    if (force && h264.length) return { codecs: [...h264, ...codecs.filter((c) => !h264.includes(c))], detail: `${detail(null)}; check failed: ${err?.message || err}` };
    return { codecs: null, detail: `${detail(null)}; check failed: ${err?.message || err}` };
  }
}

function say(text) { notice.textContent = text; notice.style.display = text ? 'block' : 'none'; }

// OBS-source content is left as a transparent hole: the plugin draws that source beneath this page.
const renderer = new StageRenderer(canvas, {
  video: (pid, kind) => bank.video(pid, kind),
  clip: () => clipEl,
}, { contentMode: 'hole' });
// Exposed for troubleshooting from the browser console / remote debugging.
/** @type {any} */ (window).studioHost = { client, bank, mixer, renderer };

async function main() {
  try {
    await client.join({ key: param('key') || undefined });
  } catch (err) {
    say(`Studio Host: ${err.message}`);
    setTimeout(() => location.reload(), 5000);
    return;
  }
  const { width, height, fps } = client.output;
  canvas.width = width;
  canvas.height = height;
  renderer.start(fps);

  // Guests get their own reduced-size copy of the picture (at most 1280 wide, like the OBS feed
  // the plugin sends). The OBS-source hole would show as black to them, so their copy fills it
  // with a labelled placeholder instead.
  const guestCanvas = document.createElement('canvas');
  guestCanvas.width = Math.min(GUEST_FEED_WIDTH, width);
  guestCanvas.height = Math.round((guestCanvas.width * height) / width / 2) * 2;
  const gctx = /** @type {CanvasRenderingContext2D} */ (guestCanvas.getContext('2d', { alpha: false }));
  // The latest frame of the OBS output, when the plugin sends it.
  /** @type {{frame: VideoFrame, at: number}|null} */ let obsFrame = null;
  client.on('binary', (/** @type {ArrayBuffer} */ buf) => {
    const kind = new Uint8Array(buf, 0, 1)[0];
    if (kind === 0x41 /* A */) {
      const rate = new DataView(buf, 1, 4).getUint32(0, true);
      mixer.pushObsAudio(new Float32Array(buf.slice(5)), rate);
    } else if (kind === 0x56 /* V */ && typeof VideoFrame === 'function') {
      const view = new DataView(buf, 1, 4);
      const w = view.getUint16(0, true), h = view.getUint16(2, true);
      try {
        const frame = new VideoFrame(new Uint8Array(buf, 5), {
          format: 'I420', codedWidth: w, codedHeight: h, timestamp: Math.round(performance.now() * 1000),
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
        });
        obsFrame?.frame.close();
        obsFrame = { frame, at: performance.now() };
      } catch (err) { console.warn('[program] bad OBS frame', err); }
    }
  });
  renderer.afterDraw = () => {
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    if (obsFrame && performance.now() - obsFrame.at < 1000) {
      gctx.drawImage(obsFrame.frame, 0, 0, guestCanvas.width, guestCanvas.height);
      return;
    }
    gctx.fillStyle = '#000';
    gctx.fillRect(0, 0, guestCanvas.width, guestCanvas.height);
    gctx.drawImage(canvas, 0, 0, guestCanvas.width, guestCanvas.height);
    const c = renderer.contentNow;
    if (c && c.alpha > 0.02) {
      gctx.setTransform(guestCanvas.width / REF_W, 0, 0, guestCanvas.height / REF_H, 0, 0);
      gctx.globalAlpha = c.alpha;
      drawContentPlaceholder(gctx, c.rect, c.source, client.state?.studio.brand);
      gctx.globalAlpha = 1;
    }
  };
  /** @type {any} */ (window).studioHost.guestCanvas = guestCanvas;
  // When this machine can encode H.264 in hardware, guests' copies prefer it so Chromium uses the
  // GPU's encoder; otherwise the browser's default codec (normally VP8, encoded in software).
  // The browser in OBS can under-report its hardware encoder, so the producer can also choose
  // H.264 in the studio settings. A change applies to guests who connect after it.
  /** @type {RTCRtpCodec[]|null} */ let feedCodecs = null;
  const chooseFeedCodecs = async () => {
    const forceH264 = client.guestFeed.codec === 'h264';
    const { codecs, detail } = await hardwareH264Codecs(guestCanvas.width, guestCanvas.height, forceH264);
    feedCodecs = codecs;
    const choice = !codecs ? 'browser default (no hardware H.264 encoder found)'
      : forceH264 ? 'H.264 (chosen in studio settings)' : 'H.264 (hardware encoder available)';
    console.warn(`[program] guest feed codec: ${choice} (${detail})`);
  };
  await chooseFeedCodecs();

  const programStream = guestCanvas.captureStream(fps);
  const programVideo = programStream.getVideoTracks()[0];

  // Each guest gets its own encode of the program, and WebRTC's congestion control lowers it
  // for guests on weaker connections. The caps only stop strong connections from taking more
  // than their share of this machine's upload (which also carries the live stream) and, with
  // many guests, keep the encoders from taking more than their share of its CPU.
  /** @type {WeakMap<import('../common/peer.js').PeerLink, string>} */
  const feedApplied = new WeakMap();
  /** @returns {RTCRtpEncodingParameters} */
  const feedEncoding = () => {
    const open = Math.max(1, [...links.values()].filter((l) => !l.closed && l.purpose === 'program').length);
    const { maxKbps, totalKbps } = client.guestFeed;
    const pixels = open * guestCanvas.width * guestCanvas.height;
    return {
      maxBitrate: Math.max(GUEST_FEED_MIN_KBPS, Math.min(maxKbps, Math.floor(totalKbps / open))) * 1000,
      scaleResolutionDownBy: Math.max(1, Math.round(Math.sqrt(pixels / GUEST_FEED_PIXEL_BUDGET) * 100) / 100),
    };
  };
  const rebalanceFeed = () => {
    const enc = feedEncoding();
    const key = JSON.stringify(enc);
    for (const l of links.values()) {
      const sender = l.senders.get('program-video');
      if (l.closed || !sender || feedApplied.get(l) === key) continue;
      feedApplied.set(l, key);
      applyEncoding(sender, enc);
    }
  };
  client.on('guest-feed', (m) => {
    const codecChanged = m.guestFeed.codec !== client.guestFeed.codec;
    client.guestFeed = m.guestFeed;
    rebalanceFeed();
    if (codecChanged) chooseFeedCodecs();
  });

  const links = manageLinks(client, (link) => {
    if (link.purpose !== 'program') return;
    bank.watch(link);
    const out = new MediaStream();
    link.setTrack('program-video', programVideo, out, { ...feedEncoding(), maxFramerate: Math.min(fps, 30) }, feedCodecs)
      .then(rebalanceFeed);
    const mm = mixer.mixMinusFor(link.peer).getAudioTracks()[0];
    // Audio goes first when a guest's connection is congested.
    link.setTrack('program-audio', mm, out, { priority: 'high', networkPriority: 'high' });
    link.addEventListener('closed', () => { mixer.dropGuest(link.peer); setTimeout(rebalanceFeed); });
    let dropped = false;
    link.addEventListener('state', (/** @type {any} */ e) => {
      const name = client.state?.participants.find((p) => p.id === link.peer)?.name || link.peer.slice(0, 8);
      if (e.detail === 'failed' || e.detail === 'disconnected') { dropped = true; console.warn(`connection to ${name}: ${e.detail}`); }
      // Log the recovery too, so a brief drop shows as a pair of lines in the OBS log.
      else if (dropped && (e.detail === 'connected' || e.detail === 'completed')) { dropped = false; console.warn(`connection to ${name}: back (${e.detail})`); }
    });
  });
  /** @type {any} */ (window).studioHost.links = links;

  // Report each guest's connection health and incoming media rates to the server (shown in
  // the producer dock).
  /** @type {Map<string, any>} */
  const prev = new Map();
  setInterval(async () => {
    const now = performance.now();
    const list = await Promise.all([...links.values()].filter((l) => !l.closed).map((l) => linkStats(l)));
    for (const l of list) {
      const p = prev.get(l.peer);
      const secs = p ? (now - p.at) / 1000 : 0;
      l.videoKbps = p && secs > 0 ? Math.max(0, Math.round(((l.videoBytesIn - p.videoBytesIn) * 8) / 1000 / secs)) : null;
      l.audioKbps = p && secs > 0 ? Math.max(0, Math.round(((l.audioBytesIn - p.audioBytesIn) * 8) / 1000 / secs)) : null;
      l.audioLevel = Math.round(mixer.takePeak(l.peer) * 1000) / 1000;
      l.audioActive = l.audioLevel > 0.002 || (p ? l.audioEnergy > p.audioEnergy : false);
      // Log the codec (and, where the browser reveals it, the encoder) each guest's copy uses, on
      // the first reading and when it changes. Chromium only names the encoder to pages that
      // capture a camera or microphone, so inside OBS it usually shows as unknown.
      const sent = l.sent?.codec ? `${l.sent.codec} via ${l.sent.encoder || 'unknown encoder'}${l.sent.hardware === true ? ' (hardware)' : l.sent.hardware === false ? ' (software)' : ''}` : p?.sent;
      prev.set(l.peer, { at: now, videoBytesIn: l.videoBytesIn, audioBytesIn: l.audioBytesIn, audioEnergy: l.audioEnergy, sent });
      if (sent && sent !== p?.sent) {
        const name = client.state?.participants.find((x) => x.id === l.peer)?.name || l.peer.slice(0, 8);
        console.warn(`[guest ${name}] program video: ${sent}`);
      }
    }
    client.post('diag', { links: list }).catch(() => {});
    rebalanceFeed();
  }, 3000);

  const syncAudio = () => {
    const st = client.state;
    if (!st) return;
    for (const p of st.participants) {
      mixer.setSource(p.id, 'camera', bank.stream(p.id, 'camera'));
      mixer.setSource(p.id, 'screen', bank.stream(p.id, 'screen'));
    }
  };
  bank.onChange(syncAudio);

  const onState = (st) => {
    bank.setState(st);
    renderer.setState(st);
    mixer.setState(st);
    syncAudio();
    syncClip(st);
  };
  client.on('welcome', (m) => onState(m.state));
  client.on('state', (m) => onState(m.state));
  client.on('superseded', () => {
    renderer.stop();
    say('Another Studio Host program output has taken over. Only one program source can be active at a time.');
    client.disconnect();
  });
  client.on('lost', () => { say('Reconnecting to Studio Host…'); setTimeout(() => location.reload(), 3000); });
  client.on('reconnecting', () => say(''));
  client.on('connected', () => say(''));

  // If audio stays blocked, tell the operator how to unblock it.
  setInterval(() => {
    if (mixer.suspended && notice.style.display === 'none') say('Audio is blocked. Right-click this source in OBS → Interact, then click once.');
    else if (!mixer.suspended && notice.textContent?.startsWith('Audio is blocked')) say('');
  }, 4000);
  window.addEventListener('pointerdown', () => mixer.ctx.resume());
  window.addEventListener('beforeunload', () => client.leave());
}

/** @param {any} st */
function syncClip(st) {
  const key = st.clip ? `${st.clip.asset}@${st.clip.startedAt}` : null;
  if (key === clipKey) return;
  clipKey = key;
  if (clipEl) { clipEl.pause(); clipEl.removeAttribute('src'); clipEl.load(); mixer.setClip(null); clipEl = null; }
  if (!st.clip) return;
  const asset = st.studio.assets.find((a) => a.id === st.clip.asset);
  if (!asset) return;
  const el = document.createElement('video');
  el.src = `/assets/${asset.file}`;
  el.playsInline = true;
  el.crossOrigin = 'anonymous';
  el.addEventListener('ended', () => client.post('clip-ended').catch(() => {}));
  el.addEventListener('error', () => client.post('clip-ended').catch(() => {}));
  mixer.setClip(el);
  clipEl = el;
  el.play().catch((err) => console.warn('[program] clip play failed', err));
}

main();
