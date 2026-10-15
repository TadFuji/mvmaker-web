import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parsePricing, sanitizeTable, validPrice } from '../js/price-parser.js';
import * as P from '../js/pricing.js';

// Shaped like the official page (2026-10-13), plus a newer Omni and Lyria.
const PAGE = `<html><body><nav>Gemini Omni Flash Lyria 3.5</nav>
<h2>Gemini Omni Flash</h2><code>gemini-omni-1.1-flash</code> Try it in Google AI Studio
<table><tr><td>Output price</td><td>Not available</td><td>$9.00 (text) $17.50 (video) *</td></tr></table>
Used to improve our products Yes No * Billing is based on total output token consumption, calculated at a rate of 5,792 tokens per second of 720p video. Under Standard pricing, this equates to an effective price of approximately $0.10 per second.
<h2>Gemini Omni Flash Preview</h2><code>gemini-omni-flash-preview</code> $17.50 (video)
<h2>Gemini Omni 2 Flash</h2><code>gemini-omni-2-flash</code> Output price $35.00 (video) * Used to improve our products * calculated at a rate of 5,792 tokens per second of 720p video.
<h2>Gemini Nano Banana 2.1 &#127820;</h2><code>gemini-nano-banana-2.1</code> Output price $30.00 (images) Equivalent to $0.0336 per 1K image * , $0.0504 per 2K image
<h2>Lyria 3.5</h2><code>lyria-3.5</code> Lyria 3.5 (Full Song) Not available $0.08 per song Used to improve our products
<h2>Lyria 3</h2><code>lyria-3-clip-preview</code> $0.04 per song
<h2>Lyria 4</h2><code>lyria-4</code> $0.12 per song
<h2>Broken</h2><code>lyria-5</code> $8000 per song
</body></html>`;

afterEach(() => P.setOfficialPrices({}, null));

test('parsePricing reads each family, newer versions included', () => {
  const { models } = parsePricing(PAGE);
  assert.deepEqual(models['gemini-omni-1.1-flash'], { perSecond: 0.1014, outPerM: 17.5 });
  assert.deepEqual(models['gemini-omni-2-flash'], { perSecond: 0.2027, outPerM: 35 });
  assert.deepEqual(models['gemini-nano-banana-2.1'], { perImage: 0.0403 });
  assert.deepEqual(models['lyria-3.5'], { perSong: 0.08 });
  assert.deepEqual(models['lyria-4'], { perSong: 0.12 });
  assert.equal(models['lyria-3-clip-preview'], undefined); // not a tracked line
  assert.equal(models['gemini-omni-flash-preview'], undefined);
  assert.equal(models['lyria-5'], undefined); // implausible -> rejected
});

test('a section never borrows the next model price', () => {
  const page = 'gemini-omni-3-flash coming soon. gemini-omni-1.1-flash $17.50 (video) approximately $0.10 per second';
  const { models } = parsePricing(page);
  assert.equal(models['gemini-omni-3-flash'], undefined);
  assert.ok(models['gemini-omni-1.1-flash']);
});

test('sanitizeTable drops malformed or implausible entries from the network', () => {
  const t = sanitizeTable({ models: {
    'lyria-4': { perSong: 0.1, extra: 'x' },
    'lyria-6': { perSong: 0.0001 },
    'gemini-omni-2-flash': { perSecond: 0.2 }, // outPerM missing
    'evil-model': { perSong: 0.1 },
    'gemini-nano-banana-3': { perImage: '0.05' },
  } });
  assert.deepEqual(t, { 'lyria-4': { perSong: 0.1 } });
  assert.deepEqual(sanitizeTable(null), {});
  assert.deepEqual(sanitizeTable({ models: 'x' }), {});
  assert.equal(validPrice('video', { perSecond: 0.1, outPerM: Infinity }), false);
});

test('official prices take precedence; unlisted models are 3x the base', () => {
  assert.equal(P.priceSource('lyria-4'), 'assumed');
  assert.ok(Math.abs(P.musicCost('lyria-4') - 0.24) < 1e-9);
  P.setOfficialPrices({ 'lyria-4': { perSong: 0.12 }, 'lyria-3.5': { perSong: 0.1 } }, { source: 'live', checkedAt: 0 });
  assert.equal(P.priceSource('lyria-4'), 'official');
  assert.equal(P.musicCost('lyria-4'), 0.12);
  assert.equal(P.musicCost('lyria-3.5'), 0.1);
  // Still unlisted: 3x the base model's official price.
  assert.ok(Math.abs(P.musicCost('lyria-9') - 0.3) < 1e-9);
  assert.equal(P.priceSource('gemini-omni-1.1-flash'), 'builtin');
  assert.equal(P.officialPriceInfo().source, 'live');
});

// Cases from the independent review (2026-10-15): page changes that must not
// make the parser read a LOWER price.
test('Batch or short-clip prices are never taken as the price', () => {
  const batchFirst = 'gemini-nano-banana-2.1 Try it in Google AI Studio Batch Equivalent to $0.0168 per 1K image Standard Equivalent to $0.0336 per 1K image Used to improve our products';
  // The Batch tab comes first here, so no Standard price is read -> not listed.
  assert.equal(parsePricing(batchFirst).models['gemini-nano-banana-2.1'], undefined);
  const both = 'gemini-nano-banana-2.1 Try it in Google AI Studio Equivalent to $0.0336 per 1K image * Used to improve our products Yes No Batch Equivalent to $0.0168 per 1K image';
  assert.deepEqual(parsePricing(both).models['gemini-nano-banana-2.1'], { perImage: 0.0403 });
  const clip = 'lyria-4 Lyria 4 Clip (30s) $0.04 per song Lyria 4 (Full Song) $0.16 per song Used to improve our products';
  assert.deepEqual(parsePricing(clip).models['lyria-4'], { perSong: 0.16 });
});

test('a much higher real price is kept, not replaced by the 3x guess', () => {
  const { models } = parsePricing('lyria-4 Lyria 4 (Full Song) $2.00 per song Used to improve our products');
  assert.deepEqual(models['lyria-4'], { perSong: 2 });
  assert.deepEqual(sanitizeTable({ models: { 'lyria-4': { perSong: 2 } } }), { 'lyria-4': { perSong: 2 } });
  assert.deepEqual(sanitizeTable({ models: { 'lyria-4': { perSong: 0.03 } } }), {}); // too low -> distrusted
});

test('a model with no price does not borrow the next table across another heading', () => {
  const page = 'gemini-omni-2-flash coming soon. Deep Research deep-research-pro Try it in Google AI Studio Output $17.50 (video) at a rate of 5,792 tokens per second of 720p video.';
  assert.equal(parsePricing(page).models['gemini-omni-2-flash'], undefined);
});

test('/api/prices refuses query strings without fetching', async () => {
  const { GET } = await import('../api/prices.js');
  const res = await GET(new Request('https://x.example/api/prices?x=1'));
  assert.equal(res.status, 400);
});
