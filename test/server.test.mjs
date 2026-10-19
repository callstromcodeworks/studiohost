import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createSelfSignedCert } from '../data/app/server/certs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Ports vary per run so a leftover server from an interrupted run cannot collide.
const LOCAL = 20000 + (process.pid % 4000) * 2, PUB = LOCAL + 1;
let server, config;

before(async () => {
  const data = mkdtempSync(join(tmpdir(), 'studiohost-test-'));
  server = spawn(process.execPath, [join(ROOT, 'data/app/server/index.js')], {
    env: { ...process.env, STUDIOHOST_DATA: data, STUDIOHOST_LOCAL_PORT: String(LOCAL), STUDIOHOST_PUBLIC_PORT: String(PUB), STUDIOHOST_NETWORK: 'lan' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); }));
  config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  // The guest listener starts just after the local one.
  for (let i = 0; i < 50; i++) {
    try { if ((await post('join', { role: 'guest', name: 'probe', key: config.guestKey }, { pub: true })).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(() => server.kill());

/** POST to the local (trusted) or public (untrusted, TLS) listener. */
function post(route, body, { session, pub = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) { headers['X-Client-Id'] = session.id; headers['X-Client-Token'] = session.token; }
  if (!pub) {
    return fetch(`http://127.0.0.1:${LOCAL}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: PUB, path: `/api/${route}`, method: 'POST', headers, rejectUnauthorized: false }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('remote clients need the right keys', async () => {
  assert.equal((await post('join', { role: 'host' }, { pub: true })).status, 403);
  assert.equal((await post('join', { role: 'program' }, { pub: true })).status, 403);
  assert.equal((await post('join', { role: 'guest', name: 'x', key: 'nope' }, { pub: true })).status, 403);
  assert.equal((await post('join', { role: 'guest', name: 'x', key: config.guestKey }, { pub: true })).status, 200);
  assert.equal((await post('join', { role: 'host', key: config.guestKey }, { pub: true })).status, 403, 'guest key must not unlock host');
  assert.equal((await post('join', { role: 'host', key: config.hostKey }, { pub: true })).status, 200);
});

test('localhost (OBS) can join as host without a key', async () => {
  assert.equal((await post('join', { role: 'host' })).status, 200);
});

test('guests cannot run host actions; hosts can', async () => {
  const guest = (await post('join', { role: 'guest', name: 'G', key: config.guestKey }, { pub: true })).body;
  const host = (await post('join', { role: 'host' })).body;
  assert.equal((await post('action', { action: 'layout', layout: 'solo' }, { session: guest, pub: true })).status, 403);
  assert.equal((await post('action', { action: 'layout', layout: 'solo' }, { session: host })).status, 200);
  assert.equal((await post('action', { action: 'layout', layout: 'bogus' }, { session: host })).status, 400);
  assert.equal((await post('action', { action: 'brand', brand: { color: 'red' } }, { session: host })).status, 200, 'invalid colors are ignored, not fatal');
  assert.equal((await post('action', { action: 'stage', participant: guest.id, on: true }, { session: host })).status, 200);
  assert.equal((await post('action', { action: 'stage', participant: 'nobody', on: true }, { session: host })).status, 400);
});

test('guests can only message everyone or the host', async () => {
  const a = (await post('join', { role: 'guest', name: 'A', key: config.guestKey }, { pub: true })).body;
  const b = (await post('join', { role: 'guest', name: 'B', key: config.guestKey }, { pub: true })).body;
  assert.equal((await post('chat', { text: 'hi all', to: null }, { session: a, pub: true })).status, 200);
  assert.equal((await post('chat', { text: 'psst', to: 'host' }, { session: a, pub: true })).status, 200);
  assert.equal((await post('chat', { text: 'dm', to: b.id }, { session: a, pub: true })).status, 400);
});

test('static files cannot escape the public folder', async () => {
  for (const p of ['/..%2fpackage.json', '/assets/..%2f..%2fdata%2fconfig.json', '/common/..%2f..%2fserver%2fconfig.js']) {
    const r = await fetch(`http://127.0.0.1:${LOCAL}${p}`);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
  }
});

test('self-signed certificate is valid X.509 with SANs', () => {
  const { cert } = createSelfSignedCert(['studio.example.com']);
  const x = new X509Certificate(cert);
  assert.ok(x.verify(x.publicKey));
  assert.match(x.subjectAltName, /DNS:localhost/);
  assert.match(x.subjectAltName, /DNS:studio\.example\.com/);
  assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);
});

test('a new invite link retires the old one; guests who joined can still rejoin unless removed', async () => {
  const host = (await post('join', { role: 'host' })).body;
  const before = (await post('info', {}, { session: host })).body;
  const oldKey = new URL(before.invite).searchParams.get('k');
  assert.ok(before.inviteExpiresAt > Date.now(), 'links expire by default');
  assert.equal(before.inviteExpiryHours, 1);
  const joined = (await post('join', { role: 'guest', name: 'Ticket', key: oldKey }, { pub: true })).body;
  assert.ok(joined.rejoin, 'guests get a rejoin ticket');

  assert.equal((await post('invite-new', {}, { session: host })).status, 200);
  const after = (await post('info', {}, { session: host })).body;
  const newKey = new URL(after.invite).searchParams.get('k');
  assert.notEqual(newKey, oldKey);

  const stale = await post('join', { role: 'guest', name: 'Late', key: oldKey }, { pub: true });
  assert.equal(stale.status, 403);
  assert.match(stale.body.error, /expired/);
  assert.equal((await post('join', { role: 'guest', name: 'Fresh', key: newKey }, { pub: true })).status, 200);

  const back = await post('join', { role: 'guest', name: 'Ticket', key: oldKey, ticket: joined.rejoin }, { pub: true });
  assert.equal(back.status, 200, 'the ticket gets a guest back in after the link changed');
  assert.equal((await post('action', { action: 'kick', participant: back.body.id }, { session: host })).status, 200);
  assert.equal((await post('join', { role: 'guest', name: 'Ticket', key: oldKey, ticket: joined.rejoin }, { pub: true })).status, 403, 'removed guests cannot rejoin');
  assert.equal((await post('join', { role: 'guest', name: 'Ticket', key: oldKey, ticket: back.body.rejoin }, { pub: true })).status, 403);
});

test('invite expiry is a studio setting with fixed choices', async () => {
  const host = (await post('join', { role: 'host' })).body;
  assert.equal((await post('config-save', { inviteExpiryHours: 5 }, { session: host })).status, 400);
  assert.equal((await post('config-save', { inviteExpiryHours: 0 }, { session: host })).status, 200);
  assert.equal((await post('config-get', {}, { session: host })).body.inviteExpiryHours, 0);
  assert.equal((await post('info', {}, { session: host })).body.inviteExpiresAt, null);
  assert.equal((await post('config-save', { inviteExpiryHours: 24 }, { session: host })).status, 200);
  const info = (await post('info', {}, { session: host })).body;
  assert.ok(Math.abs(info.inviteExpiresAt - (Date.now() + 24 * 3600_000)) < 5000);
});

test('malformed JSON is refused with 400', async () => {
  const r = await fetch(`http://127.0.0.1:${LOCAL}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(r.status, 400);
});
