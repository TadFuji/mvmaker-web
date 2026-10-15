// Browser-only media helpers: measuring durations and assembling the final MV
// (clips + song + lyric subtitles) with a canvas and MediaRecorder. Recording
// runs in real time, so a 60 s MV takes about 60 s to export.

import { lineAt } from './lyrics.js';

export const RENDER_SIZE = { '16:9': [1280, 720], '9:16': [720, 1280] };

function once(el, ok, bad = 'error', ms = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('メディアの読み込みが時間内に終わりませんでした')); }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onBad = () => { cleanup(); reject(new Error('メディアを読み込めませんでした（このブラウザで再生できない形式の可能性があります）')); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener(bad, onBad); }
    el.addEventListener(ok, onOk);
    el.addEventListener(bad, onBad);
  });
}

/** Duration in seconds of an audio/video Blob, or null. */
export async function probeDuration(blob, kind) {
  if (!blob) return null;
  const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
  el.preload = 'metadata';
  el.muted = true;
  const url = URL.createObjectURL(blob);
  try {
    el.src = url;
    await once(el, 'loadedmetadata');
    if (!Number.isFinite(el.duration)) {
      // MediaRecorder WebM files report Infinity until the end is read.
      el.currentTime = 1e9;
      await once(el, 'durationchange', 'error', 5000).catch(() => {});
    }
    return Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    el.removeAttribute('src');
  }
}

/** Best recording format this browser supports, MP4 first. */
export function pickRecorderType() {
  const types = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function canExport() { return pickRecorderType() !== null && typeof AudioContext !== 'undefined'; }

function drawCover(ctx, src, sw, sh, w, h) {
  if (!sw || !sh) return;
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Splits a lyric line into rows that fit `maxWidth`. */
function wrap(ctx, text, maxWidth) {
  const rows = [];
  let row = '';
  for (const ch of text) {
    if (ctx.measureText(row + ch).width > maxWidth && row) { rows.push(row); row = ch; } else row += ch;
  }
  if (row) rows.push(row);
  return rows.slice(0, 3);
}

function drawLyric(ctx, line, t, w, h) {
  if (!line) return;
  const fade = Math.min(1, (t - line.start) / 0.15, (line.end - t) / 0.15);
  const size = Math.round(Math.min(w, h) * 0.07);
  ctx.save();
  ctx.globalAlpha = Math.max(0, fade);
  ctx.font = `800 ${size}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const rows = wrap(ctx, line.text, w * 0.86);
  const lh = size * 1.3;
  const baseY = h * (h > w ? 0.78 : 0.84) - ((rows.length - 1) * lh) / 2;
  rows.forEach((r, i) => {
    const y = baseY + i * lh;
    ctx.lineWidth = size * 0.22;
    ctx.strokeStyle = 'rgba(10, 12, 30, 0.85)';
    ctx.strokeText(r, w / 2, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(r, w / 2, y);
  });
  ctx.restore();
}

/**
 * clips: [{ blob, duration }] in order (duration = scene length in seconds).
 * Shorter clips are slowed down to fill their scene; longer ones are cut.
 * Returns the recorded Blob.
 */
export async function assemble({ clips, song, lyrics, aspect, onProgress, signal }) {
  const [w, h] = RENDER_SIZE[aspect] ?? RENDER_SIZE['16:9'];
  const type = pickRecorderType();
  if (type === null) throw new Error('このブラウザは動画の書き出しに対応していません。パソコンの Chrome か Safari の最新版でお試しください。');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const urls = [];
  const videos = [];
  let audioCtx;
  let recorder;
  let raf = 0;
  let onHidden;
  try {
    for (const c of clips) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const u = URL.createObjectURL(c.blob);
      urls.push(u);
      v.src = u;
      await once(v, 'loadeddata');
      videos.push(v);
    }
    const ends = [];
    let acc = 0;
    for (const c of clips) { acc += c.duration; ends.push(acc); }
    const total = acc;

    audioCtx = new AudioContext();
    await audioCtx.resume();
    const buffer = await audioCtx.decodeAudioData(await song.arrayBuffer());
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = audioCtx.createGain();
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(gain).connect(dest);
    if (buffer.duration > total + 0.05) {
      // Song cut short: fade out over the last 1.5 s.
      gain.gain.setValueAtTime(1, audioCtx.currentTime + Math.max(0, total - 1.5));
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + total);
    }

    // Paint the first frame before recording starts.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    drawCover(ctx, videos[0], videos[0].videoWidth, videos[0].videoHeight, w, h);

    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, { mimeType: type || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

    let failed = null;
    onHidden = () => {
      if (document.hidden) failed = new Error('書き出し中にほかのタブやアプリに切り替えたため中止しました。もう一度「書き出す」を押して、終わるまでこの画面を表示したままにしてください。');
    };
    document.addEventListener('visibilitychange', onHidden);

    recorder.start(1000);
    const t0 = audioCtx.currentTime + 0.05;
    source.start(t0);
    let current = -1;

    const startClip = (i) => {
      const v = videos[i];
      const sceneLen = clips[i].duration;
      const clipLen = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : sceneLen;
      v.playbackRate = Math.max(0.25, Math.min(1, clipLen / sceneLen));
      v.currentTime = 0;
      v.play().catch(() => {});
      if (current >= 0 && videos[current] !== v) videos[current].pause();
      current = i;
      // Get the next clip ready.
      const next = videos[i + 1];
      if (next) { next.currentTime = 0; }
    };

    await new Promise((resolve, reject) => {
      const frame = () => {
        if (failed || signal?.aborted) { reject(failed ?? new Error('中止しました')); return; }
        const t = audioCtx.currentTime - t0;
        if (t >= total) { resolve(); return; }
        if (t >= 0) {
          let i = ends.findIndex((e) => t < e);
          if (i < 0) i = videos.length - 1;
          if (i !== current) startClip(i);
          const v = videos[i];
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, h);
          drawCover(ctx, v, v.videoWidth, v.videoHeight, w, h);
          drawLyric(ctx, lineAt(lyrics, t), t, w, h);
          onProgress?.(Math.min(1, t / total));
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });

    recorder.stop();
    source.stop();
    await stopped;
    const mime = (recorder.mimeType || type || 'video/webm').split(';')[0];
    return new Blob(chunks, { type: mime });
  } catch (e) {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    throw e;
  } finally {
    cancelAnimationFrame(raf);
    if (onHidden) document.removeEventListener('visibilitychange', onHidden);
    for (const v of videos) { v.pause(); v.removeAttribute('src'); }
    for (const u of urls) URL.revokeObjectURL(u);
    if (audioCtx) audioCtx.close().catch(() => {});
  }
}

export function extensionFor(mime) { return mime?.includes('mp4') ? 'mp4' : 'webm'; }
