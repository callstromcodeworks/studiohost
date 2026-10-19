#!/usr/bin/env node
// @ts-check
// Studio Host server. Normally started by the Studio Host OBS plugin (with --managed),
// which talks to it over stdin/stdout. It can also run on its own (`npm start`) for
// development and tests, without the OBS features.
import http from 'node:http';
import { CONFIG_PATH, DATA_DIR, MANAGED, loadConfig, saveConfigPatch } from './config.js';
import { createHandler, createUpgradeHandler } from './http.js';
import { PluginChannel } from './ipc.js';
import { Studio } from './studio.js';
import { Invite, INVITE_EXPIRY_CHOICES } from './invite.js';
import { NetworkManager, defaultNetworkSettings, validateSettings } from './network.js';

const channel = MANAGED ? new PluginChannel() : null;
const config = loadConfig();
const studio = new Studio(config);
const invite = new Invite(config, saveConfigPatch);
// Producer pages show the invite link and when it changes next.
invite.on('changed', () => studio.broadcast({ type: 'invite' }, (c) => c.role === 'host'));

studio.obs = { managed: MANAGED, ...(channel?.status || {}) };
if (channel) {
  channel.onStatus = (status) => { studio.obs = { managed: true, ...status }; studio.broadcastState(); };
  studio.onSlots = (count) => channel.send({ type: 'slots', count });
  studio.onContent = (c) => channel.send({ type: 'content', ...c });
  studio.onFeedWanted = (on) => channel.send({ type: 'feed', on });
  studio.onWidgets = (items) => channel.send({ type: 'widgets', items });
  channel.onFeed = (kind, payload) => studio.forwardFeed(kind, payload);
}

/**
 * Network settings from config.json. STUDIOHOST_NETWORK=lan (tests, CI) runs a LAN-only guest
 * server without going through setup. A v0.1/0.2 config (publicUrl/tls) becomes Manual setup.
 */
/** @returns {import('./network.js').NetworkSettings} */
function loadNetworkSettings() {
  const saved = config.network ? { ...defaultNetworkSettings(), ...config.network } : defaultNetworkSettings();
  saved.auto = { ...(saved.auto || {}) }; saved.manual = { ...(saved.manual || {}) };
  if (!saved.mode && process.env.STUDIOHOST_NETWORK === 'lan') {
    return /** @type {any} */ ({ ...saved, mode: 'manual', manual: { address: 'lan', port: Number(process.env.STUDIOHOST_PUBLIC_PORT) || 8731, certificate: 'self-signed', bindAddress: '0.0.0.0' }, transient: true });
  }
  if (!saved.mode && config.publicUrl) {
    try {
      const u = new URL(config.publicUrl);
      saved.mode = 'manual';
      saved.manual = {
        address: 'domain', host: u.hostname, port: Number(u.port) || config.publicPort || 443, bindAddress: config.bindAddress || '0.0.0.0',
        certificate: config.tls?.cert && config.tls?.key ? 'files' : 'self-signed', certFile: config.tls?.cert || undefined, keyFile: config.tls?.key || undefined,
      };
    } catch { /* ignore a malformed old URL */ }
  }
  return saved;
}

/** Guest-facing request handler (assigned once `ctx` exists below). @type {import('node:http').RequestListener} */
let guestHandler = (_req, res) => { res.writeHead(503); res.end(); };
const network = new NetworkManager({
  settings: loadNetworkSettings(),
  save: (s) => { if (!(/** @type {any} */ (s).transient)) { const { transient, ...clean } = /** @type {any} */ (s); saveConfigPatch({ network: clean }); config.network = clean; } },
  dataDir: DATA_DIR, localPort: config.localPort,
  handler: (req, res) => guestHandler(req, res), upgrade: createUpgradeHandler(studio),
});
network.on('status', (status) => {
  studio.broadcast({ type: 'network', status }, (c) => c.role === 'host');
  channel?.send({ type: 'network', configured: status.configured, state: status.state, publicUrl: status.publicUrl });
});

function links() {
  const local = `http://127.0.0.1:${config.localPort}`;
  const pub = network.publicUrl;
  return {
    invite: pub ? `${pub}/guest/?k=${invite.key}` : '',
    inviteExpiresAt: invite.expiresAt,
    inviteExpiryHours: invite.hours,
    hostJoin: pub ? `${pub}/guest/?k=${config.hostKey}&host=1` : '',
    hostRemote: pub ? `${pub}/host/?key=${config.hostKey}` : '',
    dock: `${local}/host/`,
    wizard: `${local}/setup/`,
    program: `${local}/output/program.html`,
    slot: `${local}/output/slot.html?slot=`,
    feature: `${local}/output/feature.html`,
    configured: network.configured,
    output: config.output,
    managed: MANAGED,
    configPath: CONFIG_PATH,
  };
}

/** Studio settings that apply to both setup modes (no restart needed). */
function configView() {
  return { iceServers: config.iceServers, maxGuests: config.maxGuests, localPort: config.localPort, guestFeed: config.guestFeed, inviteExpiryHours: invite.hours };
}

/** @param {any} body @returns {string} */
function configSave(body) {
  const patch = {};
  if ('maxGuests' in body) {
    const n = Number(body.maxGuests);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Max guests must be between 1 and 50.');
    patch.maxGuests = n;
  }
  if ('iceServers' in body) {
    const list = body.iceServers;
    if (!Array.isArray(list) || !list.every((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)))) {
      throw new Error('STUN/TURN servers must be a JSON list like [{"urls": "stun:stun.l.google.com:19302"}].');
    }
    patch.iceServers = list;
  }
  if ('guestFeed' in body) {
    const maxKbps = Number(body.guestFeed?.maxKbps), totalKbps = Number(body.guestFeed?.totalKbps);
    if (!Number.isInteger(maxKbps) || maxKbps < 300 || maxKbps > 20000) throw new Error('Program video per guest must be between 300 and 20000 kbps.');
    if (!Number.isInteger(totalKbps) || totalKbps < 300 || totalKbps > 200000) throw new Error('Program video for all guests must be between 300 and 200000 kbps.');
    const codec = body.guestFeed?.codec ?? config.guestFeed.codec ?? 'auto';
    if (codec !== 'auto' && codec !== 'h264') throw new Error('Program video codec must be "auto" or "h264".');
    patch.guestFeed = { ...config.guestFeed, maxKbps, totalKbps, codec };
  }
  const expiry = 'inviteExpiryHours' in body ? Number(body.inviteExpiryHours) : invite.hours;
  if (!INVITE_EXPIRY_CHOICES.includes(expiry)) throw new Error('Invite links can expire after 1, 2, 6, 12 or 24 hours, or never.');
  let restart = false;
  if ('localPort' in body) {
    const n = Number(body.localPort);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Local port must be between 1024 and 65535.');
    if (n !== config.localPort) { patch.localPort = n; restart = true; }
  }
  saveConfigPatch(patch);
  if (expiry !== invite.hours) invite.setExpiry(expiry);
  Object.assign(config, restart ? { ...patch, localPort: config.localPort } : patch);
  if (patch.guestFeed) studio.broadcast({ type: 'guest-feed', guestFeed: patch.guestFeed }, (c) => c.role === 'program');
  if (restart && channel) {
    setTimeout(() => channel.send({ type: 'restart' }), 300);
    return 'Saved. Studio Host is restarting to use the new local port.';
  }
  return restart ? 'Saved. Restart Studio Host to use the new local port.' : 'Saved. New guests get the updated settings.';
}

const ctx = {
  studio, config, invite, links, configView, configSave,
  managed: MANAGED,
  obsSetup: () => (channel ? channel.request('setupScenes') : Promise.reject(new Error('Creating scenes needs the Studio Host OBS plugin.'))),
  /** @param {string} scene @param {number} [slot] */
  obsScene: (scene, slot) => {
    if (!channel) return Promise.reject(new Error('Scene switching needs the Studio Host OBS plugin.'));
    return channel.request('setScene', { scene, slot });
  },
  network: {
    status: () => network.status(),
    /** @param {any} body */
    apply: (body) => {
      const next = validateSettings(body, network.settings, { localPort: config.localPort });
      if (body.iceServers !== undefined || body.maxGuests !== undefined) configSave({ ...(body.iceServers !== undefined ? { iceServers: body.iceServers } : {}), ...(body.maxGuests !== undefined ? { maxGuests: body.maxGuests } : {}) });
      network.apply(next).catch((err) => console.error('[network]', err.message));
      return network.status();
    },
    recheck: () => network.recheck(),
    /** Opens the setup wizard window in OBS (plugin) — the page itself falls back to opening it. */
    openWizard: () => { if (!channel) return false; channel.send({ type: 'open-wizard' }); return true; },
    finished: () => { channel?.send({ type: 'setup-done' }); },
  },
};
guestHandler = createHandler(ctx, false);

start();

async function start() {
  // Local listener: OBS sources, the dock and the setup wizard load from here (no TLS on localhost).
  const local = http.createServer(createHandler(ctx, true));
  local.keepAliveTimeout = 65_000; local.headersTimeout = 70_000; local.requestTimeout = 0;
  local.on('upgrade', createUpgradeHandler(studio));
  local.on('error', (err) => fatal(`Local port ${config.localPort}`, err));
  await new Promise((r) => local.listen(config.localPort, '127.0.0.1', () => r(undefined)));

  // Guest side: whatever the setup chose (nothing until setup has run).
  network.start().catch((err) => console.error('[network]', err.message));

  const l = links();
  if (channel) {
    channel.send({
      type: 'ready', localPort: config.localPort, slots: studio.studio.slots, output: config.output,
      configured: network.configured, publicUrl: network.publicUrl,
    });
    studio.notifyWidgets(true);
  } else {
    console.log(`
  Studio Host is running
  ──────────────────────────────────────────────────────────────
  Producer controls:                        ${l.dock}
  Setup wizard:                             ${l.wizard}
  Program output:                           ${l.program}
  Guest slot N output:                      ${l.slot}N
  Featured screen share output:             ${l.feature}
  Config file:                              ${CONFIG_PATH}
`);
    if (!network.configured) console.log('  Guests can’t join yet: open the setup wizard to choose how they reach you.\n');
    network.once('status', () => { if (network.publicUrl) console.log(`  Guest invite link: ${network.publicUrl}/guest/?k=${invite.key}\n`); });
  }

  const shutdown = async () => { await network.stop(); local.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The plugin closes stdin on exit: release router mappings first.
  if (channel) channel.onClose = shutdown;
}

/** @param {string} what @param {any} err */
function fatal(what, err) {
  const message = `${what}: ${err.code === 'EADDRINUSE' ? 'already in use by another program. Choose a different port.' : err.message}`;
  console.error(message);
  channel?.send({ type: 'fatal', message });
  setTimeout(() => process.exit(1), 100);
}
