// Reads model prices from Google's official pricing page
// (https://ai.google.dev/gemini-api/docs/pricing). Used by the Vercel function
// api/prices.js (live, cached for a day) and scripts/update-prices.mjs (the
// bundled snapshot prices.json). Pure functions; no network here.
//
// Output: { models: { "<model id>": { perSong } | { perImage } | { perSecond, outPerM } } }

import { FAMILIES } from './models.js';

export const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing?hl=en';

/** HTML -> plain text with single spaces. */
export function pageText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

const ANY_ID = /\b(?:gemini|lyria|veo|imagen)-[a-z0-9](?:[a-z0-9.\-]*[a-z0-9])?/g;
const num = (s) => Number(String(s).replace(/,/g, ''));

/**
 * The part of the page about the model whose id starts at `start`:
 * up to the next model id or the next model heading ("Try it in Google AI
 * Studio"), max 2000 chars. `prices` is cut further at the end of the
 * Standard price table, so Batch prices and other tables are never read;
 * `notes` keeps the footnote after the table (Omni's tokens-per-second).
 */
function sectionAt(text, start, id) {
  const from = start + id.length;
  let end = Math.min(text.length, start + 2000);
  const re = new RegExp(ANY_ID.source, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) && m.index < end) {
    if (m[0] !== id) { end = m.index; break; }
  }
  const tryIt = text.indexOf('Try it in Google AI Studio', from + 30);
  if (tryIt >= 0 && tryIt < end) end = tryIt;
  const notes = text.slice(start, end);
  let cut = notes.length;
  for (const marker of ['Used to improve our products', 'Batch']) {
    const i = notes.indexOf(marker, id.length);
    if (i >= 0 && i < cut) cut = i;
  }
  return { prices: notes.slice(0, cut), notes };
}

/** Largest number captured by `re` in `s` (estimates should err high). */
function maxMatch(re, s) {
  let best = null;
  for (const m of s.matchAll(re)) best = Math.max(best ?? 0, num(m[1]));
  return best;
}

function parseSection(family, { prices, notes }) {
  if (family === 'music') {
    const v = maxMatch(/\$([\d.]+) per song/g, prices);
    return v ? { perSong: v } : null;
  }
  if (family === 'image') {
    const v = maxMatch(/Equivalent to \$([\d.]+) per 1K image/g, prices);
    // + about 20 % for the reference images and prompt sent as input.
    return v ? { perImage: round(v * 1.2) } : null;
  }
  if (family === 'video') {
    const outPerM = maxMatch(/\$([\d.]+) \(video\)/g, prices);
    if (!outPerM) return null;
    const rate = maxMatch(/([\d,]+) tokens per second of 720p video/g, notes);
    const approx = maxMatch(/approximately \$([\d.]+) per second/g, notes);
    let perSecond = null;
    if (rate) perSecond = round((outPerM * rate) / 1e6);
    if (approx) perSecond = Math.max(perSecond ?? 0, approx);
    return perSecond ? { perSecond, outPerM } : null;
  }
  return null;
}

const round = (n) => Math.round(n * 10000) / 10000;

/** Prices for every model of the three families found on the page. */
export function parsePricing(html) {
  const text = pageText(html);
  const models = {};
  for (const family of Object.keys(FAMILIES)) {
    const seen = new Set();
    let m;
    const re = new RegExp(ANY_ID.source, 'g');
    while ((m = re.exec(text))) {
      const id = m[0];
      if (seen.has(id) || !FAMILIES[family].pattern.test(id)) continue;
      const price = parseSection(family, sectionAt(text, m.index, id));
      if (price && validPrice(family, price)) { models[id] = price; seen.add(id); }
    }
  }
  return { models };
}

// Reference prices (checked by hand 2026-10-13). A price below 0.6x of these
// is more likely a misreading (e.g. a Batch or short-clip price) and is
// rejected, so the higher built-in or 3x estimate is used instead —
// underestimating is the dangerous direction for the budget stop. High
// prices are accepted up to 100x (above that it is surely a misreading).
const REFERENCE = {
  music: { perSong: 0.08 },
  image: { perImage: 0.04 },
  video: { perSecond: 0.1, outPerM: 17.5 },
};

export function familyOf(id) {
  return Object.keys(FAMILIES).find((f) => FAMILIES[f].pattern.test(id)) ?? null;
}

/** All fields present, finite, and within 0.6x-100x of the reference. */
export function validPrice(family, price) {
  const ref = REFERENCE[family];
  if (!ref || !price || typeof price !== 'object') return false;
  return Object.entries(ref).every(([k, r]) => {
    const v = price[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= r * 0.6 && v <= r * 100;
  });
}

/** Keeps only well-formed entries of a prices document from the network. */
export function sanitizeTable(doc) {
  const out = {};
  const models = doc && typeof doc === 'object' ? doc.models : null;
  if (!models || typeof models !== 'object') return out;
  for (const [id, price] of Object.entries(models)) {
    const family = familyOf(id);
    if (!family || !validPrice(family, price)) continue;
    const keys = Object.keys(REFERENCE[family]);
    out[id] = Object.fromEntries(keys.map((k) => [k, price[k]]));
  }
  return out;
}
