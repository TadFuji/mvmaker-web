// Vercel Function: GET /api/prices
// Reads Google's official pricing page and returns the prices of the Lyria,
// Nano Banana and Omni models as JSON. Vercel's CDN caches the answer for a
// day, so Google's page is read about once a day.
// Takes no input and never sees users' API keys.

import { PRICING_URL, parsePricing } from '../js/price-parser.js';

const MAX_BYTES = 5_000_000;

export async function GET(request) {
  // Each different query string would be a separate CDN cache entry; refuse
  // them so the page can't be made to fetch Google's page over and over.
  if (request && new URL(request.url).search) {
    return Response.json({ error: 'no query parameters' }, { status: 400 });
  }
  try {
    const res = await fetch(PRICING_URL, { redirect: 'follow', signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error('pricing page HTTP ' + res.status);
    const html = await res.text();
    if (html.length > MAX_BYTES) throw new Error('pricing page too large');
    const { models } = parsePricing(html);
    if (!Object.keys(models).length) throw new Error('no prices found');
    return Response.json(
      { checkedAt: new Date().toISOString(), source: 'live', models },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } },
    );
  } catch (e) {
    // The page then uses the bundled snapshot (prices.json).
    return Response.json(
      { error: String(e?.message || e).slice(0, 200) },
      { status: 502, headers: { 'Cache-Control': 'public, s-maxage=600' } },
    );
  }
}
