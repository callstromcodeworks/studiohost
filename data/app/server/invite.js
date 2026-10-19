// @ts-check
// The guest invite link. Its key is replaced automatically once it is older than the expiry
// chosen in the studio settings (1 hour by default, or never), so a link that was shared
// around stops working. Guests already in the studio are not affected: each guest who joins
// gets a rejoin ticket, which lets them back in after a dropped connection or a server
// restart even once the link has changed. Removing a guest revokes their ticket.
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Hours an invite link stays valid; 0 means it never expires. */
export const INVITE_EXPIRY_CHOICES = [1, 2, 6, 12, 24, 0];
export const DEFAULT_INVITE_EXPIRY_HOURS = 1;
const TICKET_HOURS = 12;

export const newKey = () => randomBytes(12).toString('base64url');

/** @param {string} a @param {string} b */
export function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export class Invite extends EventEmitter {
  /**
   * @param {import('./config.js').StudioConfig} config  holds guestKey, guestKeyIssuedAt, inviteExpiryHours, rejoinSecret
   * @param {(patch: Record<string, any>) => void} save  persists config changes
   */
  constructor(config, save) {
    super();
    this.config = config;
    this.save = save;
    /** The key before the last change, so its link can be told apart from a wrong one. */
    this.previousKey = '';
    /** Ticket families (the participant id of a guest's first join) that may no longer rejoin. */
    /** @type {Set<string>} */ this.revoked = new Set();
    /** Participant id → ticket family. @type {Map<string, string>} */ this.families = new Map();
    /** @type {NodeJS.Timeout|null} */ this.timer = null;
    const patch = {};
    if (!config.guestKeyIssuedAt) patch.guestKeyIssuedAt = config.guestKeyIssuedAt = Date.now();
    if (!config.rejoinSecret) patch.rejoinSecret = config.rejoinSecret = randomBytes(32).toString('base64url');
    if (Object.keys(patch).length) save(patch);
    this.rotateIfDue();
    this.schedule();
  }

  get hours() {
    const h = this.config.inviteExpiryHours;
    return INVITE_EXPIRY_CHOICES.includes(/** @type {number} */ (h)) ? /** @type {number} */ (h) : DEFAULT_INVITE_EXPIRY_HOURS;
  }

  /** When the current link stops working (ms), or null if it never does. */
  get expiresAt() { return this.hours ? (this.config.guestKeyIssuedAt || 0) + this.hours * 3600_000 : null; }

  /** The current invite key (replaced first if it has expired). */
  get key() { this.rotateIfDue(); return this.config.guestKey; }

  rotateIfDue() {
    const at = this.expiresAt;
    if (at !== null && Date.now() >= at) this.rotate();
  }

  /** Replaces the invite key now: the old link stops working. */
  rotate() {
    this.previousKey = this.config.guestKey;
    this.config.guestKey = newKey();
    this.config.guestKeyIssuedAt = Date.now();
    this.save({ guestKey: this.config.guestKey, guestKeyIssuedAt: this.config.guestKeyIssuedAt });
    this.schedule();
    this.emit('changed');
  }

  /** Changes the expiry. The current link's clock restarts, so it doesn't expire on the spot. @param {number} hours */
  setExpiry(hours) {
    if (!INVITE_EXPIRY_CHOICES.includes(hours)) throw new Error('Invite links can expire after 1, 2, 6, 12 or 24 hours, or never.');
    this.config.inviteExpiryHours = hours;
    this.config.guestKeyIssuedAt = Date.now();
    this.save({ inviteExpiryHours: hours, guestKeyIssuedAt: this.config.guestKeyIssuedAt });
    this.schedule();
    this.emit('changed');
  }

  /** Changes the link when it expires, so pages showing it update without waiting for a guest. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = this.expiresAt;
    if (at === null) return;
    this.timer = setTimeout(() => this.rotateIfDue(), Math.max(1000, at - Date.now() + 50));
    this.timer.unref();
  }

  /**
   * Checks the key from an invite link.
   * @param {string} key @returns {'ok'|'expired'|'invalid'}
   */
  check(key) {
    if (safeEqual(key, this.key)) return 'ok';
    return this.previousKey && safeEqual(key, this.previousKey) ? 'expired' : 'invalid';
  }

  /**
   * A ticket for participant `pid` to rejoin with. A guest who rejoins with a ticket keeps its
   * family and expiry, so a ticket can't be renewed forever.
   * @param {string} pid @param {{family: string, exp: number}|null} [from] the ticket they rejoined with
   */
  ticket(pid, from = null) {
    const family = from?.family || pid;
    const exp = from?.exp || Date.now() + TICKET_HOURS * 3600_000;
    this.families.set(pid, family);
    const body = `${family}.${exp}`;
    return `${body}.${this.sign(body)}`;
  }

  /** @param {unknown} ticket @returns {{family: string, exp: number}|null} */
  checkTicket(ticket) {
    if (typeof ticket !== 'string') return null;
    const m = /^([\w-]{1,64})\.(\d{1,15})\.([\w-]{43})$/.exec(ticket);
    if (!m || !safeEqual(m[3], this.sign(`${m[1]}.${m[2]}`))) return null;
    const exp = Number(m[2]);
    if (exp < Date.now() || this.revoked.has(m[1])) return null;
    return { family: m[1], exp };
  }

  /** Stops participant `pid` (removed by the producer) from rejoining with their ticket. @param {string} pid */
  revoke(pid) {
    const family = this.families.get(pid);
    if (family) this.revoked.add(family);
  }

  /** @param {string} body */
  sign(body) { return createHmac('sha256', /** @type {string} */ (this.config.rejoinSecret)).update(body).digest('base64url'); }

  stop() { if (this.timer) clearTimeout(this.timer); }
}
