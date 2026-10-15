// Drives the setup wizard in a browser: Automatic (against a stand-in hostname service, Pebble and
// a simulated router) and Manual (local network). Needs PEBBLE_BIN/PEBBLE_DIR and Playwright.
//   PLAYWRIGHT_MODULE=… PEBBLE_BIN=… PEBBLE_DIR=… node test/wizard.e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import https from 'node:https';
import { startFakeRouter } from './fake-router.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PEBBLE = process.env.PEBBLE_BIN, PEBBLE_DIR = process.env.PEBBLE_DIR;
const SHOTS = process.env.SHOTS_DIR || join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'wizard-'));
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };
function run(cmd, args, env, label) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  procs.push(p); p.label = label; return p;
}
const until = async (p, text) => { for (let i = 0; i < 300 && !p.log.includes(text); i++) await sleep(50); };

const router = await startFakeRouter({ externalIp: '127.0.0.1' });
const [dnsPort, apiPort, pebblePort, pebbleMgmt, localPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
const svc = run(process.execPath, [join(ROOT, 'test/fake-hostname-service.mjs')], { ZONE: 'live.studiohost.test', DNS_PORT: String(dnsPort), DNS_HOST: '127.0.0.1', API_PORT: String(apiPort), API_BIND: '127.0.0.1', PROBE_CA_FILE: join(tmp, 'root.pem') }, 'dns');
await until(svc, 'API:');
const cfg = JSON.parse(readFileSync(join(PEBBLE_DIR, 'test/config/pebble-config.json'), 'utf8'));
Object.assign(cfg.pebble, { listenAddress: `127.0.0.1:${pebblePort}`, managementListenAddress: `127.0.0.1:${pebbleMgmt}`, certificate: join(PEBBLE_DIR, 'test/certs/localhost/cert.pem'), privateKey: join(PEBBLE_DIR, 'test/certs/localhost/key.pem') });
writeFileSync(join(tmp, 'pebble.json'), JSON.stringify(cfg));
const pebble = run(PEBBLE, ['-config', join(tmp, 'pebble.json'), '-dnsserver', `127.0.0.1:${dnsPort}`], { PEBBLE_VA_NOSLEEP: '1' }, 'pebble');
await until(pebble, 'Listening on');
writeFileSync(join(tmp, 'root.pem'), await new Promise((res) => https.get({ host: '127.0.0.1', port: pebbleMgmt, path: '/roots/0', ca: readFileSync(join(PEBBLE_DIR, 'test/certs/pebble.minica.pem')) }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })));

const studio = run(process.execPath, [join(ROOT, 'data/app/server/index.js')], {
  STUDIOHOST_DATA: join(tmp, 'studio'), STUDIOHOST_LOCAL_PORT: String(localPort),
  STUDIOHOST_DNS_SERVICE: `http://127.0.0.1:${apiPort}`, STUDIOHOST_ACME_DIRECTORY: `https://127.0.0.1:${pebblePort}/dir`,
  STUDIOHOST_ACME_CA: join(PEBBLE_DIR, 'test/certs/pebble.minica.pem'), STUDIOHOST_UPNP_LOCATION: router.location, STUDIOHOST_PROPAGATION_MS: '0',
}, 'studio');
await until(studio, 'running');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
try {
  const page = await (await browser.newContext({ viewport: { width: 760, height: 900 } })).newPage();
  page.on('pageerror', (e) => { console.log(`FAIL  page error: ${e.message}`); fails.push(`page error: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g/.test(m.text())) console.log(`INFO  console: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${localPort}/setup/`);
  await page.waitForSelector('#choose:not(.hidden)');
  await sleep(500);
  await page.screenshot({ path: join(SHOTS, 'wizard-choose.png') });
  check(await page.isChecked('input[name="mode"][value="auto"]'), 'Automatic is preselected');

  // Dock before setup: invite button says setup is needed.
  const dock = await (await browser.newContext()).newPage();
  await dock.goto(`http://127.0.0.1:${localPort}/host/`);
  await dock.waitForFunction(() => document.querySelector('#copy-invite')?.textContent === 'Finish setup');
  check(true, 'dock asks to finish setup before guests can join');

  await page.click('#choose-next');
  await page.waitForSelector('#progress:not(.hidden)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'wizard-progress.png') });
  const done = await page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') && document.querySelector('#invite').textContent.includes('/guest/?k='), null, { timeout: 90_000 }).then(() => true).catch(() => false);
  check(done, 'Automatic setup completes and shows the invite link');
  const invite = await page.textContent('#invite');
  check(/^https:\/\/[a-z]+-[a-z]+-\d{4}\.live\.studiohost\.test:\d{5}\/guest\/\?k=/.test(invite), `invite uses the generated name and a 5-digit port (${invite})`);
  const states = await page.$$eval('#path li', (lis) => lis.map((li) => li.className));
  check(states.every((c) => c === 'ok'), `every stage is done (${states.join(',')})`);
  await page.screenshot({ path: join(SHOTS, 'wizard-done.png') });
  await dock.waitForFunction(() => document.querySelector('#copy-invite')?.textContent === 'Invite link', null, { timeout: 10_000 });
  check(true, 'dock invite button becomes available after setup');

  // Rerun the wizard: Manual, local network only.
  await page.click('#progress-back');
  await page.check('input[name="mode"][value="manual"]');
  await page.click('#choose-next');
  await page.waitForSelector('#manual:not(.hidden)');
  await page.screenshot({ path: join(SHOTS, 'wizard-manual.png'), fullPage: true });
  await page.check('input[name="address"][value="lan"]');
  check(await page.isDisabled('input[name="cert"][value="letsencrypt"]'), 'Let’s Encrypt is unavailable for local network only');
  await page.fill('#m-port', String(localPort)); // clash with the local port: must be refused
  await page.click('#manual-save');
  await page.waitForSelector('#manual-error:not(.hidden)');
  check(/used for OBS itself/.test(await page.textContent('#manual-error')), 'a clashing port is refused with an explanation');
  const lanPort = await freePort();
  await page.fill('#m-port', String(lanPort));
  await page.click('#manual-save');
  await page.waitForSelector('#progress:not(.hidden)');
  const lanDone = await page.waitForFunction((p) => document.querySelector('#invite').textContent.includes(`:${p}/guest/`), lanPort, { timeout: 60_000 }).then(() => true).catch(() => false);
  check(lanDone, 'Manual (local network) setup completes');
  if (!lanDone) {
    // Diagnostics for CI: what the server and the page think.
    const st = await page.evaluate(async () => { try { return await window.studioHostSetup?.status(); } catch (e) { return String(e); } });
    console.log('INFO  server status:', JSON.stringify(st));
    console.log('INFO  page:', JSON.stringify(await page.evaluate(() => ({ invite: document.querySelector('#invite').textContent, path: [...document.querySelectorAll('#path li')].map((li) => `${li.className}: ${li.textContent}`) }))));
    console.log('INFO  studio log:', studio.log.slice(-1500).replace(/\n/g, ' | '));
  }
  check(/self-signed/.test(await page.textContent('#result-note')), 'self-signed warning is explained');
  check(router.mappings.size === 0, 'switching away from Automatic removes the router mapping');
  await page.screenshot({ path: join(SHOTS, 'wizard-manual-done.png') });
  await page.click('#finish');
  await page.waitForURL(/\/host\/$/, { timeout: 5000 }).then(() => check(true, 'Finish continues to the producer controls')).catch(() => check(false, 'Finish continues to the producer controls'));
} catch (err) {
  fails.push(String(err));
  console.error(err, studio.log.slice(-2000));
} finally {
  await browser.close();
  for (const p of procs) p.kill();
  router.close();
}
console.log(fails.length ? `\n${fails.length} failure(s)` : '\nAll checks passed');
process.exit(fails.length ? 1 : 0);
