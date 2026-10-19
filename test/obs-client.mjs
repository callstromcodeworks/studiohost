// @ts-check
// Minimal obs-websocket v5 client (built into OBS 28+), used by the OBS smoke test to drive
// a real OBS. Uses Node's built-in WebSocket.
import { createHash, randomUUID } from 'node:crypto';

/** @param {string} s */
const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');

export class ObsClient {
  /**
   * @param {string} url @param {string} password
   * @param {number} [eventSubscriptions] obs-websocket event mask (default: obs-websocket's default)
   */
  constructor(url, password, eventSubscriptions) {
    this.url = url;
    this.password = password;
    this.eventSubscriptions = eventSubscriptions;
    /** @type {((type: string, data: any) => void)|null} */
    this.onEvent = null;
    /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {WebSocket|null} */
    this.ws = null;
  }

  /** @returns {Promise<void>} */
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error(`Timed out connecting to OBS at ${this.url}. Is OBS running with the WebSocket server enabled (Tools → WebSocket Server Settings)?`)); }, timeoutMs);
      const fail = (/** @type {Error} */ e) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } reject(e); };
      let ws;
      try { ws = new WebSocket(this.url, 'obswebsocket.json'); } catch (e) { return fail(new Error(`Bad OBS WebSocket URL: ${this.url}`)); }
      this.ws = ws;
      ws.onerror = () => fail(new Error(`Could not connect to OBS at ${this.url}. Is OBS running with the WebSocket server enabled (Tools → WebSocket Server Settings)?`));
      ws.onclose = (ev) => {
        if (ev.code === 4009) fail(new Error('OBS rejected the WebSocket password.'));
        for (const p of this.pending.values()) p.reject(new Error('OBS connection closed'));
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.op === 0) {
          const identify = { rpcVersion: 1 };
          if (this.eventSubscriptions !== undefined) identify.eventSubscriptions = this.eventSubscriptions;
          const auth = msg.d.authentication;
          if (auth) {
            if (!this.password) return fail(new Error('OBS WebSocket requires a password.'));
            identify.authentication = sha256b64(sha256b64(this.password + auth.salt) + auth.challenge);
          }
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (msg.op === 2) {
          clearTimeout(timer);
          resolve();
        } else if (msg.op === 5) {
          this.onEvent?.(msg.d.eventType, msg.d.eventData);
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(`${msg.d.requestType} failed: ${msg.d.requestStatus.comment || msg.d.requestStatus.code}`));
        }
      };
    });
  }

  /** @param {string} requestType @param {object} [requestData] @returns {Promise<any>} */
  call(requestType, requestData = {}) {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('not connected'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() { this.ws?.close(); }
}
