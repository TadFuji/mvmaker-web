import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/models.js';
import * as P from '../js/pricing.js';
import * as D from '../js/director.js';
import * as L from '../js/lyrics.js';

test('pickLatest follows newer versions of the same line only', () => {
  const ids = ['models/lyria-3.5', 'lyria-4', 'lyria-4.1-preview', 'lyria-3-clip-preview', 'lyria-realtime-exp', 'lyria-5-pro'];
  assert.equal(M.pickLatest('music', ids), 'lyria-4');
  const img = ['gemini-nano-banana-2.1', 'gemini-nano-banana-2.10', 'gemini-nano-banana-2.2-lite', 'gemini-3.1-flash-image'];
  assert.equal(M.pickLatest('image', img), 'gemini-nano-banana-2.10');
  const vid = ['gemini-omni-1.1-flash', 'gemini-omni-flash', 'gemini-omni-flash-preview', 'gemini-omni-2-flash', 'gemini-omni-2.5-pro'];
  assert.equal(M.pickLatest('video', vid), 'gemini-omni-2-flash');
});

test('pickLatest never goes below the checked version and skips broken ids', () => {
  assert.equal(M.pickLatest('video', ['gemini-omni-1.0-flash']), 'gemini-omni-1.1-flash');
  assert.equal(M.pickLatest('video', []), 'gemini-omni-1.1-flash');
  assert.equal(M.pickLatest('music', ['lyria-4', 'lyria-3.6'], ['lyria-4']), 'lyria-3.6');
});

test('idsFromList reads names and baseModelId', () => {
  const ids = M.idsFromList({ models: [{ name: 'models/lyria-3.5' }, { name: 'models/x-001', baseModelId: 'x' }, { bad: 1 }] });
  assert.deepEqual(ids.sort(), ['lyria-3.5', 'x', 'x-001']);
});

test('unknown newer models are priced higher than the known one', () => {
  assert.equal(P.imageCost('gemini-nano-banana-2.1'), 0.04);
  assert.ok(Math.abs(P.imageCost('gemini-nano-banana-3') - 0.12) < 1e-9);
  assert.equal(P.videoEstimate('gemini-omni-1.1-flash'), 4);
  assert.equal(P.videoActual('gemini-omni-1.1-flash', { total_output_tokens: 1_000_000 }, 8), 17.5);
  assert.ok(Math.abs(P.videoActual('gemini-omni-1.1-flash', null, 8) - 0.8) < 1e-9);
});

test('budget counts reserved and uncertain at the estimate, failed at 0', () => {
  const p = { budgetUSD: 5, ledger: [
    { status: 'ok', actual: 1, estimate: 4 },
    { status: 'failed', actual: 0, estimate: 4 },
    { status: 'uncertain', actual: 0, estimate: 2 },
    { status: 'reserved', actual: 0, estimate: 1 },
  ] };
  assert.equal(P.spent(p), 4);
  P.checkBudget(p, 1);
  assert.throws(() => P.checkBudget(p, 1.01), P.BudgetExceeded);
});

test('decodePlan clamps, normalizes and rejects incomplete plans', () => {
  const json = JSON.stringify({
    title: 'T', music_style: 'pop', character: 'c', visual_style: 'v',
    sections: [{ name: 'Verse', start: -3, end: 99, lines: [' a ', '', 'b'] }],
    scenes: [{ start: 10, end: 30, summary_ja: '2', prompt_en: 'p2' }, { start: 0, end: 10, summary_ja: '1', prompt_en: 'p1' }, { start: 0, end: 5, prompt_en: '' }],
  });
  const plan = D.decodePlan(json, 30);
  assert.deepEqual(plan.sections[0], { name: 'Verse', start: 0, end: 30, lines: ['a', 'b'] });
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.scenes[0].prompt, 'p1');
  assert.equal(plan.scenes[0].start, 0);
  assert.equal(plan.scenes[1].end, 30);
  assert.ok(Math.abs(plan.scenes[0].end - 10) < 1e-9);
  assert.throws(() => D.decodePlan('{"sections":[]}', 30), D.DirectorError);
  assert.throws(() => D.decodePlan('not json', 30), D.DirectorError);
});

test('song prompt carries lyrics and structure', () => {
  const plan = { musicStyle: 'EDM 150 BPM', sections: [{ name: 'Intro', start: 0, end: 5, lines: [] }, { name: 'Chorus', start: 5, end: 65, lines: ['ララ'] }] };
  const s = D.songPrompt(plan, { vocal: 'male', durationSeconds: 65 });
  assert.match(s, /One male lead vocalist/);
  assert.match(s, /\[Chorus\] 0:05-1:05/);
  assert.match(s, /\[Intro\]\n\(instrumental\)/);
});

test('Lyria timestamps are parsed and missing ends filled', () => {
  const t = L.parseLyria('[[A0]]\n[0.5:] 一行目\n[3.0:4.0] 二行目\n[20:] 最後', 22);
  assert.deepEqual(t, [
    { start: 0.5, end: 3, text: '一行目' },
    { start: 3, end: 4, text: '二行目' },
    { start: 20, end: 22, text: '最後' },
  ]);
  assert.equal(L.parseLyria('[:] 時刻なし', 10), null);
  assert.equal(L.parseLyria('ただの文章', 10), null);
});

test('fromPlan spreads lines evenly and lineAt finds the current line', () => {
  const t = L.fromPlan([{ start: 0, end: 4, lines: ['a', 'b'] }, { start: 4, end: 6, lines: [] }], 10);
  assert.deepEqual(t, [{ start: 0, end: 2, text: 'a' }, { start: 2, end: 4, text: 'b' }]);
  assert.equal(L.lineAt(t, 2.5).text, 'b');
  assert.equal(L.lineAt(t, 5), null);
  assert.equal(L.sanitize([{ start: 99, end: 100, text: 'x' }], 10), null);
});
