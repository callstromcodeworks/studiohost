// End-to-end test: starts Studio Host, opens the program output, the host dock, a slot
// output and two guests in headless Chromium with fake camera/mic devices, and checks
// that video and audio actually flow. Requires Playwright with Chromium:
//   npm i -D playwright && npx playwright install chromium
//   node test/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BLUR_FILES } from '../data/app/public/guest/blur.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS_DIR || join(ROOT, 'test', 'screenshots');
const LOCAL = 18730, PUB = 18731;

const data = mkdtempSync(join(tmpdir(), 'studiohost-e2e-'));
const server = spawn(process.execPath, [join(ROOT, 'data/app/server/index.js')], {
  env: { ...process.env, STUDIOHOST_DATA: data, STUDIOHOST_LOCAL_PORT: String(LOCAL), STUDIOHOST_PUBLIC_PORT: String(PUB), STUDIOHOST_NETWORK: 'lan' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); }));
const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors',
    '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing',
  ],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
const fails = [];
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(url, label) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${label}] ${m.text()}`); });
  page.on('pageerror', (e) => { console.log(`  [${label}] PAGE ERROR ${e.message}`); fails.push(`${label}: ${e.message}`); });
  await page.goto(url);
  return page;
}
async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); }
  return false;
}

try {
  const program = await open(`http://127.0.0.1:${LOCAL}/output/program.html`, 'program');
  const host = await open(`http://127.0.0.1:${LOCAL}/host/`, 'host');
  const slot = await open(`http://127.0.0.1:${LOCAL}/output/slot.html?slot=1&names=1`, 'slot');
  const feature = await open(`http://127.0.0.1:${LOCAL}/output/feature.html`, 'feature');
  // Like OBS: more than six pages from the same host in one browser profile (the per-host
  // HTTP connection limit). Long-lived event connections must not starve other requests.
  const slots = {};
  for (const n of [2, 3, 4]) slots[n] = await open(`http://127.0.0.1:${LOCAL}/output/slot.html?slot=${n}`, `slot${n}`);

  const guests = [];
  for (const name of ['Ada Lovelace', 'Grace Hopper']) {
    const g = await open(`https://localhost:${PUB}/guest/?k=${config.guestKey}`, name);
    await g.fill('#name', name);
    if (name === 'Ada Lovelace') await g.fill('#headline', 'Mathematician');
    await g.waitForFunction(() => document.querySelector('#lobby-video')?.srcObject?.getTracks().length >= 2);
    await g.click('#join');
    guests.push(g);
  }
  const [ada, grace] = guests;

  check(await waitFor(() => host.evaluate(() => document.querySelectorAll('.person').length === 2)), 'host sees two guests backstage');

  // Bad invite key is rejected.
  const bad = await open(`https://localhost:${PUB}/guest/?k=wrong`, 'bad-guest');
  await bad.fill('#name', 'Intruder');
  await bad.click('#join');
  check(await waitFor(() => bad.evaluate(() => !document.querySelector('#lobby-error').classList.contains('hidden') && /not valid/.test(document.querySelector('#lobby-error').textContent))), 'wrong invite key is refused');
  await bad.close();

  // Bring Ada on stage.
  await host.locator('.person', { hasText: 'Ada Lovelace' }).locator('button', { hasText: 'Add to stage' }).click();
  check(await waitFor(() => program.evaluate(() => window.studioHost.client.state?.stage.length === 1)), 'Ada is on stage');

  // Ada's title is shown under her name: in the dock, the program state and her slot output.
  check(await waitFor(() => host.evaluate(() => [...document.querySelectorAll('.p-headline')].some((el) => el.textContent === 'Mathematician'))), 'dock shows the guest’s title');
  check(await waitFor(() => slot.evaluate(() => document.querySelector('#headline').textContent === 'Mathematician')), 'slot output name tag shows the title');

  // Program receives Ada's camera.
  check(await waitFor(() => program.evaluate(() => {
    const s = window.studioHost.client.state; const p = s.participants.find((x) => x.name === 'Ada Lovelace');
    const v = window.studioHost.bank.video(p.id, 'camera'); return !!v && v.videoWidth > 0;
  })), 'program receives guest camera video');

  // Canvas shows non-background pixels inside the stage tile.
  const measureTile = () => program.evaluate(() => {
    const c = document.querySelector('#stage'); const g = c.getContext('2d');
    const d = g.getImageData(c.width / 2 - 50, c.height / 2 - 50, 100, 100).data;
    let differ = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0x14) + Math.abs(d[i + 1] - 0x16) + Math.abs(d[i + 2] - 0x1a) > 30) differ++;
    return differ / (d.length / 4);
  });
  let tileColorful = 0;
  await waitFor(async () => (tileColorful = await measureTile()) > 0.3, 8000);
  check(tileColorful > 0.3, `program canvas draws the guest tile (${(tileColorful * 100).toFixed(0)}% non-background)`);

  // Guests receive the program feed.
  for (const [g, n] of [[ada, 'Ada'], [grace, 'Grace']]) {
    check(await waitFor(() => g.evaluate(() => { const v = document.querySelector('#program'); return v.srcObject && v.videoWidth > 0 && !v.paused; })), `${n} sees the program feed`);
  }
  // Two guests share the default caps (3000 kbps each, 12000 in all), and program audio goes first.
  check(await waitFor(() => program.evaluate(() => {
    const links = [...window.studioHost.links.values()].filter((l) => !l.closed);
    return links.length === 2 && links.every((l) => {
      const v = l.senders.get('program-video')?.getParameters().encodings?.[0];
      const a = l.senders.get('program-audio')?.getParameters().encodings?.[0];
      return v?.maxBitrate === 3_000_000 && v?.scaleResolutionDownBy === 1 && a?.priority === 'high';
    });
  }), 8000), 'program video is capped per guest and program audio has priority');
  check(await program.evaluate(() => window.studioHost.guestCanvas.width === 1280), 'guests get a 1280-wide program picture');

  check(await waitFor(() => host.evaluate(() => {
    const st = window.studioHost.client.state; const ada = st.participants.find((p) => p.name === 'Ada Lovelace');
    return st.connections?.[ada.id]?.state === 'connected';
  })), 'program reports guest connection health to the dock');

  // Mix-minus: Grace (backstage) hears Ada (on stage); measure audio energy on Grace's program feed.
  const level = (page) => page.evaluate(async () => {
    const v = document.querySelector('#program');
    const ac = new AudioContext(); await ac.resume();
    const an = ac.createAnalyser(); an.fftSize = 2048;
    ac.createMediaStreamSource(v.srcObject).connect(an);
    let peak = 0; const buf = new Float32Array(an.fftSize);
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
    ac.close(); return peak;
  });
  check(await waitFor(async () => (await level(grace)) > 0.01, 12000), 'backstage guest hears the on-stage guest (mix-minus)');

  // Program audio mixer has both guests as sources.
  check(await waitFor(() => program.evaluate(() => window.studioHost.mixer.sources.size >= 2)), 'program mixer has audio from both guests');

  // Host previews.
  check(await waitFor(() => host.evaluate(() => [...document.querySelectorAll('.person .thumb video:not(.screen-thumb)')].filter((v) => v.videoWidth > 0).length === 2)), 'host dock shows preview video for both guests');

  // Slot output: Ada was auto-assigned slot 1 and is on stage.
  check(await waitFor(() => slot.evaluate(() => { const v = document.querySelector('#video'); return document.querySelector('#wrap').classList.contains('show') && v.videoWidth > 0; })), 'slot 1 output shows Ada');

  // A guest on a weak uplink (capped at 150 kbps video / 12 kbps audio) next to an uncapped one.
  const weak = await open(`https://localhost:${PUB}/guest/?k=${config.guestKey}&maxv=150&maxa=12`, 'Weak Link');
  await weak.fill('#name', 'Weak Link');
  await weak.waitForFunction(() => document.querySelector('#lobby-video')?.srcObject?.getTracks().length >= 2);
  await weak.click('#join');
  const rates = async () => program.evaluate(() => {
    const st = window.studioHost.client.state;
    const id = (n) => st.participants.find((p) => p.name === n)?.id;
    const c = (n) => st.connections?.[id(n)] || {};
    return { ada: c('Ada Lovelace'), weak: c('Weak Link') };
  });
  await sleep(15000);
  let r = await rates();
  // Stats arrive every 3 s; take the best of a few samples for the uncapped guest.
  for (let i = 0; i < 3 && !(r.ada.videoKbps > 200); i++) { await sleep(3000); r = await rates(); }
  console.log(`INFO  received rates: Ada ${r.ada.videoKbps} kbps video / ${r.ada.audioKbps} kbps audio (${r.ada.height}p); weak ${r.weak.videoKbps} / ${r.weak.audioKbps} (${r.weak.height}p)`);
  check(r.weak.videoKbps > 20 && r.weak.videoKbps <= 190, `capped guest video stays under its 150 kbps cap (${r.weak.videoKbps})`);
  check(r.weak.audioKbps > 4 && r.weak.audioKbps <= 18, `capped guest audio stays under its 12 kbps cap (${r.weak.audioKbps})`);
  check(r.ada.videoKbps > r.weak.videoKbps * 1.5, `uncapped guest sends more video (${r.ada.videoKbps} vs ${r.weak.videoKbps})`);
  check(r.weak.framesIn > 0 && r.weak.audioActive === true, 'capped guest still delivers video frames and audio');
  await host.locator('.person', { hasText: 'Weak Link' }).locator('button', { hasText: 'Add to stage' }).click();
  check(await waitFor(() => host.evaluate(() => /kbps|Mbps/.test(document.querySelector('.person.on')?.textContent || '')
    && [...document.querySelectorAll('.person')].some((el) => el.textContent.includes('Weak Link') && el.querySelector('.flag.bad')))),
    'dock shows bitrates and flags the low-bitrate guest');
  await weak.close();
  check(await waitFor(() => program.evaluate(() => window.studioHost.client.state.participants.length === 2), 25000), 'guest who closed the page is removed');

  // Banner + ticker.
  await host.click('#tabs button[data-tab="banners"]');
  await host.fill('#banner-text', 'Welcome to the show — Studio Host test');
  await host.click('#banner-form button');
  await host.locator('#banner-list button', { hasText: 'Show' }).first().click();
  check(await waitFor(() => program.evaluate(() => !!window.studioHost.client.state.studio.activeBanner)), 'banner shown');
  // One guest filling the frame, with a banner and a ticker: the name tag moves above them.
  await host.fill('#banner-text', 'Breaking: tickers scroll at the speed you set');
  await host.check('#banner-ticker');
  await host.click('#banner-form button');
  await host.locator('#banner-list .item', { hasText: 'Breaking' }).locator('button', { hasText: 'Show' }).click();
  await host.locator('#ticker-speed').fill('300');
  await host.click('#guest-layouts button[title="Solo"]');
  check(await waitFor(() => program.evaluate(() => window.studioHost.client.state.studio.tickerSpeed === 300)), 'ticker speed setting reaches the program');
  check(await waitFor(() => program.evaluate(() => {
    const r = window.studioHost.renderer;
    return r.overlays?.length === 2;
  })), 'program knows where the banner and ticker are');
  await sleep(800);
  await program.screenshot({ path: join(SHOTS, 'banner-names.png') });
  // Banner position and single-copy ticker.
  await host.selectOption('#banner-pos', 'top-center');
  await host.uncheck('#ticker-repeat');
  check(await waitFor(() => program.evaluate(() => {
    const st = window.studioHost.client.state.studio, b = window.studioHost.renderer.overlays?.[0];
    return st.bannerPosition === 'top-center' && st.tickerRepeat === false && b && b.y < 200 && Math.abs(b.x + b.w / 2 - 960) < 2;
  })), 'banner moves to top center and ticker repeat turns off');
  await sleep(800);
  await program.screenshot({ path: join(SHOTS, 'banner-top-ticker-once.png') });
  await host.selectOption('#banner-pos', 'bottom-left');
  await host.check('#ticker-repeat');
  await host.locator('#banner-list .item', { hasText: 'Breaking' }).locator('button', { hasText: 'Hide' }).click();

  // Timer: a two-minute countdown, top center, which pauses and takes an extra minute.
  await host.fill('#timer-min', '2');
  await host.fill('#timer-sec', '0');
  await host.fill('#timer-label', 'Back in');
  await host.click('#timer-start');
  check(await waitFor(() => program.evaluate(() => {
    const r = window.studioHost.renderer, t = window.studioHost.client.state.studio.timer;
    return t?.label === 'Back in' && /^(2:00|1:5\d)$/.test(r.timerText(t)) && r.overlays?.some((o) => o.y < 200 && Math.abs(o.x + o.w / 2 - 960) < 2);
  })), 'countdown timer shows at the top center of the program');
  await host.click('#timer-pause');
  await host.click('#timer-plus');
  check(await waitFor(() => host.evaluate(() => /^(3:00|2:5\d)$/.test(document.querySelector('#timer-value').textContent) && document.querySelector('#timer-pause').textContent === 'Resume')), 'timer pauses and takes an extra minute');
  // The program may get the pause and the extra minute a moment after the dock does.
  check(await waitFor(() => program.evaluate(() => {
    const t = window.studioHost.client.state.studio.timer;
    return !!t?.pausedAt && t.endsAt - t.pausedAt > 120_000;
  })), 'the program has the paused timer');
  const paused = await program.evaluate(() => window.studioHost.renderer.timerText(window.studioHost.client.state.studio.timer));
  await sleep(1500);
  check(paused === await program.evaluate(() => window.studioHost.renderer.timerText(window.studioHost.client.state.studio.timer)), 'a paused timer stands still');
  await program.screenshot({ path: join(SHOTS, 'timer.png') });
  await host.click('#timer-hide');
  check(await waitFor(() => program.evaluate(() => !window.studioHost.client.state.studio.timer)), 'timer hidden');

  // Layout switch + second guest on stage.
  await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: 'Add to stage' }).click();
  await host.click('#layouts button[data-layout="spotlight"]');
  check(await waitFor(() => program.evaluate(() => window.studioHost.client.state.studio.layout === 'spotlight' && window.studioHost.client.state.stage.length === 2)), 'layout set to spotlight with two on stage');

  // Presets: save this stage, change it, and bring it back with one click.
  host.once('dialog', (d) => d.accept('Interview'));
  await host.click('#preset-save');
  check(await waitFor(() => host.evaluate(() => document.querySelector('#preset-list .recall')?.textContent === 'Interview')), 'preset saved');
  await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: 'Remove' }).first().click();
  await host.click('#layouts button[data-layout="solo"]');
  check(await waitFor(() => program.evaluate(() => window.studioHost.client.state.stage.length === 1)), 'stage changed');
  await host.click('#preset-list .recall');
  check(await waitFor(() => program.evaluate(() => {
    const st = window.studioHost.client.state;
    return st.studio.layout === 'spotlight' && st.stage.map((id) => st.participants.find((p) => p.id === id)?.name).join() === 'Ada Lovelace,Grace Hopper';
  })), 'recalling the preset restores the layout and who is on stage');

  // Screen share (may be unavailable in headless environments).
  const shared = await ada.evaluate(async () => {
    try { document.querySelector('#share').click(); } catch { return false; }
    await new Promise((r) => setTimeout(r, 1500));
    return window.studioHost.client.state.participants.find((p) => p.id === window.studioHost.client.id)?.screen;
  });
  if (shared) {
    await host.locator('.person', { hasText: 'Ada Lovelace' }).locator('button', { hasText: 'Show screen' }).click();
    check(await waitFor(() => program.evaluate(() => {
      const s = window.studioHost.client.state; if (!s.featuredScreen) return false;
      const v = window.studioHost.bank.video(s.featuredScreen, 'screen'); return !!v && v.videoWidth > 0;
    })), 'featured screen share reaches the program');
    check(await waitFor(() => feature.evaluate(() => { const v = document.querySelector('#video'); return v.classList.contains('show') && v.videoWidth > 0; })), 'screen-share output shows the shared screen');

    // With content, guests are grouped on either side of it (default "sides" content layout).
    const targets = () => program.evaluate(() => [...window.studioHost.renderer.anim.values()].filter((a) => !a.leaving)
      .map((a) => ({ kind: a.target.kind, name: window.studioHost.client.state.participants.find((p) => p.id === a.target.pid)?.name, ...a.target.rect })));
    const sidesOk = (t) => {
      const scr = t.find((x) => x.kind === 'screen'); const cams = t.filter((x) => x.kind === 'camera');
      return !!scr && Math.abs(scr.x + scr.w / 2 - 960) < 1 && cams.length === 2
        && cams.some((c) => c.x + c.w <= scr.x) && cams.some((c) => c.x >= scr.x + scr.w);
    };
    check(await waitFor(async () => sidesOk(await targets())), 'with a screen share, guests are grouped on both sides of it');

    // Hide Grace: she leaves the picture (her audio stays), the layout adapts.
    await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: /^Hide$/ }).click();
    check(await waitFor(async () => { const t = await targets(); return t.filter((x) => x.kind === 'camera').length === 1 && t[0] && !t.some((x) => x.name === 'Grace Hopper'); }),
      'hidden guest leaves the picture and the layout adapts');
    check(await program.evaluate(() => {
      const g = window.studioHost.client.state.participants.find((p) => p.name === 'Grace Hopper');
      const src = window.studioHost.mixer.sources.get(`${g.id}:camera`);
      return !!src && src.program.gain.value > 0.5;
    }), "hidden guest's audio stays in the program");
    const graceSlot = await program.evaluate(() => window.studioHost.client.state.participants.find((p) => p.name === 'Grace Hopper').slot);
    if (slots[graceSlot]) check(await waitFor(() => slots[graceSlot].evaluate(() => !document.querySelector('#wrap').classList.contains('show'))), "hidden guest's slot output is hidden too");

    // Stop showing the screen: guests fill the centre again (Grace still hidden: Ada alone).
    await host.selectOption('#content-select', '');
    check(await waitFor(async () => { const t = await targets(); return t.length === 1 && t[0].kind === 'camera' && t[0].w > 1000; }),
      'without content the shown guests fill the centre');
    await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: /^Show$/ }).click();
    check(await waitFor(async () => (await targets()).filter((x) => x.kind === 'camera').length === 2), 'unhidden guest returns to the picture');
  } else {
    console.log('SKIP  screen share (getDisplayMedia unavailable in this headless browser)');
  }

  // Chat: guest → host, host → guest privately.
  check(await ada.isVisible('#chat'), 'guest chat is open beside the picture');
  await ada.fill('#chat-input', 'Hello from Ada');
  await ada.click('#chat-form button');
  check(await waitFor(() => host.evaluate(() => document.querySelector('#chat-log').textContent.includes('Hello from Ada'))), 'host receives guest chat');
  await host.click('#tabs button[data-tab="chat"]');
  const graceId = await grace.evaluate(() => window.studioHost.client.id);
  await host.selectOption('#chat-to', graceId);
  await host.fill('#chat-input', 'Private note for Grace');
  await host.click('#chat-form button');
  check(await waitFor(() => grace.evaluate(() => document.querySelector('#chat-log').textContent.includes('Private note for Grace'))), 'guest receives private host message');
  await sleep(500);
  check(!(await ada.evaluate(() => document.querySelector('#chat-log').textContent.includes('Private note for Grace'))), 'other guest does not see the private message');

  // Background blur: a guest turns it on in the lobby. The MediaPipe files come from a local
  // copy (BLUR_FILES_DIR, or fetched from npm and Google's model storage here).
  const blurDir = blurFiles();
  if (blurDir) {
    await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|storage\.googleapis\.com)\//, (route) => {
      const file = Object.values(BLUR_FILES).find((f) => f.url === route.request().url());
      if (!file) return route.abort();
      return route.fulfill({ body: readFileSync(join(blurDir, file.url.split('/').pop())), contentType: file.type, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    const blurry = await open(`https://localhost:${PUB}/guest/?k=${config.guestKey}`, 'Blur Guest');
    await blurry.fill('#name', 'Blur Guest');
    await blurry.check('#blur');
    check(await waitFor(() => blurry.evaluate(() => {
      const b = window.studioHost.blur, v = document.querySelector('#lobby-video');
      return !!b?.hasMask && v.srcObject?.getVideoTracks()[0] === b.output && v.videoWidth > 0;
    }), 30000), 'blur turns the camera into a blurred track');
    console.log(`INFO  segmenter labels: ${await blurry.evaluate(() => JSON.stringify(window.studioHost.blur.labels))}, mask ${await blurry.evaluate(() => window.studioHost.blur.maskIndex)}`);
    await blurry.click('#join');
    check(await waitFor(() => program.evaluate(() => {
      const p = window.studioHost.client.state.participants.find((x) => x.name === 'Blur Guest');
      const v = p && window.studioHost.bank.video(p.id, 'camera');
      return !!v && v.videoWidth > 0;
    }), 45000), 'the program receives the blurred camera');
    await blurry.evaluate(() => { const b = document.querySelector('#blur-2'); b.checked = false; b.dispatchEvent(new Event('change')); });
    check(await waitFor(() => blurry.evaluate(() => !window.studioHost.blur && !!document.querySelector('#self-video').srcObject?.getVideoTracks()[0]?.getSettings().deviceId)), 'turning blur off sends the camera as it is');
    await blurry.screenshot({ path: join(SHOTS, 'guest-blur.png') });
    await blurry.close();
  } else {
    console.log('SKIP  background blur (MediaPipe files unavailable)');
  }

  // Upload a logo (generated PNG) and set it.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  mkdirSync(join(data, 'tmp'), { recursive: true });
  writeFileSync(join(data, 'tmp', 'logo.png'), png);
  await host.click('#tabs button[data-tab="media"]');
  await host.setInputFiles('#upload', join(data, 'tmp', 'logo.png'));
  check(await waitFor(() => host.evaluate(() => window.studioHost.client.state.studio.assets.length === 1)), 'image upload stored');
  await host.locator('#asset-list button', { hasText: 'Logo' }).click();
  check(await waitFor(() => program.evaluate(() => !!window.studioHost.client.state.studio.brand.logo)), 'logo applied');

  // Kick Grace.
  await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: '•••' }).click();
  host.once('dialog', (d) => d.accept());
  await host.locator('.person', { hasText: 'Grace Hopper' }).locator('button', { hasText: 'Remove' }).last().click();
  check(await waitFor(() => grace.evaluate(() => !document.querySelector('#ended').classList.contains('hidden'))), 'removed guest sees the removal screen');
  check(await waitFor(() => host.evaluate(() => document.querySelectorAll('.person').length === 1)), 'host list drops the removed guest');

  await sleep(1500);
  mkdirSync(SHOTS, { recursive: true });
  await program.screenshot({ path: join(SHOTS, 'program.png') });
  await host.click('#tabs button[data-tab="banners"]');
  await host.screenshot({ path: join(SHOTS, 'host.png'), fullPage: true });
  await ada.screenshot({ path: join(SHOTS, 'guest.png') });
  const lobby = await open(`https://localhost:${PUB}/guest/?k=${config.guestKey}`, 'lobby');
  await sleep(1500);
  await lobby.screenshot({ path: join(SHOTS, 'lobby.png') });
} catch (err) {
  console.error(err);
  fails.push(String(err));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nAll checks passed');

/** A folder with the background blur files (see BLUR_FILES), or null if they can't be had. */
function blurFiles() {
  let dir = process.env.BLUR_FILES_DIR;
  if (dir) return dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'studiohost-blur-'));
    const version = BLUR_FILES.bundle.url.match(/@([\d.]+)\//)[1];
    const tgz = execFileSync('npm', ['pack', `@mediapipe/tasks-vision@${version}`, '--silent', '--pack-destination', dir], { encoding: 'utf8' }).trim();
    execFileSync('tar', ['xzf', join(dir, tgz), '-C', dir, '--strip-components=1', 'package/vision_bundle.mjs', 'package/wasm/vision_wasm_internal.js', 'package/wasm/vision_wasm_internal.wasm']);
    for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) execFileSync('mv', [join(dir, 'wasm', f), join(dir, f)]);
    execFileSync('curl', ['-sSfL', '-o', join(dir, BLUR_FILES.model.url.split('/').pop()), BLUR_FILES.model.url]);
    return existsSync(join(dir, 'vision_wasm_internal.wasm')) ? dir : null;
  } catch (err) {
    console.log(`INFO  could not fetch the blur files: ${err.message}`);
    return null;
  }
}
process.exit(fails.length ? 1 : 0);
