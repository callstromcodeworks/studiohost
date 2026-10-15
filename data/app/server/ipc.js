// @ts-check
// Line-delimited JSON channel to the Studio Host OBS plugin, which starts this
// server as a child process and talks to it over stdin/stdout.
//
// server -> plugin (stdout)
//   {type:'ready', localPort, slots, output, configured, publicUrl}   configured=false: run the setup wizard
//   {type:'slots', count}
//   {type:'obs', id, action:'setScene', scene:'studio'|'screen'|'guest', slot?}
//   {type:'obs', id, action:'setupScenes'}
//   {type:'content', source, rect}           draw OBS source `source` at rect {x,y,w,h} (0..1 of the
//                                            Program frame) under the studio picture; source '' = none
//   {type:'restart'}                         config changed; please restart me
//   {type:'network', configured, state, publicUrl}  guest-side status changed
//   {type:'open-wizard'}                      show the setup wizard window
//   {type:'setup-done'}                       the wizard finished; close its window
//   {type:'feed', on}                         start/stop sending the OBS output (only needed while guests are connected)
//   {type:'widgets', items:[{id,name,url,visible}]}  web widgets to keep as Browser Sources in the Studio scene
// plugin -> server (stdin)
//   {type:'obs-status', streaming, recording, virtualcam, studioMode, scene, builtin, sources}
//   {type:'obs-result', id, ok, message?, error?}
//   binary packets between the lines: 0x01, kind ('V' video, 'A' audio), uint32le length, payload
//     V: uint16le width, uint16le height, I420 planes (the OBS program picture, scaled down)
//     A: uint32le sample rate, interleaved float32 stereo (OBS audio minus Studio Host's guests)
import { randomUUID } from 'node:crypto';

export class PluginChannel {
  constructor() {
    /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    /** @type {((status: any) => void)|null} */
    this.onStatus = null;
    this.status = { streaming: false, recording: false, virtualcam: false, studioMode: false, scene: null, builtin: null, sources: /** @type {string[]|undefined} */ (undefined) };
    // stdout belongs to the protocol; route ordinary logging to stderr (the plugin copies it into the OBS log).
    console.log = (...args) => console.error(...args);
    console.info = (...args) => console.error(...args);
    /** OBS output packets from the plugin. @type {((kind: string, payload: Buffer) => void)|null} */
    this.onFeed = null;
    /** @type {Buffer} */ let buf = Buffer.alloc(0);
    // While a large packet is incomplete, chunks are collected and joined once it is all here
    // (joining on every chunk would copy each video frame many times over).
    /** @type {Buffer[]} */ let parts = [];
    let partsLen = 0, need = 0;
    process.stdin.on('data', (chunk) => {
      if (need) {
        parts.push(chunk); partsLen += chunk.length;
        if (partsLen < need) return;
        buf = Buffer.concat(parts, partsLen); parts = []; partsLen = 0; need = 0;
      } else {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      }
      let pos = 0;
      while (pos < buf.length) {
        if (buf[pos] === 0x01) {
          if (buf.length - pos < 6) break;
          const len = buf.readUInt32LE(pos + 2);
          if (buf.length - pos < 6 + len) { need = 6 + len; break; }
          this.onFeed?.(String.fromCharCode(buf[pos + 1]), buf.subarray(pos + 6, pos + 6 + len));
          pos += 6 + len;
        } else {
          const nl = buf.indexOf(0x0a, pos);
          if (nl < 0) break;
          const line = buf.toString('utf8', pos, nl).trim();
          if (line) this.receive(line);
          pos = nl + 1;
        }
      }
      buf = pos ? buf.subarray(pos) : buf;
      if (need) { parts = [buf]; partsLen = buf.length; buf = Buffer.alloc(0); }
    });
    /** Called when the plugin closes stdin (OBS exiting); defaults to exiting. @type {(() => void)|null} */
    this.onClose = null;
    // The plugin closes stdin when OBS exits (or crashes): shut down with it.
    process.stdin.on('end', () => {
      if (!this.onClose) process.exit(0);
      // Give cleanup (e.g. removing router port mappings) a moment, then exit regardless.
      setTimeout(() => process.exit(0), 3000).unref();
      this.onClose();
    });
  }

  /** @param {object} msg */
  send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

  /** @param {string} line */
  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'obs-status') {
      this.status = {
        streaming: !!msg.streaming, recording: !!msg.recording, virtualcam: !!msg.virtualcam,
        studioMode: !!msg.studioMode, scene: typeof msg.scene === 'string' ? msg.scene : null,
        builtin: typeof msg.builtin === 'string' ? msg.builtin : null,
        // Video sources the producer can show as content (names), when the plugin sends them.
        sources: Array.isArray(msg.sources)
          ? msg.sources.map((x) => (typeof x === 'string' ? x : x?.name)).filter((x) => typeof x === 'string' && x).slice(0, 500)
          : this.status.sources,
      };
      this.onStatus?.(this.status);
    } else if (msg.type === 'obs-result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.message || 'Done.');
      else p.reject(new Error(msg.error || 'OBS could not do that.'));
    }
  }

  /**
   * Asks the plugin to do something in OBS.
   * @param {string} action @param {object} [args]
   * @returns {Promise<string>}
   */
  request(action, args = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('OBS did not respond.')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'obs', id, action, ...args });
    });
  }
}
