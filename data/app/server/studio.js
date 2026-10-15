// @ts-check
// Studio state, connected clients, and WebRTC link brokering.
//
// Media never passes through this server: browsers connect to each other with
// WebRTC and this module only relays signaling messages between them.
//
// Roles
//   guest   – a remote participant (also used by the host when they appear on camera)
//   host    – the producer control page (an OBS custom browser dock, or any browser with the host key)
//   program – the composited output page loaded as an OBS Browser Source (exactly one is active)
//   slot    – a single-participant output page loaded as an OBS Browser Source
//   feature – the screen-share output page (shows the featured screen share full-frame)
//
// Links (WebRTC peer connections the server asks two clients to set up)
//   program – guest <-> program: guest sends camera/mic/screen, program returns the
//             program picture plus a mix-minus of everyone else's audio
//   preview – guest  -> host:    low-bitrate video for the producer's backstage view
//   slot    – guest  -> slot:    full-quality camera/mic/screen for that slot's source
//   feature – guest  -> feature: full-quality screen share of the featured (or only) sharer
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

import { GUEST_LAYOUTS, CONTENT_LAYOUTS, obsContentRect, REF_W, REF_H } from '../public/common/render.js';

export const LAYOUTS = [...GUEST_LAYOUTS, ...CONTENT_LAYOUTS];
export const NAME_STYLES = ['bubble', 'block', 'minimal', 'outline', 'accent', 'none'];
export const LOGO_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const BANNER_POSITIONS = ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right'];
const STATE_PATH = join(DATA_DIR, 'state.json');
const RECONNECT_GRACE_MS = 15_000;
const CHAT_HISTORY = 200;
const TICKER_MIN = 40, TICKER_MAX = 600; // ticker speed range, pixels per second

/**
 * @typedef {'guest'|'host'|'program'|'slot'|'feature'} Role
 * @typedef {'program'|'preview'|'slot'|'feature'} LinkPurpose
 * @typedef {{id: string, a: string, b: string, purpose: LinkPurpose}} Link   a = media sender (guest)
 * @typedef {{
 *   id: string, token: string, role: Role, name: string, slot: number|null,
 *   conn: import('./ws.js').WsConnection|null, queue: object[], lastSeen: number,
 *   dropTimer: NodeJS.Timeout|null, remote: boolean, everConnected: boolean, lastDiagLog?: number,
 * }} Client
 * @typedef {{
 *   id: string, name: string, isHost: boolean, onStage: boolean, slot: number|null,
 *   volume: number, programAudio: boolean, hostMuted: boolean, hidden: boolean,
 *   cam: boolean, mic: boolean, screen: boolean,
 *   streams: {camera: string|null, screen: string|null}, joinedAt: number,
 * }} Participant
 */

/** Persisted studio settings (everything that should survive a restart). */
function defaultStudio() {
  return {
    layout: 'grid',          // used while only guests are shown
    contentLayout: 'sides',  // used while content (a screen share or OBS source) is shown
    /** OBS source shown as content (plugin only); persisted so it survives restarts. */
    obsContent: /** @type {string|null} */ (null),
    showNames: true,
    brand: {
      color: '#FF991C',
      textColor: '#FFFFFF',
      nameStyle: 'bubble',
      font: 'Roboto',
      logo: /** @type {string|null} */ (null),
      logoPosition: 'top-right',
      background: { color: '#14161A', image: /** @type {string|null} */ (null) },
      overlay: /** @type {string|null} */ (null),
    },
    banners: /** @type {{id: string, text: string, ticker: boolean}[]} */ ([]),
    activeBanner: /** @type {string|null} */ (null),
    activeTicker: /** @type {string|null} */ (null),
    tickerSpeed: 140,        // pixels per second on the 1920-wide frame
    tickerRepeat: true,      // false: one copy of the text crosses the screen at a time
    bannerPosition: 'bottom-left',
    /**
     * Web widgets (Streamlabs/StreamElements alerts, goals, event lists) the plugin adds to the
     * Studio scene as OBS Browser Sources. URLs carry account tokens, so pages only get id, name
     * and visibility (see publicState).
     */
    widgets: /** @type {{id: string, name: string, url: string, visible: boolean}[]} */ ([]),
    assets: /** @type {{id: string, name: string, kind: 'image'|'video', file: string}[]} */ ([]),
    slots: 4,
  };
}

export class Studio {
  /** @param {import('./config.js').StudioConfig} config */
  constructor(config) {
    this.config = config;
    /** @type {Map<string, Client>} */ this.clients = new Map();
    /** @type {Map<string, Participant>} */ this.participants = new Map();
    /** @type {Map<string, Link>} */ this.links = new Map();
    /** @type {string[]} participant ids on stage, in display order */ this.stage = [];
    /** @type {string|null} participant whose screen share is featured */ this.featuredScreen = null;
    /** @type {{asset: string, startedAt: number}|null} */ this.clip = null;
    /** @type {{id: string, fromId: string, from: string, to: string|null, text: string, ts: number}[]} */
    this.chat = [];
    /** @type {string|null} */ this.programClientId = null;
    /** OBS status reported by the plugin (managed mode). */
    this.obs = /** @type {Record<string, any>} */ ({ managed: false });
    /** Each guest's connection to the program output, as reported by it. @type {Record<string, any>} */
    this.connections = {};
    /** Called when the OBS-source content or its position changes. @type {((c: {source: string, rect: any}) => void)|null} */
    this.onContent = null;
    /** @type {string} */ this.lastContentKey = '';
    /** Called when the widget list changes (plugin only). @type {((items: any[]) => void)|null} */
    this.onWidgets = null;
    /** @type {string} */ this.lastWidgetsKey = '';
    /** Called when the slot count changes. @type {((count: number) => void)|null} */
    this.onSlots = null;
    /** Called to start/stop the OBS output feed (plugin only). @type {((on: boolean) => void)|null} */
    this.onFeedWanted = null;
    this.feedOn = false;
    this.studio = defaultStudio();
    this.studio.slots = config.obs.slots || this.studio.slots;
    this.load();
    this.saveTimer = /** @type {NodeJS.Timeout|null} */ (null);
  }

  // ---- persistence -----------------------------------------------------
  load() {
    if (!existsSync(STATE_PATH)) return;
    try {
      const saved = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      const d = defaultStudio();
      this.studio = {
        ...d, ...saved,
        brand: { ...d.brand, ...(saved.brand || {}), background: { ...d.brand.background, ...(saved.brand?.background || {}) } },
      };
      // v0.1 kept the screen-share layouts in `layout`.
      if (saved.layout === 'screen' || saved.layout === 'pip') {
        this.studio.contentLayout = saved.layout === 'screen' ? 'right' : 'pip';
        this.studio.layout = 'grid';
      }
    } catch (err) {
      console.warn('[studio] could not read state.json, starting fresh:', err.message);
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_PATH + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.studio, null, 2));
      renameSync(tmp, STATE_PATH);
    }, 250);
  }

  // ---- clients ---------------------------------------------------------
  /**
   * @param {{role: Role, name?: string, slot?: number, remote: boolean, isHost?: boolean}} opts
   * @returns {Client}
   */
  addClient({ role, name = '', slot, remote, isHost = false }) {
    /** @type {Client} */
    const client = {
      id: randomUUID(), token: randomBytes(18).toString('base64url'), role,
      name: cleanText(name, 40) || (role === 'guest' ? 'Guest' : role),
      slot: role === 'slot' ? clampInt(slot, 1, 64, 1) : null,
      conn: null, queue: [], lastSeen: Date.now(), dropTimer: null, remote, everConnected: false,
    };
    this.clients.set(client.id, client);

    if (role === 'guest') {
      this.participants.set(client.id, {
        id: client.id, name: client.name, isHost, onStage: false,
        slot: this.firstFreeSlot(), volume: 1, programAudio: true, hostMuted: false, hidden: false,
        cam: false, mic: false, screen: false, streams: { camera: null, screen: null }, joinedAt: Date.now(),
      });
    }
    if (role === 'program') {
      const previous = this.programClientId && this.clients.get(this.programClientId);
      if (previous) {
        this.send(previous, { type: 'superseded' });
        this.removeClient(previous.id);
      }
      this.programClientId = client.id;
    }
    // A client starts with no event stream; its links are created once it connects (attachStream).
    // Arm the drop timer now so a client that never opens its stream is cleaned up.
    this.armDrop(client);
    this.broadcastState();
    return client;
  }

  /**
   * Find a client by id and token.
   * @param {string|null|undefined} id @param {string|null|undefined} token
   */
  auth(id, token) {
    const c = id ? this.clients.get(id) : undefined;
    return c && token && c.token === token ? c : null;
  }

  /**
   * Attaches the page's event channel (a WebSocket). Messages queued while the page was
   * disconnected are delivered first after the welcome.
   * @param {Client} client @param {import('./ws.js').WsConnection} conn
   */
  attachStream(client, conn) {
    const fresh = !client.everConnected;
    if (client.dropTimer) { clearTimeout(client.dropTimer); client.dropTimer = null; }
    if (client.conn && client.conn !== conn) client.conn.close(4000, 'replaced');
    client.conn = conn;
    client.lastSeen = Date.now();
    this.send(client, { type: 'welcome', id: client.id, state: this.publicState(), chat: this.chatFor(client) });
    for (const msg of client.queue.splice(0)) conn.send(JSON.stringify(msg));
    if (fresh) {
      client.everConnected = true;
      this.relink();
    }
    conn.onclose = () => {
      if (client.conn === conn) {
        client.conn = null;
        this.armDrop(client);
        if (client.role === 'program') this.broadcastState(); // program went offline
      }
    };
    if (client.role === 'program') this.broadcastState(); // program came online
  }

  /** @param {Client} client */
  armDrop(client) {
    if (client.dropTimer) clearTimeout(client.dropTimer);
    client.dropTimer = setTimeout(() => this.removeClient(client.id), RECONNECT_GRACE_MS);
    client.dropTimer.unref();
  }

  /** @param {string} id */
  removeClient(id) {
    const client = this.clients.get(id);
    if (!client) return;
    if (client.dropTimer) clearTimeout(client.dropTimer);
    client.conn?.close(1000, 'removed');
    this.clients.delete(id);
    if (this.participants.delete(id)) {
      this.stage = this.stage.filter((p) => p !== id);
      if (this.featuredScreen === id) this.featuredScreen = null;
    }
    if (this.programClientId === id) this.programClientId = null;
    for (const link of [...this.links.values()]) {
      if (link.a === id || link.b === id) this.dropLink(link);
    }
    this.relink(); // e.g. the screen-share output may now follow a different sharer
    this.broadcastState();
  }

  // ---- messaging -------------------------------------------------------
  /** @param {Client} client @param {object} msg */
  send(client, msg) {
    if (client.conn) client.conn.send(JSON.stringify(msg));
    else if (client.queue.length < 500) client.queue.push(msg);
  }

  /** @param {object} msg @param {(c: Client) => boolean} [filter] */
  broadcast(msg, filter = () => true) {
    for (const c of this.clients.values()) if (filter(c)) this.send(c, msg);
  }

  broadcastState() {
    const state = this.publicState();
    this.broadcast({ type: 'state', state });
    this.notifyContent(state);
    this.updateFeed(state);
    this.notifyWidgets();
  }

  /** Sends the plugin the widget list (with URLs) when it changes, or always with `force`. */
  notifyWidgets(force = false) {
    const key = JSON.stringify(this.studio.widgets);
    if (!force && key === this.lastWidgetsKey) return;
    this.lastWidgetsKey = key;
    this.onWidgets?.(this.studio.widgets);
  }

  /** The OBS output is only needed while the program page is up and has guests to send it to. */
  updateFeed(state = this.publicState()) {
    const on = state.programOnline && this.participants.size > 0;
    if (on === this.feedOn) return;
    this.feedOn = on;
    this.onFeedWanted?.(on);
  }

  /**
   * Passes a packet of the OBS output (see ipc.js) to the program page, which sends it on to guests.
   * Video is dropped while the page is behind; audio never is.
   * @param {string} kind @param {Buffer} payload
   */
  forwardFeed(kind, payload) {
    const conn = this.programClientId ? this.clients.get(this.programClientId)?.conn : null;
    if (!conn || (kind === 'V' && conn.backlog > 4 * 1024 * 1024)) return;
    conn.sendBinary(Buffer.concat([Buffer.from(kind, 'latin1'), payload]));
  }

  /**
   * The content on screen: the featured screen share, else the OBS source (plugin only,
   * and only while that source exists in OBS). null means guests fill the frame.
   * @returns {{kind: 'screen', pid: string} | {kind: 'obs', source: string} | null}
   */
  contentState() {
    if (this.featuredScreen && this.participants.get(this.featuredScreen)?.screen) return { kind: 'screen', pid: this.featuredScreen };
    const source = this.studio.obsContent;
    if (source && this.obs.managed && (!Array.isArray(this.obs.sources) || this.obs.sources.includes(source))) return { kind: 'obs', source };
    return null;
  }

  /** Tells the plugin where to draw the OBS-source content (normalized 0..1), when it changes. @param {any} state */
  notifyContent(state) {
    const c = obsContentRect(state);
    const msg = c
      ? { source: c.source, rect: { x: c.rect.x / REF_W, y: c.rect.y / REF_H, w: c.rect.w / REF_W, h: c.rect.h / REF_H } }
      : { source: '', rect: null };
    const key = JSON.stringify(msg);
    if (key === this.lastContentKey) return;
    this.lastContentKey = key;
    this.onContent?.(msg);
  }

  /** Everything every page needs to render; contains no secrets. */
  publicState() {
    return {
      studio: { ...this.studio, widgets: this.studio.widgets.map(({ url, ...w }) => w) },
      participants: [...this.participants.values()],
      stage: this.stage,
      featuredScreen: this.featuredScreen,
      content: this.contentState(),
      clip: this.clip,
      programOnline: !!this.programClientId && !!this.clients.get(this.programClientId)?.conn,
      hosts: [...this.clients.values()].filter((c) => c.role === 'host').length,
      slotPages: [...this.clients.values()].filter((c) => c.role === 'slot').map((c) => c.slot),
      screenTarget: this.screenTarget(),
      connections: this.connections,
      obs: this.obs,
      output: this.config.output,
    };
  }

  // ---- WebRTC link brokering -------------------------------------------
  /** Recomputes which peer connections should exist and creates/drops links to match. */
  /** The participant whose screen the feature output shows: the featured one, else the first sharer. */
  screenTarget() {
    if (this.featuredScreen && this.participants.get(this.featuredScreen)?.screen) return this.featuredScreen;
    const sharers = [...this.participants.values()].filter((p) => p.screen).sort((a, b) => a.joinedAt - b.joinedAt);
    return sharers[0]?.id || null;
  }

  relink() {
    /** @type {Map<string, {a: string, b: string, purpose: LinkPurpose}>} */
    const wanted = new Map();
    const live = [...this.clients.values()].filter((c) => c.everConnected);
    for (const guest of live.filter((c) => c.role === 'guest')) {
      const p = this.participants.get(guest.id);
      for (const other of live) {
        /** @type {LinkPurpose|null} */
        let purpose = null;
        if (other.role === 'program') purpose = 'program';
        else if (other.role === 'host') purpose = 'preview';
        else if (other.role === 'slot' && p && p.slot === other.slot) purpose = 'slot';
        // Every guest stays linked to the screen-share output, so when one starts sharing only
        // a track is added to a connection that is already up (setting up a new one from the
        // OBS page has taken many seconds). Only the screen target sends anything on it.
        else if (other.role === 'feature' && p) purpose = 'feature';
        if (purpose) wanted.set(`${guest.id}|${other.id}|${purpose}`, { a: guest.id, b: other.id, purpose });
      }
    }
    for (const link of [...this.links.values()]) {
      if (!wanted.delete(`${link.a}|${link.b}|${link.purpose}`)) this.dropLink(link);
    }
    for (const w of wanted.values()) {
      const link = { id: randomUUID(), ...w };
      this.links.set(link.id, link);
      const a = this.clients.get(link.a), b = this.clients.get(link.b);
      // The guest (media sender) is the "polite" peer in the perfect-negotiation pattern.
      if (a) this.send(a, { type: 'link', linkId: link.id, peer: link.b, purpose: link.purpose, polite: true, peerRole: b?.role });
      if (b) this.send(b, { type: 'link', linkId: link.id, peer: link.a, purpose: link.purpose, polite: false, peerRole: 'guest' });
    }
  }

  /** @param {Link} link */
  dropLink(link) {
    this.links.delete(link.id);
    for (const id of [link.a, link.b]) {
      const c = this.clients.get(id);
      if (c) this.send(c, { type: 'unlink', linkId: link.id });
    }
  }

  /** Relay an SDP/ICE message to the other end of a link. @param {Client} from @param {string} linkId @param {any} data */
  signal(from, linkId, data) {
    const link = this.links.get(linkId);
    if (!link || (link.a !== from.id && link.b !== from.id)) return false;
    const to = this.clients.get(link.a === from.id ? link.b : link.a);
    if (to) this.send(to, { type: 'signal', linkId, data });
    return true;
  }

  // ---- participants ----------------------------------------------------
  firstFreeSlot() {
    const used = new Set([...this.participants.values()].map((p) => p.slot));
    for (let i = 1; i <= this.studio.slots; i++) if (!used.has(i)) return i;
    return null;
  }

  /** Guest reports its own media status. @param {Client} client @param {any} body */
  updateSelf(client, body) {
    const p = this.participants.get(client.id);
    if (!p) return;
    if (typeof body.name === 'string' && cleanText(body.name, 40)) p.name = client.name = cleanText(body.name, 40);
    for (const k of /** @type {const} */ (['cam', 'mic', 'screen'])) if (typeof body[k] === 'boolean') p[k] = body[k];
    if (body.streams && typeof body.streams === 'object') {
      p.streams = { camera: cleanId(body.streams.camera), screen: cleanId(body.streams.screen) };
    }
    if (!p.screen && this.featuredScreen === p.id) this.featuredScreen = null;
    this.relink();
    this.broadcastState();
  }

  // ---- host actions ----------------------------------------------------
  /**
   * Applies a producer action. Returns an error string, or null on success.
   * @param {Client} client @param {any} a
   * @returns {string|null}
   */
  hostAction(client, a) {
    const s = this.studio;
    const p = typeof a.participant === 'string' ? this.participants.get(a.participant) : undefined;
    const needP = () => { if (!p) throw new UserError('unknown participant'); return p; };
    try {
      switch (a.action) {
        case 'stage': {
          const q = needP();
          q.onStage = !!a.on;
          this.stage = this.stage.filter((id) => id !== q.id);
          if (q.onStage) {
            if (typeof a.index === 'number') this.stage.splice(clampInt(a.index, 0, this.stage.length, this.stage.length), 0, q.id);
            else this.stage.push(q.id);
          }
          break;
        }
        case 'reorder': {
          const order = Array.isArray(a.order) ? a.order.filter((id) => this.stage.includes(id)) : [];
          this.stage = [...order, ...this.stage.filter((id) => !order.includes(id))];
          break;
        }
        case 'featureScreen': {
          if (a.participant === null) { this.featuredScreen = null; break; }
          const q = needP();
          if (!q.screen) throw new UserError('that participant is not sharing a screen');
          this.featuredScreen = q.id;
          s.obsContent = null; // one piece of content at a time
          break;
        }
        case 'content': {
          // {kind: 'none'} | {kind: 'screen', participant} | {kind: 'obs', source}
          if (a.kind === 'none') { this.featuredScreen = null; s.obsContent = null; break; }
          if (a.kind === 'screen') {
            const q = needP();
            if (!q.screen) throw new UserError('that participant is not sharing a screen');
            this.featuredScreen = q.id; s.obsContent = null; break;
          }
          if (a.kind === 'obs') {
            const source = cleanText(a.source, 200);
            if (!this.obs.managed) throw new UserError('Showing an OBS source needs the Studio Host OBS plugin.');
            if (!source || (Array.isArray(this.obs.sources) && !this.obs.sources.includes(source))) throw new UserError('That OBS source was not found.');
            s.obsContent = source; this.featuredScreen = null; break;
          }
          throw new UserError('unknown content');
        }
        case 'layout':
          if (a.layout === 'screen') a.layout = 'right'; // v0.1 name
          if (GUEST_LAYOUTS.includes(a.layout)) s.layout = a.layout;
          else if (CONTENT_LAYOUTS.includes(a.layout)) s.contentLayout = a.layout;
          else throw new UserError('unknown layout');
          break;
        case 'hide': needP().hidden = !!a.on; break;
        case 'showNames': s.showNames = !!a.on; break;
        case 'volume': needP().volume = Math.max(0, Math.min(2, Number(a.volume) || 0)); break;
        case 'hostMute': needP().hostMuted = !!a.on; break;
        case 'programAudio': needP().programAudio = !!a.on; break;
        case 'markHost': needP().isHost = !!a.on; break;
        case 'rename': { const q = needP(); const n = cleanText(a.name, 40); if (n) q.name = n; break; }
        case 'slot': {
          const q = needP();
          if (a.slot === null) { q.slot = null; break; }
          const slot = clampInt(a.slot, 1, s.slots, 1);
          for (const other of this.participants.values()) if (other.slot === slot) other.slot = q.slot; // swap
          q.slot = slot;
          break;
        }
        case 'slots': s.slots = clampInt(a.count, 1, 16, 4); break;
        case 'kick': {
          const q = needP();
          const c = this.clients.get(q.id);
          if (c) this.send(c, { type: 'kicked' });
          setTimeout(() => this.removeClient(q.id), 300);
          break;
        }
        case 'requestMedia': {
          // Asks a guest to turn their camera or mic back on (the guest decides).
          const q = needP();
          const c = this.clients.get(q.id);
          if (c) this.send(c, { type: 'request', what: a.what === 'cam' ? 'cam' : 'mic' });
          break;
        }
        case 'brand': {
          const b = a.brand || {};
          if (isColor(b.color)) s.brand.color = b.color;
          if (isColor(b.textColor)) s.brand.textColor = b.textColor;
          if (NAME_STYLES.includes(b.nameStyle)) s.brand.nameStyle = b.nameStyle;
          if (typeof b.font === 'string') s.brand.font = cleanText(b.font, 60) || 'Roboto';
          if (b.logo === null || this.hasAsset(b.logo, 'image')) s.brand.logo = b.logo;
          if (LOGO_POSITIONS.includes(b.logoPosition)) s.brand.logoPosition = b.logoPosition;
          if (b.overlay === null || this.hasAsset(b.overlay, 'image')) s.brand.overlay = b.overlay;
          if (b.background) {
            if (isColor(b.background.color)) s.brand.background.color = b.background.color;
            if (b.background.image === null || this.hasAsset(b.background.image, 'image')) s.brand.background.image = b.background.image;
          }
          break;
        }
        case 'bannerSave': {
          const text = cleanText(a.text, 300);
          if (!text) throw new UserError('banner text is empty');
          const existing = s.banners.find((x) => x.id === a.id);
          if (existing) { existing.text = text; existing.ticker = !!a.ticker; }
          else s.banners.push({ id: randomUUID(), text, ticker: !!a.ticker });
          break;
        }
        case 'bannerDelete':
          s.banners = s.banners.filter((x) => x.id !== a.id);
          if (s.activeBanner === a.id) s.activeBanner = null;
          if (s.activeTicker === a.id) s.activeTicker = null;
          break;
        case 'bannerShow': {
          if (a.id === null) { s.activeBanner = null; break; }
          const bn = s.banners.find((x) => x.id === a.id);
          if (!bn) throw new UserError('unknown banner');
          if (bn.ticker) s.activeTicker = s.activeTicker === bn.id ? null : bn.id;
          else s.activeBanner = s.activeBanner === bn.id ? null : bn.id;
          break;
        }
        case 'tickerHide': s.activeTicker = null; break;
        case 'tickerSpeed': s.tickerSpeed = clampInt(a.speed, TICKER_MIN, TICKER_MAX, 140); break;
        case 'tickerRepeat': s.tickerRepeat = !!a.on; break;
        case 'bannerPosition':
          if (!BANNER_POSITIONS.includes(a.position)) throw new UserError('unknown banner position');
          s.bannerPosition = a.position;
          break;
        case 'widgetSave': {
          const name = cleanText(a.name, 60);
          if (!name) throw new UserError('give the widget a name');
          const existing = s.widgets.find((x) => x.id === a.id);
          if (a.id && !existing) throw new UserError('unknown widget');
          if (s.widgets.some((x) => x !== existing && x.name.toLowerCase() === name.toLowerCase())) throw new UserError('another widget already has that name');
          // The URL may be left out when editing, to keep the saved one.
          const url = a.url === undefined && existing ? existing.url : widgetUrl(a.url);
          if (existing) Object.assign(existing, { name, url });
          else {
            if (s.widgets.length >= 20) throw new UserError('too many widgets');
            s.widgets.push({ id: randomUUID(), name, url, visible: true });
          }
          break;
        }
        case 'widgetShow': {
          const w = s.widgets.find((x) => x.id === a.id);
          if (!w) throw new UserError('unknown widget');
          w.visible = !!a.on;
          break;
        }
        case 'widgetDelete': s.widgets = s.widgets.filter((x) => x.id !== a.id); break;
        case 'clipPlay':
          if (!this.hasAsset(a.asset, 'video')) throw new UserError('unknown video clip');
          this.clip = { asset: a.asset, startedAt: Date.now() };
          break;
        case 'clipStop': this.clip = null; break;
        case 'assetDelete': this.deleteAsset(a.asset); break;
        default: throw new UserError('unknown action');
      }
    } catch (err) {
      if (err instanceof UserError) return err.message;
      throw err;
    }
    this.save();
    if (['slot', 'slots', 'featureScreen', 'content', 'kick'].includes(a.action)) this.relink(); // content can change the screen target
    if (a.action === 'slots') this.onSlots?.(s.slots);
    this.broadcastState();
    return null;
  }

  /** @param {any} id @param {'image'|'video'} kind */
  hasAsset(id, kind) {
    return typeof id === 'string' && this.studio.assets.some((x) => x.id === id && x.kind === kind);
  }

  /** @param {{id: string, name: string, kind: 'image'|'video', file: string}} asset */
  addAsset(asset) {
    this.studio.assets.push(asset);
    this.save();
    this.broadcastState();
  }

  /** @param {string} id */
  deleteAsset(id) {
    const s = this.studio;
    s.assets = s.assets.filter((x) => x.id !== id);
    if (s.brand.logo === id) s.brand.logo = null;
    if (s.brand.overlay === id) s.brand.overlay = null;
    if (s.brand.background.image === id) s.brand.background.image = null;
    if (this.clip?.asset === id) this.clip = null;
  }

  /**
   * Program page reports connection health per guest. Broadcast only when something a
   * person would notice changes (state or candidate types), not on every counter tick.
   * @param {any[]} list
   */
  setConnections(list) {
    /** @type {Record<string, any>} */
    const next = {};
    for (const l of list) {
      if (!l || typeof l.peer !== 'string' || !this.participants.has(l.peer)) continue;
      next[l.peer] = {
        state: String(l.state || ''), ice: String(l.ice || ''), local: l.local || null, remote: l.remote || null,
        framesIn: Number(l.framesIn) || 0, bytesIn: Number(l.bytesIn) || 0, bytesOut: Number(l.bytesOut) || 0,
        rtt: typeof l.rtt === 'number' ? l.rtt : null,
        videoKbps: num(l.videoKbps), audioKbps: num(l.audioKbps), fps: num(l.fps),
        width: num(l.width), height: num(l.height), audioActive: typeof l.audioActive === 'boolean' ? l.audioActive : null,
        audioLevel: num(l.audioLevel),
      };
    }
    // Rates are bucketed so small fluctuations don't cause a broadcast every few seconds.
    const bucket = (/** @type {number|null} */ v) => (v == null ? null : v < 100 ? Math.round(v / 10) : Math.round(Math.log2(v) * 4));
    const key = (/** @type {Record<string, any>} */ c) => JSON.stringify(Object.entries(c)
      .map(([k, v]) => [k, v.state, v.local, v.remote, v.framesIn > 0, v.height, bucket(v.videoKbps), bucket(v.audioKbps)]).sort());
    const changed = key(next) !== key(this.connections);
    this.connections = next;
    if (changed) this.broadcastState();
  }

  /** Program page reports a clip finished. */
  clipEnded() {
    if (this.clip) { this.clip = null; this.broadcastState(); }
  }

  // ---- chat (private studio chat between host and guests, never shown on stream) --
  /** @param {Client} from @param {string} text @param {string|null} to */
  postChat(from, text, to) {
    const body = cleanText(text, 1000);
    if (!body) return 'message is empty';
    if (from.role !== 'guest' && from.role !== 'host') return 'not allowed';
    // Guests may only message everyone or the producers ("host").
    if (from.role === 'guest' && to !== null && to !== 'host') return 'guests can only message everyone or the host';
    if (from.role === 'host' && to !== null && to !== 'host' && !this.participants.has(to)) return 'unknown recipient';
    const p = this.participants.get(from.id);
    const msg = {
      id: randomUUID(), fromId: from.id, from: from.role === 'host' ? 'Producer' : (p?.name || from.name),
      to, text: body, ts: Date.now(),
    };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.broadcast({ type: 'chat', message: msg }, (c) => canSee(c, msg));
    return null;
  }

  /** @param {Client} client */
  chatFor(client) { return this.chat.filter((m) => canSee(client, m)); }
}

/** @param {Client} c @param {{fromId: string, to: string|null}} m */
function canSee(c, m) {
  if (c.role === 'host') return true;
  if (c.role !== 'guest') return false;
  return m.to === null || m.fromId === c.id || m.to === c.id;
}

class UserError extends Error {}

/** A widget's page address: http(s) only. @param {unknown} v @returns {string} */
function widgetUrl(v) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { throw new UserError('enter the widget’s full web address (https://…)'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UserError('widget addresses must start with https://');
  if (u.href.length > 2000) throw new UserError('that address is too long');
  return u.href;
}

/** @param {any} v @param {number} max */
export function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
/** @param {any} v */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
/** @param {any} v */
function cleanId(v) { return typeof v === 'string' && /^[\w{}-]{1,100}$/.test(v) ? v : null; }
/** @param {any} v */
function isColor(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
/** @param {any} v @param {number} min @param {number} max @param {number} dflt */
export function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}
