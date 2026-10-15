// @ts-check
// Client for the Studio Host hostname service (hosted by Callstrom Code Works) used by Automatic setup.
import https from 'node:https';
import http from 'node:http';

export class HostnameServiceError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) { super(message); this.status = status; }
}

export class HostnameService {
  /** @param {{url: string, ca?: string}} opts */
  constructor({ url, ca }) {
    this.url = url.replace(/\/+$/, '');
    this.ca = ca;
  }

  /**
   * @param {string} method @param {string} path @param {any} [body] @param {string} [token]
   * @returns {Promise<any>}
   */
  call(method, path, body, token) {
    const u = new URL(this.url + path);
    const mod = u.protocol === 'http:' ? http : https;
    const data = body ? JSON.stringify(body) : '';
    return new Promise((resolve, reject) => {
      const req = mod.request(u, {
        method, timeout: 15_000, ...(this.ca ? { ca: this.ca } : {}),
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = {};
          try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
          if ((res.statusCode || 0) >= 400) reject(new HostnameServiceError(/** @type {any} */ (json).error || `Hostname service error (HTTP ${res.statusCode}).`, res.statusCode || 0));
          else resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(new HostnameServiceError(`Could not reach the Studio Host hostname service (${err.message}).`, 0)));
      if (data) req.write(data);
      req.end();
    });
  }

  /** @returns {Promise<{name: string, fqdn: string, token: string, expiresAt: number, zone: string, ip4: string|null}>} */
  register() { return this.call('POST', '/v1/names'); }

  /** @param {string} name @param {string} token @param {string|undefined} ip4 omitted = the address the service sees */
  update(name, token, ip4) { return this.call('PUT', `/v1/names/${encodeURIComponent(name)}/address`, ip4 ? { ip4 } : {}, token); }

  /** @param {string} name @param {string} token @param {string[]} values */
  setChallenge(name, token, values) { return this.call('PUT', `/v1/names/${encodeURIComponent(name)}/acme-challenge`, { values }, token); }

  /** @param {string} name @param {string} token @param {number} port */
  probe(name, token, port) { return this.call('POST', `/v1/names/${encodeURIComponent(name)}/probe`, { port }, token); }

  /** @param {string} name @param {string} token */
  release(name, token) { return this.call('DELETE', `/v1/names/${encodeURIComponent(name)}`, undefined, token); }
}
