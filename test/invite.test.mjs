import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Invite } from '../data/app/server/invite.js';

function make(extra = {}) {
  const config = { guestKey: 'first-key', inviteExpiryHours: 1, ...extra };
  const saved = [];
  const invite = new Invite(/** @type {any} */ (config), (p) => saved.push(p));
  return { config, saved, invite };
}

test('a new invite gets an issue time and a rejoin secret, saved to the config', () => {
  const { config, saved, invite } = make();
  assert.ok(config.guestKeyIssuedAt > 0);
  assert.ok(config.rejoinSecret.length > 20);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['guestKeyIssuedAt', 'rejoinSecret']);
  assert.equal(invite.key, 'first-key');
  assert.equal(invite.expiresAt, config.guestKeyIssuedAt + 3600_000);
  invite.stop();
});

test('an expired key is replaced, and the old link is reported as expired', () => {
  const { config, invite } = make({ guestKeyIssuedAt: Date.now() - 2 * 3600_000, rejoinSecret: 's'.repeat(40) });
  assert.notEqual(invite.key, 'first-key');
  assert.equal(invite.check('first-key'), 'expired');
  assert.equal(invite.check('something-else'), 'invalid');
  assert.equal(invite.check(config.guestKey), 'ok');
  invite.stop();
});

test('never-expiring links are kept however old they are', () => {
  const { invite } = make({ inviteExpiryHours: 0, guestKeyIssuedAt: 1, rejoinSecret: 's'.repeat(40) });
  assert.equal(invite.key, 'first-key');
  assert.equal(invite.expiresAt, null);
  invite.stop();
});

test('changing the expiry restarts the clock and rejects other values', () => {
  const { config, invite } = make({ guestKeyIssuedAt: Date.now() - 50 * 60_000, rejoinSecret: 's'.repeat(40) });
  invite.setExpiry(6);
  assert.equal(invite.key, 'first-key');
  assert.ok(Math.abs(invite.expiresAt - (Date.now() + 6 * 3600_000)) < 1000);
  assert.throws(() => invite.setExpiry(3));
  assert.equal(config.inviteExpiryHours, 6);
  invite.stop();
});

test('rejoin tickets survive a new link, keep their family, and can be revoked', () => {
  const { invite } = make();
  const t1 = invite.ticket('guest-1');
  invite.rotate();
  const back = invite.checkTicket(t1);
  assert.equal(back?.family, 'guest-1');
  const t2 = invite.ticket('guest-2', back);
  assert.equal(invite.checkTicket(t2)?.family, 'guest-1');
  assert.equal(invite.checkTicket(t1.slice(0, -2) + 'xx'), null, 'tampered ticket');
  invite.revoke('guest-2');
  assert.equal(invite.checkTicket(t1), null);
  assert.equal(invite.checkTicket(t2), null);
  invite.stop();
});
