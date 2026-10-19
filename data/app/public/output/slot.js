// Single-guest output for an OBS Browser Source: /output/slot.html?slot=N
// Options:
//   audio=1         play this guest's audio here (off by default; the program source carries audio)
//   names=1         show the guest's name tag (and headline)
//   source=screen   show the guest's screen share instead of their camera
//   fit=contain     letterbox instead of crop
//   always=1        show the guest even while they are backstage
import { StudioClient, param, forwardConsoleToServer } from '../common/client.js';
import { manageLinks } from '../common/peer.js';
import { MediaBank } from '../common/media.js';
import { initials, fontStack } from '../common/render.js';

const slot = Math.max(1, Number(param('slot')) || 1);
const withAudio = param('audio') === '1';
const withNames = param('names') === '1';
const source = param('source') === 'screen' ? 'screen' : 'camera';
const always = param('always') === '1';

const wrap = /** @type {HTMLElement} */ (document.getElementById('wrap'));
const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
const avatar = /** @type {HTMLElement} */ (document.getElementById('avatar'));
const nameTag = /** @type {HTMLElement} */ (document.getElementById('name'));
const ini = /** @type {HTMLElement} */ (document.getElementById('initials'));
const nameText = /** @type {HTMLElement} */ (document.getElementById('name-text'));
const headline = /** @type {HTMLElement} */ (document.getElementById('headline'));
video.style.objectFit = param('fit') === 'contain' ? 'contain' : 'cover';
video.muted = !withAudio;

const client = new StudioClient('slot');
forwardConsoleToServer(client);
const bank = new MediaBank();
/** @type {any} */ (window).studioHost = { client, bank };

function update() {
  const st = client.state;
  if (!st) return;
  const p = st.participants.find((x) => x.slot === slot);
  // Hidden guests are hidden here too; ?always=1 only overrides being backstage.
  const visible = !!p && !p.hidden && (always || p.onStage);
  wrap.classList.toggle('show', visible);
  if (!p) { video.srcObject = null; return; }
  const stream = bank.stream(p.id, source);
  if (video.srcObject !== stream) { video.srcObject = stream; if (stream) video.play().catch(() => {}); }
  const brand = st.studio.brand;
  const camOff = source === 'camera' && !p.cam;
  avatar.style.display = camOff || !stream ? 'grid' : 'none';
  ini.textContent = initials(p.name);
  ini.style.background = brand.color;
  ini.style.color = brand.textColor;
  ini.style.fontFamily = fontStack(brand.font);
  nameTag.style.display = withNames && source === 'camera' ? 'block' : 'none';
  nameText.textContent = p.name;
  headline.textContent = p.headline || '';
  nameTag.classList.toggle('two', !!p.headline);
  nameTag.style.background = brand.color;
  nameTag.style.color = brand.textColor;
  nameTag.style.fontFamily = fontStack(brand.font);
}

async function main() {
  try {
    await client.join({ slot, key: param('key') || undefined });
  } catch (err) {
    console.error(err);
    setTimeout(() => location.reload(), 5000);
    return;
  }
  manageLinks(client, (link) => { if (link.purpose === 'slot') bank.watch(link); });
  bank.onChange(update);
  const onState = (/** @type {any} */ st) => { bank.setState(st); update(); };
  client.on('welcome', (m) => onState(m.state));
  client.on('state', (m) => onState(m.state));
  client.on('lost', () => setTimeout(() => location.reload(), 3000));
  window.addEventListener('beforeunload', () => client.leave());
}

main();
