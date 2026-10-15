// "お試しモード": a fake Gemini that makes placeholder lyrics, pictures, music
// and clips inside the browser. No network, no key, no charges.

import { FAMILIES } from './models.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function readBrief(prompt) {
  const theme = /Theme: (.*)/.exec(prompt)?.[1]?.trim() || 'お試し';
  const seconds = Number(/exactly (\d+) seconds/.exec(prompt)?.[1] || 30);
  return { theme, seconds };
}

function demoPlan(prompt) {
  const { theme, seconds } = readBrief(prompt);
  const scenes = Math.max(1, Math.ceil(seconds / 10));
  const half = Math.round(seconds / 2);
  return {
    title: `${theme.slice(0, 12)}のうた（お試し）`,
    music_style: 'demo pop',
    sections: [
      { name: 'Verse', start: 0, end: half, lines: ['ここに歌詞が入ります', 'お試しモードの歌詞です', `テーマは「${theme.slice(0, 16)}」`] },
      { name: 'Chorus', start: half, end: seconds, lines: ['本番では Gemini が', '歌詞を考えてくれます', 'さあ 作ってみよう'] },
    ],
    character: 'demo character',
    visual_style: 'demo style',
    scenes: Array.from({ length: scenes }, (_, i) => ({
      start: (i * seconds) / scenes,
      end: ((i + 1) * seconds) / scenes,
      summary_ja: `場面 ${i + 1}：お試しの映像（本番では AI が作ります）`,
      prompt_en: `demo shot ${i + 1}`,
    })),
  };
}

const hues = [205, 260, 330, 160, 30, 290, 190, 0, 120];

function paint(ctx, w, h, seed, t = 0) {
  const hue = hues[seed % hues.length];
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue}, 70%, 55%)`);
  g.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 35%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    const x = (w * ((i * 0.37 + t * 0.08 * (i + 1)) % 1));
    const y = h * (0.2 + 0.6 * ((i * 0.53) % 1));
    ctx.fillStyle = `hsla(${(hue + i * 30) % 360}, 90%, 80%, 0.35)`;
    ctx.beginPath();
    ctx.arc(x, y, Math.min(w, h) * (0.05 + 0.03 * i), 0, Math.PI * 2);
    ctx.fill();
  }
  // A simple figure so the "character" is visible.
  const cx = w / 2 + Math.sin(t * 3) * w * 0.05;
  const cy = h * 0.55;
  const r = Math.min(w, h) * 0.09;
  ctx.fillStyle = '#ffe9d6';
  ctx.beginPath(); ctx.arc(cx, cy - r * 1.6, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `hsl(${(hue + 180) % 360}, 65%, 50%)`;
  ctx.fillRect(cx - r * 0.9, cy - r * 0.5, r * 1.8, r * 2.4);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `700 ${Math.round(Math.min(w, h) * 0.05)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('お試し', w / 2, h * 0.12);
}

function canvasFor(aspect) {
  const c = document.createElement('canvas');
  [c.width, c.height] = aspect === '9:16' ? [432, 768] : [768, 432];
  return c;
}

let seedCounter = 1;

function wav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function demoSong(seconds) {
  const rate = 22050;
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  const notes = [261.6, 329.6, 392.0, 523.3, 440.0, 392.0, 329.6, 293.7];
  const beat = 0.5; // 120 BPM
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.floor(t / beat);
    const pos = t - k * beat;
    const env = Math.exp(-pos * 4);
    const f = notes[k % notes.length];
    let s = 0.18 * env * Math.sin(2 * Math.PI * f * t);
    if (k % 2 === 0) s += 0.35 * Math.exp(-pos * 30) * Math.sin(2 * Math.PI * 60 * pos); // kick
    out[i] = s;
  }
  return wav(out, rate);
}

async function demoClip(aspect, seconds = 2) {
  const c = canvasFor(aspect);
  const ctx = c.getContext('2d');
  const seed = seedCounter++;
  paint(ctx, c.width, c.height, seed, 0);
  const types = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
  const type = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(c.captureStream(30), type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(500);
  const start = performance.now();
  await new Promise((resolve) => {
    // setTimeout (not requestAnimationFrame) so it also runs in a background tab.
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      paint(ctx, c.width, c.height, seed, t);
      if (t >= seconds) resolve(); else setTimeout(tick, 33);
    };
    tick();
  });
  rec.stop();
  await done;
  return new Blob(chunks, { type: (rec.mimeType || type || 'video/webm').split(';')[0] });
}

export class DemoGemini {
  constructor() {
    this.models = {};
    for (const [k, f] of Object.entries(FAMILIES)) this.models[k] = f.fallback;
  }

  async validateKey() { await wait(300); return this.models; }

  async generateJSON({ prompt, audio }) {
    await wait(audio ? 600 : 1500);
    if (audio) {
      // Timing pass: spread the given lines over 0..30 s.
      const lines = prompt.split('\n\n').slice(1).join('\n').split('\n').filter(Boolean);
      const step = 25 / Math.max(1, lines.length);
      return { text: JSON.stringify({ lines: lines.map((text, i) => ({ text, start: 1 + i * step, end: 1 + (i + 1) * step - 0.3 })) }), usage: null };
    }
    if (prompt.startsWith('Translate this request')) {
      const text = prompt.split('\n\n').slice(1).join(' ').trim();
      return { text: JSON.stringify({ english: `(demo translation) ${text}` }), usage: null };
    }
    const current = /\nCurrent plan:\n([\s\S]*)$/.exec(prompt);
    if (current) {
      // Revision: put the request into the first lyric line so it is visible.
      const plan = JSON.parse(current[1]);
      const request = /User's request: (.*)/.exec(prompt)?.[1] ?? '';
      plan.sections[0].lines = [`（直しました：${request.slice(0, 20)}）`, ...plan.sections[0].lines.slice(1)];
      return { text: JSON.stringify(plan), usage: { total_input_tokens: 1500, total_output_tokens: 1500 } };
    }
    return { text: JSON.stringify(demoPlan(prompt)), usage: { total_input_tokens: 800, total_output_tokens: 1500 } };
  }

  async generateImage({ aspect }) {
    await wait(800);
    const c = canvasFor(aspect);
    paint(c.getContext('2d'), c.width, c.height, seedCounter++, 0.5);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { blob, usage: null, model: this.models.image };
  }

  async generateMusic({ prompt }) {
    await wait(1200);
    const seconds = Number(/about (\d+) seconds/.exec(prompt)?.[1] || 30) * 1.1;
    return { blob: demoSong(seconds), text: '', usage: null, model: this.models.music };
  }

  async generateVideo({ aspect }) {
    await wait(300);
    return { blob: await demoClip(aspect), usage: null, model: this.models.video };
  }
}
