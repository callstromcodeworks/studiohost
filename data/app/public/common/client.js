// Browser side of the Studio Host signaling protocol:
// POST /api/join, then a Server-Sent Events stream for everything the server pushes.

export class StudioClient extends EventTarget {
  /** @param {'guest'|'host'|'program'|'slot'} role */
  constructor(role) {
    super();
    this.role = role;
    this.id = null;
    this.token = null;
    this.iceServers = [];
    this.output = { width: 1920, height: 1080, fps: 30 };
    this.state = null;
    this.events = null;
    this.debug = false;
  }

  /**
   * @param {{name?: string, key?: string, slot?: number, asHost?: boolean}} [opts]
   */
  async join(opts = {}) {
    const res = await fetch('/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: this.role, ...opts }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Join failed (${res.status})`);
    Object.assign(this, { id: body.id, token: body.token, iceServers: body.iceServers, output: body.output, debug: !!body.debug });
    this.open();
    return body;
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/ws?id=${encodeURIComponent(this.id)}&token=${encodeURIComponent(this.token)}`;
    this.closedByUs = false;
    const connect = () => {
      const ws = new WebSocket(url);
      this.events = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { this.retries = 0; this.emit('connected', {}); };
      ws.onmessage = (ev) => {
        // Binary messages carry the OBS output (program page only).
        if (typeof ev.data !== 'string') { this.emit('binary', ev.data); return; }
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state' || msg.type === 'welcome') this.state = msg.state;
        this.emit(msg.type, msg);
      };
      ws.onclose = (ev) => {
        if (this.closedByUs) return;
        // 4401: the server no longer knows this session (e.g. it restarted): rejoin needed.
        if (ev.code === 4401) { this.emit('lost', {}); return; }
        this.emit('reconnecting', {});
        this.retries = (this.retries || 0) + 1;
        // Keep trying; the server keeps the session for a short grace period.
        setTimeout(connect, Math.min(5000, 500 * this.retries));
      };
    };
    connect();
  }

  /** @param {string} type @param {any} detail */
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** @param {string} type @param {(msg: any) => void} fn */
  on(type, fn) { this.addEventListener(type, (e) => fn(/** @type {CustomEvent} */ (e).detail)); return this; }

  /** @param {string} route @param {any} body */
  async post(route, body = {}) {
    const res = await fetch(`/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': this.id, 'X-Client-Token': this.token },
      body: JSON.stringify(body),
      keepalive: route === 'leave',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /** @param {File} file @param {(fraction: number) => void} [onProgress] */
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('X-Client-Id', this.id);
      xhr.setRequestHeader('X-Client-Token', this.token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed (network error)'));
      xhr.send(file);
    });
  }

  /** @param {string} action @param {object} [args] */
  action(action, args = {}) { return this.post('action', { action, ...args }); }

  /** Stops listening for events (without leaving the studio). */
  disconnect() {
    this.closedByUs = true;
    this.events?.close();
  }

  leave() {
    this.disconnect();
    if (this.id) this.post('leave').catch(() => {});
  }
}

/**
 * For pages that run inside OBS (no visible console): copy warnings and errors to the
 * server, which writes them to the OBS log.
 * @param {StudioClient} client
 */
export function forwardConsoleToServer(client) {
  let budget = 200; // per minute
  setInterval(() => { budget = 200; }, 60_000);
  const send = (level, args) => {
    if (budget-- <= 0 || !client.id) return;
    const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 500);
    client.post('log', { level, msg }).catch(() => {});
  };
  for (const level of ['warn', 'error', 'info']) {
    const original = console[level].bind(console);
    // info is only forwarded when the server runs with STUDIOHOST_DEBUG=1
    console[level] = (...args) => { original(...args); if (level !== 'info' || client.debug) send(level, args); };
  }
  // Debug only: report when the page is hidden or its timers run late (a throttled or starved
  // page stalls WebRTC setup, and the server-side timestamps of its log lines can't show that).
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), late = now - last - 1000;
    last = now;
    if (client.debug && late > 500) console.info(`[page] timers ran ${Math.round(late)} ms late (visibility ${document.visibilityState})`);
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (client.debug) console.info(`[page] visibility ${document.visibilityState}`); });
  window.addEventListener('error', (e) => send('error', [`${e.message} (${e.filename}:${e.lineno})`]));
  window.addEventListener('unhandledrejection', (e) => send('error', [String(e.reason)]));
}

/** Reads `name` from the query string. @param {string} name */
export const param = (name) => new URLSearchParams(location.search).get(name);
