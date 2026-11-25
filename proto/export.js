// Motion Lite export test (2026-11-26): can a browser render a talking-head video with captions to MP4 on its own,
// fast enough, so the Anna version costs us no server time? Frames come from a <video> element seeked frame by frame,
// are drawn with captions onto a canvas, encoded with WebCodecs (H.264, else VP9, else AV1) and muxed with the
// original audio (AAC, else Opus) by mp4-muxer (MIT). window.__result carries the numbers for the automated test.
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';

const $ = (id) => document.getElementById(id);
const log = (s) => ($('log').textContent += `\n${s}`);
const FPS = 30;
const MAX_W = 1080;

// A fixed caption track for the test; the real app gets these from transcription + the AI plan.
const CAPTIONS = [
  { from: 0.0, to: 2.5, text: 'Aku nggak edit sama sekali' },
  { from: 2.5, to: 5.0, text: 'semuanya otomatis', hi: 'otomatis' },
  { from: 5.0, to: 8.0, text: 'tinggal upload video' },
  { from: 8.0, to: 12.0, text: 'AI yang bikin caption', hi: 'AI' },
  { from: 12.0, to: 60.0, text: 'Motion Lite di Anna' },
];

async function pickVideoCodec(width, height) {
  const candidates = [
    { codec: 'avc1.640028', mux: 'avc' },
    { codec: 'vp09.00.40.08', mux: 'vp9' },
    { codec: 'av01.0.08M.08', mux: 'av1' },
  ];
  for (const c of candidates) {
    const cfg = { codec: c.codec, width, height, bitrate: 6_000_000, framerate: FPS };
    const s = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (s.supported) return { ...c, cfg };
  }
  return null;
}

async function pickAudioCodec(sampleRate, numberOfChannels) {
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac' }, { codec: 'opus', mux: 'opus' }]) {
    const cfg = { codec: c.codec, sampleRate, numberOfChannels, bitrate: 128_000 };
    const s = await AudioEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (s.supported) return { ...c, cfg };
  }
  return null;
}

function drawCaption(g, w, h, t) {
  const c = CAPTIONS.find((x) => t >= x.from && t < x.to);
  if (!c) return;
  const size = Math.round(w * 0.07);
  g.font = `800 ${size}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const y = h * 0.72;
  const words = c.text.split(' ');
  const widths = words.map((wd) => g.measureText(wd + ' ').width);
  const total = widths.reduce((a, b) => a + b, 0);
  const pad = size * 0.35;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.roundRect(w / 2 - total / 2 - pad, y - size * 0.75, total + pad * 2, size * 1.5, size * 0.3);
  g.fill();
  let x = w / 2 - total / 2;
  g.textAlign = 'left';
  words.forEach((wd, i) => {
    g.fillStyle = c.hi && wd === c.hi ? '#f5a00b' : '#ffffff';
    g.fillText(wd, x, y);
    x += widths[i];
  });
}

const seekTo = (v, t) =>
  new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });

async function exportVideo(file) {
  const t0 = performance.now();
  const v = $('v');
  v.src = URL.createObjectURL(file);
  await new Promise((r) => (v.onloadedmetadata = r));
  const duration = v.duration;
  const k = Math.min(1, MAX_W / v.videoWidth);
  const width = Math.round((v.videoWidth * k) / 2) * 2;
  const height = Math.round((v.videoHeight * k) / 2) * 2;
  const cv = $('cv');
  cv.width = width;
  cv.height = height;
  const g = cv.getContext('2d');

  const vc = await pickVideoCodec(width, height);
  if (!vc) throw new Error('no supported video encoder');
  let audio = null;
  try {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    audio = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    audio = null;
  }
  const ac = audio ? await pickAudioCodec(audio.sampleRate, Math.min(2, audio.numberOfChannels)) : null;
  log(`${width}x${height}, ${duration.toFixed(1)} s · video ${vc.codec} · audio ${ac?.codec ?? 'none'}`);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: vc.mux, width, height, frameRate: FPS },
    ...(ac ? { audio: { codec: ac.mux, numberOfChannels: ac.cfg.numberOfChannels, sampleRate: ac.cfg.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => log(`video error ${e.message}`) });
  venc.configure(vc.cfg);

  const frames = Math.floor(duration * FPS);
  const mode = new URLSearchParams(location.search).get('mode') ?? 'seek';
  let encoded = 0;
  if (mode === 'play') {
    // Play in real time and encode each frame as it is shown (requestVideoFrameCallback): no seeking, so the export
    // takes about the video's own length. A frame shown while the encoder is still busy is skipped, not queued.
    await new Promise((resolve) => {
      let lastKey = -1e9;
      const onFrame = (_now, meta) => {
        const t = meta.mediaTime;
        if (venc.encodeQueueSize <= 6) {
          g.drawImage(v, 0, 0, width, height);
          drawCaption(g, width, height, t);
          const frame = new VideoFrame(cv, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
          const key = t - lastKey >= 2;
          if (key) lastKey = t;
          venc.encode(frame, { keyFrame: key });
          frame.close();
          encoded++;
        }
        if (!v.ended) v.requestVideoFrameCallback(onFrame);
      };
      v.onended = () => resolve();
      v.requestVideoFrameCallback(onFrame);
      v.currentTime = 0;
      v.play();
    });
  }
  for (let i = 0; mode === 'seek' && i < frames; i++) {
    const t = i / FPS;
    await seekTo(v, t);
    g.drawImage(v, 0, 0, width, height);
    drawCaption(g, width, height, t);
    const frame = new VideoFrame(cv, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
    venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    if (i % 90 === 0) $('log').lastChild && ($('go').textContent = `Exporting ${Math.round((i / frames) * 100)}%`);
  }
  await venc.flush();
  const tVideo = performance.now();

  if (ac) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => log(`audio error ${e.message}`) });
    aenc.configure(ac.cfg);
    const ch = ac.cfg.numberOfChannels;
    const block = 4096;
    for (let s = 0; s < audio.length; s += block) {
      const n = Math.min(block, audio.length - s);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(audio.getChannelData(Math.min(c, audio.numberOfChannels - 1)).subarray(s, s + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((s / audio.sampleRate) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
  }
  muxer.finalize();
  const buf = muxer.target.buffer;
  const ms = performance.now() - t0;
  const blob = new Blob([buf], { type: 'video/mp4' });
  const a = $('dl');
  a.href = URL.createObjectURL(blob);
  a.download = 'motion-lite-test.mp4';
  a.hidden = false;
  const result = { mode, encodedFrames: mode === 'play' ? encoded : frames, seconds: ms / 1000, videoSeconds: (tVideo - t0) / 1000, duration, frames, width, height, videoCodec: vc.codec, audioCodec: ac?.codec ?? null, bytes: buf.byteLength, speed: duration / (ms / 1000) };
  log(`done in ${result.seconds.toFixed(1)} s (${result.speed.toFixed(2)}x realtime) · ${(buf.byteLength / 1e6).toFixed(1)} MB`);
  window.__result = result;
  window.__mp4 = buf;
  return result;
}

$('file').onchange = () => ($('go').disabled = !$('file').files?.[0]);
$('go').onclick = async () => {
  $('go').disabled = true;
  $('log').textContent = 'Exporting…';
  try {
    await exportVideo($('file').files[0]);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    window.__result = { error: e.message };
  } finally {
    $('go').disabled = false;
    $('go').textContent = 'Export';
  }
};
