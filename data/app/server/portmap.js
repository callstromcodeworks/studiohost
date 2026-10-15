// @ts-check
// Opens a TCP port on the user's router so guests can reach Studio Host:
// UPnP Internet Gateway Device first (most home routers), then NAT-PMP (Apple and others).
// Mappings are leased and renewed, and removed again when Studio Host stops.
import dgram from 'node:dgram';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const LEASE_SECONDS = 3600;

export class PortMapError extends Error {}

/**
 * @typedef {{
 *   method: 'upnp'|'natpmp', externalIp: string|null, externalPort: number, internalPort: number,
 *   internalIp: string, gateway: string, leaseSeconds: number,
 * }} Mapping
 */

// ---- UPnP --------------------------------------------------------------------------------

/**
 * Finds gateway description URLs with SSDP.
 * @param {{timeoutMs?: number, ssdpAddress?: string, ssdpPort?: number}} [opts]
 * @returns {Promise<string[]>}
 */
export function discoverGateways({ timeoutMs = 2500, ssdpAddress = SSDP_ADDRESS, ssdpPort = SSDP_PORT } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    sock.on('message', (msg) => {
      const loc = /^location:\s*(\S+)/im.exec(msg.toString('latin1'));
      if (loc) found.add(loc[1].trim());
    });
    sock.on('error', () => { try { sock.close(); } catch { /* closed */ } resolve([...found]); });
    sock.bind(0, () => {
      try { sock.setMulticastTTL(2); } catch { /* not all platforms */ }
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        // Send twice: SSDP is UDP and routers are known to drop the odd request.
        sock.send(msg, ssdpPort, ssdpAddress);
        setTimeout(() => { try { sock.send(msg, ssdpPort, ssdpAddress); } catch { /* closed */ } }, 300);
      }
    });
    setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found]); }, timeoutMs);
  });
}

/** @param {string} url @param {{method?: string, headers?: Record<string, string>, body?: string}} [opts] */
function httpText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const tag = (/** @type {string} */ xml, /** @type {string} */ name) => new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? null;

/**
 * Reads a gateway description and returns its WAN connection control endpoint.
 * @param {string} location
 * @returns {Promise<{controlUrl: string, serviceType: string}|null>}
 */
export async function findWanService(location) {
  const { status, text } = /** @type {any} */ (await httpText(location));
  if (status !== 200) return null;
  const base = tag(text, 'URLBase') || location;
  const services = text.split(/<(?:\w+:)?service>/i).slice(1);
  // Prefer WANIPConnection (v2, then v1), then WANPPPConnection.
  const ranked = services
    .map((s) => ({ serviceType: tag(s, 'serviceType') || '', controlURL: tag(s, 'controlURL') }))
    .filter((s) => s.controlURL && /WAN(IP|PPP)Connection:\d/.test(s.serviceType))
    .sort((a, b) => rank(a.serviceType) - rank(b.serviceType));
  if (!ranked.length) return null;
  return { controlUrl: new URL(/** @type {string} */ (ranked[0].controlURL), base).toString(), serviceType: ranked[0].serviceType };
}
const rank = (/** @type {string} */ t) => (t.includes('WANIPConnection:2') ? 0 : t.includes('WANIPConnection') ? 1 : 2);

/**
 * Calls a SOAP action on the WAN connection service.
 * @param {{controlUrl: string, serviceType: string}} svc @param {string} action @param {Record<string, string|number>} args
 */
async function soap(svc, action, args) {
  const params = Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c])}</${k}>`).join('');
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.serviceType}">${params}</u:${action}></s:Body></s:Envelope>`;
  const res = /** @type {{status: number, text: string}} */ (await httpText(svc.controlUrl, {
    method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.serviceType}#${action}"`, 'Content-Length': String(Buffer.byteLength(body)) },
  }));
  if (res.status !== 200) {
    const code = tag(res.text, 'errorCode'), desc = tag(res.text, 'errorDescription');
    const err = new PortMapError(`Router refused ${action}${code ? ` (UPnP error ${code}${desc ? `: ${desc}` : ''})` : ` (HTTP ${res.status})`}.`);
    /** @type {any} */ (err).upnpCode = code ? Number(code) : null;
    throw err;
  }
  return res.text;
}

/** The local address used to talk to `host` (picks the right interface on multi-homed machines). @param {string} host */
export function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.connect(9, host, () => { const a = s.address().address; s.close(); resolve(a); });
  });
}

// ---- NAT-PMP (RFC 6886) ------------------------------------------------------------------

/** @param {string} gateway @param {Buffer} request @param {number} expectOp */
function natPmpRequest(gateway, request, expectOp, port = 5351) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let timeout = 250, tries = 0, timer;
    const finish = (/** @type {any} */ err, /** @type {any} */ val) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } err ? reject(err) : resolve(val); };
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      if (msg.length < 8 || msg[0] !== 0 || msg[1] !== expectOp) return;
      const result = msg.readUInt16BE(2);
      if (result !== 0) return finish(new PortMapError(`NAT-PMP error ${result}.`));
      finish(null, msg);
    });
    const send = () => {
      if (tries++ >= 5) return finish(new PortMapError('No NAT-PMP response from the router.'));
      sock.send(request, port, gateway);
      timer = setTimeout(send, timeout);
      timeout *= 2;
    };
    sock.bind(0, send);
  });
}

/** @param {string} gateway @param {number} port */
async function natPmpExternal(gateway, port) {
  const msg = /** @type {Buffer} */ (await natPmpRequest(gateway, Buffer.from([0, 0]), 128, port));
  return `${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`;
}

/** @param {string} gateway @param {number} internal @param {number} external @param {number} lifetime @param {number} port */
async function natPmpMap(gateway, internal, external, lifetime, port) {
  const req = Buffer.alloc(12);
  req[0] = 0; req[1] = 2; // TCP
  req.writeUInt16BE(internal, 4); req.writeUInt16BE(external, 6); req.writeUInt32BE(lifetime, 8);
  const msg = /** @type {Buffer} */ (await natPmpRequest(gateway, req, 130, port));
  return { externalPort: msg.readUInt16BE(10), lifetime: msg.readUInt32BE(12) };
}

/** Best-effort default gateway (IPv4) for the platform. @returns {Promise<string|null>} */
export async function defaultGateway() {
  try {
    if (process.platform === 'linux') {
      const table = await readFile('/proc/net/route', 'utf8');
      for (const line of table.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
          const n = parseInt(f[2], 16);
          return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.'); // little-endian
        }
      }
      return null;
    }
    const out = await new Promise((resolve) => {
      const [cmd, args] = process.platform === 'win32' ? ['route', ['print', '-4', '0.0.0.0']] : ['route', ['-n', 'get', 'default']];
      execFile(cmd, args, { timeout: 3000, windowsHide: true }, (_e, stdout) => resolve(String(stdout || '')));
    });
    const text = /** @type {string} */ (out);
    const m = process.platform === 'win32'
      ? /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(text)
      : /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---- mapper ------------------------------------------------------------------------------

export class PortMapper {
  /**
   * @param {{
   *   port: number, externalPort?: number, description?: string, log?: (m: string) => void,
   *   upnpLocation?: string, ssdp?: {address?: string, port?: number}, natPmpGateway?: string, natPmpPort?: number,
   *   disableNatPmp?: boolean,
   * }} opts  upnpLocation / ssdp / natPmp* override discovery (tests and unusual networks)
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    /** @type {Mapping|null} */ this.mapping = null;
    /** @type {{controlUrl: string, serviceType: string}|null} */ this.upnp = null;
    /** @type {NodeJS.Timeout|null} */ this.timer = null;
  }

  /** Opens the port. Throws PortMapError with a user-facing explanation when it can't. @returns {Promise<Mapping>} */
  async open() {
    const { port } = this.opts;
    const errors = [];
    try {
      const m = await this.openUpnp(port, this.opts.externalPort ?? port);
      if (m) return this.done(m);
      errors.push('No UPnP router answered.');
    } catch (err) { errors.push(err.message); }
    if (!this.opts.disableNatPmp) {
      try { return this.done(await this.openNatPmp(port, this.opts.externalPort ?? port)); } catch (err) { errors.push(err.message); }
    }
    throw new PortMapError(`Could not open port ${this.opts.externalPort ?? port} on your router automatically. ${errors.join(' ')} ` +
      'Turn on UPnP (sometimes called "UPnP IGD" or "NAT-PMP") in your router settings, or forward the port by hand and choose Manual setup.');
  }

  /** @param {number} port internal port @param {number} [external] @returns {Promise<Mapping|null>} */
  async openUpnp(port, external = port) {
    const locations = this.opts.upnpLocation ? [this.opts.upnpLocation]
      : await discoverGateways({ ssdpAddress: this.opts.ssdp?.address, ssdpPort: this.opts.ssdp?.port });
    for (const loc of locations) {
      const svc = await findWanService(loc).catch(() => null);
      if (!svc) continue;
      const gateway = new URL(svc.controlUrl).hostname;
      const internalIp = await localAddressFor(gateway);
      const add = (/** @type {number} */ lease) => soap(svc, 'AddPortMapping', {
        NewRemoteHost: '', NewExternalPort: external, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: internalIp,
        NewEnabled: 1, NewPortMappingDescription: this.opts.description || 'Studio Host', NewLeaseDuration: lease,
      });
      let lease = LEASE_SECONDS;
      try { await add(lease); } catch (err) {
        // 725: the router only supports permanent mappings.
        if (/** @type {any} */ (err).upnpCode === 725) { lease = 0; await add(0); } else throw err;
      }
      let externalIp = null;
      try { externalIp = tag(await soap(svc, 'GetExternalIPAddress', {}), 'NewExternalIPAddress'); } catch { /* optional */ }
      this.upnp = svc;
      return { method: 'upnp', externalIp: externalIp && isIP(externalIp) ? externalIp : null, externalPort: external, internalPort: port, internalIp, gateway, leaseSeconds: lease };
    }
    return null;
  }

  /** @param {number} port internal port @param {number} [external] @returns {Promise<Mapping>} */
  async openNatPmp(port, external = port) {
    const gateway = this.opts.natPmpGateway || (await defaultGateway());
    if (!gateway) throw new PortMapError('Could not find the router address for NAT-PMP.');
    const pmpPort = this.opts.natPmpPort || 5351;
    const externalIp = await natPmpExternal(gateway, pmpPort);
    const r = await natPmpMap(gateway, port, external, LEASE_SECONDS, pmpPort);
    if (r.externalPort !== external) {
      // The router chose a different external port; release it and report.
      await natPmpMap(gateway, port, 0, 0, pmpPort).catch(() => {});
      throw new PortMapError(`The router would only map port ${external} as ${r.externalPort}.`);
    }
    return { method: 'natpmp', externalIp, externalPort: external, internalPort: port, internalIp: await localAddressFor(gateway), gateway, leaseSeconds: r.lifetime };
  }

  /** @param {Mapping} m */
  done(m) {
    this.mapping = m;
    this.log(`Port ${m.externalPort} opened on the router via ${m.method === 'upnp' ? 'UPnP' : 'NAT-PMP'}${m.externalIp ? ` (public address ${m.externalIp})` : ''}.`);
    if (this.timer) clearInterval(this.timer);
    // Renew at half the lease. Permanent (0) leases are still re-asserted hourly in case the router rebooted.
    const every = Math.max(60, (m.leaseSeconds || LEASE_SECONDS * 2) / 2) * 1000;
    this.timer = setInterval(() => this.renew().catch((e) => this.log(`Port renewal failed: ${e.message}`)), every);
    this.timer.unref();
    return m;
  }

  async renew() {
    if (!this.mapping) return;
    const { internalPort, externalPort } = this.mapping;
    const m = this.mapping.method === 'upnp' ? await this.openUpnp(internalPort, externalPort) : await this.openNatPmp(internalPort, externalPort);
    if (m) this.mapping = { ...m };
  }

  /** Removes the mapping (best effort). */
  async close() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const m = this.mapping;
    this.mapping = null;
    if (!m) return;
    try {
      if (m.method === 'upnp' && this.upnp) await soap(this.upnp, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: 'TCP' });
      else if (m.method === 'natpmp') await natPmpMap(m.gateway, m.internalPort, 0, 0, this.opts.natPmpPort || 5351);
    } catch { /* the router will expire it */ }
  }
}

/** True for addresses that mean the router itself is behind another NAT (no public IP). @param {string|null} ip */
export function isBehindAnotherNat(ip) {
  if (!ip) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
