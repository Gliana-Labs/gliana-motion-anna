# Motion Lite (Anna)

A separate, Anna-only version of Gliana Motion: upload a short talking-head video, the AI edits it (captions, style),
and the browser exports the MP4. Transcription and the edit plan run on the user's Anna credits; rendering runs in the
user's browser, so it costs no server time. motion.glianalabs.com is untouched.

## Status

**Export test (proto/), 2026-11-26.** Frames are read from a `<video>` seeked frame by frame, drawn with captions on a
canvas, encoded with WebCodecs (H.264, else VP9, else AV1) and muxed with the original audio (AAC, else Opus) by
mp4-muxer (MIT, vendored in `vendor/`). Measured in Chromium on a Ryzen 5 7500F desktop:

| Input | Export time | Speed | Output |
|---|---|---|---|
| 20 s, 720x1280 | 20.9 s | 0.96x realtime | H.264 + Opus, 600 frames, valid MP4 (ffprobe), captions at the right times |
| 60 s, 720x1280 | 75.4 s | 0.80x realtime | H.264 + Opus, 1800 frames, 44 MB at 6 Mbps |

Not tested yet: phones and low-end laptops, Safari, a real camera video (H.264/HEVC input).

## Try it

```bash
python3 -m http.server 5190 --bind 127.0.0.1
# open http://127.0.0.1:5190/proto/export.html and pick a video
```
