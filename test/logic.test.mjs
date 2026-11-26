import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechSegments, wavBytes, toBase64, autoPhrases, timeCaptions, captionAt, cleanTitle, extractJson } from '../app/bundle/logic.js';

const RATE = 16000;
/** Tone bursts with silence between: [from, to] seconds. */
function bursts(spans, total) {
  const s = new Float32Array(total * RATE);
  for (const [a, b] of spans) for (let i = a * RATE; i < b * RATE; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return s;
}

test('finds speech between pauses', () => {
  const segs = speechSegments(bursts([[0.5, 2.0], [2.8, 5.0]], 6), RATE);
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[0].from - 0.5) < 0.05 && Math.abs(segs[0].to - 2.0) < 0.05);
  assert.ok(Math.abs(segs[1].from - 2.8) < 0.05);
});

test('a short pause does not split; a long stretch is cut at 8 s; silence gives nothing', () => {
  assert.equal(speechSegments(bursts([[0, 2], [2.1, 4]], 5), RATE).length, 1);
  const long = speechSegments(bursts([[0, 19]], 20), RATE);
  assert.ok(long.length >= 3 && long.every((s) => s.to - s.from <= 8.001));
  assert.deepEqual(speechSegments(new Float32Array(RATE * 3), RATE), []);
});

test('wav is 16 kHz mono 16-bit with the right length', () => {
  const w = wavBytes(bursts([[0, 1]], 2), RATE, 0, 1);
  const dv = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), 'RIFF');
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint32(40, true), 32000);
  assert.ok(toBase64(w).length > 40000);
});

test('captions take AI phrases only when they match the transcript, and split time by length', () => {
  const segs = [{ from: 0, to: 3, text: 'aku nggak edit sama sekali' }, { from: 4, to: 6, text: 'semuanya otomatis' }];
  const plan = { segments: [{ i: 0, phrases: [{ text: 'aku nggak edit', hi: 'edit' }, { text: 'sama sekali', hi: '' }] }, { i: 1, phrases: [{ text: 'totally different words here', hi: 'words' }] }] };
  const caps = timeCaptions(segs, plan);
  assert.equal(caps[0].text, 'aku nggak edit');
  assert.equal(caps[0].hi, 'edit');
  assert.equal(caps[0].from, 0);
  assert.equal(caps[1].to, 3);
  assert.equal(caps[2].text, 'semuanya otomatis'); // fallback for the mismatched segment
  assert.equal(caps[2].hi, 'semuanya');
  assert.equal(caps[0].words.length, 3);
  assert.equal(caps[0].words.at(-1).to, caps[0].to);
  assert.equal(captionAt(caps, 3.5), null);
  assert.equal(captionAt(caps, 4.2).text, 'semuanya otomatis');
});

test('fallback phrases, title and JSON helpers', () => {
  assert.deepEqual(autoPhrases('a bb ccc dddd eeeee'), [{ text: 'a bb ccc', hi: '' }, { text: 'dddd eeeee', hi: 'eeeee' }]);
  assert.equal(cleanTitle('#Edit video tanpa ribet sama sekali hari ini'), 'Edit video tanpa ribet sama sekali');
  assert.deepEqual(extractJson('ok ```json\n{"a":1}\n```'), { a: 1 });
});

test('with real word times (Whisper), each phrase spans its own words', () => {
  const seg = { from: 1, to: 4, text: 'I never edit my videos', words: [{ w: 'I', from: 1, to: 1.2 }, { w: 'never', from: 1.3, to: 1.8 }, { w: 'edit', from: 2.0, to: 2.4 }, { w: 'my', from: 2.9, to: 3.0 }, { w: 'videos', from: 3.1, to: 3.8 }] };
  const caps = timeCaptions([seg], { segments: [{ i: 0, phrases: [{ text: 'I never edit', hi: 'never' }, { text: 'my videos', hi: 'videos' }] }] });
  assert.equal(caps.length, 2);
  assert.deepEqual([caps[0].from, caps[0].to], [1, 2.9]); // held until the next phrase starts
  assert.deepEqual([caps[1].from, caps[1].to], [2.9, 4]);
  assert.deepEqual(caps[1].words.map((w) => [w.w, w.from]), [['my', 2.9], ['videos', 3.1]]);
  // A re-worded phrase falls back to the proportional split.
  const fb = timeCaptions([seg], { segments: [{ i: 0, phrases: [{ text: 'I never edit my clips at all', hi: '' }] }] });
  assert.equal(fb.length, 2);
});
