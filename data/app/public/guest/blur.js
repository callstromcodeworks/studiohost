// Background blur for a guest's camera, done in the guest's browser and only if they turn it
// on. It uses Google's MediaPipe selfie segmentation: the runtime and model (about 14 MB) are
// downloaded the first time a guest turns blur on, from jsDelivr and Google's model storage,
// and every file is checked against the SHA-384 hash pinned here before it is used.
//
// The blurred picture is a new video track: in Chrome and Edge it is made frame by frame from
// the camera track (which keeps running while the tab is in the background); elsewhere it is
// drawn onto a canvas and captured from it.

const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1';
/** @type {Record<'bundle'|'loader'|'wasm'|'model', {url: string, sri: string, type: string}>} */
export const BLUR_FILES = {
  bundle: { url: `${MEDIAPIPE}/vision_bundle.mjs`, sri: 'sha384-YN1WLhNpIcHS4MxTu2oyTBQ8z8VQ1hRWCjNtxtbIsyaMxAuPG4sATYsdYCCb5gIe', type: 'text/javascript' },
  loader: { url: `${MEDIAPIPE}/wasm/vision_wasm_internal.js`, sri: 'sha384-GVXEXjb5e7Cw6TkMq2OpQ3uJgBZuX8usnh/hMRK9jEL4+UOZicEaz6EXyQqn1F5P', type: 'text/javascript' },
  wasm: { url: `${MEDIAPIPE}/wasm/vision_wasm_internal.wasm`, sri: 'sha384-zc3zcc1lq06r75ak9gryxpq17bhb6Uc0DxVt6p+z24YD7ijlvsMulvu15X9ZkMdr', type: 'application/wasm' },
  model: {
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite',
    sri: 'sha384-kApgiEA8Mxx75sl2xi4boAj4BQpwO06RRz2BlZtiq6HizOHOi6rhyiklO5kbe8bm', type: 'application/octet-stream',
  },
};

// The model looks at a 256x144 picture; the mask it returns is scaled up to the camera's size.
const MASK_W = 256, MASK_H = 144;
const SEGMENT_HZ = 15;

const generatorPath = () => 'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window && 'VideoFrame' in window;

/** Whether this browser can blur (it needs a secure page, WebAssembly and a way to make a video track). */
export function blurSupported() {
  return !!globalThis.crypto?.subtle && typeof WebAssembly === 'object' && typeof OffscreenCanvas === 'function'
    && (generatorPath() || 'captureStream' in HTMLCanvasElement.prototype);
}

/** @param {{url: string, sri: string}} file */
async function fetchChecked(file) {
  const res = await fetch(file.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`could not download it (${res.status})`);
  const buf = await res.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', buf));
  if (`sha384-${btoa(String.fromCharCode(...digest))}` !== file.sri) throw new Error('the download did not match its checksum');
  return buf;
}

/** @type {Promise<any>|null} */ let loading = null;

/** Downloads and starts the segmenter once; later calls share it. */
function loadSegmenter() {
  loading ||= (async () => {
    const files = /** @type {const} */ (['bundle', 'loader', 'wasm', 'model']);
    const [bundle, loader, wasm, model] = await Promise.all(files.map((k) => fetchChecked(BLUR_FILES[k])));
    const blobUrl = (/** @type {ArrayBuffer} */ buf, /** @type {string} */ type) => URL.createObjectURL(new Blob([buf], { type }));
    const vision = await import(blobUrl(bundle, BLUR_FILES.bundle.type));
    const fileset = { wasmLoaderPath: blobUrl(loader, BLUR_FILES.loader.type), wasmBinaryPath: blobUrl(wasm, BLUR_FILES.wasm.type) };
    const create = (/** @type {'GPU'|'CPU'} */ delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    let segmenter;
    try { segmenter = await create('GPU'); } catch { segmenter = await create('CPU'); }
    // The person's confidence: the "person" mask if the model names one, else its only mask.
    const labels = /** @type {string[]} */ (segmenter.getLabels?.() || []);
    const person = labels.findIndex((l) => /person|foreground|selfie/i.test(l));
    return { segmenter, labels, maskIndex: person >= 0 ? person : labels.length > 1 ? 1 : 0 };
  })();
  loading.catch(() => { loading = null; }); // let a later attempt try again
  return loading;
}

export class BackgroundBlur {
  constructor() {
    this.stopped = false;
    /** @type {MediaStreamTrack|null} */ this.output = null;
    /** @type {(() => void)|null} */ this.cleanup = null;
    this.lastTs = 0;
    this.hasMask = false;
    this.small = new OffscreenCanvas(MASK_W, MASK_H);
    this.smallCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (this.small.getContext('2d', { willReadFrequently: true }));
    this.mask = new OffscreenCanvas(MASK_W, MASK_H);
    this.maskCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (this.mask.getContext('2d'));
    this.maskData = new ImageData(MASK_W, MASK_H);
    this.maskData.data.fill(255);
    this.person = new OffscreenCanvas(2, 2);
    this.personCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (this.person.getContext('2d'));
    /** @type {OffscreenCanvas|HTMLCanvasElement} */ this.out = new OffscreenCanvas(2, 2);
    this.tiny = new OffscreenCanvas(2, 2);
    this.tinyCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (this.tiny.getContext('2d'));
    this.canFilter = typeof this.personCtx.filter === 'string';
  }

  /**
   * Starts blurring the camera track and returns the blurred track. The camera track is left
   * running (stop it yourself); the blurred one stops with `stop()`.
   * @param {MediaStreamTrack} camera
   * @returns {Promise<MediaStreamTrack>}
   */
  async start(camera) {
    const { segmenter, labels, maskIndex } = await loadSegmenter();
    if (this.stopped) throw new Error('stopped');
    this.segmenter = segmenter;
    this.labels = labels;
    this.maskIndex = maskIndex;
    return generatorPath() ? this.startGenerator(camera) : this.startCanvas(camera);
  }

  /** Chrome and Edge: read the camera's frames and write blurred ones to a new track. @param {MediaStreamTrack} camera */
  startGenerator(camera) {
    const W = /** @type {any} */ (window);
    const processor = new W.MediaStreamTrackProcessor({ track: camera, maxBufferSize: 2 });
    const generator = /** @type {MediaStreamTrack} */ (new W.MediaStreamTrackGenerator({ kind: 'video' }));
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {OffscreenCanvas} */ (this.out).getContext('2d'));
    (async () => {
      while (!this.stopped) {
        const { value: frame, done } = await reader.read().catch(() => ({ value: null, done: true }));
        if (done || !frame) break;
        try {
          this.composite(ctx, frame, frame.displayWidth, frame.displayHeight);
          const out = new VideoFrame(/** @type {OffscreenCanvas} */ (this.out), { timestamp: frame.timestamp });
          frame.close();
          await writer.write(out);
          out.close();
        } catch (err) {
          frame.close();
          if (!this.stopped) console.warn('[blur]', err);
          break;
        }
      }
      if (!this.stopped) generator.stop(); // the camera track ended
    })();
    this.cleanup = () => { reader.cancel().catch(() => {}); writer.close().catch(() => {}); };
    this.output = generator;
    return generator;
  }

  /** Other browsers: play the camera in a video element, draw it blurred onto a canvas and capture that. @param {MediaStreamTrack} camera */
  async startCanvas(camera) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream([camera]);
    await video.play();
    const canvas = document.createElement('canvas');
    this.out = canvas;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    const track = canvas.captureStream(30).getVideoTracks()[0];
    // A worker's timer keeps ticking in a background tab, where the page's own timers slow down.
    const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' })));
    worker.onmessage = () => {
      if (this.stopped || video.readyState < 2 || !video.videoWidth) return;
      try { this.composite(ctx, video, video.videoWidth, video.videoHeight); } catch (err) { console.warn('[blur]', err); }
    };
    this.cleanup = () => { worker.terminate(); video.srcObject = null; };
    this.output = track;
    return track;
  }

  /**
   * Draws one blurred frame: the whole picture blurred, with the person (from the model's mask)
   * drawn sharp on top.
   * @param {OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D} ctx @param {CanvasImageSource} src @param {number} w @param {number} h
   */
  composite(ctx, src, w, h) {
    if (this.out.width !== w || this.out.height !== h) {
      this.out.width = this.person.width = w;
      this.out.height = this.person.height = h;
      this.tiny.width = Math.max(1, Math.round(w / 24));
      this.tiny.height = Math.max(1, Math.round(h / 24));
    }
    // Find the person: at most SEGMENT_HZ times a second (the model is most of the work; a
    // person moves little between two frames, so the frames in between reuse the last mask).
    const now = performance.now();
    if (!this.hasMask || now - this.lastTs >= 1000 / SEGMENT_HZ) this.segment(src, now);
    this.draw(ctx, src, w, h);
  }

  /** Runs the model on one frame and keeps its mask. @param {CanvasImageSource} src @param {number} now */
  segment(src, now) {
    this.smallCtx.drawImage(src, 0, 0, MASK_W, MASK_H);
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    this.segmenter.segmentForVideo(this.small, ts, (/** @type {any} */ result) => {
      const m = result.confidenceMasks?.[this.maskIndex];
      if (!m) return;
      const conf = m.getAsFloat32Array();
      const px = this.maskData.data;
      for (let i = 0; i < conf.length; i++) px[i * 4 + 3] = conf[i] * 255;
      this.maskCtx.putImageData(this.maskData, 0, 0);
      this.hasMask = true;
    });
  }

  /**
   * Draws the frame blurred, with the person cut out by the mask drawn sharp on top.
   * @param {OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D} ctx @param {CanvasImageSource} src @param {number} w @param {number} h
   */
  draw(ctx, src, w, h) {
    // The background, blurred.
    ctx.globalCompositeOperation = 'copy';
    if (this.canFilter) {
      const r = Math.max(4, Math.round(w / 90));
      ctx.filter = `blur(${r}px)`;
      ctx.drawImage(src, -2 * r, -2 * r, w + 4 * r, h + 4 * r); // overdraw so the edges don't fade
      ctx.filter = 'none';
    } else {
      this.tinyCtx.drawImage(src, 0, 0, this.tiny.width, this.tiny.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.tiny, 0, 0, w, h);
    }
    if (!this.hasMask) return; // nothing found yet: show only the blur rather than the room
    // The person, cut out with the mask (scaled up and softened at the edges).
    const p = this.personCtx;
    p.globalCompositeOperation = 'copy';
    p.imageSmoothingQuality = 'high';
    if (this.canFilter) p.filter = `blur(${Math.max(1, Math.round(w / 640))}px)`;
    p.drawImage(this.mask, 0, 0, w, h);
    p.filter = 'none';
    p.globalCompositeOperation = 'source-in';
    p.drawImage(src, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.person, 0, 0);
  }

  stop() {
    this.stopped = true;
    this.cleanup?.();
    this.output?.stop();
  }
}
