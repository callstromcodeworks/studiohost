// Smoke test against a real OBS running the Studio Host plugin (used in CI on Ubuntu under Xvfb).
// Expects: OBS running with the plugin installed and obs-websocket on ws://127.0.0.1:4455 without auth.
//   STUDIOHOST_CONFIG_DIR  the plugin's config folder (holds config.json)
//   PLAYWRIGHT_MODULE      optional path to playwright; enables the guest/WebRTC checks
// Writes a plain-text report to stdout and exits non-zero if any check fails.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ObsClient } from '../data/app/server/obs.js';
import { computeLayout, REF_W, REF_H } from '../data/app/public/common/render.js';

const require = createRequire(import.meta.url);
const LOCAL = 'http://127.0.0.1:8730';
const results = [];
const check = (ok, msg) => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(1000); }
  return null;
}
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
  const r = await fetch(`${LOCAL}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
/** Joins as a producer and returns the first state snapshot. */
async function snapshot() {
  const host = (await post('join', { role: 'host' })).body;
  const msg = await welcome(LOCAL, host);
  await post('leave', {}, host);
  return msg.state;
}

let browser = null;

// ---------------------------------------------------------------------------------------------
// Multiple guests on simulated uplinks of different quality, hiding guests, and content layouts,
// all checked in OBS's own rendered output.

/** Guests and the uplink each one simulates (caps in kbps; null = uncapped). */
const GUESTS = [
  { name: 'HD Guest', video: null, audio: null },
  { name: 'Mid Guest', video: 800, audio: 32 },
  { name: 'Low Guest', video: 250, audio: 16 },
  { name: 'Weak Guest', video: 100, audio: 8 },
];
const BG = [0x14, 0x16, 0x1a]; // default studio background
const MAGENTA = [255, 0, 255]; // the OBS color source used as content

/**
 * First run: the plugin reports that setup is needed; then Automatic setup is applied through
 * the wizard's API and must complete (port via the simulated router, a generated hostname from
 * the DNS service, a certificate from Pebble, and an outside-in reachability check).
 * @returns {Promise<string|null>} the guest invite link
 */
async function automaticSetup(host, configDir) {
  const before = (await post('network-status', {}, host)).body;
  check(before.configured === false, 'fresh install: guests can’t join until setup runs');
  if (configDir) {
    const logs = join(dirname(dirname(configDir)), 'logs');
    const latest = readdirSync(logs).sort().pop();
    check(/server ready on port \d+ \(setup needed\)/.test(readFileSync(join(logs, latest), 'utf8')), 'plugin knows setup is needed');
  }
  const applied = await post('network-apply', { mode: 'auto' }, host);
  if (!check(applied.status === 200, `Automatic setup accepted (${applied.status} ${applied.body.error || ''})`)) return null;
  const st = await waitFor(async () => {
    const s = (await post('network-status', {}, host)).body;
    return s.state === 'ready' || s.state === 'problem' ? s : null;
  }, 180_000);
  if (!check(st?.state === 'ready', `Automatic setup completes (${st ? st.steps.map((x) => `${x.id}:${x.state}${x.state !== 'ok' ? ` ${x.detail}` : ''}`).join('; ') : 'timed out'})`)) return null;
  check(st.port >= 10000 && st.port <= 65535, `random 5-digit guest port (${st.port})`);
  check(new RegExp(`^[a-z]+-[a-z]+-\\d{4}\\.${(process.env.SMOKE_ZONE || '').replace(/\./g, '\\.')}$`).test(st.host), `generated hostname (${st.host})`);
  check(st.certificate?.kind === 'letsencrypt', 'certificate from the ACME server (Pebble standing in for Let’s Encrypt)');
  check(st.reach?.reachable && st.reach?.studioHost && st.reach?.certificateValid, 'reachable from outside with a trusted certificate');
  const info = (await post('info', {}, host)).body;
  check(info.invite.startsWith(`${st.publicUrl}/guest/?k=`), `invite link uses the generated address (${info.invite})`);
  return info.invite;
}

async function guestScenarios(obs, host, invite, pw) {
  const { chromium } = require(pw);
  const fqdn = new URL(invite).hostname;
  browser = await chromium.launch({
    // The generated hostname only exists in the test DNS; point it at this machine.
    args: [`--host-resolver-rules=MAP ${fqdn} 127.0.0.1`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'],
  });
  const act = async (action, args = {}) => {
    const r = await post('action', { action, ...args }, host);
    if (r.status !== 200) console.log(`INFO  action ${action} -> ${r.status} ${r.body.error}`);
    return r.status === 200;
  };
  const idOf = async (name) => (await snapshot()).participants.find((p) => p.name === name)?.id;

  // Each guest in its own browser context, like separate devices.
  const pages = {};
  for (const g of GUESTS) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const caps = (g.video ? `&maxv=${g.video}` : '') + (g.audio ? `&maxa=${g.audio}` : '');
    await page.goto(`${invite}${caps}`);
    await page.fill('#name', g.name);
    await page.waitForFunction(() => document.querySelector('#lobby-video')?.srcObject?.getTracks().length >= 2, null, { timeout: 30_000 });
    await page.click('#join');
    pages[g.name] = page;
  }
  const sampler = Object.values(pages)[0];
  for (const g of GUESTS) {
    const ok = await waitFor(() => pages[g.name].evaluate(() => { const v = document.querySelector('#program'); return !!v.srcObject && v.videoWidth > 0; }), 60_000);
    check(!!ok, `${g.name} receives the program feed from the studio hub inside OBS`);
  }

  // Everyone on stage, guests-only layout, Studio scene live.
  for (const g of GUESTS) await act('stage', { participant: await idOf(g.name), on: true });
  await act('layout', { layout: 'grid' });
  await act('layout', { layout: 'sides' });
  await act('content', { kind: 'none' });
  await post('obs-scene', { scene: 'studio' }, host);

  // ---- bitrates -------------------------------------------------------------------------
  // Give bandwidth estimation time to ramp up, then keep the best of a few samples per guest.
  await sleep(20_000);
  const best = {};
  for (let i = 0; i < 5; i++) {
    const st = await snapshot();
    for (const g of GUESTS) {
      const c = st.connections?.[st.participants.find((p) => p.name === g.name)?.id];
      if (!c) continue;
      const b = best[g.name] || (best[g.name] = { video: 0, audio: 0, fps: 0, height: 0, frames: 0, audible: false, rtt: c.rtt });
      b.video = Math.max(b.video, c.videoKbps || 0);
      b.audio = Math.max(b.audio, c.audioKbps || 0);
      b.fps = Math.max(b.fps, c.fps || 0);
      b.height = Math.max(b.height, c.height || 0);
      b.frames = Math.max(b.frames, c.framesIn || 0);
      b.audible = b.audible || c.audioActive === true;
    }
    await sleep(3000);
  }
  console.log('INFO  guest        cap video/audio   received video/audio   resolution  fps');
  for (const g of GUESTS) {
    const b = best[g.name] || {};
    console.log(`INFO  ${g.name.padEnd(11)}  ${String(g.video ?? '—').padStart(5)} / ${String(g.audio ?? '—').padEnd(5)}   ${String(b.video).padStart(6)} / ${String(b.audio).padEnd(6)} kbps   ${String(b.height).padStart(4)}p     ${b.fps}`);
  }
  for (const g of GUESTS) {
    const b = best[g.name];
    if (!check(!!b && b.frames > 0, `${g.name}: video frames reach the studio`)) continue;
    if (g.video) {
      check(b.video <= g.video * 1.25 + 15, `${g.name}: video stays within its ${g.video} kbps cap (${b.video})`);
      check(b.video >= Math.min(g.video * 0.4, 60), `${g.name}: video uses its bandwidth (${b.video} of ${g.video} kbps)`);
    } else {
      check(b.video >= 300, `${g.name}: uncapped video ramps up (${b.video} kbps)`);
    }
    if (g.audio) check(b.audio <= g.audio * 1.5 + 4, `${g.name}: audio stays within its ${g.audio} kbps cap (${b.audio})`);
    check(b.audio > 2 && b.audible, `${g.name}: audio arrives and is audible in the studio (${b.audio} kbps)`);
    check(b.fps >= 5, `${g.name}: video keeps moving (${b.fps} fps)`);
  }
  const hd = best['HD Guest'], weak = best['Weak Guest'];
  if (hd && weak) check(hd.height > weak.height, `the weakest uplink gets a lower resolution (${weak.height}p vs ${hd.height}p)`);

  // Program audio reaches OBS's mixer (the Studio Host Audio source).
  const peak = await programAudioPeak();
  check(peak > 0.001, `program audio reaches the OBS mixer via Studio Host Audio (peak ${peak.toFixed(3)})`);

  // OBS's own audio reaches guests: a looping tone in the live scene, heard on a guest's
  // program feed (compared with the tone muted, since guests also hear each other).
  const tone = join(tmpdir(), 'studiohost-smoke-tone.wav');
  writeFileSync(tone, toneWav(TONE_HZ, 2));
  await obs.call('CreateInput', { sceneName: 'Studio Host: Studio', inputName: 'Smoke Tone', inputKind: 'ffmpeg_source',
    inputSettings: { is_local_file: true, local_file: tone, looping: true } });
  await sleep(3000);
  const onDb = await toneLevel(sampler);
  await obs.call('SetInputMute', { inputName: 'Smoke Tone', inputMuted: true });
  await sleep(2000);
  const offDb = await toneLevel(sampler);
  await obs.call('RemoveInput', { inputName: 'Smoke Tone' });
  check(onDb - offDb > 10, `OBS audio reaches guests (${TONE_HZ} Hz tone ${onDb.toFixed(0)} dB, muted ${offDb.toFixed(0)} dB)`);

  // ---- layouts, checked in OBS's rendered frame ------------------------------------------
  await sleep(2000);
  await checkFrame(obs, sampler, 'four guests fill the frame (no content)');

  await act('hide', { participant: await idOf('Mid Guest'), on: true });
  await act('hide', { participant: await idOf('Low Guest'), on: true });
  await sleep(2500);
  await checkFrame(obs, sampler, 'two guests hidden: the two shown guests are re-laid out', { expectCams: 2 });
  const slotOfMid = (await snapshot()).participants.find((p) => p.name === 'Mid Guest').slot;
  const midSlot = await waitFor(async () => (await coverage(obs, sampler, `Studio Host: Guest ${slotOfMid}`)) < 0.02 ? true : null, 15_000);
  check(!!midSlot, `hidden guest's own scene ("Studio Host: Guest ${slotOfMid}") goes blank`);
  await act('hide', { participant: await idOf('Mid Guest'), on: false });
  await act('hide', { participant: await idOf('Low Guest'), on: false });

  // OBS source as content: a magenta color source (in a scene of its own, off air).
  if (!(await obs.call('GetSceneList')).scenes.some((x) => x.sceneName === 'Smoke Sources')) await obs.call('CreateScene', { sceneName: 'Smoke Sources' });
  await obs.call('CreateInput', { sceneName: 'Smoke Sources', inputName: 'Smoke Content', inputKind: 'color_source_v3',
    inputSettings: { color: 0xffff00ff, width: 1920, height: 1080 } });
  const listed = await waitFor(async () => ((await snapshot()).obs?.sources || []).includes('Smoke Content'), 10_000);
  check(!!listed, 'new OBS source appears in the dock\'s content list');
  check(await act('content', { kind: 'obs', source: 'Smoke Content' }), 'OBS source chosen as content');
  for (const layout of ['sides', 'right', 'pip', 'full']) {
    await act('layout', { layout });
    await sleep(2500);
    await checkFrame(obs, sampler, `OBS source as content, "${layout}" layout`);
  }
  // Hiding still works with content showing: guests regroup around it.
  await act('layout', { layout: 'sides' });
  await act('hide', { participant: await idOf('Weak Guest'), on: true });
  await sleep(2500);
  await checkFrame(obs, sampler, 'content with one guest hidden: three guests placed around it', { expectCams: 3 });
  await act('hide', { participant: await idOf('Weak Guest'), on: false });

  // Content off: guests fill the centre again, the content's area is studio again.
  await act('content', { kind: 'none' });
  await sleep(2500);
  await checkFrame(obs, sampler, 'content removed: guests fill the centre again', { noMagenta: true });

  // A guest's screen share as content.
  const shared = await pages['HD Guest'].evaluate(async () => {
    document.querySelector('#share').click();
    await new Promise((r) => setTimeout(r, 2500));
    return !!window.studioHost.client.state.participants.find((p) => p.id === window.studioHost.client.id)?.screen;
  });
  if (shared) {
    check(await act('content', { kind: 'screen', participant: await idOf('HD Guest') }), 'guest screen share chosen as content');
    const geometry = await waitFor(async () => {
      const t = computeLayout(await snapshot());
      const scr = t.find((x) => x.kind === 'screen');
      const cams = t.filter((x) => x.kind === 'camera');
      return scr && cams.length === 4 && cams.filter((c) => c.rect.x + c.rect.w <= scr.rect.x).length === 1
        && cams.filter((c) => c.rect.x >= scr.rect.x + scr.rect.w).length === 3 ? true : null;
    }, 10_000);
    check(!!geometry, 'with a screen share, slot 1 sits left of it and the other three guests right');
    await sleep(2500);
    await checkFrame(obs, sampler, 'screen share as content, "sides" layout', { screenAsVideo: true });
    const screenScene = await waitFor(async () => { const v = await coverage(obs, sampler, 'Studio Host: Guest Screen Share'); return v > 0.05 ? v : null; }, 20_000);
    check(!!screenScene, `"Studio Host: Guest Screen Share" scene shows the shared screen (${screenScene ? Math.round(screenScene * 100) : 0}% of frame)`);
    if (!screenScene) {
      const st = await snapshot();
      console.log(`INFO  screenTarget ${st.screenTarget}; sharing: ${st.participants.filter((p) => p.screen).map((p) => p.name).join(', ') || 'nobody'}`);
      // The job log isn't always readable, so put the screen output's own story in the report.
      const source = await coverage(obs, sampler, 'Studio Host Guest Screen Share').catch((e) => `error: ${e.message}`);
      console.log(`INFO  "Studio Host Guest Screen Share" source alone: ${typeof source === 'number' ? `${Math.round(source * 100)}% of frame` : source}`);
      const scene = await obs.call('GetSceneItemList', { sceneName: 'Studio Host: Guest Screen Share' }).catch(() => null);
      console.log(`INFO  screen scene items: ${scene ? scene.sceneItems.map((i) => `${i.sourceName}${i.sceneItemEnabled ? '' : ' (hidden)'}`).join(', ') : 'unavailable'}`);
      for (const line of obsLogLines(/page feature|link feature|\[studiohost\].*(screen|feature)/i).slice(-15)) console.log(`INFO  ${line}`);
    }
  } else {
    console.log('INFO  screen sharing unavailable in this browser; skipped the screen-share content checks');
  }
}

const TONE_HZ = 2500;

/** A mono 16-bit 48 kHz WAV file of a sine tone. @param {number} hz @param {number} seconds */
function toneWav(hz, seconds) {
  const rate = 48000, n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return buf;
}

/** Loudest level (dB) near TONE_HZ in a guest's program feed over a few seconds. */
function toneLevel(page) {
  return page.evaluate(async (hz) => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#program'));
    const ac = new AudioContext(); await ac.resume();
    const an = ac.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
    ac.createMediaStreamSource(/** @type {MediaStream} */ (v.srcObject)).connect(an);
    const bins = new Float32Array(an.frequencyBinCount);
    const at = Math.round(hz / (ac.sampleRate / an.fftSize));
    let best = -200;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatFrequencyData(bins);
      for (let k = at - 2; k <= at + 2; k++) best = Math.max(best, bins[k]);
    }
    ac.close();
    return best;
  }, TONE_HZ);
}

/** Peak level of the Studio Host Audio source over a few seconds, from OBS's own meters. */
async function programAudioPeak() {
  const meter = new ObsClient('ws://127.0.0.1:4455', '', 1 << 16); // InputVolumeMeters (high-volume)
  await meter.connect(5000);
  let peak = 0;
  meter.onEvent = (type, data) => {
    if (type !== 'InputVolumeMeters') return;
    const input = data.inputs.find((i) => i.inputName === 'Studio Host Audio');
    for (const ch of input?.inputLevelsMul || []) peak = Math.max(peak, ch[1] || 0);
  };
  await sleep(5000);
  meter.close();
  return peak;
}

/** Fraction of an OBS source's rendered frame that is neither background nor black. */
/** Lines of the current OBS log matching `re` (the log is next to the plugin's config folder). */
function obsLogLines(re) {
  try {
    const dir = join(dirname(dirname(process.env.STUDIOHOST_CONFIG_DIR || '')), 'logs');
    const latest = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().pop();
    return latest ? readFileSync(join(dir, latest), 'utf8').split('\n').filter((l) => re.test(l)).map((l) => l.slice(0, 300)) : [];
  } catch (err) {
    return [`(OBS log unavailable: ${err.message})`];
  }
}

async function coverage(obs, page, sourceName) {
  const shot = await obs.call('GetSourceScreenshot', { sourceName, imageFormat: 'png', imageWidth: 320, imageHeight: 180 });
  return page.evaluate(async (data) => {
    const img = new Image(); img.src = data; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90 && d[i + 3] > 0) n++;
    return n / (d.length / 4);
  }, shot.imageData);
}

const near = (px, rgb, tol = 60) => Math.abs(px[0] - rgb[0]) + Math.abs(px[1] - rgb[1]) + Math.abs(px[2] - rgb[2]) <= tol;
const isVideo = (px) => !near(px, BG, 40) && !near(px, MAGENTA, 120) && px[0] + px[1] + px[2] > 90;

/**
 * Renders "Studio Host: Studio" through OBS and checks it against the layout the studio state
 * implies: every shown guest's tile has video, content (if any) shows the magenta OBS source,
 * and the space between tiles is background.
 */
async function checkFrame(obs, page, label, opts = {}) {
  const state = await snapshot();
  const tiles = computeLayout(state);
  const cams = tiles.filter((t) => t.kind === 'camera');
  const content = tiles.find((t) => t.kind === 'content' || t.kind === 'screen');
  if (opts.expectCams !== undefined && cams.length !== opts.expectCams) {
    check(false, `${label}: expected ${opts.expectCams} guest tiles, layout has ${cams.length}`);
    return;
  }
  const W = 960, H = 540;
  const points = [];
  // Sample a little above centre (the name tag sits at the bottom of a tile).
  for (const t of cams) points.push({ what: 'guest', x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h * 0.4 });
  if (content) {
    // The centre plus one point near a corner, skipping points a guest tile sits on (in "pip" the
    // guests are drawn on top of the content).
    const onCam = ([x, y]) => cams.some((t) => x >= t.rect.x && x <= t.rect.x + t.rect.w && y >= t.rect.y && y <= t.rect.y + t.rect.h);
    const probes = [[0.5, 0.5], [0.1, 0.15], [0.1, 0.85]].map(([fx, fy]) => [content.rect.x + content.rect.w * fx, content.rect.y + content.rect.h * fy]).filter((pt) => !onCam(pt));
    for (const [x, y] of probes.slice(0, 2)) points.push({ what: content.kind === 'content' ? 'content' : 'screen', x, y });
  }
  // Background probes: frame corners inside the margin, and gaps not covered by any tile.
  const covered = (x, y) => tiles.some((t) => x >= t.rect.x - 6 && x <= t.rect.x + t.rect.w + 6 && y >= t.rect.y - 6 && y <= t.rect.y + t.rect.h + 6);
  for (const [x, y] of [[20, REF_H / 2], [REF_W - 20, REF_H / 2], [REF_W / 2, 20]]) if (!covered(x, y)) points.push({ what: 'background', x, y });
  if (opts.noMagenta) points.push({ what: 'not-content', x: REF_W / 2, y: REF_H / 2 });

  let lastBad = '';
  const ok = await waitFor(async () => {
    const shot = await obs.call('GetSourceScreenshot', { sourceName: 'Studio Host: Studio', imageFormat: 'png', imageWidth: W, imageHeight: H });
    const px = await page.evaluate(async ({ data, pts, W, H, RW, RH }) => {
      const img = new Image(); img.src = data; await img.decode();
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return pts.map((p) => {
        const x = Math.round((p.x / RW) * W), y = Math.round((p.y / RH) * H);
        const d = g.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
        return sum.map((v) => Math.round(v / (d.length / 4)));
      });
    }, { data: shot.imageData, pts: points, W, H, RW: REF_W, RH: REF_H });
    const bad = points.map((p, i) => {
      const v = px[i];
      const good = p.what === 'guest' ? isVideo(v)
        : p.what === 'content' ? near(v, MAGENTA, 120)
        : p.what === 'screen' ? !near(v, MAGENTA, 120)
        : p.what === 'not-content' ? !near(v, MAGENTA, 120)
        : near(v, BG, 45);
      return good ? null : `${p.what}@${Math.round(p.x)},${Math.round(p.y)}=rgb(${v.join(',')})`;
    }).filter(Boolean);
    lastBad = bad.join(' ');
    return bad.length === 0 ? true : null;
  }, 12_000);
  check(!!ok, `${label} (${cams.length} guest tile${cams.length === 1 ? '' : 's'}${content ? ' + content' : ''})${ok ? '' : ': ' + lastBad}`);
}

async function main() {
let exitCode = 0;
try {
  check(!!(await waitFor(async () => (await fetch(`${LOCAL}/api/ping`)).ok, 120_000)), 'plugin started the Studio Host server');

  const obs = await waitFor(async () => { const c = new ObsClient('ws://127.0.0.1:4455', ''); await c.connect(3000); return c; }, 60_000);
  if (!check(!!obs, 'connected to OBS over obs-websocket')) throw new Error('no obs-websocket');

  const scenes = (await obs.call('GetSceneList')).scenes.map((s) => s.sceneName);
  for (const name of ['Studio Host: Studio', 'Studio Host: Guest Screen Share', 'Studio Host: Guest 1']) {
    check(scenes.includes(name), `built-in scene "${name}" exists`);
  }
  const inputs = (await obs.call('GetInputList')).inputs;
  const kinds = new Set(inputs.map((i) => i.unversionedInputKind || i.inputKind));
  for (const kind of ['studiohost_program', 'studiohost_guest', 'studiohost_screen']) check(kinds.has(kind), `source type ${kind} is in use`);
  check(inputs.some((i) => i.inputName === 'Studio Host Audio'), 'Studio Host Audio source exists');

  const ready = await waitFor(async () => { const s = await snapshot(); return s.programOnline ? s : null; }, 90_000);
  check(!!ready, 'studio hub browser inside OBS connected to the server');
  const state = ready || (await snapshot());
  check(state.obs?.managed === true, 'server reports it is managed by the plugin');

  const host = (await post('join', { role: 'host' })).body;
  // Keep the producer session alive for the whole test, like an open dock (sessions without an
  // event connection are dropped after a short grace period).
  const hostEvents = new WebSocket(`${LOCAL.replace(/^http/, 'ws')}/api/ws?id=${host.id}&token=${host.token}`);
  hostEvents.onerror = () => {};
  const sw = await post('obs-scene', { scene: 'screen' }, host);
  check(sw.status === 200, `scene switch via plugin (${sw.status} ${sw.body.message || sw.body.error})`);
  await sleep(1500);
  const current = await obs.call('GetCurrentProgramScene');
  check(current.currentProgramSceneName === 'Studio Host: Guest Screen Share' || current.sceneName === 'Studio Host: Guest Screen Share',
    `OBS switched to the screen share scene (now "${current.currentProgramSceneName || current.sceneName}")`);
  const st2 = await waitFor(async () => { const s = await snapshot(); return s.obs?.builtin === 'screen' ? s : null; }, 10_000);
  check(!!st2, 'plugin reported the new scene back to the server');

  // A web widget (stands in for a Streamlabs alert box) becomes a Browser Source in the Studio scene.
  const widgetAct = (action, args) => post('action', { action, ...args }, host);
  await widgetAct('widgetSave', { name: 'Smoke Widget', url: `${LOCAL}/favicon.svg` });
  const widgetItem = async () => (await obs.call('GetSceneItemList', { sceneName: 'Studio Host: Studio' })).sceneItems
    .find((i) => i.sourceName === 'Studio Host Widget: Smoke Widget');
  const added = await waitFor(async () => (await widgetItem())?.sceneItemEnabled === true ? true : null, 10_000);
  check(!!added, 'widget added to the Studio scene as a Browser Source');
  const settings = added && (await obs.call('GetInputSettings', { inputName: 'Studio Host Widget: Smoke Widget' }));
  check(settings?.inputKind === 'browser_source' && settings.inputSettings.url === `${LOCAL}/favicon.svg`, 'widget Browser Source loads the widget link');
  const widgetId = (await snapshot()).studio.widgets.find((w) => w.name === 'Smoke Widget')?.id;
  await widgetAct('widgetShow', { id: widgetId, on: false });
  check(!!(await waitFor(async () => (await widgetItem())?.sceneItemEnabled === false ? true : null, 10_000)), 'hiding the widget hides its source');
  await widgetAct('widgetDelete', { id: widgetId });
  const widgetGone = await waitFor(async () => (await obs.call('GetInputList')).inputs.every((i) => i.inputName !== 'Studio Host Widget: Smoke Widget') ? true : null, 10_000);
  if (!check(!!widgetGone, 'deleting the widget removes its source from OBS')) {
    results.push(`INFO  widget scene item still in the Studio scene: ${!!(await widgetItem())}`);
  }

  const configDir = process.env.STUDIOHOST_CONFIG_DIR;
  const pw = process.env.PLAYWRIGHT_MODULE;
  const invite = await automaticSetup(host, configDir);
  if (invite && pw) await guestScenarios(obs, host, invite, pw);
  else results.push('SKIP  guest checks (set STUDIOHOST_CONFIG_DIR and PLAYWRIGHT_MODULE)');
  hostEvents.close();
  obs.close();
} catch (err) {
  check(false, `smoke test crashed: ${err.message}`);
} finally {
  await browser?.close();
}
if (results.some((r) => r.startsWith('FAIL'))) exitCode = 1;
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
process.exit(exitCode);
}

main();
