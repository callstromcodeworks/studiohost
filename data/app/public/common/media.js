// Tracks remote MediaStreams received over any PeerLink and exposes them as
// playing <video> elements keyed by participant + kind (camera / screen).

export class MediaBank {
  constructor() {
    /** @type {Map<string, {stream: MediaStream, video: HTMLVideoElement, link: any}>} */
    this.byStream = new Map();
    /** @type {any} */
    this.state = null;
    this.holder = document.createElement('div');
    this.holder.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(this.holder);
    this.listeners = new Set();
  }

  /** @param {any} state */
  setState(state) { this.state = state; }

  /** @param {() => void} fn */
  onChange(fn) { this.listeners.add(fn); }

  changed() { for (const fn of this.listeners) fn(); }

  /**
   * Registers a link's incoming streams.
   * @param {import('./peer.js').PeerLink} link
   */
  watch(link) {
    const sync = () => {
      for (const [id, stream] of link.streams) {
        const existing = this.byStream.get(id);
        if (existing && existing.link === link) continue;
        if (existing) existing.video.remove();
        const video = document.createElement('video');
        video.muted = true;          // audio is handled separately (Web Audio)
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = stream;
        this.holder.appendChild(video);
        video.play().catch(() => {});
        video.addEventListener('resize', () => this.changed());
        this.byStream.set(id, { stream, video, link });
      }
      for (const [id, entry] of this.byStream) {
        if (entry.link === link && !link.streams.has(id)) { entry.video.remove(); this.byStream.delete(id); }
      }
      this.changed();
    };
    link.addEventListener('streams', sync);
    link.addEventListener('closed', () => {
      for (const [id, entry] of this.byStream) if (entry.link === link) { entry.video.remove(); this.byStream.delete(id); }
      this.changed();
    });
    sync();
  }

  /** @param {string} pid @param {'camera'|'screen'} kind */
  entry(pid, kind) {
    const p = this.state?.participants.find((x) => x.id === pid);
    const sid = p?.streams?.[kind];
    return sid ? this.byStream.get(sid) || null : null;
  }

  /** @param {string} pid @param {'camera'|'screen'} kind @returns {HTMLVideoElement|null} */
  video(pid, kind) { return this.entry(pid, kind)?.video || null; }

  /** @param {string} pid @param {'camera'|'screen'} kind @returns {MediaStream|null} */
  stream(pid, kind) { return this.entry(pid, kind)?.stream || null; }
}
