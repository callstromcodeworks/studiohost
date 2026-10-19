// Web Audio mixing for the program output:
//  - the program mix (everyone on stage) goes to the page's audio output, which OBS
//    captures when the Browser Source has "Control audio via OBS" enabled
//  - each guest gets a "mix-minus": everyone they should hear, minus themselves, plus the
//    OBS audio when the plugin sends it (which already leaves out Studio Host's guests)
//  - inside OBS, each participant's own audio (before volume and mute) is also tapped and
//    handed to onTap, which sends it to the plugin for that guest's strip in the OBS mixer

export class AudioMixer {
  constructor() {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    /** @type {Map<string, {stream: MediaStream, node: MediaStreamAudioSourceNode, program: GainNode, sends: Map<string, GainNode>, pid: string}>} */
    this.sources = new Map();
    /** @type {Map<string, MediaStreamAudioDestinationNode>} */
    this.mixMinus = new Map();
    /** @type {{el: HTMLMediaElement, node: MediaElementAudioSourceNode, out: GainNode} | null} */
    this.clip = null;
    /** OBS audio for guests (never played to the page's own output). @type {AudioWorkletNode|null} */
    this.obs = null;
    /** @type {Promise<void>|null} */ this.obsLoading = null;
    this.state = null;
    /** Per-participant audio taps for the OBS mixer (see enableTaps). @type {Map<string, {input: GainNode, node: AudioWorkletNode}>} */
    this.taps = new Map();
    /** @type {Promise<void>|null} */ this.tapsLoading = null;
    this.tapsReady = false;
    /** Receives each tap's audio: mono 16-bit samples at `rate` Hz. @type {((pid: string, rate: number, samples: Int16Array) => void)|null} */
    this.onTap = null;
    // Browsers may start the context suspended until a user gesture; keep nudging it.
    setInterval(() => { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }, 1000);
    setInterval(() => this.sampleLevels(), 100);
  }

  get suspended() { return this.ctx.state !== 'running'; }

  /** The mix-minus stream to send back to a guest. @param {string} pid */
  mixMinusFor(pid) {
    let dest = this.mixMinus.get(pid);
    if (!dest) {
      dest = this.ctx.createMediaStreamDestination();
      this.mixMinus.set(pid, dest);
      for (const src of this.sources.values()) this.connectSend(src, pid);
      if (this.clip) this.clip.out.connect(dest);
      this.obs?.connect(dest);
      this.apply();
    }
    return dest.stream;
  }

  /** @param {string} pid */
  dropGuest(pid) {
    for (const [key, src] of this.sources) if (src.pid === pid) this.removeSource(key);
    const tap = this.taps.get(pid);
    if (tap) { tap.input.disconnect(); tap.node.disconnect(); tap.node.port.close(); this.taps.delete(pid); }
    const dest = this.mixMinus.get(pid);
    if (dest) {
      for (const src of this.sources.values()) { src.sends.get(pid)?.disconnect(); src.sends.delete(pid); }
      this.mixMinus.delete(pid);
    }
  }

  /**
   * Makes sure the audio of `stream` is mixed in for participant pid (kind = camera|screen).
   * @param {string} pid @param {'camera'|'screen'} kind @param {MediaStream|null} stream
   */
  setSource(pid, kind, stream) {
    const key = `${pid}:${kind}`;
    const cur = this.sources.get(key);
    const hasAudio = !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live');
    if (cur && (!hasAudio || cur.stream !== stream || cur.trackId !== stream.getAudioTracks()[0]?.id)) this.removeSource(key);
    if (!hasAudio || this.sources.has(key)) return;
    const node = this.ctx.createMediaStreamSource(stream);
    const program = this.ctx.createGain();
    program.gain.value = 0;
    node.connect(program).connect(this.master);
    // Level metering (before volume/mute) for the producer dock and diagnostics.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    const src = { stream, node, program, analyser, peak: 0, sends: new Map(), pid, trackId: stream.getAudioTracks()[0].id };
    this.sources.set(key, src);
    for (const target of this.mixMinus.keys()) this.connectSend(src, target);
    this.connectTap(src);
    this.apply();
  }

  /** Starts tapping each participant's audio for onTap (once; the plugin is there to take it). */
  enableTaps() {
    if (this.tapsLoading) return;
    const url = URL.createObjectURL(new Blob([GUEST_TAP_WORKLET], { type: 'text/javascript' }));
    this.tapsLoading = this.ctx.audioWorklet.addModule(url).then(() => {
      // The taps feed a silent gain into the output so the browser keeps running them.
      this.tapSink = this.ctx.createGain();
      this.tapSink.gain.value = 0;
      this.tapSink.connect(this.ctx.destination);
      this.tapsReady = true;
      for (const src of this.sources.values()) this.connectTap(src);
    }).catch((err) => console.warn('[mixer] guest audio for the OBS mixer unavailable', err));
  }

  /** @param {any} src */
  connectTap(src) {
    if (!this.tapsReady) return;
    let tap = this.taps.get(src.pid);
    if (!tap) {
      const input = this.ctx.createGain();
      const node = new AudioWorkletNode(this.ctx, 'guest-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const pid = src.pid;
      node.port.onmessage = (e) => this.onTap?.(pid, this.ctx.sampleRate, new Int16Array(e.data));
      input.connect(node).connect(/** @type {GainNode} */ (this.tapSink));
      tap = { input, node };
      this.taps.set(pid, tap);
    }
    src.node.connect(tap.input);
  }

  /** @param {any} src @param {string} target */
  connectSend(src, target) {
    if (src.pid === target || src.sends.has(target)) return;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.node.connect(g).connect(/** @type {MediaStreamAudioDestinationNode} */ (this.mixMinus.get(target)));
    src.sends.set(target, g);
  }

  /**
   * Highest peak (0..1) of a participant's audio since the last call; resets on read.
   * Sampled frequently by sampleLevels() so short sounds are not missed.
   * @param {string} pid
   */
  takePeak(pid) {
    let peak = 0;
    for (const src of this.sources.values()) if (src.pid === pid) { peak = Math.max(peak, src.peak); src.peak = 0; }
    return peak;
  }

  sampleLevels() {
    const buf = new Float32Array(1024);
    for (const src of this.sources.values()) {
      src.analyser.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
      if (p > src.peak) src.peak = p;
    }
  }

  /** @param {string} key */
  removeSource(key) {
    const src = this.sources.get(key);
    if (!src) return;
    src.node.disconnect(); src.program.disconnect(); src.analyser.disconnect();
    for (const g of src.sends.values()) g.disconnect();
    this.sources.delete(key);
  }

  /**
   * Queues OBS audio for the guests: interleaved stereo float32 at `rate` Hz.
   * @param {Float32Array} samples @param {number} rate
   */
  pushObsAudio(samples, rate) {
    if (this.obs) { this.obs.port.postMessage({ samples, rate }, [samples.buffer]); return; }
    if (this.obsLoading) return; // dropped while the worklet loads
    const url = URL.createObjectURL(new Blob([OBS_FEED_WORKLET], { type: 'text/javascript' }));
    this.obsLoading = this.ctx.audioWorklet.addModule(url).then(() => {
      this.obs = new AudioWorkletNode(this.ctx, 'obs-feed', { numberOfInputs: 0, outputChannelCount: [2] });
      // Glitches in the OBS audio for guests go to the OBS log (this page forwards warnings).
      this.obs.port.onmessage = (e) => {
        const { underruns, droppedMs, rate, pageRate, started } = e.data;
        if (started && rate !== pageRate) console.warn(`[mixer] OBS audio is ${rate} Hz, page audio ${pageRate} Hz; resampling for guests`);
        if (underruns || droppedMs) console.warn(`[mixer] OBS audio for guests: ${underruns} gap(s), ${Math.round(droppedMs)} ms dropped to catch up`);
      };
      for (const dest of this.mixMinus.values()) this.obs.connect(dest);
    }).catch((err) => console.warn('[mixer] OBS audio unavailable', err));
  }

  /** @param {HTMLMediaElement|null} el */
  setClip(el) {
    if (this.clip) { this.clip.node.disconnect(); this.clip.out.disconnect(); this.clip = null; }
    if (!el) return;
    const node = this.ctx.createMediaElementSource(el);
    const out = this.ctx.createGain();
    node.connect(out);
    out.connect(this.master);
    for (const dest of this.mixMinus.values()) out.connect(dest);
    this.clip = { el, node, out };
  }

  /** @param {any} state */
  setState(state) { this.state = state; this.apply(); }

  /** Recomputes every gain from the studio state. */
  apply() {
    const st = this.state;
    if (!st) return;
    const byId = new Map(st.participants.map((p) => [p.id, p]));
    const t = this.ctx.currentTime;
    for (const src of this.sources.values()) {
      const p = byId.get(src.pid);
      const vol = p && !p.hostMuted ? p.volume : 0;
      // Program (what goes to OBS): only people on stage, unless they are "talkback only".
      src.program.gain.setTargetAtTime(p && p.onStage && p.programAudio ? vol : 0, t, 0.03);
      for (const [target, g] of src.sends) {
        const q = byId.get(target);
        // Guests on stage hear the stage. Backstage guests hear the stage and each other.
        // Producers who joined on camera (isHost) are heard by everyone.
        const audible = !!p && !!q && (p.onStage || p.isHost || !q.onStage);
        g.gain.setTargetAtTime(audible ? vol : 0, t, 0.03);
      }
    }
  }
}

// Collects a participant's audio as mono 16-bit samples and posts them in blocks of 1024 frames
// (about 20 ms). Nothing is posted while no audio is connected.
const GUEST_TAP_WORKLET = `
class GuestTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1024); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    const len = chans[0].length, k = chans.length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < k; c++) v += chans[c][i];
      v /= k;
      this.buf[this.n++] = (v > 1 ? 1 : v < -1 ? -1 : v) * 32767;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(1024); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('guest-tap', GuestTap);
`;

// Plays the OBS audio for guests from a ring buffer. OBS audio arrives in bursts (it comes
// through the plugin, the server and a WebSocket), so playback starts once ~80 ms is buffered.
// Clock drift and bursts are absorbed by playing 0.5% faster while more than ~150 ms is queued
// (or slower below ~60 ms), which is inaudible, instead of skipping audio; only a backlog over
// ~500 ms is dropped. The page may run at a different rate than OBS (e.g. 44.1 vs 48 kHz), so
// samples are linearly interpolated.
const OBS_FEED_WORKLET = `
class ObsFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rate = 0; this.cap = 0; this.buf = null;
    this.w = 0; this.r = 0; this.frac = 0; // frames written / read (absolute), position between r and r+1
    this.playing = false;
    // Glitch counters, reported to the page at most every 5 s while there is something to say.
    this.underruns = 0; this.dropped = 0; this.lastReport = 0;
    this.port.onmessage = (e) => this.push(e.data.samples, e.data.rate);
  }
  push(samples, rate) {
    if (rate !== this.rate) {
      this.rate = rate; this.cap = rate * 2; this.buf = new Float32Array(this.cap * 2);
      this.w = 0; this.r = 0; this.frac = 0; this.playing = false;
      this.port.postMessage({ started: true, underruns: 0, droppedMs: 0, rate, pageRate: sampleRate });
    }
    const n = samples.length / 2, cap = this.cap, buf = this.buf;
    for (let i = 0; i < n; i++) {
      const k = ((this.w + i) % cap) * 2;
      buf[k] = samples[i * 2]; buf[k + 1] = samples[i * 2 + 1];
    }
    this.w += n;
    const max = rate * 0.5;
    if (this.w - this.r > max) { // far behind: skip to the target
      const keep = Math.round(rate * 0.08);
      this.dropped += this.w - keep - this.r;
      this.r = this.w - keep; this.frac = 0;
    }
    if (currentTime - this.lastReport >= 5 && (this.underruns || this.dropped)) {
      this.port.postMessage({ underruns: this.underruns, droppedMs: (1000 * this.dropped) / rate, rate, pageRate: sampleRate });
      this.underruns = 0; this.dropped = 0; this.lastReport = currentTime;
    }
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const rate = this.rate, cap = this.cap, buf = this.buf;
    if (!rate) return true;
    let queued = this.w - this.r;
    if (!this.playing && queued >= rate * 0.08) this.playing = true;
    const base = rate / sampleRate;
    const step = base * (queued > rate * 0.15 ? 1.005 : queued < rate * 0.06 ? 0.995 : 1);
    for (let i = 0; i < left.length; i++) {
      if (!this.playing || this.w - this.r < 2) {
        if (this.playing) { this.underruns++; this.playing = false; }
        left[i] = 0; right[i] = 0; continue;
      }
      const a = (this.r % cap) * 2, b = ((this.r + 1) % cap) * 2, f = this.frac;
      left[i] = buf[a] + (buf[b] - buf[a]) * f;
      right[i] = buf[a + 1] + (buf[b + 1] - buf[a + 1]) * f;
      const next = f + step, adv = next | 0;
      this.r += adv; this.frac = next - adv;
    }
    return true;
  }
}
registerProcessor('obs-feed', ObsFeed);
`;
