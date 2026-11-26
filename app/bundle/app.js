// Motion Lite on Anna: pick a talking video, get captions, export an MP4, all without our servers.
//   speech:  found in the browser (logic.speechSegments), each stretch transcribed with anna.audio.transcribe
//            (the user's Anna credits) so every caption has a real start and end;
//   plan:    one anna.llm.complete call splits the text into short phrases, picks highlight words and a headline;
//   render:  the same overlay code draws the preview and the export (render.js);
//   export:  the video plays once in real time, each shown frame is drawn and encoded with WebCodecs, muxed with the
//            original audio by mp4-muxer. Measured on a mid-range phone (Dimensity 7300): 60 s in about 67 s.
import { AnnaAppRuntime } from '/static/anna-apps/_sdk/latest/index.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';
import { MAX_SECONDS, STT_RATE, PLAN_PROMPT, speechSegments, wavBytes, toBase64, timeCaptions, captionAt, cleanTitle, extractJson, cleanBroll, cleanPost, mixMusic } from './logic.js';
import { STYLES, drawOverlay, drawSample, drawBase } from './render.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FPS = 30;
const GLIANA_STT = 'https://api.glianalabs.com/v1/motion-lite/transcribe';
const MAX_W = 1080;

let anna = null;
let file = null;
let project = { style: 'pop', title: '', captions: [], broll: [], mood: '', post: '', music: null };
let size = { w: 720, h: 1280 };

function say(el, msg, err = false) {
  el.textContent = msg;
  el.classList.toggle('err', err);
}
const store = (k, v) => anna?.storage.set({ key: k, value: v }).catch(() => undefined);
function progress(which, frac) {
  const wrap = $(which === 'ex' ? 'ex-prog' : 'prog');
  const bar = $(which === 'ex' ? 'ex-bar' : 'prog-bar');
  wrap.hidden = frac == null;
  if (frac != null) bar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ── Video ────────────────────────────────────────────────────────────────
const v = $('v');
async function loadVideo(f) {
  v.src = URL.createObjectURL(f);
  v.muted = false;
  await new Promise((resolve, reject) => {
    v.onloadedmetadata = resolve;
    v.onerror = () => reject(new Error('This video cannot be opened here. Try an MP4 or WebM.'));
  });
  if (!(v.duration > 0)) throw new Error('Could not read the video length.');
  if (v.duration > MAX_SECONDS + 0.5) throw new Error(`This video is ${Math.round(v.duration)} s. Motion Lite takes up to ${MAX_SECONDS} s.`);
  // The shorter side at most 1080 px: a 1080x1920 phone video keeps its size, a 4K one is scaled down.
  const k = Math.min(1, MAX_W / Math.min(v.videoWidth, v.videoHeight));
  size = { w: Math.round((v.videoWidth * k) / 2) * 2, h: Math.round((v.videoHeight * k) / 2) * 2 };
  const cv = $('cv');
  cv.width = size.w;
  cv.height = size.h;
}

async function decodeAudio(f, rate) {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buf = await ctx.decodeAudioData(await f.arrayBuffer());
  return buf;
}
function mono(buf) {
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

// ── Captions: speech → text → phrases ────────────────────────────────────

/**
 * One piece of speech, as text. Anna routes transcription to the user's own STT provider, and providers differ in
 * what they accept: on 2026-11-26 the first real run (Alibaba DashScope behind Anna) refused inline WAV with
 * "url error, please check url". So the piece is tried as WAV, then as M4A (AAC, encoded here with WebCodecs), then
 * with each other STT model the catalogue lists; the first combination that works is kept for every later piece.
 */
async function transcribePiece(samples, seg, lang, stt) {
  const attempts = [];
  if (stt.working) attempts.push(stt.working);
  // First as a link (2026-11-26: inline base64 failed on EVERY model with the provider's "url error", so Anna's inline
  // path is the broken part): the piece goes to Anna (upload.inline) and the provider fetches a presigned URL.
  for (const a of [{ format: 'wav', via: 'url' }, { format: 'm4a', via: 'url' }, { format: 'wav' }, { format: 'm4a' }])
    if (!attempts.some((x) => x.format === a.format && x.via === a.via && !x.model)) attempts.push(a);
  if (!stt.models) {
    const cat = await anna.llm.catalog({ serviceType: 'stt' }).catch(() => null);
    stt.models = (cat?.models ?? []).map((m) => m.modelName).filter(Boolean);
  }
  for (const m of stt.models) for (const format of ['wav', 'm4a']) if (!attempts.some((x) => x.model === m && x.format === format && x.via === 'url')) attempts.push({ format, model: m, via: 'url' });
  let lastErr = null;
  for (const a of attempts) {
    let uploaded = null;
    try {
      const bytes = a.format === 'm4a' ? await m4aBytes(samples, seg.from, seg.to) : wavBytes(samples, STT_RATE, seg.from, seg.to);
      if (!bytes) continue; // this browser cannot encode AAC
      const common = { format: a.format, ...(a.model ? { model: a.model } : {}), ...(lang ? { language: lang } : {}) };
      let r;
      if (a.via === 'url') {
        uploaded = await uploadForStt(bytes, a.format);
        r = await anna.audio.transcribe({ audioUrl: uploaded.url, ...common }, { timeoutMs: 120_000 });
      } else {
        r = await anna.audio.transcribe({ audioBase64: toBase64(bytes), ...common }, { timeoutMs: 120_000 });
      }
      stt.working = a;
      return String(r?.text ?? '').trim();
    } catch (e) {
      if (/QUOTA/i.test(String(e?.code ?? e?.message))) throw e; // out of credits: retrying other models would not help
      lastErr = e;
      stt.tried.push(`${a.model ?? 'default'}/${a.format}/${a.via ?? 'inline'}`);
    }
  }
  throw new Error(`Transcription failed (${stt.tried.slice(-4).join(', ')}): ${String(lastErr?.message ?? lastErr).slice(0, 200)}`);
}

/**
 * Hand one audio piece to Anna and get a ~30-minute presigned link for the STT provider (anna.upload.inline: the bytes
 * travel through the host RPC, so no browser PUT, CSP or CORS is involved). 2026-11-26: the first try used
 * files.upload_init + a direct PUT and failed with "Failed to fetch" in the real Anna window.
 */
async function uploadForStt(bytes, format) {
  const mime = format === 'm4a' ? 'audio/mp4' : 'audio/wav';
  const r = await anna.upload.inline({ filename: `speech-${Date.now()}.${format}`, mime_type: mime, content_b64: toBase64(bytes), purpose: 'user_artifact' });
  if (!r?.download_url) throw new Error('upload returned no link');
  return { url: r.download_url };
}

/** A piece of mono 16 kHz audio as M4A (AAC-LC) bytes, or null when this browser has no AAC encoder. */
async function m4aBytes(samples, from, to) {
  if (!('AudioEncoder' in window)) return null;
  let rate = 16000;
  let up = 1;
  if (!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 16000, numberOfChannels: 1 }).catch(() => ({}))).supported) {
    if (!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1 }).catch(() => ({}))).supported) return null;
    rate = 48000;
    up = 3; // 16 kHz → 48 kHz, linear
  }
  const a = Math.max(0, Math.floor(from * STT_RATE));
  const b = Math.min(samples.length, Math.ceil(to * STT_RATE));
  const src = samples.subarray(a, b);
  const pcm = new Float32Array(src.length * up);
  for (let i = 0; i < pcm.length; i++) {
    const x = i / up;
    const k = Math.floor(x);
    const f = x - k;
    pcm[i] = (src[k] ?? 0) * (1 - f) + (src[k + 1] ?? src[k] ?? 0) * f;
  }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: 'aac', numberOfChannels: 1, sampleRate: rate }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: () => undefined });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, bitrate: 64_000 });
  for (let s = 0; s < pcm.length; s += 4096) {
    const n = Math.min(4096, pcm.length - s);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((s / rate) * 1e6), data: pcm.slice(s, s + n) });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
async function makeCaptions() {
  if (!anna) throw new Error('Open Motion Lite inside Anna to make captions.');
  say($('status'), 'Listening for speech…');
  progress('mk', 0.05);
  let samples;
  try {
    samples = mono(await decodeAudio(file, STT_RATE));
  } catch {
    throw new Error('This video has no audio track we can read.');
  }
  const lang = $('lang').value || undefined;
  // First: GlianaAI's free Whisper (one call, real word times). Anna's audio.transcribe failed for every model with the
  // provider's "url error" on 2026-11-26; it stays as the fallback, per speech piece.
  const gl = await glianaStt(samples, lang).catch(() => null);
  let segments = gl;
  if (!segments) segments = await annaStt(samples, lang);
  if (!segments.length) throw new Error('The speech could not be transcribed. Try a clearer recording.');
  return planCaptions(segments);
}

/** GlianaAI speech-to-text: the whole clip as 16 kHz WAV, back as segments with word times; null if unavailable. */
async function glianaStt(samples, lang) {
  say($('status'), 'Transcribing…');
  progress('mk', 0.15);
  const body = wavBytes(samples, STT_RATE, 0, samples.length / STT_RATE);
  const r = await fetch(`${GLIANA_STT}${lang ? `?language=${lang}` : ''}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) return null;
  const j = await r.json();
  const segs = (j.segments ?? [])
    .map((s) => ({ from: s.start, to: s.end, text: String(s.text ?? '').trim(), words: (s.words ?? []).map((w) => ({ w: w.word, from: w.start, to: w.end })) }))
    .filter((s) => s.text && s.to > s.from);
  progress('mk', 0.8);
  return segs.length ? segs : null;
}

/** Anna speech-to-text, one speech piece at a time (each piece keeps its real start and end). */
async function annaStt(samples, lang) {
  const segs = speechSegments(samples, STT_RATE);
  if (!segs.length) throw new Error('No speech found in this video.');
  let done = 0;
  const texts = new Array(segs.length).fill('');
  const stt = { working: null, models: null, tried: [] };
  const step = () => {
    done++;
    say($('status'), `Transcribing ${done} of ${segs.length}…`);
    progress('mk', 0.1 + (0.7 * done) / segs.length);
  };
  // The first piece finds a format/model the user's STT provider accepts; the rest reuse it, three at a time.
  texts[0] = await transcribePiece(samples, segs[0], lang, stt);
  step();
  const queue = segs.map((s, i) => i).slice(1);
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      texts[i] = await transcribePiece(samples, segs[i], lang, stt);
      step();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return segs.map((s, i) => ({ ...s, text: texts[i] })).filter((s) => s.text);
}

/** One AI call: short phrases, highlight words and a headline, timed from the transcript. */
async function planCaptions(segments) {
  say($('status'), 'Writing captions…');
  progress('mk', 0.88);
  let plan = null;
  try {
    const r = await anna.llm.complete({
      systemPrompt: PLAN_PROMPT,
      messages: [{ role: 'user', content: segments.map((s, i) => `${i}: ${s.text}`).join('\n') }],
      maxTokens: 2500,
      temperature: 0.3,
      thinking: false,
    });
    plan = extractJson(r?.content?.text);
  } catch {
    plan = null; // captions still come out, phrased by the fallback
  }
  // Segment numbers in the prompt index the filtered list.
  return { title: cleanTitle(plan?.title), captions: timeCaptions(segments, plan), broll: cleanBroll(plan, segments), mood: String(plan?.mood ?? '').trim().slice(0, 80), post: cleanPost(plan?.post) };
}

// ── Preview ──────────────────────────────────────────────────────────────
const g = $('cv').getContext('2d');
function paint() {
  drawBase(g, v, size.w, size.h, v.currentTime, project);
  drawOverlay(g, size.w, size.h, v.currentTime, project);
  $('seek').value = String(Math.round((v.currentTime / v.duration) * 1000));
  $('time').textContent = clock(v.currentTime);
}
function loop() {
  paint();
  if (!v.paused && !v.ended) v.requestVideoFrameCallback(loop);
}
async function seekTo(t) {
  v.currentTime = t;
  await new Promise((r) => (v.onseeked = r));
  paint();
}

/** Style picker: each choice is a small live render of that look, drawn by the same code as the export. */
function renderSwatches(el) {
  el.innerHTML = Object.entries(STYLES)
    .map(([id, s]) => `<button type="button" class="sw" role="radio" data-style="${id}" aria-checked="${id === project.style}" aria-label="${s.name}"><canvas width="240" height="320"></canvas><span>${s.name}</span></button>`)
    .join('');
  el.querySelectorAll('.sw').forEach((b) => {
    drawSample(b.querySelector('canvas').getContext('2d'), 240, 320, b.dataset.style, b.dataset.style === 'karaoke' ? 0.5 : 1.1);
    b.onclick = () => {
      project.style = b.dataset.style;
      document.querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.style === project.style)));
      if (!$('studio').hidden) paint();
      save();
    };
  });
}

/** The upload screen's demo: the chosen look, looping over a sample frame. */
function demo() {
  const c = $('demo');
  const dg = c.getContext('2d');
  const t0 = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (now) => {
    if ($('pick').hidden) return;
    drawSample(dg, c.width, c.height, project.style, reduce ? 1.1 : ((now - t0) / 1000) % 4.6);
    if (!reduce) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const save = () =>
  store('last', {
    name: file?.name,
    style: project.style,
    title: project.title,
    captions: project.captions,
    broll: project.broll.map(({ from, to, prompt }) => ({ from, to, prompt })),
    mood: project.mood,
    post: project.post,
  });

// ── Extras on Anna: music, B-roll pictures ───────────────────────────────
/**
 * Bring an Anna media link (presigned R2) into the window as a blob:. Only a blob (or a CORS-readable file) can be drawn
 * into the export canvas or decoded for the mix; a plain cross-origin <img> would taint the canvas and break export.
 */
async function loadAsset(url) {
  const r = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  return { blob, url: URL.createObjectURL(blob) };
}

async function musicModel() {
  const cat = await anna.llm.catalog({ serviceType: 'music_gen' }).catch(() => null);
  const ms = cat?.models ?? [];
  return ms.find((m) => m.isUserPreferred) ?? ms[0] ?? null;
}

async function addMusic() {
  const btn = $('add-music');
  btn.disabled = true;
  const st = $('music-status');
  st.classList.remove('done');
  try {
    st.textContent = 'Composing music… (about a minute)';
    const m = await musicModel();
    const d = m?.capabilities?.duration;
    const want = Math.ceil(v.duration) + 1;
    const durationSec = d?.type === 'range' ? Math.min(Math.max(want, d.min ?? 5), d.max ?? want) : undefined;
    const job = await anna.music.generateAwait(
      {
        prompt: `${project.mood || 'warm, modern'} instrumental background music for a short talking video, no vocals, steady, not distracting`,
        instrumental: true,
        ...(durationSec ? { durationSec } : {}),
        ...(m?.modelName ? { model: m.modelName } : {}),
        idempotencyKey: `ml-music-${Math.round(v.duration * 10)}-${(project.mood || 'x').replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}-${Date.now() % 1e6}`,
      },
      { onProgress: (p) => (st.textContent = `Composing music… ${p.state ?? ''}`), timeoutMs: 10 * 60_000 },
    );
    const url = job?.result?.url;
    if (!url) throw new Error('no music came back');
    let asset;
    try {
      asset = await loadAsset(url);
    } catch {
      // Playable but not readable here: preview it, say plainly it cannot go into the export.
      $('music').src = url;
      project.music = null;
      st.textContent = `Music made, but this window may not read it (${new URL(url).host}), so it plays in the preview only and is not in the export.`;
      return;
    }
    project.music = asset;
    $('music').src = asset.url;
    $('music').volume = 0.35;
    st.textContent = `Music added${project.mood ? ` (${project.mood})` : ''}. Plays under your voice in the preview and the export.`;
    st.classList.add('done');
    btn.textContent = 'New music';
  } catch (e) {
    const quota = /QUOTA/i.test(String(e?.code ?? e?.message));
    st.textContent = quota ? 'Your Anna credits ran out.' : `Music failed: ${String(e?.message ?? e).slice(0, 160)}`;
  } finally {
    btn.disabled = false;
  }
}

async function addBroll() {
  const btn = $('add-broll');
  const st = $('broll-status');
  st.classList.remove('done');
  if (!project.broll.length) {
    st.textContent = 'The AI found no concrete moment to picture in this video.';
    return;
  }
  btn.disabled = true;
  let ok = 0;
  let blocked = 0;
  let blockedHost = '';
  try {
    st.textContent = `Making ${project.broll.length} picture${project.broll.length > 1 ? 's' : ''}…`;
    await Promise.all(
      project.broll.map(async (b) => {
        try {
          const r = await anna.image.generate({ prompt: `${b.prompt}, photographic, vivid, no text`, size: '1024x1536' }, { timeoutMs: 180_000 });
          const url = r?.images?.[0]?.url;
          if (!url) return;
          let asset;
          try {
            asset = await loadAsset(url);
          } catch {
            blocked++;
            blockedHost = new URL(url).host;
            return;
          }
          const img = new Image();
          img.src = asset.url;
          await img.decode();
          b.img = img;
          b.asset = asset;
          ok++;
        } catch (e) {
          if (/QUOTA/i.test(String(e?.code ?? e?.message))) throw e;
        }
      }),
    );
    st.textContent = ok
      ? `${ok} picture${ok > 1 ? 's' : ''} added at the moments you mention.${blocked ? ` ${blocked} could not be read here.` : ''}`
      : blocked
        ? `Pictures were made, but this window may not read them (${blockedHost}), so they cannot go into the export.`
        : 'No pictures came back. Try again.';
    if (ok) st.classList.add('done');
    btn.textContent = 'New pictures';
    paint();
  } catch (e) {
    st.textContent = /QUOTA/i.test(String(e?.code ?? e?.message)) ? 'Your Anna credits ran out.' : `Pictures failed: ${String(e?.message ?? e).slice(0, 160)}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Export ───────────────────────────────────────────────────────────────
async function pickVideoCodec(w, h) {
  for (const c of [{ codec: 'avc1.640028', mux: 'avc' }, { codec: 'vp09.00.40.08', mux: 'vp9' }, { codec: 'av01.0.08M.08', mux: 'av1' }]) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate: 3_500_000, framerate: FPS };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) return { ...c, cfg };
  }
  return null;
}
async function pickAudioCodec(rate, ch) {
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac' }, { codec: 'opus', mux: 'opus' }]) {
    const cfg = { codec: c.codec, sampleRate: rate, numberOfChannels: ch, bitrate: 128_000 };
    if ((await AudioEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) return { ...c, cfg };
  }
  return null;
}

async function exportMp4() {
  if (!('VideoEncoder' in window)) throw new Error('This browser cannot export video. Use a recent Chrome or Edge.');
  const { w, h } = size;
  const vc = await pickVideoCodec(w, h);
  if (!vc) throw new Error('No video encoder available in this browser.');
  let audio = null;
  try {
    audio = await decodeAudio(file, 48000);
  } catch {
    audio = null;
  }
  const ch = audio ? Math.min(2, audio.numberOfChannels) : 0;
  const ac = audio ? await pickAudioCodec(audio.sampleRate, ch) : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: vc.mux, width: w, height: h, frameRate: FPS },
    ...(ac ? { audio: { codec: ac.mux, numberOfChannels: ch, sampleRate: audio.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => console.error(e) });
  venc.configure(vc.cfg);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const eg = cv.getContext('2d');

  // Play once, muted, in real time; draw and encode each frame as it is shown.
  v.pause();
  v.muted = true;
  await seekTo(0);
  await new Promise((resolve) => {
    let lastKey = -1e9;
    const onFrame = (_now, meta) => {
      const t = meta.mediaTime;
      if (venc.encodeQueueSize <= 6) {
        drawBase(eg, v, w, h, t, project);
        drawOverlay(eg, w, h, t, project);
        const frame = new VideoFrame(cv, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
        const key = t - lastKey >= 2;
        if (key) lastKey = t;
        venc.encode(frame, { keyFrame: key });
        frame.close();
      }
      progress('ex', t / v.duration);
      say($('ex-status'), `Rendering ${Math.min(99, Math.round((t / v.duration) * 100))}%… keep this window open.`);
      if (!v.ended) v.requestVideoFrameCallback(onFrame);
    };
    v.onended = () => resolve();
    v.requestVideoFrameCallback(onFrame);
    v.play();
  });
  await venc.flush();
  if (ac) {
    say($('ex-status'), 'Adding sound…');
    let chans = Array.from({ length: ch }, (_, c) => audio.getChannelData(Math.min(c, audio.numberOfChannels - 1)));
    if (project.music?.blob) {
      try {
        const mctx = new OfflineAudioContext(2, 1, audio.sampleRate);
        const mb = await mctx.decodeAudioData(await project.music.blob.arrayBuffer());
        chans = mixMusic(chans, Array.from({ length: mb.numberOfChannels }, (_, c) => mb.getChannelData(c)), audio.sampleRate);
      } catch (e) {
        console.warn('music mix skipped', e);
      }
    }
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => console.error(e) });
    aenc.configure(ac.cfg);
    for (let s = 0; s < audio.length; s += 4096) {
      const n = Math.min(4096, audio.length - s);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(chans[c].subarray(s, s + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((s / audio.sampleRate) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
  }
  muxer.finalize();
  v.muted = false;
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// ── Wire up ──────────────────────────────────────────────────────────────
async function main() {
  try {
    anna = await AnnaAppRuntime.connect();
    await anna.window.set_title({ title: 'Motion Lite' }).catch(() => undefined);
    $('host').classList.add('on');
    $('host-text').textContent = 'Connected to Anna';
    $('host').title = 'Speech-to-text and AI captions run through the Anna host on your Anna credits';
  } catch {
    $('host-text').textContent = 'Preview (not in Anna)';
    say($('status'), 'Preview mode: open in Anna to make captions.');
  }
  // The caption face must be loaded before the first frame is drawn, or the canvas falls back for the whole export.
  await Promise.all([document.fonts.load('800 40px Jakarta'), document.fonts.load('700 40px Jakarta')]).catch(() => undefined);
  renderSwatches($('swatches'));
  demo();

  $('file').onchange = async () => {
    const f = $('file').files?.[0];
    if (!f) return;
    file = f;
    try {
      await loadVideo(f);
      $('make').disabled = false;
      document.querySelector('.drop').classList.add('has');
      $('drop-title').textContent = f.name.length > 34 ? `${f.name.slice(0, 31)}…` : f.name;
      $('drop-sub').textContent = `${v.duration.toFixed(1)} s · ${size.w}×${size.h} · tap to choose another`;
      say($('status'), '');
    } catch (e) {
      $('make').disabled = true;
      say($('status'), e.message, true);
    }
  };
  $('make').onclick = async () => {
    $('make').disabled = true;
    try {
      const out = await makeCaptions();
      project = { ...project, ...out, music: null };
      $('music').removeAttribute('src');
      $('music-status').textContent = "AI music in the video's mood, under your voice. Uses Anna credits.";
      $('add-music').textContent = 'Add background music';
      $('add-broll').textContent = project.broll.length ? `Add ${project.broll.length} B-roll picture${project.broll.length > 1 ? 's' : ''}` : 'Add B-roll pictures';
      $('broll-status').textContent = project.broll.length ? `For: ${project.broll.map((b) => b.prompt.split(',')[0]).join(' · ').slice(0, 140)}. Uses Anna credits.` : 'The AI found no concrete moment to picture.';
      $('post').value = project.post;
      $('post-card').hidden = !project.post;
      renderSwatches($('swatches2'));
      $('pick').hidden = true;
      $('studio').hidden = false;
      await seekTo(0.05);
      save();
      anna?.chat?.append_artifact?.({ artifact: { kind: 'app_event', summary: `Motion Lite: ${project.captions.length} captions for ${file.name}` } })?.catch?.(() => undefined);
    } catch (e) {
      const quota = /QUOTA/i.test(String(e?.code ?? e?.message));
      say($('status'), quota ? 'Your Anna credits ran out; top up in Anna and try again.' : e.message, true);
    } finally {
      $('make').disabled = false;
      progress('mk', null);
    }
  };
  const PLAY = '<path d="M8 5v14l11-7z" fill="currentColor" />';
  const PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />';
  const icon = (playing) => {
    $('play-icon').innerHTML = playing ? PAUSE : PLAY;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  $('add-music').onclick = addMusic;
  $('add-broll').onclick = addBroll;
  $('post').onchange = () => {
    project.post = $('post').value;
    save();
  };
  $('copy-post').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('post').value);
      $('copy-post').textContent = 'Copied';
      setTimeout(() => ($('copy-post').textContent = 'Copy'), 1400);
    } catch {
      $('post').select();
    }
  };
  const music = $('music');
  const syncMusic = () => {
    if (!music.src) return;
    // The export plays the video muted; the music is mixed into the file then, so keep the preview track quiet.
    if (v.muted) return music.pause();
    if (music.duration > 0) music.currentTime = v.currentTime % music.duration;
    if (v.paused) music.pause();
    else music.play().catch(() => undefined);
  };
  v.addEventListener('play', syncMusic);
  v.addEventListener('pause', syncMusic);
  v.addEventListener('seeked', syncMusic);
  $('play').onclick = () => {
    if (v.paused) {
      v.play();
      icon(true);
      v.requestVideoFrameCallback(loop);
    } else {
      v.pause();
      icon(false);
    }
  };
  v.addEventListener('ended', () => icon(false));
  $('again').onclick = () => {
    v.pause();
    $('studio').hidden = true;
    $('pick').hidden = false;
    $('dl').hidden = true;
    $('file').value = '';
    demo();
  };
  $('seek').oninput = () => seekTo((Number($('seek').value) / 1000) * v.duration);
  $('export').onclick = async () => {
    $('export').disabled = true;
    $('dl').hidden = true;
    const t0 = performance.now();
    try {
      const blob = await exportMp4();
      const a = $('dl');
      a.href = URL.createObjectURL(blob);
      a.download = `${(file.name || 'video').replace(/\.[^.]+$/, '')}-captions.mp4`;
      a.hidden = false;
      say($('ex-status'), `Done in ${Math.round((performance.now() - t0) / 1000)} s · ${(blob.size / 1e6).toFixed(1)} MB.`);
      window.__exported = { bytes: blob.size, seconds: (performance.now() - t0) / 1000 };
    } catch (e) {
      say($('ex-status'), `Export failed: ${e.message}`, true);
      window.__exported = { error: e.message };
    } finally {
      $('export').disabled = false;
      progress('ex', null);
      icon(false);
    }
  };
  window.__ready = true;
}

main();
