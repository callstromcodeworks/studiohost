import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, gridRects, REF_W, REF_H, obsContentRect, GUEST_LAYOUTS, CONTENT_LAYOUTS } from '../data/app/public/common/render.js';

const person = (id, extra = {}) => ({ id, name: id, cam: true, mic: true, screen: false, streams: {}, ...extra });
const state = (layout, ids, extra = {}) => ({
  studio: { layout }, participants: ids.map((id) => person(id, extra[id])), stage: ids, featuredScreen: extra.featuredScreen ?? null,
});
const inside = (r) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= REF_W + 0.01 && r.y + r.h <= REF_H + 0.01;
const overlap = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

test('grid tiles are 16:9, inside the frame and never overlap', () => {
  for (let n = 1; n <= 12; n++) {
    const rects = gridRects(n, { x: 48, y: 48, w: REF_W - 96, h: REF_H - 96 });
    assert.equal(rects.length, n);
    for (const r of rects) { assert.ok(inside(r)); assert.ok(Math.abs(r.w / r.h - 16 / 9) < 1e-6); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(!overlap(rects[i], rects[j]), `n=${n} tiles ${i},${j} overlap`);
  }
});

test('every layout keeps tiles inside the frame for 0-6 people', () => {
  for (const layout of ['solo', 'grid', 'spotlight', 'sidebyside', 'screen', 'pip']) {
    for (let n = 0; n <= 6; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const tiles = computeLayout(state(layout, ids));
      for (const t of tiles) assert.ok(inside(t.rect), `${layout} n=${n}`);
      if (layout === 'solo') assert.equal(tiles.length, Math.min(n, 1));
      else assert.equal(tiles.length, n, `${layout} n=${n}`);
    }
  }
});

test('screen layout features the shared screen beside the cameras', () => {
  const st = state('screen', ['a', 'b'], { a: { screen: true }, featuredScreen: 'a' });
  const tiles = computeLayout(st);
  const screen = tiles.find((t) => t.kind === 'screen');
  assert.ok(screen);
  assert.equal(screen.fit, 'contain');
  assert.equal(tiles.filter((t) => t.kind === 'camera').length, 2);
  for (const t of tiles) if (t !== screen) assert.ok(!overlap(t.rect, screen.rect));
});

test('screen layout falls back to the grid when nobody shares', () => {
  const tiles = computeLayout(state('screen', ['a', 'b', 'c']));
  assert.deepEqual(tiles.map((t) => t.kind), ['camera', 'camera', 'camera']);
});

test('a featured screen whose owner stopped sharing is ignored', () => {
  const tiles = computeLayout(state('pip', ['a'], { a: { screen: false }, featuredScreen: 'a' }));
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].kind, 'camera');
});

// ---- hidden guests and content layouts ----------------------------------------------------


const studioState = ({ layout = 'grid', contentLayout = 'sides', n = 4, hidden = [], content = null, sharing = [] } = {}) => {
  const ids = Array.from({ length: n }, (_, i) => `g${i}`);
  return {
    studio: { layout, contentLayout },
    participants: ids.map((id) => person(id, { hidden: hidden.includes(id), screen: sharing.includes(id) })),
    stage: ids,
    content,
  };
};
const cameraTiles = (st) => computeLayout(st).filter((t) => t.kind === 'camera');

test('hidden guests are left out and the layout adapts to the guests shown', () => {
  const all = cameraTiles(studioState({ n: 4 }));
  const some = cameraTiles(studioState({ n: 4, hidden: ['g1', 'g2'] }));
  assert.equal(all.length, 4);
  assert.deepEqual(some.map((t) => t.pid), ['g0', 'g3']);
  // Two shown guests get larger tiles than four.
  assert.ok(some[0].rect.w > all[0].rect.w);
  // Two guests are laid out exactly as if only two had joined.
  const two = cameraTiles({ ...studioState({ n: 2 }), stage: ['g0', 'g1'] });
  assert.deepEqual(some.map((t) => t.rect), two.map((t) => t.rect));
  assert.equal(cameraTiles(studioState({ n: 2, hidden: ['g0', 'g1'] })).length, 0);
  assert.equal(computeLayout(studioState({ n: 2, hidden: ['g0', 'g1'], layout: 'solo' })).length, 0);
});

test('solo shows the first guest who is not hidden', () => {
  const tiles = cameraTiles(studioState({ layout: 'solo', n: 3, hidden: ['g0'] }));
  assert.deepEqual(tiles.map((t) => t.pid), ['g1']);
});

test('without content, guests fill the centre; with content, the content layout takes over', () => {
  const plain = computeLayout(studioState({ n: 2, contentLayout: 'sides' }));
  assert.ok(plain.every((t) => t.kind === 'camera'));
  const withContent = computeLayout(studioState({ n: 2, content: { kind: 'obs', source: 'Game' } }));
  assert.equal(withContent.filter((t) => t.kind === 'content').length, 1);
  // A featured screen whose owner stopped sharing counts as no content.
  const stale = computeLayout(studioState({ n: 2, content: { kind: 'screen', pid: 'g0' } }));
  assert.ok(stale.every((t) => t.kind === 'camera'));
  const live = computeLayout(studioState({ n: 2, sharing: ['g0'], content: { kind: 'screen', pid: 'g0' } }));
  assert.equal(live.filter((t) => t.kind === 'screen').length, 1);
});

test('"sides": content centred, guests grouped evenly left and right, nothing overlaps', () => {
  for (let n = 1; n <= 8; n++) {
    const tiles = computeLayout(studioState({ n, content: { kind: 'obs', source: 'S' } }));
    const content = tiles.find((t) => t.kind === 'content');
    const cams = tiles.filter((t) => t.kind === 'camera');
    assert.equal(cams.length, n);
    const cx = content.rect.x + content.rect.w / 2;
    assert.ok(Math.abs(cx - REF_W / 2) < 1, `content centred for n=${n}`);
    const left = cams.filter((t) => t.rect.x + t.rect.w <= content.rect.x);
    const right = cams.filter((t) => t.rect.x >= content.rect.x + content.rect.w);
    assert.equal(left.length + right.length, n, `every guest beside the content for n=${n}`);
    assert.equal(left.length, Math.ceil(n / 2));
    for (const t of tiles) assert.ok(inside(t.rect));
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) assert.ok(!overlap(tiles[i].rect, tiles[j].rect), `n=${n} overlap`);
  }
  // The content stays put as guests come and go (n >= 1, up to 4 per side's width bucket).
  const r1 = obsContentRect(studioState({ n: 1, content: { kind: 'obs', source: 'S' } })).rect;
  const r4 = obsContentRect(studioState({ n: 4, content: { kind: 'obs', source: 'S' } })).rect;
  assert.deepEqual(r1, r4);
});

test('every content layout keeps tiles inside the frame, and no guests means content only', () => {
  for (const contentLayout of CONTENT_LAYOUTS) {
    for (let n = 0; n <= 6; n++) {
      const tiles = computeLayout(studioState({ n, contentLayout, content: { kind: 'obs', source: 'S' } }));
      assert.equal(tiles.filter((t) => t.kind === 'content').length, 1);
      assert.equal(tiles.filter((t) => t.kind === 'camera').length, contentLayout === 'full' ? 0 : n, `${contentLayout} n=${n}`);
      for (const t of tiles) assert.ok(inside(t.rect), `${contentLayout} n=${n}`);
    }
  }
  assert.ok(GUEST_LAYOUTS.every((l) => !CONTENT_LAYOUTS.includes(l)));
});

test('obsContentRect is null for screen-share content and for no content', () => {
  assert.equal(obsContentRect(studioState({ n: 2 })), null);
  assert.equal(obsContentRect(studioState({ n: 2, sharing: ['g0'], content: { kind: 'screen', pid: 'g0' } })), null);
  assert.equal(obsContentRect(studioState({ n: 2, content: { kind: 'obs', source: 'Cam B' } })).source, 'Cam B');
});

test('guests to the right of the content get their name tags on the right', () => {
  for (const contentLayout of ['sides', 'right', 'pip']) {
    for (let n = 1; n <= 6; n++) {
      const tiles = computeLayout(studioState({ n, contentLayout, content: { kind: 'obs', source: 'S' } }));
      const content = tiles.find((t) => t.kind === 'content');
      const cx = content.rect.x + content.rect.w / 2;
      for (const t of tiles.filter((x) => x.kind === 'camera')) {
        assert.equal(!!t.nameRight, t.rect.x + t.rect.w / 2 > cx, `${contentLayout} n=${n}`);
      }
    }
  }
  // Without content, name tags stay on the left.
  assert.ok(computeLayout(studioState({ n: 4 })).every((t) => !t.nameRight));
});
