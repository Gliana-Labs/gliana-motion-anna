// Motion Lite overlays: drawn the same way for the live preview and for the export, so what you see is what you get.
// Three looks, each with fixed zones that never cover the face: a headline near the top and captions low on the chest.
import { captionAt } from './logic.js';

export const STYLES = {
  pop: { name: 'Pop', ink: '#ffffff', hi: '#f5a00b', box: 'rgba(0,0,0,0.58)', titleBg: '#f5a00b', titleInk: '#16120a', titleFor: 3.5 },
  karaoke: { name: 'Karaoke', ink: '#ffffff', hi: '#ffd23f', box: null, outline: 'rgba(0,0,0,0.85)', titleBg: '#ffffff', titleInk: '#111111', titleFor: 3.5 },
  duo: { name: 'Duo', ink: '#ffffff', hi: '#ff3d9a', box: 'rgba(0,0,0,0.5)', titleBg: '#c6ff3d', titleInk: '#111111', titleFor: Infinity },
};

function fitFont(g, text, maxW, size, weight = 800) {
  let s = size;
  for (; s > 12; s -= 2) {
    g.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    if (g.measureText(text).width <= maxW) break;
  }
  return s;
}

function drawTitle(g, w, h, title, st) {
  if (!title) return;
  const size = fitFont(g, title, w * 0.84, Math.round(w * 0.075));
  const tw = g.measureText(title).width;
  const pad = size * 0.45;
  const y = h * 0.1;
  g.fillStyle = st.titleBg;
  g.beginPath();
  g.roundRect(w / 2 - tw / 2 - pad, y - size * 0.8, tw + pad * 2, size * 1.6, size * 0.28);
  g.fill();
  g.fillStyle = st.titleInk;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(title, w / 2, y);
}

function drawCaption(g, w, h, t, cap, st, styleId) {
  const size = fitFont(g, cap.text, w * 0.86, Math.round(w * 0.072));
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const words = cap.words?.length ? cap.words : cap.text.split(/\s+/).map((w2) => ({ w: w2, from: cap.from, to: cap.to }));
  const space = g.measureText(' ').width;
  const widths = words.map((x) => g.measureText(x.w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  const y = h * 0.74;
  const pad = size * 0.38;
  // A small rise as each caption appears (first 120 ms), for life without distraction.
  const age = t - cap.from;
  const lift = age < 0.12 ? (1 - age / 0.12) * size * 0.25 : 0;
  if (st.box) {
    g.fillStyle = st.box;
    g.beginPath();
    g.roundRect(w / 2 - total / 2 - pad, y - size * 0.78 + lift, total + pad * 2, size * 1.56, size * 0.3);
    g.fill();
  }
  let x = w / 2 - total / 2;
  const hiWord = cap.hi ? cap.hi.toLowerCase() : '';
  words.forEach((wd, i) => {
    const clean = wd.w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    let color = st.ink;
    if (styleId === 'karaoke') color = t >= wd.from ? st.hi : st.ink;
    else if (hiWord && clean === hiWord.replace(/[^\p{L}\p{N}]+/gu, '')) color = st.hi;
    if (st.outline) {
      g.lineWidth = Math.max(3, size * 0.14);
      g.strokeStyle = st.outline;
      g.lineJoin = 'round';
      g.strokeText(wd.w, x, y + lift);
    }
    g.fillStyle = color;
    g.fillText(wd.w, x, y + lift);
    x += widths[i] + space;
  });
}

/** Draw the frame's overlays on top of an already-drawn video frame. */
export function drawOverlay(g, w, h, t, project) {
  const st = STYLES[project.style] ?? STYLES.pop;
  if (project.title && t < st.titleFor) drawTitle(g, w, h, project.title, st);
  const cap = captionAt(project.captions, t);
  if (cap) drawCaption(g, w, h, t, cap, st, project.style);
}
