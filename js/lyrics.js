// When each lyric line is sung. Ported from the Mac app (Lyrics.swift).

/**
 * Parses Lyria's lyric text: "[12.5:] text", "[12.5:15.0] text" or "[:] text".
 * "[[A0]]" section markers are skipped. Returns null unless every lyric line
 * has a start time.
 */
export function parseLyria(text, songDuration) {
  const items = [];
  let saw = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('[[') || !line.startsWith('[')) continue;
    const close = line.indexOf(']');
    if (close < 0) continue;
    const tag = line.slice(1, close);
    const body = line.slice(close + 1).trim();
    if (!tag.includes(':') || !body) continue;
    saw = true;
    const [a, b] = tag.split(':');
    if (a.trim() === '' || !Number.isFinite(Number(a))) return null;
    const end = b !== undefined && b.trim() !== '' && Number.isFinite(Number(b)) ? Number(b) : null;
    items.push([Number(a), end, body]);
  }
  if (!saw || !items.length) return null;
  return finish(items, songDuration);
}

/** Fills missing end times (until the next line, at most 6 s; the last at most 5 s). */
export function finish(items, songDuration) {
  const sorted = [...items].sort((x, y) => x[0] - y[0]);
  const out = [];
  sorted.forEach(([s0, e0, text], i) => {
    const start = Math.max(0, s0);
    const hasNext = i + 1 < sorted.length;
    const next = hasNext ? sorted[i + 1][0] : songDuration;
    let end = e0 ?? Math.min(next, start + (hasNext ? 6 : 5));
    end = Math.min(end, next, songDuration);
    if (end <= start) end = Math.min(start + 1.5, songDuration);
    if (start < songDuration) out.push({ start, end, text });
  });
  return out;
}

/** Fallback: spread each section's lines evenly across its planned time. */
export function fromPlan(sections, songDuration) {
  const out = [];
  for (const sec of sections) {
    if (!sec.lines.length) continue;
    const start = Math.max(0, Math.min(sec.start, songDuration));
    const end = Math.max(start, Math.min(sec.end, songDuration));
    if (end <= start) continue;
    const step = (end - start) / sec.lines.length;
    sec.lines.forEach((text, i) => out.push({ start: start + i * step, end: start + (i + 1) * step, text }));
  }
  return out;
}

/** Checks timings returned by Gemini's listening pass; null if unusable. */
export function sanitize(lines, songDuration) {
  const usable = lines.filter((l) => l.text.trim() && l.start >= 0 && l.start < songDuration);
  if (!usable.length) return null;
  return finish(usable.map((l) => [l.start, l.end > l.start ? l.end : null, l.text]), songDuration);
}

/** The lyric line shown at time t, or null. */
export function lineAt(lines, t) {
  for (const l of lines) if (t >= l.start && t < l.end) return l;
  return null;
}
