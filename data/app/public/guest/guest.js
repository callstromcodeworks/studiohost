// Guest page: green room (device check) → studio (backstage / on stage).
import { StudioClient, param } from '../common/client.js';
import { manageLinks, applyEncoding } from '../common/peer.js';
import { $, h, icon, toast, appendChat } from '../common/ui.js';
import { BackgroundBlur, blurSupported } from './blur.js';

const KEY = param('k') || '';
// Optional caps on what this guest sends, in kbps (?maxv=600&maxa=24). Useful for guests on
// metered connections, and used by the tests to simulate weak uplinks.
const capKbps = (/** @type {string} */ name) => { const v = Number(param(name)); return Number.isFinite(v) && v > 0 ? v * 1000 : Infinity; };
const MAX_VIDEO = capKbps('maxv'), MAX_AUDIO = capKbps('maxa');
const camBitrate = Math.min(2_500_000, MAX_VIDEO);
const AS_HOST = param('host') === '1';
const NAME_KEY = 'studiohost.name';
const HEADLINE_KEY = 'studiohost.headline';
const BLUR_KEY = 'studiohost.blur';
const DEV_KEY = 'studiohost.devices';
// Lets this guest back in after a dropped connection, even once the invite link has changed.
const TICKET_KEY = 'studiohost.rejoin';
const storedTicket = () => { try { return sessionStorage.getItem(TICKET_KEY) || undefined; } catch { return undefined; } };
/** @param {string|null} t */
const storeTicket = (t) => { try { if (t) sessionStorage.setItem(TICKET_KEY, t); else sessionStorage.removeItem(TICKET_KEY); } catch { /* ignore */ } };

const client = new StudioClient('guest');
/** @type {any} */ (window).studioHost = { client, get links() { return links; }, get blur() { return blur; } };

// Outgoing media. camStream keeps a stable id for the whole session so the
// studio can tell which incoming stream is the camera; tracks are swapped in place.
const camStream = new MediaStream();
/** @type {MediaStream|null} */ let screenStream = null;
let camOn = true, micOn = true;
/** The camera's own track. With blur on, camStream carries the blurred track made from it. @type {MediaStreamTrack|null} */
let cameraTrack = null;
/** @type {BackgroundBlur|null} */ let blur = null;
/** The camera track a pending blur is being started for. @type {MediaStreamTrack|null} */ let pendingCamera = null;
let blurOn = blurSupported() && stored(BLUR_KEY) === '1';
/** @type {{cam?: string, mic?: string, spk?: string}} */
let devices = loadDevices();
/** @type {Map<string, import('../common/peer.js').PeerLink>} */ let links = new Map();
let joined = false;

const videoTrack = () => camStream.getVideoTracks()[0] || null;
const audioTrack = () => camStream.getAudioTracks()[0] || null;

/** @param {string} key */
function stored(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
/** @param {string} key @param {string} value */
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
function loadDevices() { try { return JSON.parse(localStorage.getItem(DEV_KEY) || '{}'); } catch { return {}; } }
function saveDevices() { try { localStorage.setItem(DEV_KEY, JSON.stringify(devices)); } catch { /* ignore */ } }

// ---- device capture ---------------------------------------------------
/** @param {{video?: boolean, audio?: boolean}} want */
async function capture(want) {
  const constraints = {
    video: want.video ? { deviceId: devices.cam ? { ideal: devices.cam } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
    audio: want.audio ? { deviceId: devices.mic ? { ideal: devices.mic } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** Replaces camera/mic tracks in camStream and on every peer connection. @param {MediaStream} fresh */
async function adoptTracks(fresh) {
  const audio = fresh.getAudioTracks()[0];
  if (audio) {
    const old = audioTrack();
    if (old) { camStream.removeTrack(old); old.stop(); }
    audio.enabled = micOn;
    camStream.addTrack(audio);
    watchLevel();
  }
  const video = fresh.getVideoTracks()[0];
  if (video) await setCamera(video);
  for (const link of links.values()) pushTracks(link);
  if (joined) reportSelf();
}

/**
 * Puts a camera track in camStream: as it is, or blurred when blur is on. With blur on, the
 * camera is only shown once the blurred picture is ready (until then the previous picture
 * stays), so the room never shows unblurred.
 * @param {MediaStreamTrack} camera
 */
async function setCamera(camera) {
  pendingCamera = camera;
  /** @type {MediaStreamTrack} */ let track = camera;
  /** @type {BackgroundBlur|null} */ let next = null;
  if (blurOn) {
    next = new BackgroundBlur();
    renderBlur('Starting background blur…');
    try { track = await next.start(camera); }
    catch (e) {
      next.stop();
      if (pendingCamera !== camera) { if (camera !== cameraTrack) camera.stop(); return; }
      next = null;
      blurOn = false;
      store(BLUR_KEY, '0');
      toast(`Background blur could not start: ${e.message}`, { error: true, ms: 8000 });
    }
    if (pendingCamera !== camera) { next?.stop(); if (camera !== cameraTrack) camera.stop(); return; } // replaced meanwhile
  }
  pendingCamera = null;
  const old = videoTrack();
  if (old) camStream.removeTrack(old);
  blur?.stop();
  blur = next;
  if (cameraTrack && cameraTrack !== camera) cameraTrack.stop();
  cameraTrack = camera;
  camera.enabled = camOn;
  track.enabled = camOn;
  camStream.addTrack(track);
  for (const link of links.values()) pushTracks(link);
  renderBlur();
}

/** @param {boolean} on */
async function setBlur(on) {
  blurOn = on;
  store(BLUR_KEY, on ? '1' : '0');
  if (cameraTrack) await setCamera(cameraTrack);
  else renderBlur();
}

/** @param {string} [busy] what's happening, while blur is starting */
function renderBlur(busy = '') {
  for (const [row, box] of [['#blur-row', '#blur'], ['#blur-row-2', '#blur-2']]) {
    $(row).classList.toggle('hidden', !blurSupported());
    const el = /** @type {HTMLInputElement} */ ($(box));
    el.checked = blurOn;
    el.disabled = !!busy;
    el.parentElement.title = busy || 'Blurs what’s behind you. The first time, about 14 MB is downloaded.';
  }
}

async function startDevices() {
  const err = $('#lobby-error');
  err.classList.add('hidden');
  if (!navigator.mediaDevices?.getUserMedia) {
    err.textContent = window.isSecureContext
      ? 'This browser cannot access cameras or microphones.'
      : 'Camera access needs a secure (https://) link. Ask the host for an https invite link.';
    err.classList.remove('hidden');
    return;
  }
  try {
    await adoptTracks(await capture({ video: true, audio: true }));
  } catch (e1) {
    // Fall back to whatever is available (e.g. no camera).
    let partial = null;
    try { partial = await capture({ video: false, audio: true }); camOn = false; } catch { /* none */ }
    if (partial) await adoptTracks(partial);
    err.textContent = partial
      ? 'No camera available — you can still join with audio.'
      : `Could not access your camera or microphone (${e1.name}). Check browser permissions, then reload.`;
    err.classList.remove('hidden');
  }
  await fillDeviceLists();
  renderToggles();
}

async function fillDeviceLists() {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const fill = (/** @type {string[]} */ ids, /** @type {string} */ kind, /** @type {string|undefined} */ current, /** @type {string} */ fallback) => {
    const list = all.filter((d) => d.kind === kind);
    for (const id of ids) {
      const sel = $(id);
      if (!sel) continue;
      sel.replaceChildren(...list.map((d, i) => h('option', { value: d.deviceId }, d.label || `${fallback} ${i + 1}`)));
      if (current && list.some((d) => d.deviceId === current)) sel.value = current;
      sel.disabled = !list.length;
    }
  };
  fill(['#cam-select', '#cam-select-2'], 'videoinput', cameraTrack?.getSettings().deviceId, 'Camera');
  fill(['#mic-select', '#mic-select-2'], 'audioinput', audioTrack()?.getSettings().deviceId, 'Microphone');
  fill(['#spk-select'], 'audiooutput', devices.spk, 'Speaker');
  $('#spk-select').closest('label').classList.toggle('hidden', !('setSinkId' in HTMLMediaElement.prototype) || !all.some((d) => d.kind === 'audiooutput'));
}

/** @param {'cam'|'mic'} kind @param {string} deviceId */
async function switchDevice(kind, deviceId) {
  devices[kind] = deviceId;
  saveDevices();
  try {
    await adoptTracks(await capture(kind === 'cam' ? { video: true } : { audio: true }));
    await fillDeviceLists();
  } catch (e) {
    toast(`Could not switch ${kind === 'cam' ? 'camera' : 'microphone'}: ${e.message}`, { error: true });
  }
}

// ---- mic level meter (lobby) -------------------------------------------
let meterCtx = null, meterSrc = null, analyser = null;
function watchLevel() {
  const track = audioTrack();
  if (!track) return;
  try {
    meterCtx ||= new AudioContext();
    meterSrc?.disconnect();
    analyser ||= meterCtx.createAnalyser();
    analyser.fftSize = 512;
    meterSrc = meterCtx.createMediaStreamSource(new MediaStream([track]));
    meterSrc.connect(analyser);
  } catch { /* meter is optional */ }
}
function meterLoop() {
  if (analyser && !joined) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('#lobby-meter').style.width = `${micOn ? Math.min(100, (peak / 128) * 160) : 0}%`;
  }
  if (!joined) requestAnimationFrame(meterLoop);
}

// ---- sending media over links -------------------------------------------
/** @param {import('../common/peer.js').PeerLink} link */
function pushTracks(link) {
  const preview = link.purpose === 'preview';
  const featureOnly = link.purpose === 'feature'; // the screen-share output only needs the screen
  const v = featureOnly ? null : videoTrack(), a = featureOnly ? null : audioTrack();
  // The screen-share output is linked to every guest but shows one screen: send it only then.
  const sv = featureOnly && client.state?.screenTarget !== client.id ? null : screenStream?.getVideoTracks()[0] || null;
  const sa = screenStream?.getAudioTracks()[0] || null;
  link.setTrack('cam-video', v, camStream, preview ? { maxBitrate: Math.min(200_000, MAX_VIDEO), scaleResolutionDownBy: 4, maxFramerate: 15 } : { maxBitrate: camBitrate });
  // Host previews are video-only; audio goes to the program (and slot outputs).
  // The mic goes first when the guest's upload is congested.
  link.setTrack('cam-audio', preview ? null : a, camStream, { priority: 'high', networkPriority: 'high', ...(Number.isFinite(MAX_AUDIO) ? { maxBitrate: MAX_AUDIO } : {}) });
  link.setTrack('screen-video', sv, screenStream || camStream, preview ? { maxBitrate: Math.min(300_000, MAX_VIDEO), scaleResolutionDownBy: 3, maxFramerate: 5 } : { maxBitrate: Math.min(3_000_000, MAX_VIDEO) });
  link.setTrack('screen-audio', preview || featureOnly ? null : sa, screenStream || camStream, Number.isFinite(MAX_AUDIO) ? { maxBitrate: MAX_AUDIO } : undefined);
}

function reportSelf() {
  return client.post('self', {
    headline: $('#headline').value.trim(),
    cam: camOn && !!videoTrack(), mic: micOn && !!audioTrack(), screen: !!screenStream,
    streams: { camera: camStream.id, screen: screenStream?.id || null },
  }).catch(() => {});
}

// ---- controls ---------------------------------------------------------
function renderToggles() {
  const setBtn = (/** @type {HTMLElement} */ el, on, onIcon, offIcon, onLabel, offLabel, ctl) => {
    if (!el) return;
    el.replaceChildren(icon(on ? onIcon : offIcon), ...(ctl ? [on ? onLabel : offLabel] : []));
    el.classList.toggle('off', !on);
    el.classList.toggle('on', on && !ctl);
    el.title = on ? onLabel : offLabel;
  };
  setBtn($('#lobby-mic'), micOn, 'mic', 'micOff', 'Mute', 'Unmute', false);
  setBtn($('#lobby-cam'), camOn, 'cam', 'camOff', 'Stop video', 'Start video', false);
  setBtn($('#mic'), micOn, 'mic', 'micOff', 'Mute', 'Unmute', true);
  setBtn($('#cam'), camOn, 'cam', 'camOff', 'Stop video', 'Start video', true);
  const share = $('#share');
  share.replaceChildren(icon('screen'), screenStream ? 'Stop share' : 'Share screen');
  share.classList.toggle('on', !!screenStream);
  share.classList.toggle('hidden', !navigator.mediaDevices?.getDisplayMedia);
  $('#lobby-off').classList.toggle('hidden', camOn && !!videoTrack());
}

function toggleMic() {
  micOn = !micOn;
  const a = audioTrack();
  if (a) a.enabled = micOn;
  renderToggles();
  if (joined) reportSelf();
}
async function toggleCam() {
  camOn = !camOn;
  if (camOn && !videoTrack()) {
    try { await adoptTracks(await capture({ video: true })); }
    catch (e) { camOn = false; toast(`Could not start camera: ${e.message}`, { error: true }); }
  }
  const v = videoTrack();
  if (v) v.enabled = camOn;
  if (cameraTrack) cameraTrack.enabled = camOn;
  renderToggles();
  if (joined) reportSelf();
}

async function toggleShare() {
  if (screenStream) return stopShare();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    const v = s.getVideoTracks()[0];
    if (v && 'contentHint' in v) v.contentHint = 'detail';
    v?.addEventListener('ended', () => stopShare());
    screenStream = s;
    for (const link of links.values()) pushTracks(link);
    renderToggles();
    reportSelf();
    toast('Screen shared with the host. They decide when it goes on stage.');
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast(`Screen share failed: ${e.message}`, { error: true });
  }
}
function stopShare() {
  if (!screenStream) return;
  const s = screenStream;
  screenStream = null;
  for (const link of links.values()) pushTracks(link);
  for (const t of s.getTracks()) t.stop();
  renderToggles();
  reportSelf();
}

// ---- joining ----------------------------------------------------------
async function join() {
  const name = $('#name').value.trim();
  if (!name) { $('#name').focus(); toast('Please enter your name', { error: true }); return; }
  store(NAME_KEY, name);
  store(HEADLINE_KEY, $('#headline').value.trim());
  $('#join').disabled = true;
  $('#join').textContent = 'Joining…';
  try {
    const body = await client.join({ name, key: KEY, ticket: storedTicket(), asHost: AS_HOST });
    storeTicket(body.rejoin || null);
  } catch (e) {
    $('#join').disabled = false;
    $('#join').textContent = 'Join studio';
    const err = $('#lobby-error');
    err.textContent = e.message;
    err.classList.remove('hidden');
    return;
  }
  joined = true;
  meterCtx?.close().catch(() => {});
  $('#lobby').classList.add('hidden');
  $('#studio').classList.remove('hidden');
  $('#self-video').srcObject = camStream;
  $('#self-name').textContent = name;
  $('#name-2').value = name;
  $('#headline-2').value = $('#headline').value.trim();
  // Chat sits beside the picture on wide screens, so keep it open there from the start.
  if (matchMedia('(min-width: 761px)').matches) $('#chat').classList.remove('hidden');

  const program = /** @type {HTMLVideoElement} */ ($('#program'));
  if (devices.spk && 'setSinkId' in program) /** @type {any} */ (program).setSinkId(devices.spk).catch(() => {});

  links = manageLinks(client, (link) => {
    // A data channel brings the screen-share link up before anything is sent on it.
    if (link.purpose === 'feature') link.pc.createDataChannel('ready');
    pushTracks(link);
    if (link.purpose === 'program') {
      link.addEventListener('track', (/** @type {any} */ e) => {
        program.srcObject = e.detail.stream;
        $('#program-empty').classList.add('hidden');
        program.play().catch(() => toast('Tap anywhere to hear the studio'));
      });
      link.addEventListener('state', (/** @type {any} */ e) => setConn(e.detail));
      link.addEventListener('closed', () => { if (program.srcObject && ![...links.values()].some((l) => l.purpose === 'program' && !l.closed)) program.srcObject = null; });
      // Re-apply preferred encodings once connected (some browsers ignore them before negotiation).
      link.addEventListener('state', (/** @type {any} */ e) => {
        if (e.detail === 'connected') for (const [name, sender] of link.senders) if (name === 'cam-video') applyEncoding(sender, { maxBitrate: camBitrate });
      });
    }
  });
  client.on('welcome', (m) => onState(m.state));
  client.on('state', (m) => onState(m.state));
  client.on('chat', (m) => addChat(m.message));
  client.on('welcome', (m) => { $('#chat-log').replaceChildren(); m.chat.forEach(addChat); });
  client.on('kicked', () => { storeTicket(null); end('You were removed from the studio', 'The host removed you from this session.'); });
  client.on('request', (m) => toast(m.what === 'cam' ? 'The host asked you to turn on your camera.' : 'The host asked you to unmute your microphone.', { ms: 7000 }));
  client.on('lost', () => end('Disconnected', 'The connection to the studio was lost. Rejoin to continue.'));
  client.on('reconnecting', () => setConn('reconnecting'));
  client.on('connected', () => setConn(''));
  await reportSelf();
  document.addEventListener('click', () => { if (program.paused && program.srcObject) program.play().catch(() => {}); });
  watchProgramAudio(program);
}

// ---- program audio diagnostics -----------------------------------------
// Reports to the studio (which writes it to the OBS log) how the program audio is playing
// out here: once when it starts, then for any 10-second stretch where the browser had to
// speed it up or slow it down to keep its buffer in line, fill gaps, or lost packets. Speeding
// up is what the browser does to catch up after a stall, and it sounds fast and a bit garbled.
/** @param {HTMLVideoElement} program */
function watchProgramAudio(program) {
  /** @type {any} */ let prev = null;
  let first = true;
  const timer = setInterval(async () => {
    if (!joined) { clearInterval(timer); return; }
    const link = [...links.values()].find((l) => l.purpose === 'program' && !l.closed);
    if (!link) { prev = null; return; }
    /** @type {any} */ let cur = null;
    try {
      const stats = await link.pc.getStats();
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') cur = { ...s, clockRate: stats.get(s.codecId)?.clockRate }; });
    } catch { return; }
    if (!cur || !cur.totalSamplesReceived) return;
    const d = (/** @type {string} */ k) => (cur[k] || 0) - (prev && prev.id === cur.id ? prev[k] || 0 : 0);
    const samples = d('totalSamplesReceived');
    const pct = (/** @type {string} */ k) => (samples > 0 ? (100 * d(k)) / samples : 0);
    const emitted = d('jitterBufferEmittedCount');
    const report = {
      secs: prev && prev.id === cur.id ? (cur.timestamp - prev.timestamp) / 1000 : 0,
      packets: d('packetsReceived'), lost: d('packetsLost'),
      jitterMs: (cur.jitter || 0) * 1000,
      bufferMs: emitted > 0 ? (1000 * d('jitterBufferDelay')) / emitted : 0,
      acceleratedPct: pct('removedSamplesForAcceleration'),
      deceleratedPct: pct('insertedSamplesForDeceleration'),
      concealedPct: pct('concealedSamples'),
      rate: cur.clockRate || 0,
      ice: link.pc.iceConnectionState,
      paused: program.paused, playbackRate: program.playbackRate,
      browser: first ? navigator.userAgent : undefined,
    };
    prev = cur;
    const notable = report.acceleratedPct > 0.5 || report.deceleratedPct > 0.5 || report.concealedPct > 1 || report.lost > 0
      || (report.ice !== 'connected' && report.ice !== 'completed');
    if (!first && !notable) return;
    first = false;
    client.post('diag', { audio: report }).catch(() => {});
  }, 10_000);
}

/** @param {string} s */
function setConn(s) {
  const el = $('#conn-status');
  const bad = s === 'reconnecting' || s === 'disconnected' || s === 'failed' || s === 'checking';
  el.classList.toggle('hidden', !bad);
  el.className = `pill warn${bad ? '' : ' hidden'}`;
  el.textContent = s === 'checking' ? 'Connecting media…' : s === 'reconnecting' ? 'Reconnecting…' : 'Connection problem';
}

/** @param {any} st */
function onState(st) {
  // Start or stop sending the screen to the screen-share output when it picks a new screen.
  if (st.screenTarget !== onState.lastTarget) {
    onState.lastTarget = st.screenTarget;
    for (const link of links.values()) if (link.purpose === 'feature') pushTracks(link);
  }
  const me = st.participants.find((p) => p.id === client.id);
  if (!me) return;
  const status = $('#stage-status');
  status.className = `pill ${me.onStage ? 'live' : ''}`;
  status.replaceChildren(...(me.onStage ? [h('span.dot'), 'On stage'] : ['Backstage']));
  if (me.name !== $('#self-name').textContent) $('#self-name').textContent = me.name;
  const empty = $('#program-empty');
  empty.textContent = st.programOnline ? 'Connecting…' : 'The studio output is not running yet. Hang tight.';
  empty.classList.toggle('hidden', st.programOnline && !!$('#program').srcObject);
  if (onState.lastStage !== undefined && onState.lastStage !== me.onStage) toast(me.onStage ? 'You are now on stage' : 'You are backstage');
  onState.lastStage = me.onStage;
}
/** @type {boolean|undefined} */ onState.lastStage = undefined;
/** @type {string|null|undefined} */ onState.lastTarget = undefined;

/** @param {any} m */
function addChat(m) {
  const mine = m.fromId === client.id;
  appendChat(m, mine, m.to === null ? '' : m.to === 'host' ? ' → host' : ' → you');
  if (!mine && $('#chat').classList.contains('hidden')) {
    unread++;
    renderChatButton();
    toast(`${m.from}: ${m.text.slice(0, 80)}`);
  }
}

let unread = 0;
/** @param {boolean} on */
function showChat(on) {
  $('#chat').classList.toggle('hidden', !on);
  if (on) { unread = 0; $('#chat-input').focus(); }
  renderChatButton();
}
function renderChatButton() {
  const btn = $('#chat-btn');
  btn.classList.toggle('on', unread > 0);
  btn.replaceChildren(icon('chat'), unread > 0 ? `Chat (${unread})` : 'Chat');
}

/** @param {string} title @param {string} text */
function end(title, text) {
  joined = false;
  client.disconnect();
  for (const l of links.values()) l.close();
  for (const t of camStream.getTracks()) t.stop();
  blur?.stop();
  cameraTrack?.stop();
  screenStream?.getTracks().forEach((t) => t.stop());
  $('#studio').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  $('#ended').classList.remove('hidden');
  $('#ended-title').textContent = title;
  $('#ended-text').textContent = text;
}

// ---- wire up ----------------------------------------------------------
$('#name').value = stored(NAME_KEY);
$('#headline').value = stored(HEADLINE_KEY);
$('#lobby-video').srcObject = camStream;
$('#lobby-mic').addEventListener('click', toggleMic);
$('#lobby-cam').addEventListener('click', toggleCam);
$('#mic').addEventListener('click', toggleMic);
$('#cam').addEventListener('click', toggleCam);
$('#share').addEventListener('click', toggleShare);
$('#join').addEventListener('click', join);
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
for (const id of ['#cam-select', '#cam-select-2']) $(id).addEventListener('change', (e) => switchDevice('cam', e.target.value));
for (const id of ['#mic-select', '#mic-select-2']) $(id).addEventListener('change', (e) => switchDevice('mic', e.target.value));
$('#spk-select').addEventListener('change', (e) => {
  devices.spk = e.target.value; saveDevices();
  /** @type {any} */ ($('#program')).setSinkId?.(devices.spk).catch(() => {});
});
$('#name-2').addEventListener('change', (e) => {
  const name = e.target.value.trim();
  if (!name) return;
  store(NAME_KEY, name);
  client.post('self', { name }).catch(() => {});
});
$('#headline-2').addEventListener('change', (e) => {
  const headline = e.target.value.trim();
  $('#headline').value = headline;
  store(HEADLINE_KEY, headline);
  client.post('self', { headline }).catch(() => {});
});
for (const id of ['#blur', '#blur-2']) $(id).addEventListener('change', (e) => setBlur(e.target.checked));
$('#chat-btn').replaceChildren(icon('chat'), 'Chat');
$('#settings-btn').replaceChildren(icon('gear'), 'Settings');
$('#leave').replaceChildren(icon('leave'), 'Leave');
$('#chat-close').replaceChildren(icon('x'));
$('#chat-btn').addEventListener('click', () => showChat($('#chat').classList.contains('hidden')));
$('#chat-close').addEventListener('click', () => showChat(false));
$('#settings-btn').addEventListener('click', () => { fillDeviceLists(); /** @type {HTMLDialogElement} */ ($('#settings')).showModal(); });
$('#leave').addEventListener('click', () => { client.leave(); end('You left the studio', 'Thanks for joining.'); });
$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try { await client.post('chat', { text, to: $('#chat-to').value || null }); }
  catch (err) { toast(err.message, { error: true }); input.value = text; }
});
window.addEventListener('beforeunload', () => { if (joined) client.leave(); });
if (AS_HOST) $('#lobby-sub').textContent = 'Joining as the host on camera. You can hear and talk to backstage guests.';
if (!KEY) {
  $('#lobby-error').textContent = 'This link is missing its invite code. Ask the host for the full invite link.';
  $('#lobby-error').classList.remove('hidden');
}
renderToggles();
renderBlur();
startDevices().then(() => requestAnimationFrame(meterLoop));
