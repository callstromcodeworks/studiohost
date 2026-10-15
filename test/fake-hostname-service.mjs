// A minimal, in-memory stand-in for the Studio Host hostname service, for tests only:
// the HTTP API that data/app/server/hostname-service.js calls, plus a tiny authoritative DNS
// server (A and TXT records) so a test ACME CA can validate dns-01 challenges through it.
//
//   ZONE=live.studiohost.test DNS_PORT=5399 API_PORT=8099 [DNS_HOST=127.0.0.1] [API_BIND=127.0.0.1]
//   [PROBE_CA_FILE=root.pem] node test/fake-hostname-service.mjs
//
// Logs "API: http://…" once it is listening.
import http from 'node:http';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';

const env = process.env;
const zone = String(env.ZONE || '').toLowerCase();
if (!zone) { console.error('ZONE is required'); process.exit(1); }

const ADJECTIVES = ['amber', 'brave', 'calm', 'eager', 'gentle', 'lucky', 'quiet', 'sunny'];
const NOUNS = ['otter', 'falcon', 'maple', 'river', 'comet', 'harbor', 'meadow', 'willow'];

/** @type {Map<string, {token: string, ip4: string|null, txt: string[]}>} */
const names = new Map();

function newName() {
  for (;;) {
    const name = `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}-${randomInt(1000, 10000)}`;
    if (!names.has(name)) return name;
  }
}

// ---- HTTP API ---------------------------------------------------------------------------
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Body must be JSON.' }); }
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const token = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
  const parts = new URL(req.url || '/', 'http://x').pathname.split('/').filter(Boolean);
  const expiresAt = Date.now() + 90 * 86_400_000;

  if (req.method === 'GET' && parts.join('/') === 'v1/health') return send(res, 200, { ok: true, zone, names: names.size });
  if (req.method === 'POST' && parts.join('/') === 'v1/names') {
    const name = newName();
    const rec = { token: randomBytes(24).toString('base64url'), ip4: ip.includes(':') ? null : ip, txt: [] };
    names.set(name, rec);
    return send(res, 201, { name, fqdn: `${name}.${zone}`, token: rec.token, expiresAt, zone, ip4: rec.ip4 });
  }
  if (parts[0] !== 'v1' || parts[1] !== 'names' || !parts[2]) return send(res, 404, { error: 'Not found.' });
  const name = decodeURIComponent(parts[2]).toLowerCase();
  const rec = names.get(name);
  if (!rec || rec.token !== token) return send(res, 403, { error: 'Unknown name or wrong token.' });
  const sub = parts[3] || '';
  if (req.method === 'PUT' && sub === 'address') {
    rec.ip4 = body.ip4 ?? (ip.includes(':') ? rec.ip4 : ip);
    return send(res, 200, { fqdn: `${name}.${zone}`, ip4: rec.ip4, ip6: null, expiresAt });
  }
  if (req.method === 'PUT' && sub === 'acme-challenge') {
    rec.txt = Array.isArray(body.values) ? body.values.map(String) : [];
    return send(res, 200, { name, values: rec.txt });
  }
  if (req.method === 'POST' && sub === 'probe') {
    if (!rec.ip4) return send(res, 409, { error: 'This name has no address yet.' });
    const ca = env.PROBE_CA_FILE && existsSync(env.PROBE_CA_FILE) ? readFileSync(env.PROBE_CA_FILE, 'utf8') : undefined;
    return send(res, 200, await probe(rec.ip4, Number(body.port), `${name}.${zone}`, ca));
  }
  if (req.method === 'DELETE' && !sub) { names.delete(name); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'Not found.' });
});

/** TLS handshake against the name's address, checking the certificate, then GET /api/ping. */
function probe(host, port, servername, ca) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, servername, rejectUnauthorized: false, ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => done({ reachable: false, error: 'Timed out.' }), 6000);
    const done = (r) => { clearTimeout(timer); sock.destroy(); resolve(r); };
    sock.on('error', (err) => done({ reachable: false, error: err.message }));
    sock.on('secureConnect', () => {
      const certificateValid = sock.authorized;
      const certificateError = certificateValid ? null : String(sock.authorizationError || 'not trusted');
      sock.write(`GET /api/ping HTTP/1.1\r\nHost: ${servername}:${port}\r\nConnection: close\r\n\r\n`);
      let data = '';
      sock.on('data', (c) => { data += c; });
      sock.on('end', () => done({ reachable: true, studioHost: /^HTTP\/1\.[01] 200/.test(data) && data.includes('"ok":true'), certificateValid, certificateError }));
    });
  });
}

// ---- DNS --------------------------------------------------------------------------------
/** @param {string} qname @param {number} qtype @returns {{rcode: number, answers: Buffer[]}} */
function lookup(qname, qtype) {
  const q = qname.toLowerCase().replace(/\.$/, '');
  if (q === zone) return { rcode: 0, answers: [] };
  if (!q.endsWith(`.${zone}`)) return { rcode: 5, answers: [] };
  const label = q.slice(0, -zone.length - 1);
  const acme = /^_acme-challenge\.(.+)$/.exec(label);
  const rec = names.get(acme ? acme[1] : label);
  if (!rec) return { rcode: 3, answers: [] };
  if (acme) return { rcode: 0, answers: qtype === 16 ? rec.txt.map((v) => rr(16, Buffer.concat([Buffer.from([v.length]), Buffer.from(v)]))) : [] };
  if (qtype === 1 && rec.ip4) return { rcode: 0, answers: [rr(1, Buffer.from(rec.ip4.split('.').map(Number)))] };
  return { rcode: 0, answers: [] };
}

/** An answer record whose name points back at the question (offset 12). */
function rr(type, rdata) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(0xc00c, 0); h.writeUInt16BE(type, 2); h.writeUInt16BE(1, 4); h.writeUInt32BE(30, 6); h.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([h, rdata]);
}

const dns = dgram.createSocket('udp4');
dns.on('message', (msg, rinfo) => {
  if (msg.length < 12 || msg.readUInt16BE(4) !== 1) return;
  let i = 12; const labels = [];
  while (i < msg.length && msg[i] !== 0) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('ascii')); i += msg[i] + 1; }
  const qEnd = i + 5;
  if (qEnd > msg.length) return;
  const qtype = msg.readUInt16BE(i + 1);
  const { rcode, answers } = lookup(labels.join('.'), qtype);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8400 | (msg.readUInt16BE(2) & 0x0100) | rcode, 2);
  header.writeUInt16BE(1, 4); header.writeUInt16BE(answers.length, 6);
  dns.send(Buffer.concat([header, msg.subarray(12, qEnd), ...answers]), rinfo.port, rinfo.address);
});

dns.bind(Number(env.DNS_PORT || 5399), env.DNS_HOST || '127.0.0.1', () => {
  console.log(`DNS: authoritative for ${zone} on port ${dns.address().port}`);
  const apiPort = Number(env.API_PORT || 8099);
  api.listen(apiPort, env.API_BIND || '127.0.0.1', () => console.log(`API: http://${env.API_BIND || '127.0.0.1'}:${apiPort}/v1/health`));
});
