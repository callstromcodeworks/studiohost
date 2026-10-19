// Browser test of the OBS output feed: plays the role of the plugin (starts the server with
// --managed), waits for the server to ask for the feed once a guest joins, then sends a
// solid-color picture and a tone the way the plugin does, and checks the guest sees and
// hears them. Also checks the guest's own audio comes back for their OBS mixer strip.
// Requires Playwright with Chromium (see test/e2e.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = 18830, PUB = 18831;

const data = mkdtempSync(join(tmpdir(), 'studiohost-feed-'));
const server = spawn(process.execPath, [join(ROOT, 'data/app/server/index.js'), '--managed'], {
  env: { ...process.env, STUDIOHOST_DATA: data, STUDIOHOST_LOCAL_PORT: String(LOCAL), STUDIOHOST_PUBLIC_PORT: String(PUB), STUDIOHOST_NETWORK: 'lan' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write('[server] ' + d); });
const messages = [];
/** Guest audio packets for the mixer strips: {id, rate, peak}. */
const strips = [];
let out = Buffer.alloc(0);
server.stdout.on('data', (chunk) => {
  out = Buffer.concat([out, chunk]);
  for (;;) {
    if (out[0] === 0x01) { // binary packet: 0x01, kind, uint32le length, payload
      if (out.length < 6 || out.length < 6 + out.readUInt32LE(2)) break;
      const p = out.subarray(6, 6 + out.readUInt32LE(2));
      if (out[1] === 0x47) {
        let peak = 0;
        for (let i = 40; i + 1 < p.length; i += 2) peak = Math.max(peak, Math.abs(p.readInt16LE(i)) / 32768);
        strips.push({ id: p.toString('ascii', 0, 36), rate: p.readUInt32LE(36), peak });
      }
      out = out.subarray(6 + p.length);
    } else {
      const nl = out.indexOf(0x0a);
      if (nl < 0) break;
      try { messages.push(JSON.parse(out.toString('utf8', 0, nl))); } catch { /* ignore */ }
      out = out.subarray(nl + 1);
    }
  }
});

const fails = [];
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); }
  return false;
}
function packet(kind, payload) {
  const head = Buffer.alloc(6);
  head[0] = 0x01; head[1] = kind.charCodeAt(0); head.writeUInt32LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}
// Solid magenta (BT.709 limited range: Y 63, U 193, V 205) at 960x540.
const W = 960, H = 540;
const frame = Buffer.alloc(4 + W * H * 1.5);
frame.writeUInt16LE(W, 0); frame.writeUInt16LE(H, 2);
frame.fill(63, 4, 4 + W * H); frame.fill(193, 4 + W * H, 4 + W * H * 1.25); frame.fill(205, 4 + W * H * 1.25);
let phase = 0;
function tone(frames) {
  const p = Buffer.alloc(4 + frames * 8);
  p.writeUInt32LE(48000, 0);
  for (let i = 0; i < frames; i++, phase++) {
    const v = 0.5 * Math.sin((2 * Math.PI * 440 * phase) / 48000);
    p.writeFloatLE(v, 4 + i * 8); p.writeFloatLE(v, 8 + i * 8);
  }
  return p;
}

let pump = null;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
});
try {
  check(await waitFor(() => messages.some((m) => m.type === 'ready')), 'server is ready');
  const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const program = await ctx.newPage();
  program.on('pageerror', (e) => fails.push(`program: ${e.message}`));
  await program.goto(`http://127.0.0.1:${LOCAL}/output/program.html`);
  check(await waitFor(() => program.evaluate(() => !!window.studioHost?.client.state)), 'program page connected');
  check(!messages.some((m) => m.type === 'feed' && m.on), 'feed not requested without guests');

  const guest = await ctx.newPage();
  guest.on('pageerror', (e) => fails.push(`guest: ${e.message}`));
  await guest.goto(`https://localhost:${PUB}/guest/?k=${config.guestKey}`);
  await guest.fill('#name', 'Ada');
  await guest.waitForFunction(() => document.querySelector('#lobby-video')?.srcObject?.getTracks().length >= 2);
  await guest.click('#join');
  check(await waitFor(() => messages.some((m) => m.type === 'feed' && m.on === true)), 'server asks for the feed once a guest joins');
  const guestId = await guest.evaluate(() => window.studioHost.client.id);
  check(await waitFor(() => messages.some((m) => m.type === 'guests' && m.items.some((g) => g.id === guestId && g.name === 'Ada'))), 'plugin is told about the guest for a mixer strip');
  check(await waitFor(() => strips.some((x) => x.id === guestId && x.rate >= 8000 && x.peak > 0.01)), `guest's own audio reaches the plugin for the mixer strip (${strips.length} packets)`);

  // Send like the plugin: 30 fps video, audio in 1024-frame packets.
  let ticks = 0;
  pump = setInterval(() => {
    server.stdin.write(packet('A', tone(1024)));
    if (ticks++ % 2 === 0) server.stdin.write(packet('V', frame));
  }, (1024 / 48000) * 1000);

  check(await waitFor(() => guest.evaluate(() => { const v = document.querySelector('#program'); return v.srcObject && v.videoWidth > 0; })), 'guest receives the program feed');
  const magenta = () => guest.evaluate(() => {
    const v = document.querySelector('#program');
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
    const [r, gr, b] = g.getImageData(32, 18, 1, 1).data;
    return r > 180 && gr < 80 && b > 180;
  });
  check(await waitFor(magenta), 'guest sees the OBS picture');
  const level = () => guest.evaluate(async () => {
    const v = document.querySelector('#program');
    const ac = new AudioContext(); await ac.resume();
    const an = ac.createAnalyser(); an.fftSize = 2048;
    ac.createMediaStreamSource(v.srcObject).connect(an);
    let peak = 0; const buf = new Float32Array(an.fftSize);
    for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
    ac.close(); return peak;
  });
  let peak = 0;
  check(await waitFor(async () => (peak = await level()) > 0.2, 12000), `guest hears the OBS audio (peak ${peak.toFixed(2)})`);

  clearInterval(pump); pump = null;
  await guest.click('#leave');
  check(await waitFor(() => messages.some((m) => m.type === 'feed' && m.on === false)), 'feed stops when the last guest leaves');
} finally {
  if (pump) clearInterval(pump);
  await browser.close();
  server.stdin.end();
}
if (fails.length) { console.log(`\n${fails.length} failed:\n  ${fails.join('\n  ')}`); process.exit(1); }
console.log('\nAll checks passed');
