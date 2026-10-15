// Updates prices.json (the bundled price snapshot) from Google's official
// pricing page. Run: node scripts/update-prices.mjs
// The live site normally uses /api/prices; this file is the fallback (and what
// the local test server uses).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRICING_URL, parsePricing } from '../js/price-parser.js';

const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) throw new Error('pricing page HTTP ' + res.status);
const { models } = parsePricing(await res.text());
if (!Object.keys(models).length) throw new Error('no prices found; the page layout may have changed');
const doc = { checkedAt: new Date().toISOString(), source: 'snapshot', models };
const out = fileURLToPath(new URL('../prices.json', import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(JSON.stringify(models, null, 2));
