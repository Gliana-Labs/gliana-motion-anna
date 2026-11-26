# Motion Lite (Anna)

A separate, Anna-only version of Gliana Motion: upload a short talking-head video, the AI edits it (captions, style),
and the browser exports the MP4. Transcription and the edit plan run on the user's Anna credits; rendering runs in the
user's browser, so it costs no server time. motion.glianalabs.com is untouched.

## The Anna app (app/)

Slug `motion-lite`, bundle-only (no executa, no external origins).
- **Speech:** found in the browser (`logic.speechSegments`: energy, adaptive threshold, 250 ms pauses split, 0.6-8 s
  pieces). Each piece is transcribed with `anna.audio.transcribe` (the user's Anna credits). Anna returns text without
  timestamps, so a piece's text has that piece's real start and end.
- **Plan:** one `anna.llm.complete` call splits each piece into 2-5 word phrases, picks a highlight word and writes a
  headline. Phrases are used only when they spell the piece's own words (`timeCaptions`), else 3-word fallback.
- **Looks:** Pop, Karaoke (word by word), Duo (pinned lime headline, pink highlights). `render.js` draws preview and
  export with the same code.
- **Export:** play mode (below), 3.5 Mbps H.264 (else VP9/AV1) + AAC (else Opus).
- **Extras (v0.2.0):** punch-in zoom on highlight words (`logic.zoomAt`, `render.drawBase`); background music via
  `anna.music.generateAwait` (catalog `music_gen`, `durationSec` only for range models), mixed at export by `logic.mixMusic`
  (looped, faded, ducked to 40% under the voice); up to 3 B-roll cards via `anna.image.generate` (`logic.cleanBroll`); a post
  caption from the same plan call. Anna media links are fetched into `blob:` URLs so the export canvas stays untainted; if
  the storage refuses a CORS read, the app says so and names the host (preview only, not in the export).

Harness run (mocked transcribe + LLM, real speech detection and export), 14 s test video with three speech bursts:
three pieces found at 0.5 / 4.2 / 8.9 s, 6 captions, exported in 14 s, valid MP4 (H.264 + Opus, 419 frames).

```bash
npm install && npm test
cd app && npx anna-app validate --strict
npx anna-app dev --mock-llm fixtures/replies.jsonl
```

## Status

**Export test (proto/), 2026-11-26.** Frames are read from a `<video>` seeked frame by frame, drawn with captions on a
canvas, encoded with WebCodecs (H.264, else VP9, else AV1) and muxed with the original audio (AAC, else Opus) by
mp4-muxer (MIT, vendored in `vendor/`). Measured in Chromium on a Ryzen 5 7500F desktop:

| Input | Export time | Speed | Output |
|---|---|---|---|
| 20 s, 720x1280 | 20.9 s | 0.96x realtime | H.264 + Opus, 600 frames, valid MP4 (ffprobe), captions at the right times |
| 60 s, 720x1280 | 75.4 s | 0.80x realtime | H.264 + Opus, 1800 frames, 44 MB at 6 Mbps |

**On a phone** (Solana Seeker: MediaTek MT6878 / Dimensity 7300, 8 GB, Android 16, Chrome 157), driven over adb +
DevTools:

| Mode | Input | Export time | Frames | Output |
|---|---|---|---|---|
| seek (frame by frame) | 20 s | 172.3 s (0.12x) | 600/600 | too slow: ~280 ms per seek |
| **play** (`?mode=play`, requestVideoFrameCallback) | 20 s | **22.8 s** (0.88x) | 591/600 | H.264 + AAC, valid |
| **play** | 60 s | **67.3 s** (0.89x) | 1771/1800 (1.6% dropped) | H.264 + AAC, 60.0 s, captions correct |

Play mode is the one to build on: about the video's own length, on a mid-range phone. Two traps found: Chrome on
Android draws no frames for a `hidden` <video> (requestVideoFrameCallback never fires), and mp4-muxer refuses chunks
without a duration, so every VideoFrame carries one.

Not tested yet: Safari / iPhone, low-end Android, a real camera video (H.264/HEVC input), and the size (44 MB per
minute at 6 Mbps; ~3 Mbps would halve it).

## Try it

```bash
python3 -m http.server 5190 --bind 127.0.0.1
# open http://127.0.0.1:5190/proto/export.html and pick a video
```

## Licences

This app: MIT. Bundled: Plus Jakarta Sans (SIL OFL 1.1, `app/bundle/fonts/OFL.txt`), mp4-muxer (MIT). Test videos in `test-media/` are generated with ffmpeg (test pattern + tone).
