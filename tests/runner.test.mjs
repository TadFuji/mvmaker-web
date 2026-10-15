import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient, media, fileID } from '../js/gemini.js';
import { ApiError } from '../js/vault.js';
import { Runner, newProject, currentStep, StaleError, clampBudget } from '../js/runner.js';
import { memoryStore, recover } from '../js/store.js';
import * as P from '../js/pricing.js';

const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });
const b64 = (s) => Buffer.from(s).toString('base64');

function fakeRequest(handler) {
  const log = [];
  const fn = async (method, path, opts = {}) => {
    log.push({ method, path, json: opts.json });
    return handler(method, path, opts.json, log);
  };
  fn.log = log;
  return fn;
}

test('parser reads steps and SDK-style fields; fileID extracts ids', () => {
  const r = { steps: [{ type: 'thought', content: [{ type: 'text', text: 'x' }] }, { type: 'model_output', content: [{ type: 'video', uri: 'https://g/v1beta/files/ab-1:download?alt=media' }] }], output_image: { data: 'AAA', mime_type: 'image/png' } };
  assert.deepEqual(media(r, 'video'), [{ uri: 'https://g/v1beta/files/ab-1:download?alt=media', mime: '' }]);
  assert.equal(media(r, 'image')[0].data, 'AAA');
  assert.equal(fileID('files/abc_9'), 'abc_9');
  assert.equal(fileID('nothing'), null);
});

test('validateKey picks the newest models from the list', async () => {
  const req = fakeRequest((m, path) => {
    if (path.includes('pageToken')) return ok({ models: [{ name: 'models/gemini-omni-2-flash' }] });
    return ok({ models: [{ name: 'models/lyria-3.5' }, { name: 'models/gemini-nano-banana-2.2' }], nextPageToken: 'n' });
  });
  const g = new GeminiClient(req);
  const models = await g.validateKey();
  assert.deepEqual(models, { music: 'lyria-3.5', image: 'gemini-nano-banana-2.2', video: 'gemini-omni-2-flash' });
});

test('a refused newer model falls back to the checked one and is remembered', async () => {
  let prefs = {};
  const req = fakeRequest((m, path, json) => {
    if (path.startsWith('/v1beta/models')) return ok({ models: [{ name: 'models/lyria-9' }] });
    if (json.model === 'lyria-9') throw new ApiError(404, 'submit', 'NOT_FOUND: model');
    return ok({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: b64('ID3song'), mime_type: 'audio/mpeg' }, { type: 'text', text: '[0:] la' }] }] });
  });
  const g = new GeminiClient(req, { prefs: { get: () => prefs, set: (v) => { prefs = v; } } });
  await g.validateKey();
  assert.equal(g.models.music, 'lyria-9');
  const r = await g.generateMusic({ prompt: 'p' });
  assert.equal(r.model, 'lyria-3.5');
  assert.equal(r.fellBack, 'lyria-9');
  assert.deepEqual(prefs.broken.map((b) => b.id), ['lyria-9']);
  assert.ok(Date.now() - prefs.broken[0].at < 5000);
  assert.equal(g.models.music, 'lyria-3.5');
  // Next session also skips it.
  const g2 = new GeminiClient(req, { prefs: { get: () => prefs, set: () => {} } });
  await g2.validateKey();
  assert.equal(g2.models.music, 'lyria-3.5');
  // After 14 days the newer model is tried again.
  const old = { broken: [{ id: 'lyria-9', at: Date.now() - 15 * 24 * 3600 * 1000 }] };
  const g3 = new GeminiClient(req, { prefs: { get: () => old, set: () => {} } });
  await g3.validateKey();
  assert.equal(g3.models.music, 'lyria-9');
});

test('a prompt problem does not mark the newer model as broken', async () => {
  let prefs = {};
  const req = fakeRequest((m, path) => {
    if (path.startsWith('/v1beta/models')) return ok({ models: [{ name: 'models/lyria-9' }] });
    throw new ApiError(400, 'submit', 'INVALID_ARGUMENT: prompt blocked');
  });
  const g = new GeminiClient(req, { prefs: { get: () => prefs, set: (v) => { prefs = v; } } });
  await g.validateKey();
  await assert.rejects(g.generateMusic({ prompt: 'p' }), ApiError);
  assert.equal(prefs.broken, undefined);
});

test('video uri is polled then downloaded', async () => {
  let polls = 0;
  const req = fakeRequest((m, path, json) => {
    if (json) return ok({ steps: [{ content: [{ type: 'video', uri: 'files/vid1' }] }], usage: { total_output_tokens: 10 } });
    if (path === '/v1beta/files/vid1') return ok({ state: polls++ < 1 ? 'PROCESSING' : 'ACTIVE' });
    if (path === '/v1beta/files/vid1:download?alt=media') return new Response(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), { status: 200 });
    throw new Error('unexpected ' + path);
  });
  const g = new GeminiClient(req, { pollMs: 0 });
  const r = await g.generateVideo({ prompt: 'p', references: [new Blob([new Uint8Array([0x89, 0x50])])], aspect: '9:16' });
  assert.equal(r.blob.type, 'video/mp4');
  const payload = req.log[0].json;
  assert.equal(payload.model, 'gemini-omni-1.1-flash');
  assert.equal(payload.response_format.aspect_ratio, '9:16');
  assert.equal(payload.input[0].mime_type, 'image/png');
});

// ---- runner with a fake Gemini ----

function fakeGemini({ failVideo } = {}) {
  const plan = {
    title: 'テスト', music_style: 'pop', character: 'c', visual_style: 'v',
    sections: [{ name: 'Verse', start: 0, end: 20, lines: ['一', '二'] }],
    scenes: [{ start: 0, end: 10, summary_ja: 'a', prompt_en: 'a' }, { start: 10, end: 20, summary_ja: 'b', prompt_en: 'b' }],
  };
  return {
    models: { music: 'lyria-3.5', image: 'gemini-nano-banana-2.1', video: 'gemini-omni-1.1-flash' },
    generateJSON: async ({ audio }) => audio
      ? { text: JSON.stringify({ lines: [{ text: '一', start: 1, end: 3 }, { text: '二', start: 4, end: 6 }] }), usage: null }
      : { text: JSON.stringify(plan), usage: { total_input_tokens: 1000, total_output_tokens: 1000 } },
    generateMusic: async () => ({ blob: new Blob(['song']), text: '', model: 'lyria-3.5' }),
    generateImage: async () => ({ blob: new Blob(['img']), model: 'gemini-nano-banana-2.1' }),
    generateVideo: async () => {
      if (failVideo) throw new ApiError(500, 'afterSubmit', 'boom');
      return { blob: new Blob(['vid']), usage: null, model: 'gemini-omni-1.1-flash' };
    },
  };
}

function makeRunner(opts = {}, budget = 20) {
  const store = memoryStore();
  const p = newProject({ theme: '海', mood: '', vocal: 'female', durationSeconds: 20, aspect: '16:9', budgetUSD: budget });
  const r = new Runner(p, {
    gemini: fakeGemini(opts), store,
    probeDuration: async (_b, kind) => (kind === 'audio' ? 22 : 8),
    assemble: async () => new Blob(['mp4'], { type: 'video/mp4' }),
  });
  return { r, store };
}

test('full flow reaches export and records costs', async () => {
  const { r, store } = makeRunner();
  await r.makePlan();
  assert.equal(currentStep(r.project), 1);
  await r.makeSong();
  assert.equal(currentStep(r.project), 2);
  await r.approveSong();
  assert.deepEqual(r.project.lyrics.map((l) => l.text), ['一', '二']);
  assert.equal(r.project.plan.scenes.at(-1).end, 22); // fit to the song (22 s < 20 s x 1.2)
  await r.makeStyle();
  await r.approveStyle();
  assert.equal(currentStep(r.project), 4);
  await r.makeRemainingScenes();
  assert.ok(r.canExport);
  await r.exportVideo();
  assert.equal(currentStep(r.project), 5);
  assert.ok(r.project.exportFile);
  assert.ok(r.project.ledger.every((e) => e.status === 'ok'));
  // 2 clips x 8 s x $0.10 + song + 2 images + texts
  const videoCost = r.project.ledger.filter((e) => e.kind.startsWith('動画')).reduce((s, e) => s + e.actual, 0);
  assert.ok(Math.abs(videoCost - 1.6) < 1e-9);
  const saved = await store.get(r.project.id);
  assert.equal(saved.exportFile.file, r.project.exportFile.file);
});

test('budget stops paid work before calling', async () => {
  const { r } = makeRunner({}, 3);
  await r.makePlan();
  await r.makeSong();
  await r.approveSong();
  await r.makeStyle();
  await r.approveStyle();
  await assert.rejects(r.makeRemainingScenes(), P.BudgetExceeded); // needs $4 reserved
  assert.equal(r.project.ledger.filter((e) => e.kind.startsWith('動画')).length, 0);
});

test('failed video after submit is counted as uncertain; busy blocks a second job', async () => {
  const { r } = makeRunner({ failVideo: true });
  await r.makePlan();
  await r.makeSong();
  await r.approveSong();
  await r.makeStyle();
  await r.approveStyle();
  await assert.rejects(r.makeScene(r.project.plan.scenes[0].id), ApiError);
  const e = r.project.ledger.at(-1);
  assert.equal(e.status, 'uncertain');
  assert.equal(P.counted(e), 4);
  const slow = r.run('x', () => new Promise((res) => setTimeout(res, 20)));
  await assert.rejects(r.makePlan(), /お待ちください/);
  await slow;
});

test('lyrics edits only before the song; reserved entries recover as uncertain', async () => {
  const { r } = makeRunner();
  await r.makePlan();
  await r.editLyrics(0, ' あ \n\n い ');
  assert.deepEqual(r.project.plan.sections[0].lines, ['あ', 'い']);
  await r.makeSong();
  await r.editLyrics(0, 'う');
  assert.deepEqual(r.project.plan.sections[0].lines, ['あ', 'い']);
  const p = recover({ ledger: [{ status: 'reserved' }] });
  assert.equal(p.ledger[0].status, 'uncertain');
});

test('a stale tab cannot overwrite ledger entries saved by another tab', async () => {
  const { r, store } = makeRunner();
  await r.makePlan();
  // Second tab opened earlier, with the same saved state.
  const other = new Runner(await store.get(r.project.id), { ...r.d });
  await r.makeSong(); // tab A spends money
  const before = (await store.get(r.project.id)).ledger.length;
  await assert.rejects(other.updateBudget(500), StaleError);
  const saved = await store.get(r.project.id);
  assert.equal(saved.ledger.length, before);
  assert.equal(saved.budgetUSD, 20);
  // The stale tab now has the saved copy and can act normally.
  assert.equal(other.project.ledger.length, before);
  await other.updateBudget(30);
  assert.equal((await store.get(r.project.id)).budgetUSD, 30);
  // A paid run reloads first, so tab A sees tab B's change instead of failing.
  await r.makeSong();
  assert.equal(r.project.budgetUSD, 30);
});

test('budget is limited to 0..500', () => {
  assert.equal(clampBudget(5000), 500);
  assert.equal(clampBudget(-3), 0);
  assert.equal(clampBudget('abc'), 0);
  assert.equal(newProject({ theme: 'x', budgetUSD: 9999 }).budgetUSD, 500);
});
