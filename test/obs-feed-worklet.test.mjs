// Runs the OBS-feed AudioWorklet (the source string in mixer.js) outside a browser and checks
// that OBS audio reaches guests at the right speed, cleanly, through bursts and clock drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../data/app/public/common/mixer.js', import.meta.url), 'utf8')
  .split('const OBS_FEED_WORKLET = `')[1].split('`;')[0];

/** Loads the worklet at page rate `pageRate`; returns the processor and the clock. */
function load(pageRate) {
  const clock = { t: 0 };
  const messages = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m) => messages.push(m) }; } }
  let Proc;
  const scope = { AudioWorkletProcessor, registerProcessor: (_n, c) => { Proc = c; }, sampleRate: pageRate };
  // currentTime is read as a global inside the worklet.
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'clock',
    `with (clock) { ${src} }`)(scope.AudioWorkletProcessor, scope.registerProcessor, pageRate, new Proxy(clock, {
    has: (_t, k) => k === 'currentTime', get: (t, k) => (k === 'currentTime' ? t.t : undefined),
  }));
  return { proc: new Proc(), clock, messages };
}

/**
 * Feeds `secs` of a 1 kHz tone at `obsRate` (actually produced at obsRate * drift) in
 * 1024-frame chunks that arrive in bursts of `burst`, and plays it at the page rate.
 */
function run({ obsRate = 48000, pageRate = 48000, secs = 20, drift = 1, burst = 3 }) {
  const { proc, clock, messages } = load(pageRate);
  const out = [];
  let made = 0, sent = 0;
  const pending = [];
  const quantum = 128;
  const L = new Float32Array(quantum), R = new Float32Array(quantum);
  let minQ = Infinity, maxQ = 0;
  for (let q = 0; q < (secs * pageRate) / quantum; q++) {
    clock.t = (q * quantum) / pageRate;
    // OBS produces audio by its own clock (drift), in 1024-frame chunks...
    while (made < clock.t * obsRate * drift) {
      const c = new Float32Array(2048);
      for (let i = 0; i < 1024; i++) c[i * 2] = c[i * 2 + 1] = Math.sin((2 * Math.PI * 1000 * (made + i)) / obsRate) * 0.5;
      pending.push(c); made += 1024;
    }
    // ...which reach the page in bursts.
    if (pending.length >= burst) { for (const c of pending.splice(0)) { proc.port.onmessage({ data: { samples: c, rate: obsRate } }); sent++; } }
    proc.process([], [[L, R]]);
    out.push(...L);
    if (clock.t > secs / 2) { const qd = (proc.w - proc.r) / obsRate; minQ = Math.min(minQ, qd); maxQ = Math.max(maxQ, qd); }
  }
  return { out: Float32Array.from(out), messages, proc, minQ, maxQ };
}

/** Frequency of the tone, from zero crossings. */
function analyse(x, rate) {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return { freq: (crossings * rate) / x.length };
}

test('plays at the right speed when the page runs at 44.1 kHz', () => {
  const { out } = run({ pageRate: 44100, secs: 10 });
  const tail = out.subarray(44100 * 2); // after start-up
  const { freq } = analyse(tail, 44100);
  assert.ok(Math.abs(freq - 1000) < 10, `tone at ${freq} Hz`);
});

test('resampling is clean (interpolated, not nearest-sample)', () => {
  const { out } = run({ pageRate: 44100, secs: 4, burst: 1 });
  // Compare against an ideal 1 kHz sine fitted to a stretch of steady output.
  const seg = out.subarray(44100, 44100 + 4410);
  let best = Infinity;
  for (let p = 0; p < 44.1; p += 0.05) {
    let err = 0;
    for (let i = 0; i < seg.length; i++) err = Math.max(err, Math.abs(seg[i] - 0.5 * Math.sin((2 * Math.PI * 1000 * (i + p)) / 44100)));
    best = Math.min(best, err);
  }
  assert.ok(best < 0.01, `max error ${best}`);
});

test('bursty arrival and clock drift cause no skips or gaps', () => {
  for (const drift of [0.998, 1.002]) {
    const { messages, proc, minQ, maxQ } = run({ secs: 60, drift, burst: 4 });
    const glitches = messages.filter((m) => !m.started && (m.underruns || m.droppedMs));
    assert.deepEqual(glitches, [], `drift ${drift}`);
    assert.equal(proc.underruns + proc.dropped, 0, `drift ${drift}`);
    // Latency stays bounded and the buffer never runs dry (bursts are ~85 ms apart).
    assert.ok(minQ > 0.005 && maxQ < 0.25, `drift ${drift}: ${minQ * 1000}-${maxQ * 1000} ms queued`);
  }
});

test('a big backlog is dropped down to the target', () => {
  const { proc, messages } = load(48000);
  for (let i = 0; i < 40; i++) proc.port.onmessage({ data: { samples: new Float32Array(2048), rate: 48000 } });
  assert.ok((proc.w - proc.r) / 48000 < 0.5);
  assert.ok(proc.dropped > 0);
  assert.equal(messages[0].started, true);
});
