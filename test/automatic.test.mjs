// End-to-end test of the network setup modes, with stand-ins for the outside world:
//   hostname service (test/fake-hostname-service.mjs)  ->  hostnames, dns-01 records, reachability probe
//   Pebble (Let's Encrypt's test CA, PEBBLE_BIN)  ->  certificates, validated via that DNS
//   fake router (UPnP + NAT-PMP)  ->  port mapping
//   Studio Host server  ->  configured through the same API the setup wizard uses
// Skipped unless PEBBLE_BIN points at a pebble binary (PEBBLE_DIR = its source checkout).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { X509Certificate } from 'node:crypto';
import { startFakeRouter } from './fake-router.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PEBBLE = process.env.PEBBLE_BIN;
const PEBBLE_DIR = process.env.PEBBLE_DIR || (PEBBLE ? dirname(dirname(PEBBLE)) : '');
const ZONE = 'live.studiohost.test';
const skip = !PEBBLE && 'set PEBBLE_BIN (and PEBBLE_DIR) to run';

const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const tmp = mkdtempSync(join(tmpdir(), 'studiohost-auto-'));
let router, dnsPort, apiPort, pebblePort, pebbleMgmt, pebbleHttpPort, pebbleRoot, resolver;

function spawnLogged(cmd, args, env, label) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  p.label = label;
  procs.push(p);
  return p;
}
async function waitForLog(p, text, ms = 15000) {
  const t = Date.now();
  while (!p.log.includes(text)) { if (Date.now() - t > ms) throw new Error(`${p.label} did not log "${text}":\n${p.log.slice(-2000)}`); await sleep(50); }
}

before(async () => {
  if (skip) return;
  router = await startFakeRouter({ externalIp: '127.0.0.1' }); // "public" address = this machine, so probes work
  [dnsPort, apiPort, pebblePort, pebbleMgmt] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  pebbleHttpPort = await freePort();
  pebbleRoot = join(tmp, 'pebble-root.pem');

  const svc = spawnLogged(process.execPath, [join(ROOT, 'test/fake-hostname-service.mjs')], {
    ZONE, DNS_PORT: String(dnsPort), DNS_HOST: '127.0.0.1', API_PORT: String(apiPort), API_BIND: '127.0.0.1',
    PROBE_CA_FILE: pebbleRoot,
  }, 'dns-service');
  await waitForLog(svc, 'API:');
  resolver = new Resolver(); resolver.setServers([`127.0.0.1:${dnsPort}`]);

  const cfg = JSON.parse(readFileSync(join(PEBBLE_DIR, 'test/config/pebble-config.json'), 'utf8'));
  Object.assign(cfg.pebble, {
    listenAddress: `127.0.0.1:${pebblePort}`, managementListenAddress: `127.0.0.1:${pebbleMgmt}`,
    certificate: join(PEBBLE_DIR, 'test/certs/localhost/cert.pem'), privateKey: join(PEBBLE_DIR, 'test/certs/localhost/key.pem'),
    httpPort: pebbleHttpPort,
  });
  writeFileSync(join(tmp, 'pebble.json'), JSON.stringify(cfg));
  const pebble = spawnLogged(PEBBLE, ['-config', join(tmp, 'pebble.json'), '-dnsserver', `127.0.0.1:${dnsPort}`], { PEBBLE_VA_NOSLEEP: '1' }, 'pebble');
  await waitForLog(pebble, 'Listening on');
  // The root that Pebble signs with (random per run): trust it for probes and clients.
  const root = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: pebbleMgmt, path: '/roots/0', ca: readFileSync(join(PEBBLE_DIR, 'test/certs/pebble.minica.pem')) }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  writeFileSync(pebbleRoot, root);
});
after(() => { for (const p of procs) p.kill(); router?.close(); });

/** Starts a Studio Host server (managed by a fake plugin over stdio) and returns helpers. */
async function startStudio(dataDir) {
  const localPort = await freePort();
  const p = spawnLogged(process.execPath, [join(ROOT, 'data/app/server/index.js'), '--managed'], {
    STUDIOHOST_DATA: dataDir, STUDIOHOST_LOCAL_PORT: String(localPort),
    STUDIOHOST_DNS_SERVICE: `http://127.0.0.1:${apiPort}`,
    STUDIOHOST_ACME_DIRECTORY: `https://127.0.0.1:${pebblePort}/dir`, STUDIOHOST_ACME_CA: join(PEBBLE_DIR, 'test/certs/pebble.minica.pem'),
    STUDIOHOST_UPNP_LOCATION: router.location, STUDIOHOST_PROPAGATION_MS: '0',
  }, 'studio');
  const messages = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { messages.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
  const waitMsg = async (pred, ms = 60000) => { const t = Date.now(); for (;;) { const m = messages.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`no matching message; studio log:\n${p.log.slice(-3000)}`); await sleep(100); } };
  const ready = await waitMsg((m) => m.type === 'ready');
  const call = async (route, body = {}, session) => {
    const r = await fetch(`http://127.0.0.1:${localPort}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Client-Id': session.id, 'X-Client-Token': session.token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const host = (await call('join', { role: 'host' })).body;
  // Keep the producer session alive.
  const ws = new WebSocket(`ws://127.0.0.1:${localPort}/api/ws?id=${host.id}&token=${host.token}`);
  ws.onerror = () => {};
  const status = async () => (await call('network-status', {}, host)).body;
  const waitStatus = async (pred, ms = 90000) => {
    const t = Date.now();
    for (;;) { const s = await status(); if (pred(s)) return s; if (Date.now() - t > ms) throw new Error(`setup did not finish: ${JSON.stringify(s.steps, null, 1)}\n${p.log.slice(-3000)}`); await sleep(300); }
  };
  return { p, ready, call, host, status, waitStatus, messages, waitMsg, stop: async () => { ws.close(); p.stdin.end(); await new Promise((r) => p.once('exit', r)); } };
}

/** HTTPS GET to the studio by name, resolving it through the test DNS and trusting Pebble's root. */
function getByName(fqdn, port, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: fqdn, port, path, ca: readFileSync(pebbleRoot), servername: fqdn,
      lookup: (hostname, opts, cb) => resolver.resolve4(hostname).then((a) => (opts?.all ? cb(null, [{ address: a[0], family: 4 }]) : cb(null, a[0], 4)), cb),
    }, (res) => { const cert = res.socket.getPeerCertificate(); let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, cert })); });
    req.on('error', reject);
  });
}

const studioData = mkdtempSync(join(tmpdir(), 'studiohost-auto-data-'));
let first;

test('a fresh install asks for setup', { skip }, async () => {
  const s = await startStudio(studioData);
  try {
    assert.equal(s.ready.configured, false);
    const st = await s.status();
    assert.equal(st.configured, false);
    assert.equal(st.state, 'unconfigured');
    assert.equal((await s.call('network-apply', { mode: 'nonsense' }, s.host)).status, 400);
  } finally { await s.stop(); }
});

test('Automatic: random 5-digit port via UPnP, random hostname, Let\'s Encrypt certificate, reachable', { skip }, async () => {
  const s = await startStudio(studioData);
  try {
    assert.equal((await s.call('network-apply', { mode: 'auto' }, s.host)).status, 200);
    const st = await s.waitStatus((x) => x.state === 'ready' || x.state === 'problem');
    assert.equal(st.state, 'ready', JSON.stringify(st.steps, null, 1));
    assert.ok(st.port >= 10000 && st.port <= 65535, `5-digit port (${st.port})`);
    assert.match(st.host, new RegExp(`^[a-z]+-[a-z]+-\\d{4}\\.${ZONE.replace(/\./g, '\\.')}$`));
    assert.equal(st.publicUrl, `https://${st.host}:${st.port}`);
    assert.equal(st.certificate.kind, 'letsencrypt');
    assert.equal(router.mappings.get(`TCP:${st.port}`)?.internalPort, st.port, 'router forwards the port');
    assert.deepEqual(await resolver.resolve4(st.host), ['127.0.0.1'], 'hostname points at the router\'s public address');
    assert.equal(st.reach.reachable, true);
    assert.equal(st.reach.studioHost, true);
    assert.equal(st.reach.certificateValid, true, 'the hostname service trusts the certificate');
    assert.ok(st.nameExpiresAt > Date.now() + 80 * 86400e3);
    // A guest connecting by name gets a valid certificate for that name.
    const r = await getByName(st.host, st.port, '/api/ping');
    assert.equal(r.status, 200);
    assert.match(r.cert.subjectaltname, new RegExp(st.host.replace(/\./g, '\\.')));
    const plugin = await s.waitMsg((m) => m.type === 'network' && m.state === 'ready');
    assert.equal(plugin.publicUrl, st.publicUrl);
    first = st;
  } finally { await s.stop(); }
  // Stopping removes the router mapping.
  assert.equal(router.mappings.has(`TCP:${first.port}`), false, 'mapping removed on exit');
});

test('Automatic: after a restart the same name, port and certificate are reused', { skip }, async (t) => {
  if (!first) return t.skip('needs the previous test');
  const s = await startStudio(studioData);
  try {
    assert.equal(s.ready.configured, true);
    const st = await s.waitStatus((x) => x.state === 'ready' || x.state === 'problem');
    assert.equal(st.state, 'ready', JSON.stringify(st.steps, null, 1));
    assert.equal(st.host, first.host, 'same hostname (cached until it expires)');
    assert.equal(st.port, first.port, 'same port');
    assert.equal(st.certificate.validTo, first.certificate.validTo, 'same certificate (no new order)');
    assert.ok(router.mappings.has(`TCP:${st.port}`));
  } finally { await s.stop(); }
});

test('Manual: own domain with a Let\'s Encrypt certificate over http-01', { skip }, async () => {
  // Stand-in for "your own domain": a name in the test zone pointing here.
  const reg = await (await fetch(`http://127.0.0.1:${apiPort}/v1/names`, { method: 'POST' })).json();
  const s = await startStudio(mkdtempSync(join(tmpdir(), 'studiohost-manual-')));
  try {
    const port = await freePort();
    const bad = await s.call('network-apply', { mode: 'manual', manual: { address: 'domain', host: 'not a domain', port, certificate: 'letsencrypt' } }, s.host);
    assert.equal(bad.status, 400);
    const r = await s.call('network-apply', { mode: 'manual', manual: { address: 'domain', host: reg.fqdn, port, certificate: 'letsencrypt', httpChallengePort: pebbleHttpPort } }, s.host);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await s.waitStatus((x) => x.state === 'ready' || x.state === 'problem');
    assert.equal(st.state, 'ready', JSON.stringify(st.steps, null, 1));
    assert.equal(st.publicUrl, `https://${reg.fqdn}:${port}`);
    assert.equal(st.certificate.kind, 'letsencrypt');
    const got = await getByName(reg.fqdn, port, '/api/ping');
    assert.equal(got.status, 200);
  } finally { await s.stop(); }
});

test('Manual: LAN only with a self-signed certificate', { skip }, async () => {
  const s = await startStudio(mkdtempSync(join(tmpdir(), 'studiohost-lan-')));
  try {
    const port = await freePort();
    assert.equal((await s.call('network-apply', { mode: 'manual', manual: { address: 'lan', port, certificate: 'self-signed' } }, s.host)).status, 200);
    const st = await s.waitStatus((x) => x.state !== 'working' && x.state !== 'unconfigured');
    assert.equal(st.state, 'ready');
    assert.match(st.publicUrl, new RegExp(`^https://\\d+\\.\\d+\\.\\d+\\.\\d+:${port}$`));
    assert.equal(st.certificate.kind, 'self-signed');
    assert.equal(st.steps.find((x) => x.id === 'certificate').state, 'warn');
  } finally { await s.stop(); }
});
