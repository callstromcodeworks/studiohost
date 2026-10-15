// Screen-share output for OBS: shows the featured screen share full-frame (or, if the
// producer hasn't featured one, the first guest who is sharing). Audio from the
// share is already part of the program mix, so this output is silent.
//   ?fit=cover   crop to fill instead of letterboxing
import { StudioClient, param, forwardConsoleToServer } from '../common/client.js';
import { manageLinks } from '../common/peer.js';
import { MediaBank } from '../common/media.js';

const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
if (param('fit') === 'cover') video.style.objectFit = 'cover';
const client = new StudioClient('feature');
forwardConsoleToServer(client);
const bank = new MediaBank();
/** @type {any} */ (window).studioHost = { client, bank };

function update() {
  const st = client.state;
  const pid = st?.screenTarget || null;
  const stream = pid ? bank.stream(pid, 'screen') : null;
  if (video.srcObject !== stream) { video.srcObject = stream; if (stream) video.play().catch(() => {}); }
  video.classList.toggle('show', !!stream);
}

async function main() {
  try {
    await client.join({ key: param('key') || undefined });
  } catch (err) {
    console.error(err);
    setTimeout(() => location.reload(), 5000);
    return;
  }
  if (client.debug) console.info(`[page] joined (visibility ${document.visibilityState})`);
  manageLinks(client, (link) => {
    if (client.debug) console.info(`[page] new link (visibility ${document.visibilityState})`);
    if (link.purpose === 'feature') bank.watch(link);
  });
  bank.onChange(update);
  const onState = (/** @type {any} */ st) => { bank.setState(st); update(); };
  client.on('welcome', (m) => onState(m.state));
  client.on('state', (m) => onState(m.state));
  client.on('lost', () => setTimeout(() => location.reload(), 3000));
  window.addEventListener('beforeunload', () => client.leave());
}

main();
