// Layout engine + canvas compositor shared by the program output and the host's preview.
// All geometry is computed on a 1920x1080 reference frame and scaled to the canvas.

export const REF_W = 1920;
export const REF_H = 1080;
const MARGIN = 48;
const GAP = 16;
const TICKER_H = 60;
const BANNER = { size: 40, lineH: 52, padX: 32, padY: 20 };

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 * @typedef {{key: string, pid: string|null, kind: 'camera'|'screen'|'content', rect: Rect, fit: 'cover'|'contain', small?: boolean, nameRight?: boolean, source?: string}} Tile
 */

// Layouts used when only guests are shown (they fill the frame).
export const GUEST_LAYOUTS = ['solo', 'grid', 'spotlight', 'sidebyside'];
// Layouts used while content is shown (a guest's screen share or an OBS source).
export const CONTENT_LAYOUTS = ['sides', 'right', 'pip', 'full'];

/** Fits a 16:9 box inside `area`, centered. @param {Rect} area @returns {Rect} */
function fit169(area) {
  let w = area.w, h = (w * 9) / 16;
  if (h > area.h) { h = area.h; w = (h * 16) / 9; }
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/** Lays out n 16:9 tiles as large as possible inside `area`. @param {number} n @param {Rect} area @returns {Rect[]} */
export function gridRects(n, area, gap = GAP) {
  if (n <= 0) return [];
  let best = { cols: 1, rows: n, w: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((area.w - (cols - 1) * gap) / cols, (((area.h - (rows - 1) * gap) / rows) * 16) / 9);
    if (w > best.w) best = { cols, rows, w };
  }
  const { cols, rows, w } = best;
  const h = (w * 9) / 16;
  const totalH = rows * h + (rows - 1) * gap;
  const rects = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * w + (inRow - 1) * gap;
    const x0 = area.x + (area.w - rowW) / 2;
    const y = area.y + (area.h - totalH) / 2 + r * (h + gap);
    for (let c = 0; c < inRow; c++) rects.push({ x: x0 + c * (w + gap), y, w, h });
  }
  return rects;
}

/** Stacks n 16:9 tiles vertically inside a column, centered. @param {number} n @param {Rect} col */
function columnRects(n, col, gap = GAP) {
  if (n <= 0) return [];
  let w = col.w, h = (w * 9) / 16;
  const maxH = (col.h - (n - 1) * gap) / n;
  if (h > maxH) { h = maxH; w = (h * 16) / 9; }
  const totalH = n * h + (n - 1) * gap;
  return Array.from({ length: n }, (_, i) => ({ x: col.x + (col.w - w) / 2, y: col.y + (col.h - totalH) / 2 + i * (h + gap), w, h }));
}

/**
 * Stacks n tiles in a side column, letting them grow taller than 16:9 (up to 3:4 portrait)
 * so a few guests beside the content use the full height. @param {number} n @param {Rect} col
 */
function sideColumnRects(n, col, gap = GAP) {
  if (n <= 0) return [];
  const h = Math.min((col.h - (n - 1) * gap) / n, (col.w * 4) / 3);
  const totalH = n * h + (n - 1) * gap;
  return Array.from({ length: n }, (_, i) => ({ x: col.x, y: col.y + (col.h - totalH) / 2 + i * (h + gap), w: col.w, h }));
}

/**
 * What content (if any) is on screen. Uses the server's `content` field; older states only
 * have `featuredScreen`.
 * @param {any} state @param {Map<string, any>} byId
 * @returns {{kind: 'screen', pid: string} | {kind: 'obs', source: string} | null}
 */
function activeContent(state, byId) {
  const c = state.content !== undefined ? state.content : (state.featuredScreen ? { kind: 'screen', pid: state.featuredScreen } : null);
  if (!c) return null;
  if (c.kind === 'screen') return byId.get(c.pid)?.screen ? c : null;
  if (c.kind === 'obs' && c.source) return c;
  return null;
}

/**
 * Decides where every visible video goes. Guests who are on stage but hidden are left out
 * (their audio stays in the program), and the layout adapts to the number shown.
 * With content showing, the content layout is used; otherwise the guest layout.
 * @param {any} state public studio state from the server
 * @returns {Tile[]}
 */
export function computeLayout(state) {
  const byId = new Map(state.participants.map((p) => [p.id, p]));
  const shown = state.stage.map((id) => byId.get(id)).filter((p) => p && !p.hidden);
  const cams = shown.map((p) => ({ key: `${p.id}:camera`, pid: p.id, kind: /** @type {'camera'} */ ('camera') }));
  const area = { x: MARGIN, y: MARGIN, w: REF_W - 2 * MARGIN, h: REF_H - 2 * MARGIN };
  /** @type {Tile[]} */
  const tiles = [];
  const camTiles = (/** @type {Rect[]} */ rects, list = cams, extra = {}) =>
    rects.forEach((rect, i) => tiles.push({ ...list[i], rect, fit: 'cover', ...extra }));

  const content = activeContent(state, byId);
  if (content) {
    /** @type {Omit<Tile, 'rect'>} */
    const contentTile = content.kind === 'screen'
      ? { key: `${content.pid}:screen`, pid: content.pid, kind: 'screen', fit: 'contain' }
      : { key: `content:${content.source}`, pid: null, kind: 'content', fit: 'contain', source: content.source };
    let layout = CONTENT_LAYOUTS.includes(state.studio.contentLayout) ? state.studio.contentLayout : 'sides';
    if (!cams.length) layout = 'full';

    if (layout === 'full') {
      tiles.push({ ...contentTile, rect: fit169(area) });
      return tiles;
    }
    if (layout === 'pip') {
      // Slot 1 sits in the top-left corner and the other guests stack down the right edge from
      // the top, shrinking (no wider than 16:9) when there are many. The content fills the middle,
      // centered between the two columns so it stays put as guests come and go. Guests to the
      // right of the content have their name tags on the right of their video (`nameRight`).
      const colW = 288, maxH = (colW * 3) / 4;
      tiles.push({ ...contentTile, rect: fit169({ x: area.x + colW + GAP, y: area.y, w: area.w - 2 * (colW + GAP), h: area.h }) });
      tiles.push({ ...cams[0], rect: { x: area.x, y: area.y, w: colW, h: maxH }, fit: 'cover', small: true });
      const rest = cams.slice(1);
      const h = Math.min(maxH, (area.h - (rest.length - 1) * GAP) / Math.max(1, rest.length));
      const w = Math.min(colW, (h * 16) / 9);
      rest.forEach((c, i) => tiles.push({ ...c, rect: { x: area.x + area.w - w, y: area.y + i * (h + GAP), w, h }, fit: 'cover', small: true, nameRight: true }));
      return tiles;
    }
    if (layout === 'right') {
      const sideW = 360;
      tiles.push({ ...contentTile, rect: fit169({ x: area.x, y: area.y, w: area.w - sideW - GAP, h: area.h }) });
      camTiles(columnRects(cams.length, { x: area.x + area.w - sideW, y: area.y, w: sideW, h: area.h }), cams, { nameRight: true });
      return tiles;
    }
    // 'sides': content centered, guests split into a column on either side. The content stays
    // centered (and the columns symmetric) whatever the guest count, so it doesn't jump around.
    const perSide = Math.ceil(cams.length / 2);
    const colW = perSide <= 2 ? 336 : perSide === 3 ? 300 : 240;
    const left = cams.slice(0, perSide), right = cams.slice(perSide);
    tiles.push({ ...contentTile, rect: fit169({ x: area.x + colW + GAP, y: area.y, w: area.w - 2 * (colW + GAP), h: area.h }) });
    camTiles(sideColumnRects(left.length, { x: area.x, y: area.y, w: colW, h: area.h }), left);
    camTiles(sideColumnRects(right.length, { x: area.x + area.w - colW, y: area.y, w: colW, h: area.h }), right, { nameRight: true });
    return tiles;
  }

  if (!cams.length) return tiles;
  const layout = GUEST_LAYOUTS.includes(state.studio.layout) ? state.studio.layout : 'grid';
  if (layout === 'solo') { camTiles([fit169(area)], cams.slice(0, 1)); return tiles; }
  if (layout === 'spotlight' && cams.length > 1) {
    const sideW = 400;
    camTiles([fit169({ x: area.x, y: area.y, w: area.w - sideW - GAP, h: area.h })], cams.slice(0, 1));
    camTiles(columnRects(cams.length - 1, { x: area.x + area.w - sideW, y: area.y, w: sideW, h: area.h }), cams.slice(1));
    return tiles;
  }
  if (layout === 'sidebyside' && cams.length > 1 && cams.length <= 4) {
    const w = (area.w - (cams.length - 1) * GAP) / cams.length;
    const h = Math.min(area.h, w * 1.25);
    camTiles(cams.map((_, i) => ({ x: area.x + i * (w + GAP), y: area.y + (area.h - h) / 2, w, h })));
    return tiles;
  }
  camTiles(gridRects(cams.length, area));
  return tiles;
}

/**
 * The rectangle (on the 1920x1080 reference frame) where an OBS source should be drawn,
 * or null when no OBS-source content is showing.
 * @param {any} state
 * @returns {{source: string, rect: Rect}|null}
 */
export function obsContentRect(state) {
  const t = computeLayout(state).find((x) => x.kind === 'content');
  return t ? { source: /** @type {string} */ (t.source), rect: t.rect } : null;
}

/** @param {string} name */
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * Draws the studio onto a canvas every animation frame.
 */
export class StageRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   video: (pid: string, kind: 'camera'|'screen') => HTMLVideoElement|null,
   *   clip?: () => HTMLVideoElement|null,
   * }} sources
   * @param {{contentMode?: 'hole'|'placeholder'}} [options] How OBS-source content is drawn:
   *   'hole' leaves its area transparent (the OBS plugin draws the source underneath);
   *   'placeholder' draws a labelled box (producer preview).
   */
  constructor(canvas, sources, options = {}) {
    this.canvas = canvas;
    this.contentMode = options.contentMode || 'placeholder';
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: this.contentMode === 'hole' }));
    /** Where OBS-source content currently is (animated), or null. @type {{rect: Rect, source: string, alpha: number}|null} */
    this.contentNow = null;
    this.sources = sources;
    this.state = null;
    /** @type {Map<string, {rect: Rect, alpha: number, target: Tile, leaving?: boolean}>} */
    this.anim = new Map();
    /** @type {Map<string, HTMLImageElement>} */
    this.images = new Map();
    this.tickerX = 0;
    this.lastFrame = performance.now();
    this.running = false;
    /** Called after each frame is drawn. @type {(() => void)|null} */
    this.afterDraw = null;
  }

  /** @param {any} state */
  setState(state) {
    this.state = state;
    const tiles = computeLayout(state);
    const keys = new Set(tiles.map((t) => t.key));
    for (const t of tiles) {
      const a = this.anim.get(t.key);
      if (a) { a.target = t; a.leaving = false; }
      else this.anim.set(t.key, { rect: { ...t.rect }, alpha: 0, target: t });
    }
    for (const [k, a] of this.anim) if (!keys.has(k)) a.leaving = true;
  }

  /** @param {string|null} assetId */
  image(assetId) {
    if (!assetId || !this.state) return null;
    const asset = this.state.studio.assets.find((x) => x.id === assetId);
    if (!asset) return null;
    let img = this.images.get(asset.file);
    if (!img) { img = new Image(); img.src = `/assets/${asset.file}`; this.images.set(asset.file, img); }
    return img.complete && img.naturalWidth ? img : null;
  }

  start(fps = 30) {
    if (this.running) return;
    this.running = true;
    const interval = 1000 / fps;
    let next = performance.now();
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      if (now >= next - 2) { next = Math.max(next + interval, now); this.draw(now); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  /** @param {number} now */
  draw(now) {
    const { canvas, ctx } = this;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const s = canvas.width / REF_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const st = this.state;
    const brand = st?.studio.brand;
    ctx.fillStyle = brand?.background.color || '#14161A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!st) return;
    ctx.setTransform(s, 0, 0, s, 0, 0);

    const bg = this.image(brand.background.image);
    if (bg) drawCover(ctx, bg, bg.naturalWidth, bg.naturalHeight, { x: 0, y: 0, w: REF_W, h: REF_H });

    // The banner and ticker are drawn over everything; name tags move out of their way.
    const ticker = st.studio.banners.find((b) => b.id === st.studio.activeTicker);
    const banner = st.studio.banners.find((b) => b.id === st.studio.activeBanner);
    const tickerH = ticker ? TICKER_H : 0;
    const logo = this.image(brand.logo);
    const logoBox = logo ? this.logoRect(logo, brand) : null;
    const bannerBox = banner ? this.layoutBanner(banner.text, brand, st.studio.bannerPosition, tickerH, logoBox) : null;
    /** @type {Rect[]} */
    this.overlays = [];
    if (bannerBox) this.overlays.push(bannerBox);
    if (ticker) this.overlays.push({ x: 0, y: REF_H - TICKER_H, w: REF_W, h: TICKER_H });

    // Animate tiles toward their targets.
    const k = 1 - Math.pow(0.0005, dt); // ~0.25s settle
    const byId = new Map(st.participants.map((p) => [p.id, p]));
    const order = [...this.anim.entries()].sort((a, b) => Number(!!a[1].target.small) - Number(!!b[1].target.small));
    this.contentNow = null;
    for (const [key, a] of order) {
      const t = a.target.rect;
      a.rect.x += (t.x - a.rect.x) * k; a.rect.y += (t.y - a.rect.y) * k;
      a.rect.w += (t.w - a.rect.w) * k; a.rect.h += (t.h - a.rect.h) * k;
      a.alpha += ((a.leaving ? 0 : 1) - a.alpha) * k;
      if (a.leaving && a.alpha < 0.02) { this.anim.delete(key); continue; }
      if (a.target.kind === 'content') {
        const alpha = Math.max(0, Math.min(1, a.alpha));
        this.contentNow = { rect: { ...a.rect }, source: a.target.source || '', alpha };
        if (this.contentMode === 'hole') {
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#000';
          ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
          ctx.restore();
        } else {
          ctx.globalAlpha = alpha;
          drawContentPlaceholder(ctx, a.rect, a.target.source || '', brand);
          ctx.globalAlpha = 1;
        }
        continue;
      }
      const p = byId.get(a.target.pid);
      if (!p) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, a.alpha));
      this.drawTile(a.target, a.rect, p, brand, st.studio.showNames);
      ctx.globalAlpha = 1;
    }

    const overlay = this.image(brand.overlay);
    if (overlay) ctx.drawImage(overlay, 0, 0, REF_W, REF_H);

    if (logo && logoBox) ctx.drawImage(logo, logoBox.x, logoBox.y, logoBox.w, logoBox.h);

    if (bannerBox) this.drawBanner(bannerBox, brand);
    if (ticker) this.drawTicker(ticker.text, brand, dt, st.studio.tickerSpeed || 140, st.studio.tickerRepeat !== false);
    else this.tickerX = 0;

    const clip = this.sources.clip?.();
    if (clip && clip.readyState >= 2) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, REF_W, REF_H);
      drawContain(ctx, clip, clip.videoWidth, clip.videoHeight, { x: 0, y: 0, w: REF_W, h: REF_H });
    }
    if (clip && clip.readyState >= 2) this.contentNow = null; // the clip covers everything
    this.afterDraw?.();
  }

  /** @param {Tile} tile @param {Rect} r @param {any} p @param {any} brand @param {boolean} showNames */
  drawTile(tile, r, p, brand, showNames) {
    const ctx = this.ctx;
    const radius = tile.rect.w >= REF_W ? 0 : 12;
    ctx.save();
    roundRect(ctx, r, radius);
    ctx.clip();
    ctx.fillStyle = '#0B0C0E';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const video = this.sources.video(p.id, tile.kind === 'screen' ? 'screen' : 'camera');
    const showVideo = video && video.readyState >= 2 && video.videoWidth > 0 && (tile.kind === 'screen' || p.cam);
    if (showVideo) {
      if (tile.fit === 'contain') drawContain(ctx, video, video.videoWidth, video.videoHeight, r);
      else drawCover(ctx, video, video.videoWidth, video.videoHeight, r);
    } else {
      // Camera off: initials avatar.
      const d = Math.min(r.w, r.h) * 0.36;
      ctx.fillStyle = brand.color;
      ctx.beginPath();
      ctx.arc(r.x + r.w / 2, r.y + r.h / 2, d / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = brand.textColor;
      ctx.font = `500 ${Math.round(d * 0.4)}px ${fontStack(brand.font)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(p.name), r.x + r.w / 2, r.y + r.h / 2 + 1);
    }
    ctx.restore();
    if (showNames && brand.nameStyle !== 'none' && tile.kind === 'camera') this.drawName(p.name, r, brand, !!tile.small, !!tile.nameRight);
  }

  /**
   * Draws a guest's name tag in the tile's bottom corner: bottom left, or bottom right when
   * `right` (guests to the right of the content, so the tag sits on their outer edge).
   * @param {string} name @param {Rect} r @param {any} brand @param {boolean} small @param {boolean} [right]
   */
  drawName(name, r, brand, small, right = false) {
    const ctx = this.ctx;
    const style = brand.nameStyle;
    const size = Math.max(16, Math.min(30, r.h * (small ? 0.1 : 0.055)));
    ctx.font = `500 ${size}px ${fontStack(brand.font)}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const padX = size * 0.6, h = size * 1.7;
    const bar = style === 'accent' ? Math.max(4, size * 0.25) : 0;
    const text = fitText(ctx, name, r.w - 2 * padX - bar - 24);
    const textW = ctx.measureText(text).width;
    const w = textW + 2 * padX + bar;
    const inset = style === 'block' ? 0 : size * 0.5;
    const x = right ? r.x + r.w - inset - w : r.x + inset;
    let y = r.y + r.h - inset - h;
    // Lift the tag above a banner or ticker covering it; if there is no room left in the
    // tile, put it at the top instead.
    const tag = () => ({ x, y, w, h });
    for (let i = 0; i < 3; i++) {
      const hit = (this.overlays || []).find((o) => intersects(o, tag()));
      if (!hit) break;
      y = hit.y - h - size * 0.5;
    }
    if (y < r.y + inset || (this.overlays || []).some((o) => intersects(o, tag()))) y = r.y + inset;
    if (style === 'minimal') {
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#fff';
      ctx.fillText(text, right ? x + w - padX * 0.5 - textW : x + padX * 0.5, y + h / 2);
      ctx.shadowBlur = 0;
      return;
    }
    if (style === 'outline' || style === 'accent') {
      // Dark glass behind white text, edged in the brand color: a full outline, or a bar on
      // the tag's outer side.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      if (style === 'outline') {
        roundRect(ctx, { x, y, w, h }, h / 2); ctx.fill();
        ctx.lineWidth = Math.max(2, size * 0.1);
        ctx.strokeStyle = brand.color;
        ctx.stroke();
      } else {
        roundRect(ctx, { x, y, w, h }, 4); ctx.fill();
        ctx.fillStyle = brand.color;
        ctx.save(); roundRect(ctx, { x, y, w, h }, 4); ctx.clip();
        ctx.fillRect(right ? x + w - bar : x, y, bar, h);
        ctx.restore();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + padX + (right ? 0 : bar), y + h / 2 + 1);
      return;
    }
    ctx.fillStyle = brand.color;
    if (style === 'bubble') { roundRect(ctx, { x, y, w, h }, h / 2); ctx.fill(); }
    else { ctx.save(); roundRect(ctx, r, r.w >= REF_W ? 0 : 12); ctx.clip(); ctx.fillRect(x, y, w, h); ctx.restore(); }
    ctx.fillStyle = brand.textColor;
    ctx.fillText(text, x + padX, y + h / 2 + 1);
  }

  /** Where the logo is drawn. @param {HTMLImageElement} logo @param {any} brand @returns {Rect} */
  logoRect(logo, brand) {
    const r = containRect(logo.naturalWidth, logo.naturalHeight, { x: 0, y: 0, w: 240, h: 135 });
    const right = brand.logoPosition.endsWith('right'), bottom = brand.logoPosition.startsWith('bottom');
    return { x: right ? REF_W - MARGIN - r.w : MARGIN, y: bottom ? REF_H - MARGIN - r.h : MARGIN, w: r.w, h: r.h };
  }

  /**
   * Where the banner goes and how its text wraps. A bottom banner sits above the ticker; a
   * banner that would cover the logo moves past it (below a top logo, above a bottom one).
   * @param {string} text @param {any} brand @param {string} [position] e.g. 'bottom-left', 'top-center'
   * @param {number} [tickerH] @param {Rect|null} [logoBox]
   * @returns {Rect & {lines: string[]}}
   */
  layoutBanner(text, brand, position = 'bottom-left', tickerH = 0, logoBox = null) {
    const ctx = this.ctx;
    ctx.font = `500 ${BANNER.size}px ${fontStack(brand.font)}`;
    const lines = wrapText(ctx, text, REF_W * 0.62).slice(0, 3);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + BANNER.padX * 2;
    const h = lines.length * BANNER.lineH + BANNER.padY * 2;
    const top = position.startsWith('top');
    const x = position.endsWith('right') ? REF_W - MARGIN - w : position.endsWith('center') ? (REF_W - w) / 2 : MARGIN;
    let y = top ? MARGIN : REF_H - MARGIN - tickerH - h;
    if (logoBox && intersects(logoBox, { x, y, w, h })) y = top ? logoBox.y + logoBox.h + GAP : logoBox.y - GAP - h;
    return { x, y, w, h, lines };
  }

  /** @param {Rect & {lines: string[]}} box @param {any} brand */
  drawBanner(box, brand) {
    const ctx = this.ctx;
    const { size, lineH, padX, padY } = BANNER;
    const { x, y, w, h, lines } = box;
    ctx.font = `500 ${size}px ${fontStack(brand.font)}`;
    ctx.fillStyle = brand.color;
    roundRect(ctx, { x, y, w, h }, 10);
    ctx.fill();
    ctx.fillStyle = brand.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, x + padX, y + padY + lineH * (i + 0.5) + 1));
  }

  /**
   * @param {string} text @param {any} brand @param {number} dt @param {number} speed pixels per second
   * @param {boolean} [repeat] copies follow each other across the screen; off, one copy enters
   *   from the right, leaves on the left, and only then comes round again
   */
  drawTicker(text, brand, dt, speed, repeat = true) {
    const ctx = this.ctx;
    const h = TICKER_H, y = REF_H - h;
    ctx.fillStyle = brand.color;
    ctx.fillRect(0, y, REF_W, h);
    ctx.font = `500 30px ${fontStack(brand.font)}`;
    ctx.fillStyle = brand.textColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.save();
    ctx.beginPath(); ctx.rect(0, y, REF_W, h); ctx.clip();
    if (repeat) {
      const unit = text + '     •     ';
      const uw = ctx.measureText(unit).width;
      this.tickerX = (this.tickerX + dt * speed) % uw;
      for (let x = -this.tickerX; x < REF_W; x += uw) ctx.fillText(unit, x, y + h / 2 + 1);
    } else {
      const cycle = REF_W + ctx.measureText(text).width;
      this.tickerX = (this.tickerX + dt * speed) % cycle;
      ctx.fillText(text, REF_W - this.tickerX, y + h / 2 + 1);
    }
    ctx.restore();
  }
}

/**
 * A labelled box standing in for an OBS source the browser can't see.
 * @param {CanvasRenderingContext2D} ctx @param {Rect} r @param {string} source @param {any} brand
 */
export function drawContentPlaceholder(ctx, r, source, brand) {
  ctx.save();
  ctx.fillStyle = '#0B0C0E';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = brand?.color || '#FF991C';
  ctx.lineWidth = 4;
  ctx.setLineDash([18, 12]);
  ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
  ctx.setLineDash([]);
  ctx.fillStyle = '#C9CED6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `500 ${Math.max(18, Math.min(44, r.h * 0.07))}px ${fontStack(brand?.font)}`;
  ctx.fillText(fitText(ctx, source ? `OBS: ${source}` : 'OBS source', r.w - 40), r.x + r.w / 2, r.y + r.h / 2);
  ctx.restore();
}

/** @param {string} font */
export function fontStack(font) {
  const safe = String(font || 'Roboto').replace(/["\\]/g, '');
  return `"${safe}", Roboto, "Segoe UI", system-ui, sans-serif`;
}

/** @param {CanvasRenderingContext2D} ctx @param {Rect} r @param {number} radius */
/** @param {Rect} a @param {Rect} b */
function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function roundRect(ctx, r, radius) {
  ctx.beginPath();
  if (radius <= 0) ctx.rect(r.x, r.y, r.w, r.h);
  else ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

/** @param {number} sw @param {number} sh @param {Rect} r */
function containRect(sw, sh, r) {
  const scale = Math.min(r.w / sw, r.h / sh);
  const w = sw * scale, h = sh * scale;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** @param {CanvasRenderingContext2D} ctx @param {CanvasImageSource} src @param {number} sw @param {number} sh @param {Rect} r */
function drawContain(ctx, src, sw, sh, r) {
  if (!sw || !sh) return;
  const d = containRect(sw, sh, r);
  ctx.drawImage(src, d.x, d.y, d.w, d.h);
}

/** @param {CanvasRenderingContext2D} ctx @param {CanvasImageSource} src @param {number} sw @param {number} sh @param {Rect} r */
function drawCover(ctx, src, sw, sh, r) {
  if (!sw || !sh) return;
  const scale = Math.max(r.w / sw, r.h / sh);
  const cw = r.w / scale, ch = r.h / scale;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, r.x, r.y, r.w, r.h);
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxW */
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxW */
function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const tryLine = line ? line + ' ' + word : word;
    if (ctx.measureText(tryLine).width > maxW && line) { lines.push(line); line = word; }
    else line = tryLine;
  }
  if (line) lines.push(line);
  return lines.map((l) => fitText(ctx, l, maxW));
}
