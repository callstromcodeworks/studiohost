// Producer controls. Add this page to OBS as a Custom Browser Dock
// (Docks → Custom Browser Docks…) using the local URL printed by the server.
import { StudioClient, param } from '../common/client.js';
import { manageLinks } from '../common/peer.js';
import { MediaBank } from '../common/media.js';
import { StageRenderer, initials } from '../common/render.js';
import { $, h, icon, toast, copy, timeOf } from '../common/ui.js';

const client = new StudioClient('host');
const bank = new MediaBank();
/** @type {any} */ let state = null;
/** @type {any} */ let info = null;
const canvas = /** @type {HTMLCanvasElement} */ ($('#preview'));
const renderer = new StageRenderer(canvas, { video: (pid, kind) => bank.video(pid, kind) });
/** @type {any} */ (window).studioHost = { client, bank, renderer };

const act = (/** @type {string} */ action, args = {}) => client.action(action, args).catch((e) => toast(e.message, { error: true }));

// ---- layouts ------------------------------------------------------------
// Two layout families: guests only (they fill the frame), and with content (a screen share or
// an OBS source) where guests are grouped around it. Studio Host switches between the chosen
// layout of each family automatically as content is shown or removed.
const C = 'class="f" opacity=".5"'; // content box
const GUEST_LAYOUTS = [
  ['solo', 'Solo', '<rect class="f" x="8" y="4" width="48" height="28" rx="2"/>'],
  ['grid', 'Group', '<rect class="f" x="4" y="4" width="27" height="13" rx="1.5"/><rect class="f" x="33" y="4" width="27" height="13" rx="1.5"/><rect class="f" x="4" y="19" width="27" height="13" rx="1.5"/><rect class="f" x="33" y="19" width="27" height="13" rx="1.5"/>'],
  ['spotlight', 'Leader', '<rect class="f" x="4" y="4" width="40" height="28" rx="2"/><rect class="f" x="47" y="6" width="13" height="7.5" rx="1"/><rect class="f" x="47" y="14.5" width="13" height="7.5" rx="1"/><rect class="f" x="47" y="23" width="13" height="7.5" rx="1"/>'],
  ['sidebyside', 'Side by side', '<rect class="f" x="4" y="4" width="27" height="28" rx="2"/><rect class="f" x="33" y="4" width="27" height="28" rx="2"/>'],
];
const CONTENT_LAYOUTS = [
  ['sides', 'Guests on sides', `<rect class="f" x="3" y="3" width="10" height="8" rx="1"/><rect ${C} x="15" y="8" width="34" height="20" rx="1.5"/><rect class="f" x="51" y="3" width="10" height="7" rx="1"/><rect class="f" x="51" y="12" width="10" height="7" rx="1"/><rect class="f" x="51" y="21" width="10" height="7" rx="1"/>`],
  ['right', 'Guests right', `<rect ${C} x="4" y="6" width="42" height="24" rx="2"/><rect class="f" x="48" y="8" width="12" height="7" rx="1"/><rect class="f" x="48" y="17" width="12" height="7" rx="1"/>`],
  ['pip', 'Picture-in-picture', `<rect ${C} x="0" y="0" width="64" height="36"/><rect class="f" x="3" y="3" width="11" height="8" rx="1"/><rect class="f" x="50" y="3" width="11" height="7" rx="1"/><rect class="f" x="50" y="12" width="11" height="7" rx="1"/><rect class="f" x="50" y="21" width="11" height="7" rx="1"/>`],
  ['full', 'Content only', `<rect ${C} x="6" y="4" width="52" height="28" rx="2"/>`],
];
function buildLayouts() {
  const button = (/** @type {string[]} */ [id, label, svg]) => {
    const b = h('button', { title: label, onclick: () => act('layout', { layout: id }) });
    b.dataset.layout = id;
    b.innerHTML = `<svg viewBox="0 0 64 36"><rect class="bg" width="64" height="36" rx="3"/>${svg}</svg>`;
    b.append(label);
    return b;
  };
  $('#layouts').replaceChildren(
    h('div.layout-group', { id: 'guest-layouts' }, h('div.layout-label', null, 'Guests only'), h('div.layout-row', null, ...GUEST_LAYOUTS.map(button))),
    h('div.layout-group', { id: 'content-layouts' }, h('div.layout-label', null, 'With content'), h('div.layout-row', null, ...CONTENT_LAYOUTS.map(button))),
  );
}

/** Content picker: nothing, a guest's screen share, or (inside OBS) any OBS video source. */
function renderContent() {
  const sel = $('#content-select');
  const sharers = state.participants.filter((p) => p.screen);
  const sources = state.obs?.managed ? state.obs.sources || [] : [];
  const c = state.content;
  const current = !c ? '' : c.kind === 'screen' ? `screen:${c.pid}` : `obs:${c.source}`;
  const options = [['', 'None — guests fill the frame'],
    ...sharers.map((p) => [`screen:${p.id}`, `Screen share: ${p.name}`]),
    ...sources.map((n) => [`obs:${n}`, `OBS: ${n}`])];
  // A saved OBS source that is missing from OBS right now still shows, so the choice is visible.
  if (!c && state.studio.obsContent && state.obs?.managed) options.push([`obs:${state.studio.obsContent}`, `OBS: ${state.studio.obsContent} (not found)`]);
  const key = JSON.stringify(options);
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren(...options.map(([v, t]) => h('option', { value: v }, t)));
  }
  if (document.activeElement !== sel) sel.value = current || (state.studio.obsContent && !c ? `obs:${state.studio.obsContent}` : '');
  $('#content-hint').textContent = state.obs?.managed ? '' : 'Run Studio Host inside OBS to show OBS sources here.';
  $('#guest-layouts').classList.toggle('in-use', !c);
  $('#content-layouts').classList.toggle('in-use', !!c);
}
function onContentChange(/** @type {string} */ value) {
  if (!value) return act('content', { kind: 'none' });
  if (value.startsWith('screen:')) return act('content', { kind: 'screen', participant: value.slice(7) });
  return act('content', { kind: 'obs', source: value.slice(4) });
}

// ---- participant cards (keyed so videos keep playing across updates) ------
/** @type {Map<string, any>} */
const cards = new Map();

/** @param {any} p */
function makeCard(p) {
  const video = h('video', { autoplay: true, muted: true, playsInline: true });
  const screenVideo = h('video.screen-thumb.hidden', { autoplay: true, muted: true, playsInline: true });
  const ini = h('div.ini');
  const name = h('div.p-name');
  const flags = h('div.p-flags');
  const stageBtn = h('button.btn.small.primary');
  const screenBtn = h('button.btn.small');
  const muteBtn = h('button.btn.small.icon');
  const hideBtn = h('button.btn.small', { title: 'Hide this guest’s video from the scene (their audio stays on)' });
  const upBtn = h('button.btn.small.icon', { title: 'Move left', onclick: () => move(p.id, -1) }, icon('up'));
  const downBtn = h('button.btn.small.icon', { title: 'Move right', onclick: () => move(p.id, 1) }, icon('down'));
  const moreBtn = h('button.btn.small', { title: 'More options' }, '•••');
  const vol = h('input.vol', { type: 'range', min: '0', max: '2', step: '0.05' });
  const slotSel = h('select');
  const talkback = h('input', { type: 'checkbox' });
  const hostChk = h('input', { type: 'checkbox' });
  const more = h('div.p-more.hidden', null,
    h('div.row', null, h('label', null, 'Volume'), vol),
    h('div.row', null, h('label', null, 'OBS slot'), slotSel),
    h('label.check', { title: 'Guests hear this person, but their audio is left out of the program (useful when your own mic is already an OBS input)' }, talkback, 'Talkback only (not in program audio)'),
    h('label.check', { title: 'Heard by everyone, including backstage guests' }, hostChk, 'Producer (heard backstage)'),
    h('div.row.wrap', null,
      h('button.btn.small', { onclick: () => { const n = prompt('Display name', cur().name); if (n) act('rename', { participant: p.id, name: n }); } }, 'Rename'),
      h('button.btn.small', { onclick: () => { act('requestMedia', { participant: p.id, what: 'mic' }); toast('Asked to unmute'); } }, 'Ask to unmute'),
      h('button.btn.small', { onclick: () => { act('requestMedia', { participant: p.id, what: 'cam' }); toast('Asked to turn on camera'); } }, 'Ask for camera'),
      h('button.btn.small', { onclick: () => { setChatTo(p.id); showTab('chat'); } }, 'Message'),
      h('button.btn.small.danger', { onclick: () => { if (confirm(`Remove ${cur().name} from the studio?`)) act('kick', { participant: p.id }); } }, 'Remove')),
  );
  const el = h('div.person.card', null,
    h('div.thumb', null, video, ini, screenVideo),
    h('div.p-info', null, name, flags, h('div.p-actions', null, stageBtn, hideBtn, screenBtn, muteBtn, upBtn, downBtn, moreBtn)),
    more);
  const cur = () => state.participants.find((x) => x.id === p.id) || p;

  stageBtn.addEventListener('click', () => act('stage', { participant: p.id, on: !cur().onStage }));
  screenBtn.addEventListener('click', () => act('featureScreen', { participant: state.featuredScreen === p.id ? null : p.id }));
  muteBtn.addEventListener('click', () => act('hostMute', { participant: p.id, on: !cur().hostMuted }));
  hideBtn.addEventListener('click', () => act('hide', { participant: p.id, on: !cur().hidden }));
  moreBtn.addEventListener('click', () => more.classList.toggle('hidden'));
  vol.addEventListener('change', () => act('volume', { participant: p.id, volume: Number(vol.value) }));
  slotSel.addEventListener('change', () => act('slot', { participant: p.id, slot: slotSel.value === '' ? null : Number(slotSel.value) }));
  talkback.addEventListener('change', () => act('programAudio', { participant: p.id, on: !talkback.checked }));
  hostChk.addEventListener('change', () => act('markHost', { participant: p.id, on: hostChk.checked }));

  const card = {
    el,
    update(/** @type {any} */ q) {
      name.textContent = q.name;
      ini.textContent = initials(q.name);
      const flagList = [];
      if (q.isHost) flagList.push(['Producer', 'acc']);
      if (!q.mic) flagList.push(['Mic off', 'bad']);
      if (!q.cam) flagList.push(['Camera off', 'bad']);
      if (q.hostMuted) flagList.push(['Muted by you', 'bad']);
      if (q.screen) flagList.push(['Sharing screen', 'acc']);
      if (!q.programAudio) flagList.push(['Talkback', '']);
      if (q.slot) flagList.push([`Slot ${q.slot}`, '']);
      if (q.onStage && q.hidden) flagList.push(['Hidden', 'bad']);
      const conn = state.connections?.[q.id];
      if (!state.programOnline) { /* nothing to connect to yet */ }
      else if (!conn || ['new', 'connecting', 'checking'].includes(conn.state)) flagList.push(['Connecting…', '']);
      else if (conn.state === 'failed' || conn.state === 'disconnected') flagList.push(['Connection problem', 'bad']);
      else if (conn.local === 'relay' || conn.remote === 'relay') flagList.push(['Via TURN', '']);
      if (conn && conn.state === 'connected') {
        const parts = [];
        if (q.cam && conn.height) parts.push(`${conn.height}p`);
        if (conn.videoKbps != null && q.cam) parts.push(kbps(conn.videoKbps));
        if (conn.audioKbps != null && q.mic) parts.push(`audio ${kbps(conn.audioKbps)}`);
        // Below ~250 kbps a camera looks soft; flag it so the producer can ask the guest about it.
        if (parts.length) flagList.push([parts.join(' · '), q.cam && conn.videoKbps != null && conn.videoKbps < 250 ? 'bad' : '']);
      }
      flags.replaceChildren(...flagList.map(([t, c]) => h(`span.flag${c ? '.' + c : ''}`, null, t)));
      hideBtn.classList.toggle('hidden', !q.onStage);
      hideBtn.textContent = q.hidden ? 'Show' : 'Hide';
      hideBtn.classList.toggle('on', !!q.hidden);
      stageBtn.textContent = q.onStage ? 'Remove' : 'Add to stage';
      stageBtn.className = `btn small ${q.onStage ? '' : 'primary'}`;
      screenBtn.classList.toggle('hidden', !q.screen);
      screenBtn.textContent = state.featuredScreen === q.id ? 'Stop showing screen' : 'Show screen';
      screenBtn.classList.toggle('on', state.featuredScreen === q.id);
      muteBtn.replaceChildren(icon(q.hostMuted ? 'micOff' : 'mic'));
      muteBtn.title = q.hostMuted ? 'Unmute in studio' : 'Mute in studio';
      muteBtn.classList.toggle('off', q.hostMuted);
      upBtn.classList.toggle('hidden', !q.onStage);
      downBtn.classList.toggle('hidden', !q.onStage);
      if (document.activeElement !== vol) vol.value = String(q.volume);
      talkback.checked = !q.programAudio;
      hostChk.checked = q.isHost;
      const slots = state.studio.slots;
      if (slotSel.options.length !== slots + 1) {
        slotSel.replaceChildren(h('option', { value: '' }, 'None'), ...Array.from({ length: slots }, (_, i) => h('option', { value: String(i + 1) }, `Slot ${i + 1}`)));
      }
      slotSel.value = q.slot ? String(q.slot) : '';
      el.classList.toggle('on', q.onStage);
      const cam = bank.stream(q.id, 'camera');
      if (video.srcObject !== cam) { video.srcObject = cam; if (cam) video.play().catch(() => {}); }
      video.classList.toggle('hidden', !cam || !q.cam);
      ini.classList.toggle('hidden', !!cam && q.cam);
      const scr = q.screen ? bank.stream(q.id, 'screen') : null;
      if (screenVideo.srcObject !== scr) { screenVideo.srcObject = scr; if (scr) screenVideo.play().catch(() => {}); }
      screenVideo.classList.toggle('hidden', !scr);
    },
  };
  return card;
}

/** The top-bar invite button needs a working guest address. */
async function updateInvite() {
  const fresh = await client.post('info').catch(() => null);
  if (fresh) info = fresh;
  const b = $('#copy-invite');
  const ready = !!info?.invite;
  b.textContent = ready ? 'Invite link' : 'Finish setup';
  b.title = ready ? 'Copy the guest invite link' : 'Guests can’t join until setup is done';
}

/** @param {number} v */
function kbps(v) { return v >= 1000 ? `${(v / 1000).toFixed(1)} Mbps` : `${v} kbps`; }

/** @param {string} pid @param {number} dir */
function move(pid, dir) {
  const order = [...state.stage];
  const i = order.indexOf(pid), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  act('reorder', { order });
}

function renderPeople() {
  const seen = new Set();
  const onStage = state.stage.map((id) => state.participants.find((p) => p.id === id)).filter(Boolean);
  const back = state.participants.filter((p) => !p.onStage).sort((a, b) => a.joinedAt - b.joinedAt);
  const place = (/** @type {any[]} */ list, /** @type {HTMLElement} */ container) => {
    const els = list.map((p) => {
      seen.add(p.id);
      let card = cards.get(p.id);
      if (!card) { card = makeCard(p); cards.set(p.id, card); }
      card.update(p);
      return card.el;
    });
    // Only touch the DOM when order/membership changed (keeps focus and playback).
    const same = els.length === container.children.length && els.every((el, i) => container.children[i] === el);
    if (!same) container.replaceChildren(...els);
  };
  place(onStage, $('#on-stage'));
  place(back, $('#backstage'));
  for (const [id, card] of cards) if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
  $('#stage-count').textContent = onStage.length ? `${onStage.length}` : 'Nobody on stage';
  $('#back-count').textContent = back.length ? `${back.length}` : '';
  $('#no-guests').classList.toggle('hidden', state.participants.length > 0);
}

// ---- banners ------------------------------------------------------------
function renderBanners() {
  const s = state.studio;
  $('#banner-list').replaceChildren(...s.banners.map((b) => {
    const active = b.ticker ? s.activeTicker === b.id : s.activeBanner === b.id;
    return h(`div.item${active ? '.active' : ''}`, null,
      h('div.text', null, b.ticker ? h('span.flag', null, 'Ticker') : null, ' ', b.text),
      h(`button.btn.small${active ? '.on' : ''}`, { onclick: () => act('bannerShow', { id: b.id }) }, active ? 'Hide' : 'Show'),
      h('button.btn.small.icon', { title: 'Edit', onclick: () => {
        const text = prompt('Banner text', b.text);
        if (text !== null) act('bannerSave', { id: b.id, text, ticker: b.ticker });
      } }, '✎'),
      h('button.btn.small.icon', { title: 'Delete', onclick: () => act('bannerDelete', { id: b.id }) }, icon('trash')));
  }));
  if (!s.banners.length) $('#banner-list').append(h('p.muted.small', null, 'Saved banners appear here. Click Show to put one on screen.'));
  const speed = $('#ticker-speed');
  if (document.activeElement !== speed) speed.value = String(s.tickerSpeed || 140);
  const pos = $('#banner-pos');
  if (document.activeElement !== pos) pos.value = s.bannerPosition || 'bottom-left';
  $('#ticker-repeat').checked = s.tickerRepeat !== false;
}

// ---- brand --------------------------------------------------------------
function renderBrand() {
  const b = state.studio.brand;
  const setIfIdle = (/** @type {string} */ sel, /** @type {string} */ v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
  setIfIdle('#b-color', b.color);
  setIfIdle('#b-text', b.textColor);
  setIfIdle('#b-bg', b.background.color);
  setIfIdle('#b-style', b.nameStyle);
  setIfIdle('#b-font', b.font);
  setIfIdle('#b-logopos', b.logoPosition);
  $('#b-names').checked = state.studio.showNames;
  const images = state.studio.assets.filter((a) => a.kind === 'image');
  for (const [sel, value] of [['#b-logo', b.logo], ['#b-bgimg', b.background.image], ['#b-overlay', b.overlay]]) {
    const el = $(sel);
    el.replaceChildren(h('option', { value: '' }, 'None'), ...images.map((a) => h('option', { value: a.id }, a.name)));
    el.value = value || '';
  }
}
function wireBrand() {
  const send = (/** @type {any} */ brand) => act('brand', { brand });
  $('#b-color').addEventListener('change', (e) => send({ color: e.target.value }));
  $('#b-text').addEventListener('change', (e) => send({ textColor: e.target.value }));
  $('#b-bg').addEventListener('change', (e) => send({ background: { color: e.target.value } }));
  $('#b-style').addEventListener('change', (e) => send({ nameStyle: e.target.value }));
  $('#b-font').addEventListener('change', (e) => send({ font: e.target.value }));
  $('#b-logopos').addEventListener('change', (e) => send({ logoPosition: e.target.value }));
  $('#b-logo').addEventListener('change', (e) => send({ logo: e.target.value || null }));
  $('#b-bgimg').addEventListener('change', (e) => send({ background: { image: e.target.value || null } }));
  $('#b-overlay').addEventListener('change', (e) => send({ overlay: e.target.value || null }));
  $('#b-names').addEventListener('change', (e) => act('showNames', { on: e.target.checked }));
  $('#ticker-speed').addEventListener('input', (e) => act('tickerSpeed', { speed: Number(e.target.value) }));
  $('#ticker-repeat').addEventListener('change', (e) => act('tickerRepeat', { on: e.target.checked }));
  $('#banner-pos').addEventListener('change', (e) => act('bannerPosition', { position: e.target.value }));
}

// ---- media library --------------------------------------------------------
function renderMedia() {
  const s = state.studio;
  const clip = state.clip && s.assets.find((a) => a.id === state.clip.asset);
  const now = $('#clip-now');
  now.classList.toggle('hidden', !clip);
  if (clip) now.replaceChildren(h('span.dot', { style: { color: '#EF5350' } }), h('span.grow', null, `Playing: ${clip.name}`), h('button.btn.small', { onclick: () => act('clipStop') }, icon('stop'), 'Stop'));
  $('#asset-list').replaceChildren(...s.assets.map((a) => {
    const url = `/assets/${a.file}`;
    const thumb = a.kind === 'image' ? h('img', { src: url, alt: '' }) : h('video', { src: url, muted: true, preload: 'metadata' });
    const used = [];
    if (s.brand.logo === a.id) used.push('Logo');
    if (s.brand.background.image === a.id) used.push('Background');
    if (s.brand.overlay === a.id) used.push('Overlay');
    const actions = a.kind === 'image'
      ? [
          h('button.btn.small', { onclick: () => act('brand', { brand: { logo: s.brand.logo === a.id ? null : a.id } }) }, s.brand.logo === a.id ? 'Unset logo' : 'Logo'),
          h('button.btn.small', { onclick: () => act('brand', { brand: { background: { image: s.brand.background.image === a.id ? null : a.id } } }) }, s.brand.background.image === a.id ? 'Unset bg' : 'Background'),
          h('button.btn.small', { onclick: () => act('brand', { brand: { overlay: s.brand.overlay === a.id ? null : a.id } }) }, s.brand.overlay === a.id ? 'Unset overlay' : 'Overlay'),
        ]
      : [h('button.btn.small.primary', { onclick: () => act('clipPlay', { asset: a.id }) }, icon('play'), 'Play')];
    return h('div.item', null, thumb,
      h('div.text', null, h('div', null, a.name), used.length ? h('div.muted.small', null, used.join(', ')) : null,
        h('div.row.wrap', { style: { marginTop: '4px' } }, ...actions)),
      h('button.btn.small.icon', { title: 'Delete', onclick: () => { if (confirm(`Delete ${a.name}?`)) act('assetDelete', { asset: a.id }); } }, icon('trash')));
  }));
  if (!s.assets.length) $('#asset-list').append(h('p.muted.small', null, 'Upload logos, backgrounds, overlays, and video clips (intros, outros, b-roll).'));
}
// ---- widgets (OBS Browser Sources in the Studio scene) ----------------------
function renderWidgets() {
  const s = state.studio;
  const managed = !!state.obs?.managed;
  $('#widget-list').replaceChildren(...(s.widgets || []).map((w) => h(`div.item${w.visible ? '.active' : ''}`, null,
    h('div.text', null, w.name),
    h(`button.btn.small${w.visible ? '.on' : ''}`, { onclick: () => act('widgetShow', { id: w.id, on: !w.visible }) }, w.visible ? 'Hide' : 'Show'),
    h('button.btn.small.icon', { title: 'Edit', onclick: () => {
      const name = prompt('Widget name', w.name);
      if (name === null) return;
      // The saved link isn't sent to pages (it contains an account token): blank keeps it.
      const url = prompt('Widget link (leave blank to keep the current one)', '');
      if (url === null) return;
      act('widgetSave', { id: w.id, name, ...(url.trim() ? { url } : {}) });
    } }, '✎'),
    h('button.btn.small.icon', { title: 'Delete', onclick: () => { if (confirm(`Remove ${w.name}? Its Browser Source is removed from OBS too.`)) act('widgetDelete', { id: w.id }); } }, icon('trash')))));
  if (!s.widgets?.length) $('#widget-list').append(h('p.muted.small', null, managed ? 'No widgets yet.' : 'Widgets need the Studio Host OBS plugin.'));
}

async function handleUpload(/** @type {FileList} */ files) {
  const prog = $('#upload-progress');
  for (const file of files) {
    prog.classList.remove('hidden');
    try {
      await client.upload(file, (f) => { prog.textContent = `Uploading ${file.name}… ${Math.round(f * 100)}%`; });
      toast(`Uploaded ${file.name}`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  prog.classList.add('hidden');
}

// ---- chat -----------------------------------------------------------------
let unread = 0;
/** @param {string|null} to */
function setChatTo(to) { $('#chat-to').value = to || ''; }
function renderChatTargets() {
  const sel = $('#chat-to');
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'Everyone in studio'), ...state.participants.map((p) => h('option', { value: p.id }, `Only ${p.name}`)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}
/** @param {any} m */
function addChat(m) {
  const log = $('#chat-log');
  const to = m.to === null ? '' : m.to === 'host' ? ' → producers' : ` → ${state?.participants.find((p) => p.id === m.to)?.name || 'guest'}`;
  log.append(h(`div.chat-msg${m.to !== null ? '.private' : ''}${m.fromId === client.id ? '.mine' : ''}`, null,
    h('div.who', null, `${m.from}${to} · ${timeOf(m.ts)}`), h('div', null, m.text)));
  log.scrollTop = log.scrollHeight;
  if (currentTab !== 'chat' && m.fromId !== client.id) { unread++; $('#chat-badge').textContent = String(unread); $('#chat-badge').classList.remove('hidden'); }
}

// ---- setup tab --------------------------------------------------------------
function renderSetup() {
  if (!info) return;
  const linkBox = (/** @type {string} */ label, /** @type {string} */ url, /** @type {string} */ hint) =>
    h('div.link-box', null, h('div.row', null, h('strong.grow', null, label), h('button.btn.small', { onclick: () => copy(url) }, icon('copy'), 'Copy')), h('code', null, url), hint ? h('div.muted.small', null, hint) : null);
  const notes = [];
  const slotCount = h('input', { type: 'number', min: '1', max: '16', value: String(state?.studio.slots ?? 4), style: { width: '80px' } });
  slotCount.addEventListener('change', () => act('slots', { count: Number(slotCount.value) }));
  const obsBtn = h('button.btn.primary', { onclick: async () => {
    obsBtn.disabled = true;
    try { const r = await client.post('obs-setup'); toast(r.message, { ms: 8000 }); }
    catch (e) { toast(e.message, { error: true, ms: 9000 }); }
    obsBtn.disabled = false;
  } }, info.managed ? 'Create built-in scenes' : 'Create OBS sources');
  const obsSection = info.managed
    ? [
        h('div.row', null, h('span.grow', null, 'Guest slots (one scene and source per slot)'), slotCount),
        h('div.muted.small', null, 'Built-in scenes: "Studio Host: Studio", "Studio Host: Guest Screen Share" and "Studio Host: Guest N". Missing ones are recreated; existing ones are left as you arranged them. Studio Host sources are also in OBS’s Add Source menu.'),
        obsBtn,
      ]
    : [
        h('div.row', null, h('span.grow', null, 'Per-guest slot sources'), slotCount),
        h('div.muted.small', null, 'Running without the OBS plugin. This uses OBS → Tools → WebSocket Server Settings; set obs.password in the config file if authentication is enabled.'),
        obsBtn,
        linkBox('Program (Browser Source)', info.program, `Size ${info.output.width}×${info.output.height}, enable "Control audio via OBS".`),
        linkBox('Guest slot N (Browser Source)', info.slot + '1', 'Replace the number for other slots. Options: &audio=1, &names=1, &source=screen, &fit=contain, &always=1.'),
        linkBox('Guest screen share (Browser Source)', info.feature, ''),
        linkBox('Producer controls (Custom Browser Dock)', info.dock, ''),
      ];
  $('#setup').replaceChildren(
    ...notes.map((n) => h('div.note', null, n)),
    h('h2', null, 'How guests reach you'),
    networkSummary(),
    ...(info.invite ? [
      h('h2', null, 'Invite'),
      linkBox('Guest invite link', info.invite, 'Anyone with this link can join backstage.'),
      linkBox('Join on camera yourself', info.hostJoin, 'Open in a browser with your camera. Keep this private: it carries your host key.'),
      linkBox('Producer controls from another device', info.hostRemote, 'Keep this private: it carries your host key.'),
    ] : []),
    h('h2', null, 'OBS'),
    ...obsSection,
    h('h2', null, 'Connection extras'),
    settingsForm(),
  );
}

/** Setup summary with a button to (re)run the setup wizard. */
let network = null;
function networkSummary() {
  const n = network;
  const box = h('div.stack');
  const openWizard = h('button.btn.primary', { onclick: async () => {
    const r = await client.post('network-open-wizard').catch(() => ({ opened: false }));
    if (!r.opened) window.open('/setup/', '_blank');
  } }, n?.configured ? 'Run setup wizard' : 'Set up now');
  if (!n) { box.append(h('p.muted.small', null, 'Loading…'), openWizard); return box; }
  if (n.remoteOnly) { box.append(h('p.muted.small', null, 'Setup is managed on the OBS computer.')); return box; }
  if (!n.configured) {
    box.append(h('div.note', null, 'Guests can’t join yet. Run the setup wizard to choose how they reach your studio.'), openWizard);
    return box;
  }
  const mode = n.mode === 'auto' ? 'Automatic' : n.settings?.manual?.address === 'lan' ? 'Manual — local network only' : 'Manual';
  const certText = { letsencrypt: 'Let’s Encrypt', files: 'your certificate files', 'self-signed': 'self-signed (guests see a warning)' }[n.certificate?.kind] || 'none yet';
  const problems = (n.steps || []).filter((x) => x.state === 'error' || x.state === 'warn');
  box.append(
    h('div.row.wrap', null, h('strong', null, mode), h(`span.pill.${n.state === 'ready' ? 'ok' : n.state === 'problem' ? 'warn' : ''}`, null, n.state === 'ready' ? 'Working' : n.state === 'problem' ? 'Needs attention' : 'Starting…')),
    n.publicUrl ? h('div.muted.small', null, `Address: ${n.publicUrl}`) : null,
    h('div.muted.small', null, `Certificate: ${certText}${n.certificate?.validTo ? `, valid until ${new Date(n.certificate.validTo).toLocaleDateString()}` : ''}`),
    ...problems.map((p) => h('div.note', null, `${p.label}: ${p.detail}`)),
    h('div.row.wrap', null, openWizard, h('button.btn', { onclick: () => window.open('/setup/?view=status', '_blank') }, 'Show details')),
  );
  return box;
}

/** STUN/TURN servers, max guests and program video caps (apply to both setup modes; no restart). */
function settingsForm() {
  const box = h('div.stack', null, h('p.muted.small', null, 'Loading settings…'));
  client.post('config-get').then((cfg) => {
    const f = (/** @type {string} */ label, /** @type {HTMLElement} */ input, /** @type {string} */ hint = '') =>
      h('label.field', null, label, input, hint ? h('span.muted.small', null, hint) : null);
    const maxGuests = h('input', { type: 'number', min: '1', max: '50', value: String(cfg.maxGuests) });
    const feedEach = h('input', { type: 'number', min: '300', max: '20000', step: '100', value: String(cfg.guestFeed.maxKbps) });
    const feedTotal = h('input', { type: 'number', min: '300', max: '200000', step: '100', value: String(cfg.guestFeed.totalKbps) });
    const feedCodec = h('select', null, h('option', { value: 'auto' }, 'Automatic'), h('option', { value: 'h264' }, 'H.264 (GPU encoder)'));
    /** @type {HTMLSelectElement} */ (feedCodec).value = cfg.guestFeed.codec === 'h264' ? 'h264' : 'auto';
    const ice = h('textarea', { rows: 5, spellcheck: false }, JSON.stringify(cfg.iceServers, null, 2));
    const save = h('button.btn.primary', { type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      let iceServers;
      try { iceServers = JSON.parse(ice.value); } catch { toast('STUN/TURN servers must be valid JSON.', { error: true }); return; }
      save.disabled = true;
      try { toast((await client.post('config-save', {
        maxGuests: Number(maxGuests.value), iceServers,
        guestFeed: { maxKbps: Number(feedEach.value), totalKbps: Number(feedTotal.value), codec: /** @type {HTMLSelectElement} */ (feedCodec).value },
      })).message); }
      catch (e) { toast(e.message, { error: true, ms: 8000 }); }
      save.disabled = false;
    });
    box.replaceChildren(
      f('STUN/TURN servers (JSON)', ice, 'Add a TURN server if guests on strict networks get stuck connecting.'),
      f('Max guests', maxGuests),
      f('Program video per guest (kbps)', feedEach, 'The most any one guest receives. Guests on slower connections get less automatically.'),
      f('Program video for all guests (kbps)', feedTotal, 'Shared by everyone connected. Keep it well under your upload speed minus your stream bitrate.'),
      f('Program video codec', feedCodec, 'Choose H.264 if this computer has a GPU video encoder (most NVIDIA, AMD and Intel GPUs do) to take encoding off the CPU. Applies to guests who connect after saving.'),
      h('div.row', null, h('span.grow'), save),
    );
  }).catch((e) => box.replaceChildren(h('p.muted.small', null, e.message)));
  return box;
}

// ---- OBS scenes and status (when running inside the Studio Host OBS plugin) ----------
function renderObs() {
  const obs = state.obs || {};
  const bar = $('#obs-bar');
  bar.classList.toggle('hidden', !obs.managed);
  if (!obs.managed) return;
  $('#obs-live').classList.toggle('hidden', !obs.streaming);
  $('#obs-rec').classList.toggle('hidden', !obs.recording);
  const scenes = [['studio', 'Studio', null], ['screen', 'Guest screen share', null],
    ...Array.from({ length: state.studio.slots }, (_, i) => ['guest', guestLabel(i + 1), i + 1])];
  const want = scenes.map(([k, , n]) => (n ? `${k}:${n}` : k)).join(',');
  const row = $('#obs-scenes');
  if (row.dataset.keys !== want) {
    row.dataset.keys = want;
    row.replaceChildren(...scenes.map(([kind, label, slot]) => {
      const b = h('button.btn.small', { onclick: () => client.post('obs-scene', { scene: kind, slot }).catch((e) => toast(e.message, { error: true })) }, label);
      b.dataset.builtin = slot ? `${kind}:${slot}` : String(kind);
      return b;
    }));
  }
  for (const b of row.children) {
    const el = /** @type {HTMLElement} */ (b);
    el.classList.toggle('on', el.dataset.builtin === obs.builtin);
    if (el.dataset.builtin?.startsWith('guest:')) el.textContent = guestLabel(Number(el.dataset.builtin.slice(6)));
  }
  $('#obs-scene-hint').textContent = obs.studioMode ? 'Studio mode: buttons set the preview scene.' : '';
}
/** @param {number} slot */
function guestLabel(slot) {
  const p = state.participants.find((x) => x.slot === slot);
  return p ? p.name : `Guest ${slot}`;
}

// ---- tabs -------------------------------------------------------------------
let currentTab = 'chat';
/** @param {string} tab */
function showTab(tab) {
  currentTab = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.tab === tab);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('hidden', /** @type {HTMLElement} */ (t).dataset.tab !== tab);
  if (tab === 'chat') { unread = 0; $('#chat-badge').classList.add('hidden'); $('#chat-input').focus(); }
}

// ---- state --------------------------------------------------------------------
function render() {
  if (!state) return;
  const ps = $('#program-status');
  ps.className = `pill ${state.programOnline ? 'ok' : 'warn'}`;
  ps.textContent = state.programOnline ? 'Program connected' : 'Program offline';
  ps.title = state.programOnline ? 'The program output is running in OBS' : 'The program output is not running — guests need it to connect';
  for (const b of document.querySelectorAll('#layouts button')) {
    const id = /** @type {HTMLElement} */ (b).dataset.layout;
    b.classList.toggle('active', id === state.studio.layout || id === state.studio.contentLayout);
  }
  renderContent();
  renderObs();
  renderPeople();
  renderBanners();
  renderBrand();
  renderMedia();
  renderWidgets();
  renderChatTargets();
}

async function main() {
  buildLayouts();
  $('#content-select').addEventListener('change', (/** @type {any} */ e) => onContentChange(e.target.value));
  wireBrand();
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { showTab(b.dataset.tab); if (b.dataset.tab === 'setup') renderSetup(); } });
  $('#widget-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#widget-name').value.trim(), url = $('#widget-url').value.trim();
    if (!name || !url) { toast('Enter a name and the widget link.', { error: true }); return; }
    try {
      await client.action('widgetSave', { name, url });
      $('#widget-name').value = ''; $('#widget-url').value = '';
    } catch (err) { toast(err.message, { error: true }); }
  });
  $('#banner-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#banner-text').value.trim();
    if (!text) return;
    await act('bannerSave', { text, ticker: $('#banner-ticker').checked });
    $('#banner-text').value = '';
  });
  $('#upload').addEventListener('change', (e) => { handleUpload(e.target.files); e.target.value = ''; });
  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await client.post('chat', { text, to: $('#chat-to').value || null }); }
    catch (err) { toast(err.message, { error: true }); input.value = text; }
  });
  $('#copy-invite').addEventListener('click', async () => {
    if (info?.invite) return copy(info.invite);
    const r = await client.post('network-open-wizard').catch(() => ({ opened: false }));
    if (!r.opened) window.open('/setup/', '_blank');
  });

  try {
    await client.join({ key: param('key') || undefined });
  } catch (e) {
    const f = $('#fatal');
    f.textContent = `Studio Host: ${e.message}`;
    f.classList.remove('hidden');
    setTimeout(() => location.reload(), 5000);
    return;
  }
  manageLinks(client, (link) => { if (link.purpose === 'preview') bank.watch(link); });
  bank.onChange(() => { if (state) renderPeople(); });
  const onState = (/** @type {any} */ st) => {
    state = st;
    bank.setState(st);
    renderer.setState(st);
    render();
  };
  client.on('welcome', (m) => {
    onState(m.state);
    $('#chat-log').replaceChildren();
    m.chat.forEach(addChat);
  });
  client.on('state', (m) => onState(m.state));
  client.on('chat', (m) => addChat(m.message));
  client.on('network', (m) => {
    if (network && !network.remoteOnly && (m.status.seq ?? 0) < (network.seq ?? 0)) return; // older than what we have
    network = m.status; if (currentTab === 'setup') renderSetup(); updateInvite();
  });
  client.on('lost', () => { $('#fatal').textContent = 'Reconnecting to Studio Host…'; $('#fatal').classList.remove('hidden'); setTimeout(() => location.reload(), 3000); });
  renderer.start(15);
  info = await client.post('info').catch(() => null);
  // Setup can only be viewed and changed on the OBS computer.
  const fetched = await client.post('network-status').catch(() => ({ remoteOnly: true }));
  if (!network || (fetched.seq ?? 0) >= (network.seq ?? 0)) network = fetched;
  updateInvite();
  // The Setup tab is rendered when opened (re-rendering on every state change would wipe unsaved edits).
  window.addEventListener('beforeunload', () => client.leave());
}

main();
