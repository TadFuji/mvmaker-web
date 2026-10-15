// Prompts and JSON schemas sent to Gemini, and parsing of the answers.
// Ported from the Mac app (_mvmaker/Sources/MVMakerCore/Director.swift).

const str = { type: 'string' };
const num = { type: 'number' };

export const planSchema = {
  type: 'object',
  properties: {
    title: str,
    music_style: str,
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, start: num, end: num, lines: { type: 'array', items: str } },
        required: ['name', 'start', 'end', 'lines'],
      },
    },
    character: str,
    visual_style: str,
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: num, end: num, summary_ja: str, prompt_en: str },
        required: ['start', 'end', 'summary_ja', 'prompt_en'],
      },
    },
  },
  required: ['title', 'music_style', 'sections', 'character', 'visual_style', 'scenes'],
};

const vocalEn = (v) => (v === 'male' ? 'male' : 'female');

export function planPrompt(p, request = '') {
  const n = p.durationSeconds;
  const extra = String(request).trim();
  const count = Math.max(1, Math.ceil(n / 10));
  return `You are the director and lyricist of a short music video. Plan it completely.

Brief from the user (Japanese):
- Theme: ${p.theme}
- Mood / genre: ${p.mood || 'おまかせ (choose what fits the theme best)'}
- Vocal: one ${vocalEn(p.vocal)} lead vocalist
- Total length: exactly ${n} seconds
- Frame: ${p.aspect === '9:16' ? 'vertical 9:16 (smartphone)' : 'horizontal 16:9'}
${extra ? '- Additional request (follow it): ' + extra : ''}

Output JSON with these fields:
- title: a short Japanese song title.
- music_style: English description for a music generation model: genre, BPM, key, instruments, vocal character, energy. Do not name real artists or songs.
- sections: the song structure in order (e.g. Intro, Verse, Pre-Chorus, Chorus, Outro) covering 0 to ${n} seconds with no gaps. Each has start/end in seconds and "lines": original Japanese lyrics sung in that section (an instrumental section has an empty list). Lyrics must be singable, catchy and fit the time: about one short line per 2-4 seconds. Start with a strong hook within the first 5 seconds. Never copy existing lyrics.
- character: English visual description of ONE original main character (appearance, hair, outfit, colors, personality in pose). Must not resemble any existing anime/game/brand character or real person. Adult or ageless.
- visual_style: English description of one coherent, distinctive art direction (medium, palette, lighting, texture). Avoid generic "AI art" or Pixar-like 3D looks unless the brief asks for it.
- scenes: exactly ${count} consecutive shots covering 0 to ${n} seconds, each 5 to 10 seconds long. For each: start, end, summary_ja (one short Japanese sentence for the user), prompt_en (English prompt for a video model: subject, action, setting, camera move, lighting; the main character appears in most shots, some shots can be scenery or objects that match the lyrics; describe the character as "the main character"; no on-screen text).`;
}

const toNum = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const s = (v) => (typeof v === 'string' ? v : '');

let idCounter = 0;
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + (idCounter++).toString(36);
}

export class DirectorError extends Error {}

export function decodePlan(json, durationSeconds) {
  let obj;
  try { obj = JSON.parse(json); } catch { throw new DirectorError('Gemini の返答を読み取れませんでした。もう一度お試しください。'); }
  if (!obj || typeof obj !== 'object') throw new DirectorError('Gemini の返答を読み取れませんでした。もう一度お試しください。');
  const n = durationSeconds;
  const sections = (Array.isArray(obj.sections) ? obj.sections : []).map((x) => ({
    name: s(x?.name),
    start: clamp(toNum(x?.start), 0, n),
    end: clamp(toNum(x?.end), 0, n),
    lines: (Array.isArray(x?.lines) ? x.lines : []).map((l) => s(l).trim()).filter(Boolean),
  }));
  let scenes = (Array.isArray(obj.scenes) ? obj.scenes : [])
    .map((x) => ({ id: newId(), start: toNum(x?.start), end: toNum(x?.end), summary: s(x?.summary_ja), prompt: s(x?.prompt_en), clip: null }))
    .filter((x) => x.prompt);
  if (!scenes.length || !sections.length) throw new DirectorError('Gemini の企画に必要な項目が足りませんでした。もう一度お試しください。');
  scenes = normalizeScenes(scenes, n);
  return {
    title: s(obj.title),
    musicStyle: s(obj.music_style),
    sections,
    character: s(obj.character),
    visualStyle: s(obj.visual_style),
    scenes,
  };
}

/** Makes scenes consecutive from 0 to `duration`, keeping their proportions. */
export function normalizeScenes(scenes, duration) {
  const sorted = [...scenes].sort((a, b) => a.start - b.start);
  const lengths = sorted.map((x) => Math.max(1, x.end - x.start));
  const total = lengths.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return sorted.map((x, i) => {
    const start = cursor;
    const end = i === sorted.length - 1 ? duration : cursor + (lengths[i] / total) * duration;
    cursor = end;
    return { ...x, start, end };
  });
}

export function mmss(sec) {
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function songPrompt(plan, p, request = '') {
  const extra = String(request).trim();
  const structure = plan.sections.map((x) => `[${x.name}] ${mmss(x.start)}-${mmss(x.end)}`).join('; ');
  const lyrics = plan.sections.map((x) => `[${x.name}]\n${x.lines.length ? x.lines.join('\n') : '(instrumental)'}`).join('\n\n');
  return `${plan.musicStyle} One ${vocalEn(p.vocal)} lead vocalist singing in Japanese with clear diction so every word is easy to hear. Total length about ${p.durationSeconds} seconds, no long intro or outro, clean hard stop at the end. Structure and timing: ${structure}.

Lyrics (sing exactly these words):

${lyrics}${extra ? `\n\nAdditional request from the user (follow it, but keep the lyrics above): ${extra}` : ''}`;
}

export const timingSchema = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: { type: 'object', properties: { text: str, start: num, end: num }, required: ['text', 'start', 'end'] },
    },
  },
  required: ['lines'],
};

export function timingPrompt(lines) {
  return `Listen to this song. Below are its lyric lines in the order they are sung. For each line, give the time in seconds (decimals allowed) when the singer starts and finishes singing it. Keep the given text exactly. If a line is repeated in the song, list each occurrence in order.

${lines.join('\n')}`;
}

export function decodeTiming(json) {
  try {
    const obj = JSON.parse(json);
    return (Array.isArray(obj?.lines) ? obj.lines : [])
      .filter((l) => typeof l?.text === 'string')
      .map((l) => ({ start: toNum(l.start), end: toNum(l.end), text: l.text }));
  } catch { return []; }
}

export function styleFramePrompt(plan) {
  return `Key visual for a music video. Art direction: ${plan.visualStyle}
Main character: ${plan.character}
Shot: ${plan.scenes[0]?.prompt ?? ''}
No text, no letters, no logos, no watermark.`;
}

/** Changes the user asked for on the pictures, in order (English). */
function styleNotes(plan) {
  const notes = (plan.styleNotes ?? []).filter(Boolean);
  return notes.length ? `\nChanges the user asked for on the look (the reference images already show them; keep them; later ones win): ${notes.join(' / ')}` : '';
}

export function characterSheetPrompt(plan) {
  return `Character reference sheet of one original character, drawn in exactly the same art style as the reference image. Show the full body from the front and from a three-quarter angle, plus a close-up of the face, on a plain light background. Consistent design in every view.
Character: ${plan.character}
Art direction: ${plan.visualStyle}${styleNotes(plan)}
No text, no letters, no logos.`;
}

/** Edits an existing picture (given as the reference image) as the user asked. */
export function imageEditPrompt(request) {
  return `Edit the reference image. Apply this change: ${request}
Keep everything else (character design, art style, composition, colors) as close to the reference as possible.
No text, no letters, no logos, no watermark.`;
}

export function scenePrompt(scene, plan, aspect) {
  const notes = scene.notes ? `\nRequested changes for this shot (follow them): ${scene.notes}` : '';
  return `${scene.prompt}${notes}
The main character must look exactly like the character in the reference images: ${plan.character}
Visual style (match the reference images): ${plan.visualStyle}${styleNotes(plan)}
Music video shot, ${aspect === '9:16' ? 'vertical 9:16 framing' : 'horizontal 16:9 framing'}, expressive motion. No on-screen text, no subtitles, no logos.`;
}

// ---- revising with the user's instructions ----

/** Asks Gemini to revise the current plan as the user requests. */
export function revisePlanPrompt(p, plan, request) {
  const current = {
    title: plan.title,
    music_style: plan.musicStyle,
    sections: plan.sections.map((x) => ({ name: x.name, start: x.start, end: x.end, lines: x.lines })),
    character: plan.character,
    visual_style: plan.visualStyle,
    scenes: plan.scenes.map((x) => ({ start: x.start, end: x.end, summary_ja: x.summary, prompt_en: x.prompt })),
  };
  return `You are the director and lyricist of a short music video. Below is the current plan (JSON) and a request from the user (Japanese). Revise the plan to follow the request.
Change only what the request is about; keep every other field exactly as it is. Keep the same JSON shape, the same total length (${p.durationSeconds} seconds) and the same number of scenes. Lyrics stay original Japanese and singable (never copy existing songs).

User's request: ${request}

Current plan:
${JSON.stringify(current)}`;
}

export const translateSchema = {
  type: 'object',
  properties: { english: str },
  required: ['english'],
};

export function translatePrompt(request) {
  return `Translate this request from a user into one clear English instruction for an image/video/music generation model. Keep every detail; do not add anything.

${request}`;
}

/** Same text apart from spacing, case and punctuation. */
export function sameText(a, b) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.,;:!?'"()\-–—、。・「」（）]+/g, '');
  return norm(a) === norm(b);
}

/** True when the text has only ASCII (no translation needed). */
export function isAscii(text) { return /^[\x00-\x7F]*$/.test(String(text)); }
