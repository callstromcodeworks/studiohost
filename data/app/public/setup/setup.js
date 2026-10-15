// Setup wizard: choose Automatic or Manual, then watch the guest side come up.
// Runs on the local (OBS-only) listener; the server refuses setup changes from anywhere else.
import { StudioClient, param } from '../common/client.js';
import { $, h, toast, copy } from '../common/ui.js';

const client = new StudioClient('host');
/** For troubleshooting from the console / tests. */
/** @type {any} */ (window).studioHostSetup = { client, status: () => client.post('network-status') };
/** @type {any} */ let status = null;
/** @type {any} */ let info = null;
let lastMode = 'auto';
/** Keeps the newest status: a reply to a request can arrive after a newer pushed update. */
function setStatus(/** @type {any} */ s) { if (s && (!status || (s.seq ?? 0) >= (status.seq ?? 0))) status = s; }

const SVG = {
  ok: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 16 16"><path d="M8 3.5v5.5M8 12v.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
};

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  // Move focus into the new screen for keyboard and screen-reader users (not on the first screen).
  if (id !== 'choose') /** @type {HTMLElement|null} */ ($(`#${id} input, #${id} button`))?.focus({ preventScroll: true });
}

// ---- method choice ----------------------------------------------------------------
$('#choose-next').addEventListener('click', async () => {
  const mode = /** @type {HTMLInputElement} */ ($('input[name="mode"]:checked')).value;
  lastMode = mode;
  if (mode === 'manual') { fillManual(); show('manual'); return; }
  $('#choose-next').disabled = true;
  try {
    setStatus(await client.post('network-apply', { mode: 'auto' }));
    show('progress');
    renderProgress();
  } catch (err) { toast(err.message, { error: true, ms: 8000 }); }
  $('#choose-next').disabled = false;
});

// ---- manual form ----------------------------------------------------------------------
function fillManual() {
  const m = status?.settings?.manual || {};
  const set = (/** @type {string} */ sel, v) => { if (v !== undefined && v !== null && v !== '') $(sel).value = v; };
  $(`input[name="address"][value="${m.address === 'lan' ? 'lan' : 'domain'}"]`).checked = true;
  set('#m-host', m.host);
  set('#m-port', m.port);
  set('#m-bind', m.bindAddress);
  $('#m-upnp').checked = !!m.upnp;
  $(`input[name="cert"][value="${m.certificate || 'self-signed'}"]`).checked = true;
  set('#m-acme-port', m.httpChallengePort);
  set('#m-email', m.email);
  set('#m-cert', m.certFile);
  set('#m-key', m.keyFile);
  if (info?.config) {
    $('#m-ice').value = JSON.stringify(info.config.iceServers, null, 2);
    $('#m-max').value = String(info.config.maxGuests);
  }
  syncManual();
}

function syncManual() {
  const lan = $('input[name="address"]:checked').value === 'lan';
  $('#host-field').classList.toggle('hidden', lan);
  $('#lan-note').classList.toggle('hidden', !lan);
  // Let's Encrypt can't certify a LAN address.
  const le = $('input[name="cert"][value="letsencrypt"]');
  le.disabled = lan;
  $('#cert-le').classList.toggle('muted', lan);
  if (lan && le.checked) $('input[name="cert"][value="self-signed"]').checked = true;
  const cert = $('input[name="cert"]:checked').value;
  $('#le-fields').classList.toggle('hidden', cert !== 'letsencrypt');
  $('#file-fields').classList.toggle('hidden', cert !== 'files');
}
for (const el of document.querySelectorAll('input[name="address"], input[name="cert"]')) el.addEventListener('change', syncManual);

$('#manual-back').addEventListener('click', () => show('choose'));
$('#manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#manual-error');
  err.classList.add('hidden');
  let iceServers;
  const iceText = $('#m-ice').value.trim();
  if (iceText) {
    try { iceServers = JSON.parse(iceText); } catch { return fail('STUN/TURN servers must be valid JSON, for example [{"urls": "stun:stun.l.google.com:19302"}].'); }
  }
  const body = {
    mode: 'manual',
    manual: {
      address: $('input[name="address"]:checked').value,
      host: $('#m-host').value.trim(),
      port: Number($('#m-port').value),
      bindAddress: $('#m-bind').value.trim() || '0.0.0.0',
      upnp: $('#m-upnp').checked,
      certificate: $('input[name="cert"]:checked').value,
      httpChallengePort: Number($('#m-acme-port').value) || 80,
      email: $('#m-email').value.trim(),
      certFile: $('#m-cert').value.trim(),
      keyFile: $('#m-key').value.trim(),
    },
    ...(iceServers ? { iceServers } : {}),
    ...($('#m-max').value ? { maxGuests: Number($('#m-max').value) } : {}),
  };
  $('#manual-save').disabled = true;
  try {
    setStatus(await client.post('network-apply', body));
    show('progress');
    renderProgress();
  } catch (e2) { fail(e2.message); }
  $('#manual-save').disabled = false;

  function fail(/** @type {string} */ msg) {
    err.textContent = msg;
    err.classList.remove('hidden');
    err.scrollIntoView({ block: 'nearest' });
  }
});

// ---- progress ---------------------------------------------------------------------------
function renderProgress() {
  if (!status) return;
  const steps = [...(status.steps || [])];
  const ready = status.state === 'ready';
  steps.push({ id: 'guests', label: 'Guests can join', state: ready ? 'ok' : status.state === 'problem' ? 'pending' : 'pending', detail: ready ? status.publicUrl : '' });
  $('#path').replaceChildren(...steps.map((s) => {
    const li = h(`li.${s.state}`);
    const node = h('span.node', { 'aria-hidden': 'true' });
    node.innerHTML = s.state === 'ok' ? SVG.ok : s.state === 'error' || s.state === 'warn' ? SVG.bad : SVG.dot;
    const stateText = { pending: 'Waiting', running: 'In progress', ok: 'Done', warn: 'Needs attention', error: 'Problem', skipped: 'Skipped' }[s.state] || '';
    li.append(node, h('div', null, h('div.stage-title', null, s.label, h('span.sr-only', null, ` — ${stateText}`)), s.detail ? h('div.stage-detail', null, s.detail) : null));
    return li;
  }));
  const working = status.state === 'working';
  $('#result').classList.toggle('hidden', !ready || !info);
  if (ready) refreshInvite();
  $('#retry').classList.toggle('hidden', status.state !== 'problem');
  $('#finish').disabled = working;
  $('#finish').textContent = ready ? 'Finish' : 'Close for now';
}

async function refreshInvite() {
  try { info = await client.post('info'); } catch { return; }
  $('#invite').textContent = info.invite;
  $('#result').classList.toggle('hidden', !info.invite);
  const cert = status.certificate?.kind;
  $('#result-note').textContent = cert === 'self-signed'
    ? 'Guests will see a security warning first, because the certificate is self-signed.'
    : status.settings?.mode === 'auto'
      ? 'This address stays the same as long as Studio Host runs at least once every 90 days.'
      : '';
}

$('#copy').addEventListener('click', () => copy($('#invite').textContent));
$('#progress-back').addEventListener('click', () => { fillManual(); show('choose'); });
$('#retry').addEventListener('click', async () => {
  try {
    setStatus(await client.post('network-apply', lastMode === 'manual' ? { mode: 'manual', manual: status.settings.manual } : { mode: 'auto' }));
    renderProgress();
  } catch (err) { toast(err.message, { error: true }); }
});
$('#finish').addEventListener('click', async () => {
  await client.post('setup-done').catch(() => {});
  // Inside OBS the plugin closes this window; in a browser, continue to the producer controls.
  if (!info?.managed) location.href = '/host/';
});

// ---- start --------------------------------------------------------------------------------
async function main() {
  try {
    await client.join({ key: param('key') || undefined });
    [status, info] = await Promise.all([client.post('network-status'), client.post('info')]);
    info.config = await client.post('config-get').catch(() => null);
  } catch (err) {
    document.querySelector('.wizard').replaceChildren(h('p.form-error', null, `Setup isn’t available here: ${err.message}`));
    return;
  }
  // The server restarted (e.g. a new local port): start over with a fresh session.
  client.on('lost', () => setTimeout(() => location.reload(), 1500));
  client.on('network', (m) => { setStatus(m.status); if (!$('#progress').classList.contains('hidden')) renderProgress(); });
  lastMode = status.settings?.mode || 'auto';
  $(`input[name="mode"][value="${lastMode}"]`).checked = true;
  if (status.configured && param('view') === 'status') { show('progress'); renderProgress(); }
  else show('choose');
}
main();
