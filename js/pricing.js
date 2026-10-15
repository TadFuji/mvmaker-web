// Prices in USD. Source: https://ai.google.dev/gemini-api/docs/pricing
// (checked 2026-10-13). Estimates are on the high side; the real bill is in
// Google AI Studio. Prices read at run time from Google's pricing page take
// precedence over this table; a model on neither is assumed to cost 3x the
// base model and the page says so.

import { FAMILIES, TEXT_MODEL } from './models.js';

const KNOWN = {
  // gemini-3.8-flash: $0.75 / $3.75 per 1M through 2026-12-31, doubling on
  // 2027-01-01 — the 2027 price is used to stay safe.
  [TEXT_MODEL]: { inPerM: 1.5, outPerM: 7.5 },
  // Nano Banana 2.1: $0.0336 per 1K image (+ a little input for references).
  'gemini-nano-banana-2.1': { perImage: 0.04 },
  // Lyria 3.5: $0.08 per song.
  'lyria-3.5': { perSong: 0.08 },
  // Omni 1.1 Flash: $17.50 / 1M video output tokens, about $0.10/s at 720p.
  'gemini-omni-1.1-flash': { perSecond: 0.1, outPerM: 17.5 },
};

const UNKNOWN_FACTOR = 3;
/** One generation can run up to 40 s with extensions — the worst case reserved before each video. */
export const VIDEO_MAX_SECONDS = 40;
export const TEXT_ESTIMATE = 0.05;

// Prices read from Google's pricing page (via /api/prices or prices.json).
let official = {};
let officialInfo = null; // { source: 'live' | 'snapshot', checkedAt }

/** Installs a sanitized { id: price } table read from the official page. */
export function setOfficialPrices(table, info) {
  official = { ...table };
  officialInfo = info ?? null;
}

export function officialPriceInfo() { return officialInfo; }

/**
 * Where a model's price comes from:
 * 'official' (read from Google's pricing page), 'builtin' (this file),
 * or 'assumed' (not listed yet: 3x the base model's price).
 */
export function priceSource(model) {
  if (official[model]) return 'official';
  if (KNOWN[model]) return 'builtin';
  return 'assumed';
}

export function isKnown(model) { return priceSource(model) !== 'assumed'; }

export const ASSUMED_FACTOR = UNKNOWN_FACTOR;

function priceFor(family, model) {
  if (official[model]) return official[model];
  if (KNOWN[model]) return KNOWN[model];
  // Not on the price list yet: assume 3x the base model, using the base
  // model's official price when known.
  const fallback = FAMILIES[family].fallback;
  const base = official[fallback] ?? KNOWN[fallback];
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = v * UNKNOWN_FACTOR;
  return out;
}

export function textActual(usage) {
  const i = usage?.total_input_tokens;
  const o = usage?.total_output_tokens;
  if (!Number.isFinite(i) || !Number.isFinite(o)) return TEXT_ESTIMATE;
  const p = KNOWN[TEXT_MODEL];
  return (i / 1e6) * p.inPerM + (o / 1e6) * p.outPerM;
}

export function imageCost(model) { return priceFor('image', model).perImage; }
export function musicCost(model) { return priceFor('music', model).perSong; }
export function videoEstimate(model) { return priceFor('video', model).perSecond * VIDEO_MAX_SECONDS; }

/** Real cost of a finished clip: the larger of the token and duration numbers. */
export function videoActual(model, usage, seconds) {
  const p = priceFor('video', model);
  const c = [];
  const t = usage?.total_output_tokens;
  if (Number.isFinite(t) && t > 0) c.push((t / 1e6) * p.outPerM);
  if (Number.isFinite(seconds) && seconds > 0) c.push(seconds * p.perSecond);
  return c.length ? Math.max(...c) : videoEstimate(model);
}

/** Typical cost of a whole MV without redos, shown before starting. */
export function roughTotal(durationSeconds, models) {
  const scenes = sceneCount(durationSeconds);
  return 3 * TEXT_ESTIMATE + musicCost(models.music) + 2 * imageCost(models.image)
    + scenes * 10 * priceFor('video', models.video).perSecond;
}

export function sceneCount(durationSeconds) { return Math.max(1, Math.ceil(durationSeconds / 10)); }

export function usd(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }

/** Amount counted against the budget for one ledger entry. */
export function counted(entry) {
  switch (entry.status) {
    case 'ok': return entry.actual;
    case 'failed': return 0;
    default: return entry.estimate; // uncertain / reserved
  }
}

export function spent(project) { return project.ledger.reduce((s, e) => s + counted(e), 0); }

export class BudgetExceeded extends Error {
  constructor(spentUSD, estimate, budget) {
    super(`上限額を超えるため止めました（使った金額 ${usd(spentUSD)} ＋ 今回の見込み ${usd(estimate)} ＞ 上限 ${usd(budget)}）。上限額を上げるか、作り直しを減らしてください。`);
    this.name = 'BudgetExceeded';
  }
}

export function checkBudget(project, estimate) {
  const s = spent(project);
  if (s + estimate > project.budgetUSD + 1e-9) throw new BudgetExceeded(s, estimate, project.budgetUSD);
}
