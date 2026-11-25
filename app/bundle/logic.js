// Motion Lite, pure logic (no DOM, no host): speech segments, WAV encoding, caption timing, plan checks.
// Tested by test/logic.test.mjs (node --test).

export const MAX_SECONDS = 60;
export const STT_RATE = 16000;

/**
 * Where someone is speaking, from the audio alone. Anna's transcription returns text without timestamps, so each
 * stretch of speech is transcribed on its own: its text then has an exact start and end, at the same cost (STT is
 * billed per audio second). Energy over 30 ms windows; the threshold adapts to the recording (between the quiet floor
 * and the loud level); pauses of 250 ms or more split; pieces are 0.6-8 s.
 */
export function speechSegments(samples, rate, { win = 0.03, minPause = 0.25, minLen = 0.6, maxLen = 8 } = {}) {
  const n = Math.max(1, Math.floor(rate * win));
  const energy = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += samples[j] * samples[j];
    energy.push(Math.sqrt(s / n));
  }
  if (!energy.length) return [];
  const sorted = [...energy].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const loud = sorted[Math.floor(sorted.length * 0.9)];
  const thr = floor + (loud - floor) * 0.25;
  if (loud - floor < 1e-4) return []; // silence (or a constant hum): nothing to caption
  const voiced = energy.map((e) => e > thr);
  // Close short gaps, then collect runs.
  const gap = Math.round(minPause / win);
  for (let i = 0; i < voiced.length; i++) {
    if (voiced[i]) continue;
    let j = i;
    while (j < voiced.length && !voiced[j]) j++;
    if (i > 0 && j < voiced.length && j - i < gap) for (let k = i; k < j; k++) voiced[k] = true;
    i = j - 1;
  }
  const out = [];
  for (let i = 0; i < voiced.length; i++) {
    if (!voiced[i]) continue;
    let j = i;
    while (j < voiced.length && voiced[j]) j++;
    let from = i * win;
    const to = j * win;
    while (to - from > maxLen) {
      out.push({ from, to: from + maxLen });
      from += maxLen;
    }
    if (to - from >= minLen) out.push({ from, to });
    i = j - 1;
  }
  return out.map((s) => ({ from: round3(s.from), to: round3(s.to) }));
}
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Mono Float32 slice at any rate → 16 kHz 16-bit PCM WAV bytes. */
export function wavBytes(samples, rate, from, to, outRate = STT_RATE) {
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(samples.length, Math.ceil(to * rate));
  const len = Math.max(0, Math.floor(((b - a) * outRate) / rate));
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + len * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const v = samples[a + Math.floor((i * rate) / outRate)] ?? 0;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const PLAN_PROMPT = `You edit short talking-head videos into punchy social clips. You get numbered speech segments with their text.
Return ONLY JSON:
{"title":"<hook headline, max 6 words, same language as the speech>","segments":[{"i":<segment number>,"phrases":[{"text":"<2-5 words>","hi":"<one word from that phrase to highlight, or empty>"}]}]}
Rules:
- Split each segment's text into phrases of 2 to 5 words, in order, using the segment's own words (fix obvious transcription typos only).
- Highlight the single most important word of a phrase (a number, a key noun or verb); leave "hi" empty for filler phrases.
- Keep the speech's language. No emoji, no hashtags.`;

/** Fallback when the AI's phrases do not fit a segment: 3-word phrases, highlight the longest word. */
export function autoPhrases(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3);
    const hi = [...chunk].sort((a, b) => b.length - a.length)[0]?.replace(/[^\p{L}\p{N}]/gu, '') ?? '';
    out.push({ text: chunk.join(' '), hi: hi.length >= 4 ? hi : '' });
  }
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const wordsOf = (s) => String(s).toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);
/** Same speech, allowing a fixed typo or two: 80% of each side's words appear in the other. */
function sameWords(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (!A.length || !B.length) return false;
  const inB = new Set(B);
  const inA = new Set(A);
  return A.filter((w) => inB.has(w)).length >= A.length * 0.8 && B.filter((w) => inA.has(w)).length >= B.length * 0.8;
}

/**
 * Captions with times. Each phrase gets a share of its segment proportional to its length in characters, and each
 * word a share of its phrase, so a karaoke highlight can follow the voice. AI phrases are used only when they spell
 * the same words as the transcript (ignoring case and punctuation); otherwise the fallback phrasing is used.
 */
export function timeCaptions(segments, plan) {
  const out = [];
  segments.forEach((seg, i) => {
    if (!seg.text?.trim()) return;
    let phrases = plan?.segments?.find((s) => s.i === i)?.phrases;
    const ok = Array.isArray(phrases) && phrases.length && sameWords(phrases.map((p) => p?.text ?? '').join(' '), seg.text);
    if (!ok) phrases = autoPhrases(seg.text);
    const lens = phrases.map((p) => Math.max(1, String(p.text).length));
    const total = lens.reduce((a, b) => a + b, 0);
    let t = seg.from;
    phrases.forEach((p, k) => {
      const dur = ((seg.to - seg.from) * lens[k]) / total;
      const words = String(p.text).split(/\s+/).filter(Boolean);
      const wl = words.map((w) => Math.max(1, w.length));
      const wt = wl.reduce((a, b) => a + b, 0);
      let wt0 = t;
      const timed = words.map((w, j) => {
        const d = (dur * wl[j]) / wt;
        const r = { w, from: round3(wt0), to: round3(wt0 + d) };
        wt0 += d;
        return r;
      });
      const hi = String(p.hi ?? '').trim();
      out.push({ from: round3(t), to: round3(t + dur), text: String(p.text).trim(), hi: hi && norm(p.text).includes(norm(hi)) ? hi : '', words: timed });
      t += dur;
    });
  });
  return out;
}

export const captionAt = (captions, t) => captions.find((c) => t >= c.from && t < c.to) ?? null;

export function cleanTitle(s) {
  return String(s ?? '').replace(/[#\n\r]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
}

export function extractJson(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no_json');
  return JSON.parse(s.slice(a, b + 1));
}
