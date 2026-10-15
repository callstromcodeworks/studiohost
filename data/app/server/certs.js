// @ts-check
// TLS for the guest-facing server. Browsers only allow camera/microphone access on
// secure (HTTPS) pages, so guests must reach Studio Host over HTTPS.
// network.js decides which certificate to use; without a real one, a
// self-signed certificate is generated in pure JavaScript (no OpenSSL needed);
// guests will see a browser warning they must click through.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

// ---- minimal DER encoder -------------------------------------------------
/** @param {number} n */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
/** @param {number} tag @param {Buffer} body */
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
/** @param {...Buffer} items */
const seq = (...items) => tlv(0x30, Buffer.concat(items));
/** @param {...Buffer} items */
const set = (...items) => tlv(0x31, Buffer.concat(items));
/** @param {string} dotted */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
/** @param {Buffer} buf */
const integer = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
/** @param {Date} d */
function utcTime(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}
/** @param {string} cn */
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

/** DER building blocks, shared with the ACME client (CSR generation). */
export const der = { tlv, seq, set, oid, integer, name, derLength };

/** @returns {string[]} */
export function localIPv4s() {
  const ips = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4') ips.push(ni.address);
  }
  return ips;
}

/**
 * Creates a self-signed ECDSA P-256 certificate valid for localhost and this machine's IPv4 addresses.
 * @param {string[]} [extraHosts] extra DNS names to include in the certificate
 * @returns {{cert: string, key: string}} PEM strings
 */
export function createSelfSignedCert(extraHosts = []) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const now = Date.now();
  // Positive with a non-zero first byte, so the DER INTEGER is minimal (a leading 0x00 is "illegal padding").
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;

  const sanEntries = [];
  for (const host of ['localhost', ...extraHosts]) sanEntries.push(tlv(0x82, Buffer.from(host, 'ascii')));
  for (const ip of localIPv4s()) sanEntries.push(tlv(0x87, Buffer.from(ip.split('.').map(Number))));
  const extensions = seq(
    seq(oid('2.5.29.17'), tlv(0x04, seq(...sanEntries))),                 // subjectAltName
    seq(oid('2.5.29.19'), tlv(0x04, seq())),                              // basicConstraints: CA=false
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),      // extKeyUsage: serverAuth
  );

  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),          // version v3
    integer(serial),
    ecdsaSha256,
    name('Studio Host (self-signed)'),
    seq(utcTime(new Date(now - 86400e3)), utcTime(new Date(now + 825 * 86400e3))),
    name('Studio Host (self-signed)'),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, extensions),
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
}
