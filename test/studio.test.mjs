import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STUDIOHOST_DATA = mkdtempSync(join(tmpdir(), 'studiohost-studio-'));
const { Studio } = await import('../data/app/server/studio.js');
const { formatDuration } = await import('../data/app/public/common/render.js');

function studio() {
  const s = new Studio(/** @type {any} */ ({ output: { width: 1920, height: 1080 } }));
  s.save = () => {};
  return s;
}
/** @param {Studio} s @param {string} name */
const guest = (s, name) => {
  const c = s.addClient({ role: 'guest', name, remote: true });
  clearTimeout(c.dropTimer);
  return c.id;
};

test('guests and the producer can set a headline under the name', () => {
  const s = studio();
  const id = guest(s, 'Ana');
  const client = s.clients.get(id);
  s.updateSelf(client, { headline: '  Founder, Acme Co.  ' });
  assert.equal(s.participants.get(id).headline, 'Founder, Acme Co.');
  s.updateSelf(client, { headline: 'x'.repeat(100) });
  assert.equal(s.participants.get(id).headline.length, 60);
  assert.equal(s.hostAction(null, { action: 'headline', participant: id, headline: 'Host' }), null);
  assert.equal(s.participants.get(id).headline, 'Host');
  s.updateSelf(client, { headline: '' });
  assert.equal(s.participants.get(id).headline, '');
});

test('the timer counts down, pauses, takes extra time and counts up', () => {
  const s = studio();
  assert.match(s.hostAction(null, { action: 'timerStart', mode: 'down', seconds: 0 }), /how long/);
  assert.match(s.hostAction(null, { action: 'timerStart', mode: 'down', seconds: 90000 }), /24 hours/);
  assert.match(s.hostAction(null, { action: 'timerStart', mode: 'down', at: Date.now() - 1000 }), /passed/);
  assert.equal(s.hostAction(null, { action: 'timerStart', mode: 'down', seconds: 300, label: 'Starting soon' }), null);
  const t = s.studio.timer;
  assert.equal(t.label, 'Starting soon');
  assert.ok(Math.abs(t.endsAt - Date.now() - 300_000) < 1000);
  s.hostAction(null, { action: 'timerPause', on: true });
  assert.ok(s.studio.timer.pausedAt);
  const end = s.studio.timer.endsAt;
  s.studio.timer.pausedAt -= 5000; // as if paused 5 s ago
  s.hostAction(null, { action: 'timerPause', on: false });
  assert.equal(s.studio.timer.pausedAt, null);
  assert.ok(Math.abs(s.studio.timer.endsAt - end - 5000) < 50, 'resuming adds the paused time');
  s.hostAction(null, { action: 'timerAdd', seconds: 60 });
  assert.ok(Math.abs(s.studio.timer.endsAt - end - 65_000) < 50);
  s.hostAction(null, { action: 'timerAdd', seconds: -100000 });
  assert.ok(s.studio.timer.endsAt <= Date.now(), 'never below zero');
  assert.equal(s.hotkey('timer', 0), null);
  assert.ok(s.studio.timer.pausedAt, 'hotkey pauses');
  assert.equal(s.hostAction(null, { action: 'timerStart', mode: 'up' }), null);
  assert.match(s.hostAction(null, { action: 'timerAdd', seconds: 60 }), /countdown/);
  assert.equal(s.hostAction(null, { action: 'timerPosition', position: 'bottom-right' }), null);
  assert.ok(s.hostAction(null, { action: 'timerPosition', position: 'middle' }));
  s.hostAction(null, { action: 'timerHide' });
  assert.equal(s.studio.timer, null);
  assert.ok(s.hotkey('timer', 0), 'nothing to pause');
  assert.equal(typeof s.publicState().now, 'number');
});

test('timer text', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(299), '4:59');
  assert.equal(formatDuration(3723), '1:02:03');
});

test('presets save and recall the stage, keeping guests by name', () => {
  const s = studio();
  const ana = guest(s, 'Ana'), ben = guest(s, 'Ben'), cy = guest(s, 'Cy');
  s.hostAction(null, { action: 'bannerSave', text: 'Topic' });
  const banner = s.studio.banners[0].id;
  s.hostAction(null, { action: 'stage', participant: ben, on: true });
  s.hostAction(null, { action: 'stage', participant: ana, on: true });
  s.hostAction(null, { action: 'layout', layout: 'spotlight' });
  s.hostAction(null, { action: 'bannerShow', id: banner });
  assert.equal(s.hostAction(null, { action: 'presetSave', name: 'Interview' }), null);
  const preset = s.studio.presets[0];
  assert.deepEqual(preset.stage, ['Ben', 'Ana']);
  assert.equal(preset.layout, 'spotlight');
  assert.equal(preset.banner, banner);
  assert.deepEqual(preset.content, { kind: 'none' });

  // Change everything, then recall.
  s.hostAction(null, { action: 'stage', participant: ana, on: false });
  s.hostAction(null, { action: 'stage', participant: cy, on: true });
  s.hostAction(null, { action: 'layout', layout: 'grid' });
  s.hostAction(null, { action: 'bannerShow', id: null });
  // Ben left and came back: a new id, the same name.
  s.removeClient(ben);
  const ben2 = guest(s, 'ben');
  assert.equal(s.hostAction(null, { action: 'presetRecall', id: preset.id }), null);
  assert.deepEqual(s.stage, [ben2, ana]);
  assert.equal(s.participants.get(cy).onStage, false);
  assert.equal(s.studio.layout, 'spotlight');
  assert.equal(s.studio.activeBanner, banner);

  // OBS hotkeys recall by number.
  s.hostAction(null, { action: 'stage', participant: cy, on: true });
  assert.equal(s.hotkey('preset', 1), null);
  assert.equal(s.participants.get(cy).onStage, false);
  assert.ok(s.hotkey('preset', 2));

  // A guest who is missing is skipped; a deleted banner is not shown.
  s.removeClient(ana);
  s.hostAction(null, { action: 'bannerDelete', id: banner });
  s.hostAction(null, { action: 'presetRecall', id: preset.id });
  assert.deepEqual(s.stage, [ben2]);
  assert.equal(s.studio.activeBanner, null);

  // Update, rename, reorder, delete.
  s.hostAction(null, { action: 'presetSave', name: 'Solo' });
  s.hostAction(null, { action: 'stage', participant: cy, on: true });
  s.hostAction(null, { action: 'presetUpdate', id: preset.id });
  assert.deepEqual(s.studio.presets[0].stage, ['ben', 'Cy']);
  s.hostAction(null, { action: 'presetRename', id: preset.id, name: 'Panel' });
  s.hostAction(null, { action: 'presetMove', id: preset.id, by: 1 });
  assert.deepEqual(s.studio.presets.map((p) => p.name), ['Solo', 'Panel']);
  assert.ok(s.hostAction(null, { action: 'presetSave', name: ' ' }));
  s.hostAction(null, { action: 'presetDelete', id: preset.id });
  assert.deepEqual(s.studio.presets.map((p) => p.name), ['Solo']);
  assert.ok(s.hostAction(null, { action: 'presetRecall', id: preset.id }));
});

test('a preset brings back a guest’s screen share or an OBS source as content', () => {
  const s = studio();
  s.obs = { managed: true, sources: ['Slides'] };
  const ana = guest(s, 'Ana');
  s.updateSelf(s.clients.get(ana), { screen: true });
  s.hostAction(null, { action: 'content', kind: 'screen', participant: ana });
  s.hostAction(null, { action: 'presetSave', name: 'Demo' });
  s.hostAction(null, { action: 'content', kind: 'obs', source: 'Slides' });
  s.hostAction(null, { action: 'presetSave', name: 'Slides' });
  assert.deepEqual(s.studio.presets.map((p) => p.content), [{ kind: 'screen', name: 'Ana' }, { kind: 'obs', source: 'Slides' }]);
  s.hostAction(null, { action: 'presetRecall', id: s.studio.presets[0].id });
  assert.deepEqual(s.contentState(), { kind: 'screen', pid: ana });
  s.hostAction(null, { action: 'presetRecall', id: s.studio.presets[1].id });
  assert.deepEqual(s.contentState(), { kind: 'obs', source: 'Slides' });
});
