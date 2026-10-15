// "How should it change?" requests (2026-10-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner, newProject } from '../js/runner.js';
import { memoryStore } from '../js/store.js';
import * as D from '../js/director.js';
import * as P from '../js/pricing.js';

const PLAN = {
  title: 'T', music_style: 'punk', character: 'c', visual_style: 'v',
  sections: [{ name: 'Verse', start: 0, end: 20, lines: ['一', '二'] }],
  scenes: [{ start: 0, end: 10, summary_ja: 'a', prompt_en: 'a' }, { start: 10, end: 20, summary_ja: 'b', prompt_en: 'b' }],
};

function fake() {
  const calls = [];
  const g = {
    calls,
    models: { music: 'lyria-3.5', image: 'gemini-nano-banana-2.1', video: 'gemini-omni-1.1-flash' },
    revised: null,
    async generateJSON({ prompt }) {
      calls.push({ kind: 'json', prompt });
      if (prompt.startsWith('Translate')) return { text: JSON.stringify({ english: 'EN:' + prompt.split('\n\n')[1] }), usage: null };
      if (prompt.includes('Current plan:')) return { text: JSON.stringify(g.revised), usage: null };
      return { text: JSON.stringify(PLAN), usage: null };
    },
    async generateMusic({ prompt }) { calls.push({ kind: 'music', prompt }); return { blob: new Blob(['s']), text: '', model: 'lyria-3.5' }; },
    async generateImage({ prompt, references }) { calls.push({ kind: 'image', prompt, references }); return { blob: new Blob(['img' + calls.length]), model: 'gemini-nano-banana-2.1' }; },
    async generateVideo({ prompt }) { calls.push({ kind: 'video', prompt }); return { blob: new Blob(['v']), usage: null, model: 'gemini-omni-1.1-flash' }; },
  };
  return g;
}

async function setup(budget = 20) {
  const g = fake();
  const store = memoryStore();
  const r = new Runner(newProject({ theme: 'x', mood: '', vocal: 'female', durationSeconds: 20, aspect: '16:9', budgetUSD: budget }), {
    gemini: g, store, probeDuration: async (_b, k) => (k === 'audio' ? 20 : 8), assemble: async () => new Blob(['m'], { type: 'video/mp4' }),
  });
  await r.makePlan();
  return { r, g };
}

test('song request is translated and added to the Lyria prompt', async () => {
  const { r, g } = await setup();
  await r.makeSong('もっと速く');
  const music = g.calls.find((c) => c.kind === 'music');
  assert.match(music.prompt, /Additional request from the user .*EN:もっと速く/);
  assert.equal(r.project.song.request, 'もっと速く');
  assert.ok(r.project.ledger.some((e) => e.kind === '指示の翻訳'));
  // ASCII requests are not translated.
  const before = r.project.ledger.length;
  await r.makeSong('faster');
  assert.equal(r.project.ledger.length, before + 1);
});

test('style request edits the current picture and is carried into scenes', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong();
  await r.makeStyle();
  const firstFrame = await r.file(r.project.styleImage);
  await r.makeStyle({ request: '黒い四角を消して' });
  const edit = g.calls.filter((c) => c.kind === 'image').at(-2);
  assert.match(edit.prompt, /^Edit the reference image\. Apply this change: EN:黒い四角を消して/);
  assert.equal(edit.references.length, 1);
  assert.equal(await edit.references[0].text(), await firstFrame.text());
  const sheet = g.calls.filter((c) => c.kind === 'image').at(-1);
  assert.match(sheet.prompt, /Changes the user asked for on the look .*EN:黒い四角を消して/);
  assert.deepEqual(r.project.plan.styleRequestsJa, ['黒い四角を消して']);
  await r.approveStyle();
  await r.makeScene(r.project.plan.scenes[0].id);
  assert.match(g.calls.at(-1).prompt, /Changes the user asked for on the look .*EN:黒い四角を消して/);
  // Starting over forgets the requests.
  await r.makeStyle({ fresh: true });
  assert.deepEqual(r.project.plan.styleNotes, []);
});

test('scene request is stored on the scene and sent to Omni', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong(); await r.makeStyle(); await r.approveStyle();
  const id = r.project.plan.scenes[1].id;
  await r.makeScene(id, 'カメラを激しく');
  assert.match(g.calls.at(-1).prompt, /^b\nRequested changes for this shot \(follow them\): EN:カメラを激しく/);
  const s = r.project.plan.scenes[1];
  assert.equal(s.requestJa, 'カメラを激しく');
  assert.ok(s.clip);
});

test('revising the plan keeps pictures and unchanged clips, remakes the song', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong(); await r.makeStyle(); await r.approveStyle();
  await r.makeRemainingScenes();
  const [c0, c1] = r.project.plan.scenes.map((s) => s.clip);
  g.revised = { ...PLAN, sections: [{ name: 'Verse', start: 0, end: 20, lines: ['新しい', '歌詞'] }], scenes: [PLAN.scenes[0], { ...PLAN.scenes[1], prompt_en: 'b2' }] };
  await r.revisePlan('歌詞を変えて');
  const p = r.project;
  assert.deepEqual(p.plan.sections[0].lines, ['新しい', '歌詞']);
  assert.equal(p.song, null);
  assert.ok(p.styleImage && p.styleApproved);
  assert.equal(p.plan.scenes[0].clip, c0);
  assert.equal(p.plan.scenes[1].clip, null);
  assert.notEqual(c1, null);
  // A changed character keeps the pictures and says so; paraphrase-free
  // whitespace changes count as unchanged.
  g.revised = { ...PLAN, character: 'other', scenes: [{ ...PLAN.scenes[0], prompt_en: ' a. ' }, PLAN.scenes[1]] };
  const res = await r.revisePlan('主人公を変えて');
  assert.equal(res.lookChanged, true);
  assert.ok(r.project.styleImage);
  assert.equal(r.project.plan.scenes[0].clip, c0);
  g.revised = { ...PLAN, visual_style: 'v ' };
  assert.equal((await r.revisePlan('そのまま')).lookChanged, true); // character is 'c' again vs 'other'
});

test('a revised plan with fewer scenes keeps clips by scene text, not position', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong(); await r.makeStyle(); await r.approveStyle();
  await r.makeRemainingScenes();
  const c1 = r.project.plan.scenes[1].clip;
  g.revised = { ...PLAN, scenes: [{ ...PLAN.scenes[1], start: 0, end: 20 }] };
  const res = await r.revisePlan('場面を 1 つに');
  assert.equal(r.project.plan.scenes.length, 1);
  assert.equal(r.project.plan.scenes[0].clip, c1);
  assert.equal(res.droppedClips, 1);
});

test('a failed picture edit leaves no note behind', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong(); await r.makeStyle();
  const orig = g.generateImage;
  g.generateImage = async () => { throw new Error('refused'); };
  await assert.rejects(r.makeStyle({ request: '髪を青に' }));
  assert.deepEqual(r.project.plan.styleNotes ?? [], []);
  g.generateImage = orig;
  await r.makeStyle({ request: '髪を青に' });
  assert.deepEqual(r.project.plan.styleRequestsJa, ['髪を青に']);
});

test('a failed scene request is not shown as applied', async () => {
  const { r, g } = await setup();
  await r.makeSong(); await r.approveSong(); await r.makeStyle(); await r.approveStyle();
  g.generateVideo = async () => { throw new Error('limit'); };
  const id = r.project.plan.scenes[0].id;
  await assert.rejects(r.makeScene(id, '夜にして'));
  assert.equal(r.project.plan.scenes[0].requestJa, undefined);
});

test('budget is checked before paying for a translation', async () => {
  const { r } = await setup(0.1); // plan cost ~0 (usage null -> 0.05 estimate)
  const n = r.project.ledger.length;
  await assert.rejects(r.makeSong('もっと速く'), P.BudgetExceeded);
  assert.equal(r.project.ledger.length, n);
});

test('prompt helpers', () => {
  assert.equal(D.isAscii('faster please'), true);
  assert.equal(D.isAscii('速く'), false);
  assert.ok(!D.songPrompt({ musicStyle: 'x', sections: [] }, { vocal: 'female', durationSeconds: 30 }).includes('Additional request'));
});
