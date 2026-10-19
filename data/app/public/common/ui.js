// Small DOM helpers and icons shared by the guest and host pages.

/** @param {string} sel @param {ParentNode} [root] @returns {any} */
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Tiny element builder: h('button.btn.primary', {onclick}, 'Go')
 * @param {string} tag @param {Record<string, any>|null} [attrs] @param {...any} children
 * @returns {any}
 */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const toastHost = () => {
  let el = document.querySelector('.toast-host');
  if (!el) { el = h('div.toast-host'); document.body.append(el); }
  return el;
};

/** @param {string} text @param {{error?: boolean, ms?: number}} [opts] */
export function toast(text, opts = {}) {
  const el = h(`div.toast${opts.error ? '.error' : ''}`, null, text);
  toastHost().append(el);
  setTimeout(() => el.remove(), opts.ms || 4000);
}

/** @param {string} text */
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast('Copy failed — select and copy the link manually', { error: true }); }
    ta.remove();
  }
}

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** @param {number} ts */
export const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Appends a chat message to the page's #chat-log and scrolls to it.
 * @param {any} m @param {boolean} mine @param {string} recipient e.g. ' → host', or '' for everyone
 */
export function appendChat(m, mine, recipient) {
  const log = $('#chat-log');
  log.append(h(`div.chat-msg${m.to !== null ? '.private' : ''}${mine ? '.mine' : ''}`, null,
    h('div.who', null, `${m.from}${recipient} · ${timeOf(m.ts)}`), h('div', null, m.text)));
  log.scrollTop = log.scrollHeight;
}

// Simple 24x24 icons drawn for this project.
const P = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h-2v-2.08A7 7 0 0 1 5 12z',
  micOff: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h-2v-2.08A7 7 0 0 1 5 12zM3.3 4.7l1.4-1.4 16 16-1.4 1.4z',
  cam: 'M3 6h12a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  camOff: 'M3 6h12a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM2.3 3.7l1.4-1.4 18 18-1.4 1.4z',
  screen: 'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6z',
  chat: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  leave: 'M10 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-9v-2h9V5h-9zm-1 5 1.4 1.4L8.8 11H16v2H8.8l1.6 1.6L9 16l-4-4z',
  gear: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-1.5-6h3l.5 2.6 1.9.8 2.2-1.5 2.1 2.1-1.5 2.2.8 1.9 2.5.4v3l-2.5.5-.8 1.9 1.5 2.2-2.1 2.1-2.2-1.5-1.9.8-.5 2.5h-3l-.4-2.5-1.9-.8-2.2 1.5-2.1-2.1 1.5-2.2-.8-1.9L2 13.5v-3l2.6-.4.8-1.9-1.5-2.2L6 3.9l2.2 1.5 1.9-.8z',
  up: 'M12 6l7 7-1.4 1.4L12 8.8l-5.6 5.6L5 13z',
  down: 'M12 18l-7-7 1.4-1.4 5.6 5.6 5.6-5.6L19 11z',
  x: 'M5.7 4.3 12 10.6l6.3-6.3 1.4 1.4-6.3 6.3 6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4 6.3-6.3-6.3-6.3z',
  copy: 'M8 3h11a2 2 0 0 1 2 2v11h-2V5H8zM5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v10h10V9z',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z',
};
/** @param {keyof typeof P} name */
export const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', P[name]);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
};
