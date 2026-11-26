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
{"title":"<hook headline, max 6 words, same language as the speech>",
 "segments":[{"i":<segment number>,"phrases":[{"text":"<2-5 words>","hi":"<one word from that phrase to highlight, or empty>"}]}],
 "broll":[{"i":<segment number>,"prompt":"<a vivid, concrete image prompt in English for that moment, no text in the image>"}],
 "mood":"<background music mood in English, e.g. calm lo-fi, upbeat pop, cinematic>",
 "post":"<a social media caption in the speech's language, max 200 characters, then 3-6 hashtags>"}
Rules:
- Split each segment's text into phrases of 2 to 5 words, in order, using the segment's own words (fix obvious transcription typos only).
- Highlight the single most important word of a phrase (a number, a key noun or verb); leave "hi" empty for filler phrases.
- broll: 0 to 3 moments where a picture helps (a concrete thing, place or action is mentioned). Skip abstract talk.
- Keep the speech's language for title, phrases and post. No emoji in phrases or title.`;

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
    // Real word times (Whisper): each phrase takes its own words' times, in order. Used only when the phrases have
    // exactly as many words as the transcript; any re-wording falls back to the proportional split below.
    const segWords = Array.isArray(seg.words) ? seg.words.filter((x) => x && x.w) : [];
    const phraseWords = phrases.map((p) => String(p.text).split(/\s+/).filter(Boolean));
    if (segWords.length && phraseWords.reduce((n, w) => n + w.length, 0) === segWords.length) {
      let k = 0;
      phrases.forEach((p, pi) => {
        const ws = phraseWords[pi].map((w) => {
          const src = segWords[k++];
          return { w, from: round3(src.from), to: round3(src.to) };
        });
        const nextStart = k < segWords.length ? segWords[k].from : seg.to;
        const hi = String(p.hi ?? '').trim();
        out.push({ from: ws[0].from, to: round3(Math.max(ws.at(-1).to, nextStart)), text: String(p.text).trim(), hi: hi && norm(p.text).includes(norm(hi)) ? hi : '', words: ws });
      });
      return;
    }
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

/** B-roll moments: at most 3, each at its segment's start for up to 2.2 s, never overlapping. */
export function cleanBroll(plan, segments) {
  const out = [];
  for (const b of Array.isArray(plan?.broll) ? plan.broll : []) {
    const seg = segments[b?.i];
    const prompt = String(b?.prompt ?? '').trim().slice(0, 300);
    if (!seg || !prompt) continue;
    const from = seg.from;
    const to = Math.min(seg.to, from + 2.2);
    if (to - from < 0.8 || out.some((x) => from < x.to && to > x.from)) continue;
    out.push({ from: round3(from), to: round3(to), prompt });
    if (out.length === 3) break;
  }
  return out;
}

export function cleanPost(s) {
  return String(s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 400);
}

/** Punch-in zoom: 1 + up to 8% around each highlighted word, easing in and out over 0.45 s. */
export function zoomAt(captions, t) {
  let z = 1;
  for (const c of captions) {
    if (!c.hi || t < c.from - 0.5 || t > c.to + 0.5) continue;
    const key = c.hi.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const w = (c.words ?? []).find((x) => x.w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === key);
    if (!w) continue;
    const a = (t - w.from) / 0.45;
    if (a >= 0 && a <= 1) z = Math.max(z, 1 + 0.08 * Math.sin(a * Math.PI));
  }
  return z;
}

/**
 * Music under the voice: looped to length, faded in (0.6 s) and out (1.2 s), at `gain`, and ducked to 40% of that
 * while the voice is loud. Channels are mixed per channel; the music's channel is reused when it has fewer.
 */
export function mixMusic(voice, music, rate, gain = 0.16) {
  const len = voice[0].length;
  const out = voice.map((ch) => new Float32Array(ch));
  if (!music?.length || !music[0].length) return out;
  const win = Math.max(1, Math.floor(rate * 0.05));
  const env = new Float32Array(Math.ceil(len / win));
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    const a = i * win;
    const b = Math.min(len, a + win);
    for (let j = a; j < b; j++) s += Math.abs(voice[0][j]);
    env[i] = s / Math.max(1, b - a);
  }
  const fi = rate * 0.6;
  const fo = rate * 1.2;
  for (let c = 0; c < out.length; c++) {
    const m = music[Math.min(c, music.length - 1)];
    for (let i = 0; i < len; i++) {
      const fade = Math.min(1, i / fi, (len - i) / fo);
      const duck = env[Math.floor(i / win)] > 0.04 ? 0.4 : 1;
      out[c][i] = Math.max(-1, Math.min(1, out[c][i] + m[i % m.length] * gain * duck * fade));
    }
  }
  return out;
}
