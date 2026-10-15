import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestAudioLine } from '../data/app/server/http.js';

test('guest audio report becomes one OBS-log line from numbers only', () => {
  const line = guestAudioLine('Pat\nInjected', {
    secs: 10, packets: 500, lost: 3, jitterMs: 12.4, bufferMs: 180, acceleratedPct: 7.25,
    deceleratedPct: 0, concealedPct: 1.5, rate: 48000, ice: 'connected', paused: false,
    playbackRate: 1, browser: 'Mozilla/5.0 (iPhone)', evil: '<script>',
  });
  assert.ok(!line.includes('\n'));
  assert.match(line, /^\[guest Pat ?Injected\] program audio: 10s; recv 500 pkts, lost 3; jitter 12ms, buffer 180ms; sped up 7\.3%/);
  assert.match(line, /rate 48000Hz; ice connected; browser Mozilla\/5\.0 \(iPhone\)$/);
  assert.ok(!line.includes('script'));
});

test('non-numeric fields show as ?', () => {
  const line = guestAudioLine('G', { secs: 'x', packets: {}, rate: NaN });
  assert.match(line, /\?s; recv \? pkts/);
  assert.match(line, /rate \?Hz$/);
});
