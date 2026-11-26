// Motion Lite overlays: drawn the same way for the live preview, the style swatches and the export, so what you see is
// what you get. Fixed zones that never cover the face: a headline near the top, captions low on the chest.
import { captionAt } from './logic.js';

/** Plus Jakarta Sans (OFL, bundled in fonts/), loaded by app.js before the first frame; system faces as fallback. */
export const FONT = '"Jakarta", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const STYLES = {
  pop: { name: 'Pop', ink: '#ffffff', hi: '#ffb020', box: 'rgba(12,12,16,0.62)', titleBg: '#ffb020', titleInk: '#16120a', titleFor: 3.5 },
  karaoke: { name: 'Karaoke', ink: '#ffffff', hi: '#ffd23f', hiInk: '#141414', pill: true, titleBg: '#ffffff', titleInk: '#111111', titleFor: 3.5 },
  duo: { name: 'Duo', ink: '#ffffff', hi: '#ff3d9a', box: 'rgba(12,12,16,0.5)', titleBg: '#c6ff3d', titleInk: '#111111', titleFor: Infinity },
};

const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function fitFont(g, text, maxW, size, weight = 800) {
  let s = size;
  for (; s > 12; s -= 2) {
    g.font = `${weight} ${s}px ${FONT}`;
    if (g.measureText(text).width <= maxW) break;
  }
  return s;
}

function drawTitle(g, w, h, title, st, t) {
  if (!title) return;
  const size = fitFont(g, title, w * 0.82, Math.round(w * 0.072));
  const tw = g.measureText(title).width;
  const pad = size * 0.5;
  const y = h * 0.11;
  // Drops in over the first 300 ms.
  const k = ease(t / 0.3);
  g.save();
  g.globalAlpha = k;
  g.translate(0, (1 - k) * -size * 0.6);
  g.fillStyle = st.titleBg;
  g.beginPath();
  g.roundRect(w / 2 - tw / 2 - pad, y - size * 0.82, tw + pad * 2, size * 1.64, size * 0.36);
  g.fill();
  g.fillStyle = st.titleInk;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(title, w / 2, y + size * 0.04);
  g.restore();
}

function drawCaption(g, w, h, t, cap, st, styleId) {
  const size = fitFont(g, cap.text, w * 0.84, Math.round(w * 0.074));
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const words = cap.words?.length ? cap.words : cap.text.split(/\s+/).map((x) => ({ w: x, from: cap.from, to: cap.to }));
  const space = g.measureText(' ').width * 1.05;
  const widths = words.map((x) => g.measureText(x.w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  const y = h * 0.74;
  const pad = size * 0.42;
  const k = ease((t - cap.from) / 0.14); // each caption rises into place
  g.save();
  g.globalAlpha = 0.25 + 0.75 * k;
  g.translate(0, (1 - k) * size * 0.3);
  if (st.box) {
    g.fillStyle = st.box;
    g.beginPath();
    g.roundRect(w / 2 - total / 2 - pad, y - size * 0.82, total + pad * 2, size * 1.64, size * 0.34);
    g.fill();
  } else {
    // No box: a soft shadow keeps white text readable on bright footage.
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = size * 0.35;
    g.shadowOffsetY = size * 0.06;
  }
  let x = w / 2 - total / 2;
  const hiKey = (cap.hi || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  words.forEach((wd, i) => {
    const clean = wd.w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const ww = widths[i];
    let color = st.ink;
    let scale = 1;
    if (styleId === 'karaoke') {
      const active = t >= wd.from && t < wd.to;
      if (active) {
        // The spoken word sits on a coloured pill.
        g.save();
        g.shadowColor = 'transparent';
        g.fillStyle = st.hi;
        const p = size * 0.16;
        g.beginPath();
        g.roundRect(x - p, y - size * 0.68, ww + p * 2, size * 1.36, size * 0.3);
        g.fill();
        g.restore();
        color = st.hiInk;
      } else if (t < wd.from) {
        color = 'rgba(255,255,255,0.82)';
      }
    } else if (hiKey && clean === hiKey) {
      color = st.hi;
      // The highlight word pops when it is spoken.
      const a = (t - wd.from) / 0.18;
      if (a >= 0 && a < 1) scale = 1 + 0.16 * Math.sin(a * Math.PI);
    }
    g.save();
    g.translate(x + ww / 2, y);
    g.scale(scale, scale);
    g.fillStyle = color;
    g.fillText(wd.w, -ww / 2, size * 0.04);
    g.restore();
    x += ww + space;
  });
  g.restore();
}

/** The video frame itself. */
export function drawBase(g, src, w, h) {
  g.drawImage(src, 0, 0, w, h);
}

/** A B-roll picture as a card between the headline and the captions: pops in, holds, fades out. */
function drawBroll(g, w, h, t, b) {
  const img = b.img;
  if (!img || !img.naturalWidth) return;
  const k = ease((t - b.from) / 0.25);
  const out = Math.min(1, Math.max(0, (b.to - t) / 0.2));
  const cw = w * 0.6;
  const ch = Math.min(h * 0.42, cw * 1.2);
  const cx = w / 2;
  const cy = h * 0.42;
  const s = 0.85 + 0.15 * k;
  g.save();
  g.globalAlpha = Math.min(k, out);
  g.translate(cx, cy);
  g.scale(s, s);
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = w * 0.04;
  g.shadowOffsetY = w * 0.012;
  const r = w * 0.04;
  const bw = w * 0.012;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(-cw / 2 - bw, -ch / 2 - bw, cw + bw * 2, ch + bw * 2, r + bw);
  g.fill();
  g.shadowColor = 'transparent';
  g.beginPath();
  g.roundRect(-cw / 2, -ch / 2, cw, ch, r);
  g.clip();
  // Cover-crop the picture into the card.
  const ir = img.naturalWidth / img.naturalHeight;
  const cr = cw / ch;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (ir > cr) sw = sh * cr;
  else sh = sw / cr;
  g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, -cw / 2, -ch / 2, cw, ch);
  g.restore();
}

/** Draw the frame's overlays on top of an already-drawn video frame. */
export function drawOverlay(g, w, h, t, project) {
  const st = STYLES[project.style] ?? STYLES.pop;
  for (const b of project.broll ?? []) if (t >= b.from && t < b.to) drawBroll(g, w, h, t, b);
  if (project.title && t < st.titleFor) drawTitle(g, w, h, project.title, st, t);
  const cap = captionAt(project.captions, t);
  if (cap) drawCaption(g, w, h, t, cap, st, project.style);
}

/** A still for a style swatch or the demo: dark backdrop with soft shapes, the headline and one caption. */
export function drawSample(g, w, h, styleId, t = 1.2, sample = SAMPLE) {
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#2b2d42');
  bg.addColorStop(1, '#111219');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // A silhouette so the zones read as "around a face".
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.beginPath();
  g.arc(w / 2, h * 0.42, w * 0.2, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.roundRect(w * 0.18, h * 0.6, w * 0.64, h * 0.5, w * 0.2);
  g.fill();
  drawOverlay(g, w, h, t, { ...sample, style: styleId });
}

export const SAMPLE = {
  title: 'Captions in one click',
  captions: [
    { from: 0, to: 2, text: 'I never edit this', hi: 'never', words: [{ w: 'I', from: 0, to: 0.2 }, { w: 'never', from: 0.2, to: 0.9 }, { w: 'edit', from: 0.9, to: 1.4 }, { w: 'this', from: 1.4, to: 2 }] },
    { from: 2, to: 4, text: "it's all automatic", hi: 'automatic', words: [{ w: "it's", from: 2, to: 2.4 }, { w: 'all', from: 2.4, to: 2.8 }, { w: 'automatic', from: 2.8, to: 4 }] },
  ],
};
