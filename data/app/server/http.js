// @ts-check
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, createWriteStream } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, ROOT_DIR } from './config.js';
import { cleanText } from './studio.js';
import { acceptUpgrade } from './ws.js';
import { safeEqual } from './invite.js';

const PUBLIC_DIR = join(ROOT_DIR, 'public');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const MAX_JSON = 256 * 1024;
const MAX_UPLOAD = 500 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.woff2': 'font/woff2',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);

/**
 * @param {{studio: import('./studio.js').Studio, config: import('./config.js').StudioConfig, invite: import('./invite.js').Invite, links: () => object,
 *   obsSetup: () => Promise<string>, obsScene: (scene: string, slot?: number) => Promise<string>,
 *   configView: () => object, configSave: (body: any) => string, managed: boolean,
 *   network: {status: () => any, apply: (b: any) => any, recheck: () => Promise<any>, openWizard: () => boolean, finished: () => void}}} ctx
 * @param {boolean} localListener true for the 127.0.0.1 HTTP listener used by OBS
 */
export function createHandler(ctx, localListener) {
  const { studio, config } = ctx;

  /** @param {import('node:http').IncomingMessage} req */
  const isTrusted = (req) => localListener && isLoopback(req.socket.remoteAddress);

  /** @param {import('node:http').IncomingMessage} req */
  const clientOf = (req) => studio.auth(header(req, 'x-client-id'), header(req, 'x-client-token'));

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (path.startsWith('/api/')) return await api(req, res, path.slice(5), url);
      if (path === '/') return redirect(res, '/guest/' + url.search);
      if (path === '/host' || path === '/guest' || path === '/output' || path === '/setup') return redirect(res, path + '/' + url.search);
      if (path.startsWith('/assets/')) return serveFile(req, res, UPLOAD_DIR, path.slice('/assets/'.length));
      return serveFile(req, res, PUBLIC_DIR, path.slice(1));
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      console.error('[http]', req.method, path, err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} route
   * @param {URL} url
   */
  async function api(req, res, route, url) {
    if (req.method === 'GET' && route === 'ping') return json(res, 200, { ok: true });

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    if (route === 'upload') {
      const client = clientOf(req);
      if (!client || client.role !== 'host') return json(res, 403, { error: 'host only' });
      return upload(req, res, url);
    }

    const body = await readJson(req);

    if (route === 'join') {
      const role = body.role;
      const key = typeof body.key === 'string' ? body.key : '';
      const hostKeyOk = safeEqual(key, config.hostKey);
      if (!['guest', 'host', 'program', 'slot', 'feature'].includes(role)) return json(res, 400, { error: 'bad role' });
      /** The rejoin ticket a guest who was already in the studio comes back with. */
      let ticket = null;
      if (role === 'guest') {
        ticket = ctx.invite.checkTicket(body.ticket);
        if (!isTrusted(req) && !hostKeyOk && !ticket) {
          const invite = ctx.invite.check(key);
          if (invite === 'expired') return json(res, 403, { error: 'This invite link has expired. Ask the host for a new one.' });
          if (invite !== 'ok') return json(res, 403, { error: 'This invite link is not valid. Ask the host for a new one.' });
        }
        if (studio.participants.size >= config.maxGuests) return json(res, 409, { error: 'The studio is full.' });
      } else if (!isTrusted(req) && !hostKeyOk) {
        return json(res, 403, { error: 'Host key required.' });
      }
      const asHost = role === 'guest' && !!body.asHost && (hostKeyOk || isTrusted(req));
      const client = studio.addClient({ role, name: cleanText(body.name, 40), slot: body.slot, remote: !isTrusted(req), isHost: asHost });
      return json(res, 200, {
        id: client.id, token: client.token, iceServers: config.iceServers, output: config.output, guestFeed: config.guestFeed,
        debug: process.env.STUDIOHOST_DEBUG === '1',
        rejoin: role === 'guest' ? ctx.invite.ticket(client.id, ticket) : undefined,
      });
    }

    const client = clientOf(req);
    if (!client) return json(res, 401, { error: 'unknown session' });
    client.lastSeen = Date.now();

    switch (route) {
      case 'signal':
        return studio.signal(client, String(body.linkId), body.data) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'unknown link' });
      case 'self':
        if (client.role !== 'guest') return json(res, 403, { error: 'guests only' });
        studio.updateSelf(client, body);
        return json(res, 200, { ok: true });
      case 'chat': {
        const to = body.to === undefined || body.to === null ? null : String(body.to);
        const err = studio.postChat(client, String(body.text ?? ''), to);
        return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
      }
      case 'leave':
        studio.removeClient(client.id);
        return json(res, 200, { ok: true });
      case 'log':
        // Pages running inside OBS forward their warnings here so they land in the OBS log.
        if (client.role === 'program' || client.role === 'slot' || client.role === 'feature') {
          console.error(`[page ${client.role}${client.slot ? ' ' + client.slot : ''}] ${String(body.level || 'log')}: ${cleanText(body.msg, 500)}`);
        }
        return json(res, 200, { ok: true });
      case 'diag':
        if (client.role === 'program' && Array.isArray(body.links)) studio.setConnections(body.links);
        // Guests report how the program audio they receive is playing out; log it (numbers
        // only, at most every few seconds per guest) so playback problems show in the OBS log.
        if (client.role === 'guest' && body.audio && typeof body.audio === 'object' && Date.now() - (client.lastDiagLog || 0) >= 4000) {
          client.lastDiagLog = Date.now();
          console.error(guestAudioLine(client.name, body.audio));
        }
        return json(res, 200, { ok: true });
      case 'clip-ended':
        if (client.role === 'program') studio.clipEnded();
        return json(res, 200, { ok: true });
      case 'action': {
        if (client.role !== 'host') return json(res, 403, { error: 'host only' });
        if (body.action === 'assetDelete') removeUpload(studio, body.asset);
        if (body.action === 'kick' && typeof body.participant === 'string') ctx.invite.revoke(body.participant);
        const err = studio.hostAction(client, body);
        return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
      }
      case 'info':
        if (client.role !== 'host') return json(res, 403, { error: 'host only' });
        return json(res, 200, ctx.links());
      case 'invite-new':
        if (client.role !== 'host') return json(res, 403, { error: 'host only' });
        ctx.invite.rotate();
        return json(res, 200, { ok: true });
      case 'obs-setup':
        if (client.role !== 'host') return json(res, 403, { error: 'host only' });
        try { return json(res, 200, { message: await ctx.obsSetup() }); }
        catch (err) { return json(res, 502, { error: err.message }); }
      case 'obs-scene': {
        if (client.role !== 'host') return json(res, 403, { error: 'host only' });
        const scene = String(body.scene || '');
        if (!['studio', 'screen', 'guest'].includes(scene)) return json(res, 400, { error: 'unknown scene' });
        try { return json(res, 200, { message: await ctx.obsScene(scene, Number(body.slot) || undefined) }); }
        catch (err) { return json(res, 502, { error: err.message }); }
      }
      case 'network-status':
      case 'network-apply':
      case 'network-recheck':
      case 'network-open-wizard':
      case 'setup-done': {
        // Network setup can only be changed from this computer (OBS, or a browser on it).
        if (client.role !== 'host' || client.remote) return json(res, 403, { error: 'Setup can only be changed from the OBS computer.' });
        try {
          if (route === 'network-status') return json(res, 200, ctx.network.status());
          if (route === 'network-apply') return json(res, 200, ctx.network.apply(body));
          if (route === 'network-recheck') return json(res, 200, await ctx.network.recheck());
          if (route === 'network-open-wizard') return json(res, 200, { opened: ctx.network.openWizard() });
          ctx.network.finished();
          return json(res, 200, { ok: true });
        } catch (err) { return json(res, 400, { error: err.message }); }
      }
      case 'config-get':
      case 'config-save': {
        // Server settings can only be changed from this computer (the OBS dock), not remotely.
        if (client.role !== 'host' || client.remote) return json(res, 403, { error: 'Settings can only be changed from the OBS computer.' });
        if (route === 'config-get') return json(res, 200, ctx.configView());
        try { return json(res, 200, { message: ctx.configSave(body) }); }
        catch (err) { return json(res, 400, { error: err.message }); }
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  /**
   * Streams an uploaded image/video into data/uploads.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url
   */
  function upload(req, res, url) {
    const name = cleanText(url.searchParams.get('name') || 'upload', 120);
    const ext = extname(name).toLowerCase();
    const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
    if (!kind) return json(res, 415, { error: 'Only images (png, jpg, gif, webp, svg) and videos (mp4, webm, mov) are supported.' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: 'File is too large (500 MB max).' });
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const id = randomUUID();
    const file = id + ext;
    const target = join(UPLOAD_DIR, file);
    const out = createWriteStream(target);
    let size = 0, failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD && !failed) { failed = true; req.unpipe(out); out.destroy(); safeUnlink(target); json(res, 413, { error: 'File is too large.' }); }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) { safeUnlink(target); return json(res, 400, { error: 'empty upload' }); }
      const asset = { id, name, kind, file };
      studio.addAsset(/** @type {any} */ (asset));
      json(res, 200, { asset });
    });
    out.on('error', () => { if (!failed) { failed = true; json(res, 500, { error: 'could not save file' }); } });
  }
}

/**
 * Handles WebSocket upgrades on /api/ws?id=…&token=… (the server → page event channel).
 * Unknown sessions are accepted and closed with code 4401 so the page knows to rejoin.
 * @param {import('./studio.js').Studio} studio
 */
export function createUpgradeHandler(studio) {
  /** @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket */
  return function upgrade(req, socket) {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/api/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    const client = studio.auth(url.searchParams.get('id'), url.searchParams.get('token'));
    if (!client) { conn.close(4401, 'unknown session'); return; }
    studio.attachStream(client, conn);
  };
}

/** @param {import('./studio.js').Studio} studio @param {any} id */
function removeUpload(studio, id) {
  const asset = studio.studio.assets.find((x) => x.id === id);
  if (asset) safeUnlink(join(UPLOAD_DIR, asset.file));
}

/** @param {string} p */
function safeUnlink(p) { try { unlinkSync(p); } catch { /* already gone */ } }

/**
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 * @param {string} base @param {string} rel
 */
function serveFile(req, res, base, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return json(res, 400, { error: 'bad path' }); }
  let full = normalize(join(base, decoded));
  if (full !== base && !full.startsWith(base + sep)) return json(res, 403, { error: 'forbidden' });
  if (existsSync(full) && statSync(full).isDirectory()) full = join(full, 'index.html');
  if (!existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: 'not found' });
  const ext = extname(full).toLowerCase();
  const stat = statSync(full);
  const type = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': ext === '.html' || base === PUBLIC_DIR ? 'no-cache' : 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
  // Range support so <video> clips can seek.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start); end = Math.min(stat.size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch { reject(Object.assign(new Error('the request body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
function json(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** @param {import('node:http').ServerResponse} res @param {string} to */
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

/** @param {import('node:http').IncomingMessage} req @param {string} name */
function header(req, name) { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; }

/** @param {string|undefined} addr */
export function isLoopback(addr) {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}


/**
 * One OBS-log line describing a guest's program-audio playout report (see guest.js).
 * Only numeric fields are used, plus a shortened browser description on the first report.
 * @param {string} name @param {any} a
 */
export function guestAudioLine(name, a) {
  const num = (/** @type {any} */ v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?');
  const parts = [
    `${num(a.secs)}s`,
    `recv ${num(a.packets)} pkts, lost ${num(a.lost)}`,
    `jitter ${num(a.jitterMs)}ms, buffer ${num(a.bufferMs)}ms`,
    `sped up ${num(a.acceleratedPct, 1)}%, slowed ${num(a.deceleratedPct, 1)}%, concealed ${num(a.concealedPct, 1)}%`,
    `rate ${num(a.rate)}Hz`,
  ];
  if (typeof a.ice === 'string') parts.push(`ice ${cleanText(a.ice, 20)}`);
  if (typeof a.paused === 'boolean' && a.paused) parts.push('player paused');
  if (typeof a.playbackRate === 'number' && a.playbackRate !== 1) parts.push(`playbackRate ${num(a.playbackRate, 2)}`);
  if (typeof a.browser === 'string') parts.push(`browser ${cleanText(a.browser, 200)}`);
  return `[guest ${cleanText(name, 40)}] program audio: ${parts.join('; ')}`;
}
