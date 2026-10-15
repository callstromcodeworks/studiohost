// @ts-check
// How guests reach Studio Host: the guest-facing HTTPS listener and everything that makes it
// reachable — router port mapping, the hostname, and the certificate. Two modes:
//
//   automatic  random 5-digit port opened with UPnP/NAT-PMP, a random hostname from the
//              Studio Host hostname service (cached until it expires), and a Let's Encrypt
//              certificate for that hostname (dns-01 via the service). Renewed automatically.
//   manual     the producer's own domain or IP (or LAN only), port, bind address, optional
//              UPnP, and certificate: self-signed, files, or Let's Encrypt (http-01).
//
// Progress is reported as a list of steps, shown by the setup wizard and the dock.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomInt } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { createSelfSignedCert, localIPv4s } from './certs.js';
import { AcmeClient, LETS_ENCRYPT, newKeyPem, renewalTime } from './acme.js';
import { PortMapper, isBehindAnotherNat } from './portmap.js';
import { HostnameService } from './hostname-service.js';

/** The CCW-hosted hostname service used by Automatic setup. */
export const DEFAULT_HOSTNAME_SERVICE = 'https://studioapi.callstromcodeworks.com/api';

const env = process.env;
const DNS_REFRESH_MS = 30 * 60_000;
const CERT_CHECK_MS = 12 * 3600_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * @typedef {'pending'|'running'|'ok'|'warn'|'error'|'skipped'} StepState
 * @typedef {{id: string, label: string, state: StepState, detail: string}} Step
 * @typedef {{
 *   mode: 'auto'|'manual'|null,
 *   auto: {service?: string, name?: string, fqdn?: string, token?: string, expiresAt?: number, port?: number, email?: string},
 *   manual: {address?: 'domain'|'lan', host?: string, port?: number, bindAddress?: string, upnp?: boolean,
 *            certificate?: 'self-signed'|'files'|'letsencrypt', certFile?: string, keyFile?: string, email?: string, httpChallengePort?: number},
 * }} NetworkSettings
 */

export function defaultNetworkSettings() {
  return /** @type {NetworkSettings} */ ({ mode: null, auto: {}, manual: {} });
}

/** A random 5-digit port that isn't one of the obvious ones. @param {number[]} avoid */
export function randomPort(avoid = []) {
  for (;;) { const p = randomInt(10000, 65536); if (!avoid.includes(p)) return p; }
}

/** @param {number} port @param {string} host @returns {Promise<boolean>} */
function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * Validates settings submitted by the wizard / Setup tab. Returns cleaned settings or throws.
 * @param {any} input @param {NetworkSettings} current @param {{localPort: number}} ctx
 * @returns {NetworkSettings}
 */
export function validateSettings(input, current, ctx) {
  const mode = input?.mode;
  if (mode !== 'auto' && mode !== 'manual') throw new Error('Choose Automatic or Manual.');
  const next = { mode, auto: { ...current.auto }, manual: { ...current.manual } };
  if (mode === 'auto') {
    const email = String(input.auto?.email ?? current.auto.email ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address doesn’t look right.');
    next.auto.email = email || undefined;
    return next;
  }
  const m = input.manual || {};
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Guest port must be a number from 1 to 65535.');
  if (port === ctx.localPort) throw new Error(`Port ${port} is used for OBS itself; pick another guest port.`);
  const address = m.address === 'lan' ? 'lan' : 'domain';
  const host = String(m.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (address === 'domain') {
    if (!host) throw new Error('Enter the domain name or public IP address guests will use.');
    if (!net.isIP(host) && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new Error(`“${host}” isn’t a valid domain name or IP address.`);
  }
  const bindAddress = String(m.bindAddress || '0.0.0.0').trim();
  if (!net.isIP(bindAddress)) throw new Error('Bind address must be an IP address (0.0.0.0 means all network interfaces).');
  const certificate = ['self-signed', 'files', 'letsencrypt'].includes(m.certificate) ? m.certificate : 'self-signed';
  if (certificate === 'files') {
    for (const [k, label] of [['certFile', 'certificate'], ['keyFile', 'private key']]) {
      const f = String(m[k] || '').trim();
      if (!f) throw new Error(`Enter the path of your ${label} file (PEM).`);
      if (!existsSync(f)) throw new Error(`The ${label} file “${f}” was not found.`);
    }
    try {
      const x = new X509Certificate(readFileSync(String(m.certFile).trim()));
      if (address === 'domain' && !x.checkHost(host) && !x.checkIP(host)) throw new Error(`The certificate is not valid for ${host}.`);
    } catch (err) { throw new Error(err.message.startsWith('The certificate') ? err.message : 'The certificate file is not a valid PEM certificate.'); }
  }
  if (certificate === 'letsencrypt') {
    if (address === 'lan') throw new Error('Let’s Encrypt can’t issue certificates for a local network address. Use a domain, or a self-signed certificate.');
    if (net.isIP(host)) throw new Error('Let’s Encrypt certificates here need a domain name, not an IP address.');
  }
  const httpChallengePort = Number(m.httpChallengePort || 80);
  if (!Number.isInteger(httpChallengePort) || httpChallengePort < 1 || httpChallengePort > 65535) throw new Error('Challenge port must be a number from 1 to 65535.');
  next.manual = {
    address, host: address === 'lan' ? '' : host, port, bindAddress, upnp: !!m.upnp, certificate,
    certFile: certificate === 'files' ? String(m.certFile).trim() : undefined,
    keyFile: certificate === 'files' ? String(m.keyFile).trim() : undefined,
    email: String(m.email || '').trim() || undefined, httpChallengePort,
  };
  return next;
}

export class NetworkManager extends EventEmitter {
  /**
   * @param {{
   *   settings: NetworkSettings, save: (s: NetworkSettings) => void, dataDir: string, localPort: number,
   *   handler: http.RequestListener, upgrade: (req: any, socket: any) => void, log?: (m: string) => void,
   * }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.settings = opts.settings;
    this.log = opts.log || ((m) => console.error(`[network] ${m}`));
    this.tlsDir = join(opts.dataDir, 'tls');
    mkdirSync(this.tlsDir, { recursive: true });
    /** @type {https.Server|null} */ this.server = null;
    /** @type {PortMapper|null} */ this.mapper = null;
    /** @type {PortMapper|null} */ this.challengeMapper = null;
    /** @type {Step[]} */ this.steps = [];
    /** @type {NodeJS.Timeout[]} */ this.timers = [];
    this.runId = 0;
    this.publicUrl = '';
    this.host = '';
    this.port = 0;
    /** @type {{kind: string, domain: string|null, validTo: string|null, trusted: boolean}} */
    this.certificate = { kind: 'none', domain: null, validTo: null, trusted: false };
    this.externalIp = /** @type {string|null} */ (null);
    this.reach = /** @type {any} */ (null);
    this.retries = 0;
    this.seq = 0;
  }

  get configured() { return this.settings.mode === 'auto' || this.settings.mode === 'manual'; }

  status() {
    const s = this.settings;
    return {
      // Increases with every change, so pages can ignore a status older than one they have.
      seq: this.seq,
      mode: s.mode, configured: this.configured,
      state: !this.configured ? 'unconfigured'
        : this.steps.some((x) => x.state === 'error') ? 'problem'
        : this.steps.some((x) => x.state === 'running' || x.state === 'pending') ? 'working' : 'ready',
      publicUrl: this.publicUrl, host: this.host, port: this.port, externalIp: this.externalIp,
      steps: this.steps, certificate: this.certificate, reach: this.reach,
      nameExpiresAt: s.mode === 'auto' ? s.auto.expiresAt || null : null,
      // Settings the wizard/Setup tab show (no secrets).
      settings: { mode: s.mode, auto: { email: s.auto.email || '', service: this.serviceUrl() }, manual: { ...s.manual } },
      lanAddress: lanAddress(),
    };
  }

  changed() { this.seq++; this.emit('status', this.status()); }

  serviceUrl() { return env.STUDIOHOST_DNS_SERVICE || this.settings.auto.service || DEFAULT_HOSTNAME_SERVICE; }

  /** @param {string} id @param {string} label */
  addStep(id, label) { this.steps.push({ id, label, state: 'pending', detail: '' }); }
  /** @param {string} id @param {StepState} state @param {string} [detail] */
  step(id, state, detail = '') {
    const st = this.steps.find((x) => x.id === id);
    if (st) { st.state = state; st.detail = detail; }
    this.changed();
  }

  /** Applies new settings from the wizard: saves them and restarts the guest side. @param {NetworkSettings} next */
  async apply(next) {
    const modeChanged = next.mode !== this.settings.mode;
    this.settings = next;
    if (modeChanged) this.retries = 0;
    this.opts.save(next);
    // Report "starting" straight away, so nothing shows the previous setup's address meanwhile.
    this.steps = [{ id: 'starting', label: 'Starting', state: 'running', detail: '' }];
    this.publicUrl = ''; this.host = ''; this.reach = null;
    this.certificate = { kind: 'none', domain: null, validTo: null, trusted: false };
    this.changed();
    await this.start();
  }

  async start() {
    const run = ++this.runId;
    await this.stopListening();
    this.steps = [];
    this.reach = null;
    if (!this.configured) {
      this.publicUrl = ''; this.host = ''; this.port = 0;
      this.changed();
      return;
    }
    try {
      if (this.settings.mode === 'auto') await this.runAuto(run);
      else await this.runManual(run);
      this.retries = 0;
    } catch (err) {
      if (run !== this.runId) return;
      this.log(err.message);
      // Try again later (e.g. the service or the router was briefly unavailable).
      const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.later(() => { if (run === this.runId) this.start(); }, delay);
    }
    this.changed();
  }

  /** @param {() => void} fn @param {number} ms */
  later(fn, ms) { const t = setTimeout(fn, ms); t.unref(); this.timers.push(t); }
  /** @param {() => void} fn @param {number} ms */
  every(fn, ms) { const t = setInterval(fn, ms); t.unref(); this.timers.push(t); }

  async stopListening() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    await this.mapper?.close(); this.mapper = null;
    await this.challengeMapper?.close(); this.challengeMapper = null;
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => { s.close(() => r(undefined)); s.closeAllConnections?.(); });
    }
  }

  async stop() { this.runId++; await this.stopListening(); }

  // ---- listener -------------------------------------------------------------------------
  /** @param {number} port @param {string} bind @param {{cert: string, key: string}} tls */
  async listen(port, bind, tls) {
    const server = https.createServer({ cert: tls.cert, key: tls.key }, this.opts.handler);
    server.keepAliveTimeout = 65_000; server.headersTimeout = 70_000; server.requestTimeout = 0;
    server.on('upgrade', this.opts.upgrade);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => { server.off('error', reject); resolve(undefined); });
    });
    server.on('error', (err) => this.log(`guest listener: ${err.message}`));
    this.server = server;
  }

  /** @param {{cert: string, key: string}} tls */
  useCertificate(tls) {
    this.server?.setSecureContext({ cert: tls.cert, key: tls.key });
  }

  /** Self-signed certificate for `host` (kept on disk, reused while valid). @param {string} host */
  selfSigned(host) {
    const certPath = join(this.tlsDir, 'selfsigned-cert.pem'), keyPath = join(this.tlsDir, 'selfsigned-key.pem');
    if (existsSync(certPath) && existsSync(keyPath)) {
      const cert = readFileSync(certPath, 'utf8');
      const x = new X509Certificate(cert);
      const fits = !host || net.isIP(host) ? true : x.checkHost(host);
      if (fits && new Date(x.validTo).getTime() > Date.now() + 7 * 86400e3) return { cert, key: readFileSync(keyPath, 'utf8') };
    }
    const pair = createSelfSignedCert(host && !net.isIP(host) ? [host] : []);
    writeFileSync(certPath, pair.cert);
    writeFileSync(keyPath, pair.key, { mode: 0o600 });
    return pair;
  }

  /** Let's Encrypt certificate previously issued for `domain`, if any. @param {string} domain */
  storedCertificate(domain) {
    const certPath = join(this.tlsDir, 'letsencrypt-cert.pem'), keyPath = join(this.tlsDir, 'letsencrypt-key.pem');
    if (!existsSync(certPath) || !existsSync(keyPath)) return null;
    const cert = readFileSync(certPath, 'utf8');
    const x = new X509Certificate(cert);
    if (!x.checkHost(domain) || new Date(x.validTo).getTime() < Date.now()) return null;
    return { cert, key: readFileSync(keyPath, 'utf8'), validTo: x.validTo, dueAt: renewalTime(cert) };
  }

  accountKey() {
    const p = join(this.tlsDir, 'acme-account-key.pem');
    if (!existsSync(p)) writeFileSync(p, newKeyPem(), { mode: 0o600 });
    return readFileSync(p, 'utf8');
  }

  /**
   * Obtains (or reuses) a Let's Encrypt certificate and installs it.
   * @param {string} domain @param {'dns-01'|'http-01'} type
   * @param {(c: {token: string, keyAuthorization: string, txt: string}) => Promise<void>} present
   * @param {(c: {token: string, keyAuthorization: string, txt: string}) => Promise<void>} cleanup
   * @param {string|undefined} email @param {boolean} [force]
   */
  async ensureCertificate(domain, type, present, cleanup, email, force = false) {
    const stored = this.storedCertificate(domain);
    if (stored && !force && Date.now() < stored.dueAt) {
      this.useCertificate(stored);
      this.certificate = { kind: 'letsencrypt', domain, validTo: stored.validTo, trusted: true };
      return `Valid until ${fmtDate(stored.validTo)} (renews automatically).`;
    }
    const client = new AcmeClient({
      directoryUrl: env.STUDIOHOST_ACME_DIRECTORY || LETS_ENCRYPT, accountKeyPem: this.accountKey(),
      ca: env.STUDIOHOST_ACME_CA ? readFileSync(env.STUDIOHOST_ACME_CA, 'utf8') : undefined, log: this.log,
    });
    const r = await client.obtain({
      domain, email, type, present, cleanup,
      propagationDelayMs: env.STUDIOHOST_PROPAGATION_MS !== undefined ? Number(env.STUDIOHOST_PROPAGATION_MS) : 3000,
    });
    writeFileSync(join(this.tlsDir, 'letsencrypt-cert.pem'), r.certPem);
    writeFileSync(join(this.tlsDir, 'letsencrypt-key.pem'), r.keyPem, { mode: 0o600 });
    this.useCertificate({ cert: r.certPem, key: r.keyPem });
    const validTo = new X509Certificate(r.certPem).validTo;
    this.certificate = { kind: 'letsencrypt', domain, validTo, trusted: true };
    return `Issued by Let’s Encrypt, valid until ${fmtDate(validTo)} (renews automatically).`;
  }

  // ---- automatic ---------------------------------------------------------------------------
  /** @param {number} run */
  async runAuto(run) {
    const s = this.settings;
    const svc = new HostnameService({ url: this.serviceUrl(), ca: env.STUDIOHOST_DNS_SERVICE_CA ? readFileSync(env.STUDIOHOST_DNS_SERVICE_CA, 'utf8') : undefined });
    this.addStep('port', 'Open a port on your router');
    this.addStep('name', 'Get your studio’s web address');
    this.addStep('certificate', 'Get a security certificate');
    this.addStep('reach', 'Check guests can reach you');
    this.changed();

    // 1. Port: a random 5-digit port, kept from then on. Choose another if it's taken.
    this.step('port', 'running', 'Looking for your router…');
    let mapping = null, lastError = '';
    for (let attempt = 0; attempt < 5 && run === this.runId; attempt++) {
      if (!s.auto.port || !(await portFree(s.auto.port, '0.0.0.0'))) {
        s.auto.port = randomPort([this.opts.localPort]);
        this.opts.save(s);
      }
      const mapper = new PortMapper({
        port: s.auto.port, log: this.log, upnpLocation: env.STUDIOHOST_UPNP_LOCATION || undefined,
        ...(env.STUDIOHOST_NATPMP ? { natPmpGateway: env.STUDIOHOST_NATPMP.split(':')[0], natPmpPort: Number(env.STUDIOHOST_NATPMP.split(':')[1]) || 5351 } : {}),
        ...(env.STUDIOHOST_SSDP ? { ssdp: { address: env.STUDIOHOST_SSDP.split(':')[0], port: Number(env.STUDIOHOST_SSDP.split(':')[1]) } } : {}),
      });
      try {
        mapping = await mapper.open();
        this.mapper = mapper;
        break;
      } catch (err) {
        lastError = err.message;
        // A conflict means some other device already uses that port on the router: pick another.
        if (/\b718\b|only map port/.test(lastError)) { s.auto.port = randomPort([this.opts.localPort, s.auto.port]); this.opts.save(s); continue; }
        break;
      }
    }
    if (run !== this.runId) return;
    this.port = /** @type {number} */ (s.auto.port);
    if (mapping) {
      this.externalIp = mapping.externalIp;
      if (isBehindAnotherNat(mapping.externalIp)) {
        this.step('port', 'error', `Port ${this.port} is open on your router, but your router itself has no public internet address (${mapping.externalIp}). ` +
          'This happens with some mobile and fiber providers (carrier-grade NAT) or when two routers are chained. Ask your provider for a public IP, put the first router in bridge mode, or use Manual setup with a TURN server or tunnel.');
      } else {
        this.step('port', 'ok', `Port ${this.port} is open (${mapping.method === 'upnp' ? 'UPnP' : 'NAT-PMP'}).`);
      }
    } else {
      this.step('port', 'error', lastError);
    }

    // The listener starts on the port right away (with a temporary certificate) so the
    // reachability check and guests can connect as soon as the rest is ready.
    const fqdnGuess = s.auto.fqdn || '';
    await this.listen(this.port, '0.0.0.0', this.storedCertificate(fqdnGuess) || this.selfSigned(fqdnGuess));
    if (run !== this.runId) return;

    // 2. Name: reuse the cached one until it expires; otherwise register a new one.
    this.step('name', 'running', 'Contacting the Studio Host hostname service…');
    const ip4 = mapping && !isBehindAnotherNat(mapping.externalIp) ? mapping.externalIp || undefined : undefined;
    let fresh = false;
    if (s.auto.name && s.auto.token && (s.auto.expiresAt || 0) > Date.now()) {
      try {
        const u = await svc.update(s.auto.name, s.auto.token, ip4);
        s.auto.expiresAt = u.expiresAt;
      } catch (err) {
        if (/** @type {any} */ (err).status !== 404) { this.step('name', 'error', err.message); throw err; }
        s.auto.name = undefined; // expired or released on the service side
      }
    }
    if (!s.auto.name || !s.auto.token || (s.auto.expiresAt || 0) <= Date.now()) {
      try {
        const r = await svc.register();
        Object.assign(s.auto, { name: r.name, fqdn: r.fqdn, token: r.token, expiresAt: r.expiresAt, service: this.serviceUrl() });
        if (ip4 && r.ip4 !== ip4) await svc.update(r.name, r.token, ip4);
        fresh = true;
      } catch (err) { this.step('name', 'error', err.message); throw err; }
    }
    this.opts.save(s);
    if (run !== this.runId) return;
    const fqdn = /** @type {string} */ (s.auto.fqdn);
    this.host = fqdn;
    this.publicUrl = `https://${fqdn}:${this.port}`;
    this.step('name', 'ok', `${fqdn}${fresh ? ' (new)' : ''} — kept while Studio Host runs at least once every 90 days.`);
    // Keep the address current (also extends the name's lifetime).
    this.every(() => {
      svc.update(/** @type {string} */ (s.auto.name), /** @type {string} */ (s.auto.token), this.mapper?.mapping?.externalIp || undefined)
        .then((u) => { s.auto.expiresAt = u.expiresAt; this.opts.save(s); })
        .catch((e) => this.log(`hostname update failed: ${e.message}`));
    }, DNS_REFRESH_MS);

    // 3. Certificate via dns-01 (the service publishes the challenge).
    this.step('certificate', 'running', 'Requesting a certificate from Let’s Encrypt…');
    const name = /** @type {string} */ (s.auto.name), token = /** @type {string} */ (s.auto.token);
    const issue = (/** @type {boolean} */ force) => this.ensureCertificate(fqdn, 'dns-01',
      async ({ txt }) => { await svc.setChallenge(name, token, [txt]); },
      async () => { await svc.setChallenge(name, token, []); },
      s.auto.email, force);
    try {
      this.step('certificate', 'ok', await issue(false));
    } catch (err) {
      this.certificate = { kind: 'self-signed', domain: fqdn, validTo: null, trusted: false };
      this.step('certificate', 'error', `${err.message} Guests will see a security warning until this works; Studio Host keeps trying.`);
      throw err;
    }
    this.every(() => this.renewIfDue(fqdn, issue), CERT_CHECK_MS);

    // 4. Reachability, tested from the hostname service (outside your network).
    await this.checkReach(svc, run);
  }

  /** @param {HostnameService} svc @param {number} run */
  async checkReach(svc, run) {
    const s = this.settings;
    this.step('reach', 'running', 'Testing from the internet…');
    try {
      const r = await svc.probe(/** @type {string} */ (s.auto.name), /** @type {string} */ (s.auto.token), this.port);
      if (run !== this.runId) return;
      this.reach = r;
      if (r.reachable && r.studioHost) this.step('reach', r.certificateValid === false ? 'warn' : 'ok', r.certificateValid === false ? `Reachable, but the certificate isn’t trusted yet (${r.certificateError}).` : 'Guests can reach your studio.');
      else if (r.reachable) this.step('reach', 'warn', 'Something answered on your port, but it wasn’t Studio Host. Another device may be using this port on your router.');
      else this.step('reach', 'error', `Guests can’t reach port ${this.port} from the internet (${r.error || 'no answer'}). Check that UPnP is on, or that no firewall blocks Studio Host.`);
    } catch (err) {
      this.step('reach', 'warn', `Couldn’t run the connection test: ${err.message}`);
    }
  }

  /** Runs the reachability test again (from the wizard / Setup tab). */
  async recheck() {
    if (this.settings.mode !== 'auto' || !this.settings.auto.name) return this.status();
    const svc = new HostnameService({ url: this.serviceUrl(), ca: env.STUDIOHOST_DNS_SERVICE_CA ? readFileSync(env.STUDIOHOST_DNS_SERVICE_CA, 'utf8') : undefined });
    await this.checkReach(svc, this.runId);
    return this.status();
  }

  /** @param {string} domain @param {(force: boolean) => Promise<string>} issue */
  async renewIfDue(domain, issue) {
    const stored = this.storedCertificate(domain);
    if (stored && Date.now() < stored.dueAt) return;
    try { this.step('certificate', 'ok', await issue(true)); }
    catch (err) { this.log(`certificate renewal failed (will retry): ${err.message}`); this.step('certificate', 'warn', `Renewal failed, will retry: ${err.message}`); }
  }

  // ---- manual ------------------------------------------------------------------------------
  /** @param {number} run */
  async runManual(run) {
    const m = this.settings.manual;
    const port = Number(env.STUDIOHOST_PUBLIC_PORT) || /** @type {number} */ (m.port);
    const lan = m.address === 'lan';
    const host = lan ? lanAddress() : /** @type {string} */ (m.host);
    this.port = port;
    this.host = host;
    this.publicUrl = `https://${host.includes(':') ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}`;
    if (m.upnp) this.addStep('port', 'Open the port on your router');
    this.addStep('listen', 'Start the guest server');
    this.addStep('certificate', m.certificate === 'letsencrypt' ? 'Get a Let’s Encrypt certificate' : m.certificate === 'files' ? 'Load your certificate' : 'Create a self-signed certificate');
    this.changed();

    if (m.upnp) {
      this.step('port', 'running', 'Looking for your router…');
      const mapper = new PortMapper({ port, log: this.log, upnpLocation: env.STUDIOHOST_UPNP_LOCATION || undefined });
      try {
        const mapping = await mapper.open();
        this.mapper = mapper;
        this.externalIp = mapping.externalIp;
        this.step('port', 'ok', `Port ${port} is open (${mapping.method === 'upnp' ? 'UPnP' : 'NAT-PMP'}).`);
      } catch (err) { this.step('port', 'error', err.message); }
    }
    if (run !== this.runId) return;

    let tls;
    if (m.certificate === 'files') {
      try {
        tls = { cert: readFileSync(/** @type {string} */ (m.certFile), 'utf8'), key: readFileSync(/** @type {string} */ (m.keyFile), 'utf8') };
        const x = new X509Certificate(tls.cert);
        this.certificate = { kind: 'files', domain: host, validTo: x.validTo, trusted: true };
      } catch (err) {
        this.step('certificate', 'error', `Could not read the certificate files: ${err.message}`);
        tls = this.selfSigned(host);
        this.certificate = { kind: 'self-signed', domain: host, validTo: null, trusted: false };
      }
    } else if (m.certificate === 'letsencrypt') {
      tls = this.storedCertificate(host) || this.selfSigned(host);
    } else {
      tls = this.selfSigned(host);
      this.certificate = { kind: 'self-signed', domain: host, validTo: new X509Certificate(tls.cert).validTo, trusted: false };
    }

    this.step('listen', 'running', `Listening on port ${port}…`);
    try {
      await this.listen(port, m.bindAddress || '0.0.0.0', tls);
      this.step('listen', 'ok', `Guests connect to ${this.publicUrl}${lan ? ' (only on your local network)' : ''}.`);
    } catch (err) {
      const msg = /** @type {any} */ (err).code === 'EADDRINUSE' ? `Port ${port} is already used by another program. Choose a different guest port.` :
        /** @type {any} */ (err).code === 'EACCES' ? `This computer doesn’t allow Studio Host to use port ${port}. Choose a port above 1024.` : err.message;
      this.step('listen', 'error', msg);
      throw new Error(msg);
    }

    if (m.certificate === 'files') {
      if (this.certificate.kind === 'files') this.step('certificate', 'ok', `Loaded, valid until ${fmtDate(/** @type {string} */ (this.certificate.validTo))}. Replace the files and rerun setup when you renew it.`);
    } else if (m.certificate === 'self-signed') {
      this.step('certificate', 'warn', 'Guests will see a browser security warning and must choose to continue.');
    } else {
      // http-01: Let's Encrypt connects to port 80 of the domain.
      this.step('certificate', 'running', 'Requesting a certificate from Let’s Encrypt…');
      const challenges = new Map();
      const challengePort = /** @type {number} */ (m.httpChallengePort) || 80;
      const challengeServer = http.createServer((req, res) => {
        const tokenMatch = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url || '');
        const body = tokenMatch && challenges.get(tokenMatch[1]);
        res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/plain' });
        res.end(body || 'not found');
      });
      const issue = async (/** @type {boolean} */ force) => {
        await new Promise((resolve, reject) => { challengeServer.once('error', reject); challengeServer.listen(challengePort, m.bindAddress || '0.0.0.0', () => resolve(undefined)); });
        if (m.upnp) {
          this.challengeMapper = new PortMapper({ port: challengePort, externalPort: 80, log: this.log, upnpLocation: env.STUDIOHOST_UPNP_LOCATION || undefined });
          await this.challengeMapper.open().catch((e) => this.log(`could not open port 80: ${e.message}`));
        }
        try {
          return await this.ensureCertificate(host, 'http-01',
            async ({ token, keyAuthorization }) => { challenges.set(token, keyAuthorization); },
            async ({ token }) => { challenges.delete(token); }, m.email, force);
        } finally {
          challengeServer.close();
          await this.challengeMapper?.close(); this.challengeMapper = null;
        }
      };
      try {
        this.step('certificate', 'ok', await issue(false));
      } catch (err) {
        const hint = /** @type {any} */ (err).code === 'EACCES' ? ` This computer doesn’t allow listening on port ${challengePort}; forward external port 80 to a higher local port and set it as the challenge port.`
          : ` Let’s Encrypt must reach http://${host}/ on port 80, forwarded to this computer’s port ${challengePort}.`;
        this.certificate = { kind: 'self-signed', domain: host, validTo: null, trusted: false };
        this.step('certificate', 'error', `${err.message}${hint}`);
        throw err;
      }
      this.every(() => this.renewIfDue(host, issue), CERT_CHECK_MS);
    }
  }
}

/** First non-internal IPv4 address of this computer. */
export function lanAddress() {
  return localIPv4s().find((ip) => !ip.startsWith('127.')) || '127.0.0.1';
}

/** @param {string} d */
function fmtDate(d) { return new Date(d).toISOString().slice(0, 10); }
