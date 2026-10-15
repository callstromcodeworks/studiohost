// Plays the role of the OBS plugin: starts the server with --managed and speaks
// the stdin/stdout JSON-lines protocol to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Ports vary per run so a leftover server from an interrupted run cannot collide.
const LOCAL = 30000 + (process.pid % 15000) * 2, PUB = LOCAL + 1;
let server, data, ready;
const inbox = [];
const waiters = [];

function nextMessage(pred, ms = 5000) {
  const i = inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error('timed out waiting for message')); } }, ms);
  });
}
const send = (msg) => server.stdin.write(JSON.stringify(msg) + '\n');
/** Opens the page event channel and resolves with the welcome message. */
function welcome(base, session) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws?id=${session.id}&token=${session.token}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no welcome')); }, 5000);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'welcome') { clearTimeout(timer); ws.close(); resolve(m); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
  });
}
async function post(route, body, session) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) { headers['X-Client-Id'] = session.id; headers['X-Client-Token'] = session.token; }
  const r = await fetch(`http://127.0.0.1:${LOCAL}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  data = mkdtempSync(join(tmpdir(), 'studiohost-managed-'));
  server = spawn(process.execPath, [join(ROOT, 'data/app/server/index.js'), '--managed'], {
    env: { ...process.env, STUDIOHOST_DATA: data, STUDIOHOST_LOCAL_PORT: String(LOCAL), STUDIOHOST_PUBLIC_PORT: String(PUB), STUDIOHOST_NETWORK: 'lan' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // every stdout line must be protocol JSON
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ready = await nextMessage((m) => m.type === 'ready', 10000);
});
after(() => { server.stdin.end(); setTimeout(() => server.kill(), 1000).unref(); });

test('announces readiness, then the guest address once the guest side is up', async () => {
  assert.equal(ready.localPort, LOCAL);
  assert.equal(typeof ready.slots, 'number');
  assert.equal(ready.configured, true); // STUDIOHOST_NETWORK=lan
  const net = await nextMessage((m) => m.type === 'network' && m.state === 'ready');
  assert.match(net.publicUrl, new RegExp(`^https://[0-9.]+:${PUB}$`));
});

test('OBS status from the plugin reaches the studio state', async () => {
  const host = (await post('join', { role: 'host' })).body;
  send({ type: 'obs-status', streaming: true, recording: false, studioMode: false, scene: 'Studio Host: Studio', builtin: 'studio' });
  await new Promise((r) => setTimeout(r, 200));
  const info = await post('info', {}, host);
  assert.equal(info.body.managed, true);
  const welcomeMsg = await welcome(`http://127.0.0.1:${LOCAL}`, host);
  assert.equal(welcomeMsg.state.obs.managed, true);
  assert.equal(welcomeMsg.state.obs.streaming, true);
  assert.equal(welcomeMsg.state.obs.builtin, 'studio');
});

test('scene switching round-trips through the plugin', async () => {
  const host = (await post('join', { role: 'host' })).body;
  const pending = post('obs-scene', { scene: 'guest', slot: 2 }, host);
  const req = await nextMessage((m) => m.type === 'obs' && m.action === 'setScene');
  assert.equal(req.scene, 'guest');
  assert.equal(req.slot, 2);
  send({ type: 'obs-result', id: req.id, ok: true, message: 'Switched.' });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Switched.');

  const failing = post('obs-setup', {}, host);
  const req2 = await nextMessage((m) => m.type === 'obs' && m.action === 'setupScenes');
  send({ type: 'obs-result', id: req2.id, ok: false, error: 'No scene collection loaded.' });
  const res2 = await failing;
  assert.equal(res2.status, 502);
  assert.equal(res2.body.error, 'No scene collection loaded.');
});

test('changing the slot count notifies the plugin', async () => {
  const host = (await post('join', { role: 'host' })).body;
  await post('action', { action: 'slots', count: 6 }, host);
  const msg = await nextMessage((m) => m.type === 'slots');
  assert.equal(msg.count, 6);
});

test('studio settings save without a restart; a new local port asks for one', async () => {
  const host = (await post('join', { role: 'host' })).body;
  assert.equal((await post('config-save', { maxGuests: 99 }, host)).status, 400);
  const ok = await post('config-save', { maxGuests: 6, iceServers: [{ urls: 'stun:stun.example.org:3478' }] }, host);
  assert.equal(ok.status, 200);
  let cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  assert.equal(cfg.maxGuests, 6);
  assert.equal(cfg.iceServers[0].urls, 'stun:stun.example.org:3478');
  // New joins get the new STUN/TURN list straight away.
  assert.equal((await post('join', { role: 'host' })).body.iceServers[0].urls, 'stun:stun.example.org:3478');
  assert.equal((await post('config-save', { localPort: LOCAL + 7 }, host)).status, 200);
  await nextMessage((m) => m.type === 'restart');
  cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  assert.equal(cfg.localPort, LOCAL + 7);
});

test('showing an OBS source as content tells the plugin where to draw it', async () => {
  const host = (await post('join', { role: 'host' })).body;
  send({ type: 'obs-status', streaming: false, recording: false, studioMode: false, scene: '', builtin: '', sources: [{ name: 'Game Capture' }, { name: 'Slides' }] });
  await new Promise((r) => setTimeout(r, 200));
  const unknown = await post('action', { action: 'content', kind: 'obs', source: 'Nope' }, host);
  assert.equal(unknown.status, 400);
  inbox.length = 0;
  assert.equal((await post('action', { action: 'content', kind: 'obs', source: 'Slides' }, host)).status, 200);
  const shown = await nextMessage((m) => m.type === 'content' && m.source === 'Slides');
  // Nobody on stage: content alone, centred.
  assert.ok(shown.rect.w > 0.9 && Math.abs(shown.rect.x + shown.rect.w / 2 - 0.5) < 0.001);
  // The source disappears from OBS: content goes away.
  send({ type: 'obs-status', streaming: false, recording: false, studioMode: false, scene: '', builtin: '', sources: [{ name: 'Game Capture' }] });
  await nextMessage((m) => m.type === 'content' && m.source === '' && m.rect === null);
  // ...and comes back when it reappears (the choice is remembered).
  send({ type: 'obs-status', streaming: false, recording: false, studioMode: false, scene: '', builtin: '', sources: [{ name: 'Game Capture' }, { name: 'Slides' }] });
  await nextMessage((m) => m.type === 'content' && m.source === 'Slides');
  assert.equal((await post('action', { action: 'content', kind: 'none' }, host)).status, 200);
  await nextMessage((m) => m.type === 'content' && m.source === '');
});

test('widgets reach the plugin with their links; pages never see the links', async () => {
  const host = (await post('join', { role: 'host' })).body;
  assert.equal((await post('action', { action: 'widgetSave', name: 'Alerts', url: 'javascript:alert(1)' }, host)).status, 400);
  inbox.length = 0;
  const url = 'https://streamlabs.com/alert-box/v3/SECRET-TOKEN';
  assert.equal((await post('action', { action: 'widgetSave', name: 'Alerts', url }, host)).status, 200);
  const added = await nextMessage((m) => m.type === 'widgets' && m.items.length === 1);
  assert.equal(added.items[0].url, url);
  assert.equal(added.items[0].visible, true);
  const { id } = added.items[0];
  const w = await welcome(`http://127.0.0.1:${LOCAL}`, host);
  assert.deepEqual(w.state.studio.widgets, [{ id, name: 'Alerts', visible: true }]);
  assert.ok(!JSON.stringify(w).includes('SECRET-TOKEN'));
  // Renaming without a link keeps the saved one; hiding and deleting reach the plugin too.
  assert.equal((await post('action', { action: 'widgetSave', id, name: 'Donations' }, host)).status, 200);
  const renamed = await nextMessage((m) => m.type === 'widgets' && m.items[0]?.name === 'Donations');
  assert.equal(renamed.items[0].url, url);
  assert.equal((await post('action', { action: 'widgetShow', id, on: false }, host)).status, 200);
  await nextMessage((m) => m.type === 'widgets' && m.items[0]?.visible === false);
  assert.equal((await post('action', { action: 'widgetDelete', id }, host)).status, 200);
  await nextMessage((m) => m.type === 'widgets' && m.items.length === 0);
});

test('exits when the plugin closes stdin', async () => {
  const exited = new Promise((r) => server.once('exit', r));
  server.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.equal(code, 0);
});

