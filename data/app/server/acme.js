// @ts-check
// ACME client (RFC 8555) for Let's Encrypt, with no dependencies.
// Supports the dns-01 challenge (the hostname service publishes the TXT record) and http-01
// (the caller serves the token on port 80). Keys are ECDSA P-256.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { der } from './certs.js';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const b64u = (/** @type {Buffer|string} */ b) => Buffer.from(b).toString('base64url');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {string} PEM (PKCS#8) of a new P-256 key */
export function newKeyPem() {
  return /** @type {string} */ (generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

/** @param {string} keyPem */
function jwkOf(keyPem) {
  const jwk = /** @type {any} */ (createPrivateKey(keyPem).export({ format: 'jwk' }));
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }; // members in lexicographic order (RFC 7638)
}

/** @param {string} keyPem */
export function thumbprint(keyPem) {
  return b64u(createHash('sha256').update(JSON.stringify(jwkOf(keyPem))).digest());
}

/** dns-01 TXT value for a key authorization. @param {string} keyAuthorization */
export const dnsTxtValue = (keyAuthorization) => b64u(createHash('sha256').update(keyAuthorization).digest());

/**
 * PKCS#10 certificate signing request for one DNS name.
 * @param {string} domain @param {string} keyPem
 * @returns {Buffer} DER
 */
export function createCsr(domain, keyPem) {
  const { tlv, seq, set, oid, integer, name } = der;
  const key = createPrivateKey(keyPem);
  const spki = /** @type {Buffer} */ (createPublicKey(key).export({ type: 'spki', format: 'der' }));
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(domain, 'ascii')))));
  const extensionRequest = seq(oid('1.2.840.113549.1.9.14'), set(seq(san)));
  const info = seq(integer(Buffer.from([0])), name(domain), spki, tlv(0xa0, extensionRequest));
  const signature = sign('sha256', info, { key, dsaEncoding: 'der' });
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}


/**
 * Minimal HTTPS client (supports a custom CA, used with the Pebble test server).
 * @param {string} url @param {{method?: string, headers?: Record<string, string>, body?: string, ca?: string}} opts
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: any}>}
 */
function request(url, opts = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: opts.method || 'GET', headers: opts.headers, ...(opts.ca ? { ca: opts.ca } : {}), timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout contacting ${u.host}`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export class AcmeError extends Error {
  /** @param {string} message @param {any} [problem] */
  constructor(message, problem) { super(message); this.problem = problem; }
}

export class AcmeClient {
  /**
   * @param {{directoryUrl: string, accountKeyPem: string, ca?: string, log?: (msg: string) => void}} opts
   */
  constructor({ directoryUrl, accountKeyPem, ca, log }) {
    this.directoryUrl = directoryUrl;
    this.accountKeyPem = accountKeyPem;
    this.accountKey = createPrivateKey(accountKeyPem);
    this.jwk = jwkOf(accountKeyPem);
    this.ca = ca;
    this.log = log || (() => {});
    /** @type {any} */ this.directory = null;
    /** @type {string|null} */ this.nonce = null;
    /** @type {string|null} */ this.kid = null;
  }

  async init() {
    if (this.directory) return;
    const r = await request(this.directoryUrl, { ca: this.ca });
    if (r.status !== 200 || !r.json?.newOrder) throw new AcmeError(`Could not read the ACME directory at ${this.directoryUrl} (HTTP ${r.status}).`);
    this.directory = r.json;
  }

  async getNonce() {
    if (this.nonce) { const n = this.nonce; this.nonce = null; return n; }
    const r = await request(this.directory.newNonce, { method: 'HEAD', ca: this.ca });
    const n = r.headers['replay-nonce'];
    if (!n) throw new AcmeError('The ACME server did not return a nonce.');
    return String(n);
  }

  /**
   * Signed POST (payload null = POST-as-GET). Retries once on badNonce.
   * @param {string} url @param {any} payload @param {{useJwk?: boolean, accept?: string}} [opts]
   */
  async post(url, payload, opts = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const protectedHeader = { alg: 'ES256', nonce: await this.getNonce(), url, ...(opts.useJwk || !this.kid ? { jwk: this.jwk } : { kid: this.kid }) };
      const p64 = b64u(JSON.stringify(protectedHeader));
      const pl64 = payload === null ? '' : b64u(JSON.stringify(payload));
      const signature = sign('sha256', Buffer.from(`${p64}.${pl64}`), { key: this.accountKey, dsaEncoding: 'ieee-p1363' });
      const body = JSON.stringify({ protected: p64, payload: pl64, signature: b64u(signature) });
      const r = await request(url, {
        method: 'POST', body, ca: this.ca,
        headers: { 'Content-Type': 'application/jose+json', 'Content-Length': String(Buffer.byteLength(body)), ...(opts.accept ? { Accept: opts.accept } : {}) },
      });
      if (r.headers['replay-nonce']) this.nonce = String(r.headers['replay-nonce']);
      if (r.status >= 400 && r.json?.type === 'urn:ietf:params:acme:error:badNonce' && attempt < 2) continue;
      if (r.status >= 400) {
        const detail = r.json?.detail || r.text.slice(0, 200);
        throw new AcmeError(`ACME request failed (${r.status}): ${detail}`, r.json);
      }
      return r;
    }
    throw new AcmeError('ACME server kept rejecting nonces.');
  }

  /** @param {string|undefined} email */
  async account(email) {
    await this.init();
    if (this.kid) return this.kid;
    const r = await this.post(this.directory.newAccount, {
      termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}),
    }, { useJwk: true });
    this.kid = String(r.headers.location || '');
    if (!this.kid) throw new AcmeError('The ACME server did not return an account URL.');
    return this.kid;
  }

  /** Polls an order/authorization URL until its status leaves `pending`/`processing`. @param {string} url */
  async poll(url, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const r = await this.post(url, null);
      const status = r.json?.status;
      if (status !== 'pending' && status !== 'processing') return r.json;
      if (Date.now() > deadline) throw new AcmeError(`Timed out waiting for the certificate authority (${status}).`);
      const retry = Number(r.headers['retry-after']);
      await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 10) * 1000 : 2000);
    }
  }

  /**
   * Obtains a certificate for `domain`.
   * @param {{
   *   domain: string, email?: string, certKeyPem?: string, type: 'dns-01'|'http-01',
   *   present: (c: {token: string, keyAuthorization: string, txt: string}) => Promise<void>,
   *   cleanup?: (c: {token: string, keyAuthorization: string, txt: string}) => Promise<void>,
   *   propagationDelayMs?: number,
   * }} opts
   * @returns {Promise<{certPem: string, keyPem: string, notAfter: number}>}
   */
  async obtain({ domain, email, certKeyPem, type, present, cleanup, propagationDelayMs = 2000 }) {
    await this.account(email);
    this.log(`Requesting a certificate for ${domain}…`);
    const orderRes = await this.post(this.directory.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    const orderUrl = String(orderRes.headers.location);
    let order = orderRes.json;
    const thumb = thumbprint(this.accountKeyPem);

    for (const authzUrl of order.authorizations) {
      const authz = (await this.post(authzUrl, null)).json;
      if (authz.status === 'valid') continue;
      const ch = authz.challenges.find((c) => c.type === type);
      if (!ch) throw new AcmeError(`The certificate authority did not offer a ${type} challenge.`);
      const keyAuthorization = `${ch.token}.${thumb}`;
      const info = { token: ch.token, keyAuthorization, txt: dnsTxtValue(keyAuthorization) };
      await present(info);
      try {
        if (propagationDelayMs) await sleep(propagationDelayMs);
        this.log('Asking the certificate authority to verify the challenge…');
        await this.post(ch.url, {});
        const result = await this.poll(authzUrl);
        if (result.status !== 'valid') {
          const problem = result.challenges?.find((c) => c.type === type)?.error;
          throw new AcmeError(`Verification failed: ${problem?.detail || result.status}`, problem);
        }
      } finally {
        await cleanup?.(info).catch(() => {});
      }
    }

    const keyPem = certKeyPem || newKeyPem();
    order = (await this.post(orderUrl, null)).json;
    if (order.status === 'ready') {
      await this.post(order.finalize, { csr: b64u(createCsr(domain, keyPem)) });
    }
    order = await this.poll(orderUrl);
    if (order.status !== 'valid' || !order.certificate) throw new AcmeError(`The order did not complete (${order.status}).`);
    const certRes = await this.post(order.certificate, null, { accept: 'application/pem-certificate-chain' });
    const certPem = certRes.text;
    const notAfter = new Date(new X509Certificate(certPem).validTo).getTime();
    this.log(`Certificate issued for ${domain}, valid until ${new Date(notAfter).toISOString().slice(0, 10)}.`);
    return { certPem, keyPem, notAfter };
  }
}

/**
 * When a certificate should be renewed: after two thirds of its lifetime (Let's Encrypt's
 * own recommendation), so 90-day certificates renew at ~60 days and 45-day ones at ~30.
 * @param {string} certPem
 */
export function renewalTime(certPem) {
  const x = new X509Certificate(certPem);
  const from = new Date(x.validFrom).getTime(), to = new Date(x.validTo).getTime();
  return from + ((to - from) * 2) / 3;
}
