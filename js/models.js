// Picks the newest model of each family (Lyria, Nano Banana, Omni) from the
// Gemini API's model list, so the app follows new releases without an update.
// Only the same product line is followed (no preview / lite / pro variants),
// and never a version older than the one this app was checked with.

export const TEXT_MODEL = 'gemini-3.8-flash';

export const FAMILIES = {
  music: { label: 'Lyria', pattern: /^lyria-(\d+(?:\.\d+)*)$/, fallback: 'lyria-3.5' },
  image: { label: 'Nano Banana', pattern: /^gemini-nano-banana-(\d+(?:\.\d+)*)$/, fallback: 'gemini-nano-banana-2.1' },
  video: { label: 'Gemini Omni Flash', pattern: /^gemini-omni-(\d+(?:\.\d+)*)-flash$/, fallback: 'gemini-omni-1.1-flash' },
};

export function versionOf(family, id) {
  const m = FAMILIES[family].pattern.exec(id);
  return m ? m[1].split('.').map(Number) : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Newest id of `family` among `ids`, ignoring ids listed in `broken` (models
 * that were refused earlier). Falls back to the checked version.
 */
export function pickLatest(family, ids, broken = []) {
  const f = FAMILIES[family];
  const floor = versionOf(family, f.fallback);
  let best = f.fallback;
  let bestV = floor;
  for (const raw of ids) {
    const id = String(raw).replace(/^models\//, '');
    if (broken.includes(id)) continue;
    const v = versionOf(family, id);
    if (v && compareVersions(v, bestV) > 0) { best = id; bestV = v; }
  }
  return best;
}

/** Model ids from a models.list response ({ models: [{ name, baseModelId }] }). */
export function idsFromList(response) {
  const ids = new Set();
  for (const m of response?.models ?? []) {
    if (typeof m?.name === 'string') ids.add(m.name.replace(/^models\//, ''));
    if (typeof m?.baseModelId === 'string') ids.add(m.baseModelId);
  }
  return [...ids];
}

/**
 * Current choice for every family. `ids` is the model list (may be empty when
 * the list could not be read), `broken` the refused ids.
 */
export function choose(ids, broken = []) {
  const out = {};
  for (const family of Object.keys(FAMILIES)) out[family] = pickLatest(family, ids, broken);
  return out;
}

export function isFallback(family, id) { return FAMILIES[family].fallback === id; }
