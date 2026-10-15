// Runs the steps of one MV: plan -> song -> style -> scenes -> export.
// Every paid call: check the budget, save a "reserved" ledger entry at the
// estimate, run, then settle it to the real cost (or failed / uncertain).
// Ported from the Mac app (ProjectRunner.swift).

import * as D from './director.js';
import * as L from './lyrics.js';
import * as P from './pricing.js';
import { isClearFailure } from './gemini.js';
import { TEXT_MODEL } from './models.js';

export const MAX_BUDGET_USD = 500;

/** Budget limited to 0..MAX_BUDGET_USD so a typo can't allow thousands of dollars. */
export function clampBudget(usd) {
  const n = Number(usd);
  return Number.isFinite(n) ? Math.min(MAX_BUDGET_USD, Math.max(0, n)) : 0;
}

export function newProject({ theme, mood, vocal, durationSeconds, aspect, budgetUSD, demo = false }) {
  return {
    id: D.newId(),
    createdAt: Date.now(),
    theme, mood, vocal, durationSeconds, aspect, budgetUSD: clampBudget(budgetUSD), demo,
    rev: 0,
    plan: null,
    song: null, // { file, text }
    songApproved: false,
    lyrics: null,
    styleImage: null,
    characterImage: null,
    styleApproved: false,
    exportFile: null, // { file, mime }
    ledger: [],
  };
}

export class BusyError extends Error {}
export class StaleError extends Error {}

export class Runner {
  /**
   * deps: { gemini, store, probeDuration(blob, kind) -> seconds|null,
   *         assemble(args) -> Blob, onChange(project, busy) }
   */
  constructor(project, deps) {
    this.project = project;
    this.d = deps;
    this.busy = null;
    this.progress = null;
  }

  get spent() { return P.spent(this.project); }

  /**
   * Applies a change and saves it. Each save bumps `rev`; if the saved copy
   * has a different rev, another tab changed this MV, so nothing is saved
   * (otherwise its ledger entries could be overwritten and the budget
   * bypassed) and this tab switches to the saved copy.
   */
  async commit(change) {
    const stored = await this.d.store.get(this.project.id);
    if (stored && (stored.rev ?? 0) !== (this.project.rev ?? 0)) {
      this.project = stored;
      this.notify();
      throw new StaleError('この MV はほかのタブで変更されていました。最新の状態を読み込み直したので、もう一度操作してください。');
    }
    change(this.project);
    this.project.rev = (this.project.rev ?? 0) + 1;
    await this.d.store.save(this.project);
    this.notify();
  }

  notify() { this.d.onChange?.(this.project, this.busy, this.progress); }

  setBusy(label, progress = null) { this.busy = label; this.progress = progress; this.notify(); }

  async run(label, body) {
    if (this.busy) throw new BusyError('ほかの作業が終わるまでお待ちください。');
    // Claimed synchronously so a double click can't start two jobs.
    this.setBusy(label);
    const work = async () => {
      // Start from the saved copy: another tab may have spent money meanwhile.
      const stored = await this.d.store.get(this.project.id);
      if (stored) this.project = stored;
      return body();
    };
    try {
      // Holds a lock per MV so two tabs can't run paid work on it at once.
      if (globalThis.navigator?.locks) {
        return await navigator.locks.request('mv-' + this.project.id, { ifAvailable: true }, async (lock) => {
          if (!lock) throw new BusyError('この MV はほかのタブで作業中です。そちらのタブを使ってください。');
          return work();
        });
      }
      return await work();
    } finally {
      this.setBusy(null);
    }
  }

  async reserve(kind, model, estimate) {
    P.checkBudget(this.project, estimate);
    // `assumed`: the model had no listed price, so 3x the base price was used.
    const entry = { id: D.newId(), date: Date.now(), kind, model, estimate, actual: 0, status: 'reserved', assumed: P.priceSource(model) === 'assumed' };
    await this.commit((p) => p.ledger.push(entry));
    return entry.id;
  }

  async settle(id, status, actual = 0, extra = () => {}) {
    await this.commit((p) => {
      const e = p.ledger.find((x) => x.id === id);
      if (e) { e.status = status; e.actual = actual; }
      extra(p);
    });
  }

  async settleFailure(id, e) {
    try { await this.settle(id, isClearFailure(e) ? 'failed' : 'uncertain'); } catch { /* keep original error */ }
  }

  /** Reserve, call, settle. cost(result) gives the real cost. */
  async paid(kind, model, estimate, cost, call) {
    const id = await this.reserve(kind, model, estimate);
    try {
      const r = await call();
      await this.settle(id, 'ok', cost(r), (p) => {
        const e = p.ledger.find((x) => x.id === id);
        if (e && r?.model) { e.model = r.model; e.assumed = P.priceSource(r.model) === 'assumed'; }
      });
      return r;
    } catch (e) {
      await this.settleFailure(id, e);
      throw e;
    }
  }

  async file(name) { return name ? this.d.store.getFile(this.project.id, name) : null; }

  async saveFile(name, blob) { await this.d.store.putFile(this.project.id, name, blob); return name; }

  /**
   * The user's request in English for the generation models (they are
   * prompted in English). ASCII text is used as is; otherwise one cheap
   * text call translates it.
   */
  async toEnglish(request) {
    const text = String(request ?? '').trim().slice(0, 1000);
    if (!text || D.isAscii(text)) return text;
    const r = await this.paid('指示の翻訳', TEXT_MODEL, P.TEXT_ESTIMATE, (x) => P.textActual(x.usage),
      () => this.d.gemini.generateJSON({ prompt: D.translatePrompt(text), schema: D.translateSchema }));
    try {
      const en = String(JSON.parse(r.text)?.english ?? '').trim();
      return en || text;
    } catch { return text; }
  }

  // ---- settings ----

  async updateBudget(usd) { await this.commit((p) => { p.budgetUSD = clampBudget(usd); }); }

  // ---- 1. plan ----

  async makePlan(request = '') {
    return this.run('Gemini が歌詞と絵コンテを考えています…', async () => {
      const prompt = D.planPrompt(this.project, request);
      const r = await this.paid('歌詞と絵コンテ', TEXT_MODEL, P.TEXT_ESTIMATE, (x) => P.textActual(x.usage),
        () => this.d.gemini.generateJSON({ prompt, schema: D.planSchema }));
      const plan = D.decodePlan(r.text, this.project.durationSeconds);
      await this.commit((p) => {
        p.plan = plan;
        p.song = null; p.songApproved = false; p.lyrics = null;
        p.styleImage = null; p.characterImage = null; p.styleApproved = false;
        p.exportFile = null;
      });
    });
  }

  /** User edit of one section's lyrics; only before the song exists. */
  async editLyrics(sectionIndex, text) {
    const plan = this.project.plan;
    if (this.project.song || !plan?.sections[sectionIndex]) return;
    await this.commit((p) => {
      p.plan.sections[sectionIndex].lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    });
  }

  /**
   * Revises the current plan as the user asks (lyrics, title, scenes...).
   * The song is always made again; pictures and clips are kept when what
   * they depend on did not change.
   */
  async revisePlan(request) {
    const text = String(request ?? '').trim();
    if (!this.project.plan || !text) return;
    return this.run('Gemini が指示に合わせて直しています…', async () => {
      const old = this.project.plan;
      const prompt = D.revisePlanPrompt(this.project, old, text.slice(0, 1000));
      const r = await this.paid('歌詞と絵コンテの手直し', TEXT_MODEL, P.TEXT_ESTIMATE, (x) => P.textActual(x.usage),
        () => this.d.gemini.generateJSON({ prompt, schema: D.planSchema }));
      const plan = D.decodePlan(r.text, this.project.durationSeconds);
      // Pictures are never dropped here (the user remakes them in step 3 if
      // wanted); the screen says when the character or style text changed.
      const lookChanged = D.sameText(plan.character, old.character) && D.sameText(plan.visualStyle, old.visualStyle) ? false : true;
      plan.styleNotes = old.styleNotes ?? [];
      plan.styleRequestsJa = old.styleRequestsJa ?? [];
      // A scene keeps its clip when its text is unchanged (matched by text,
      // so a changed scene count doesn't shift clips onto other scenes).
      const unused = [...old.scenes];
      let dropped = 0;
      plan.scenes = plan.scenes.map((s) => {
        const k = unused.findIndex((b) => D.sameText(b.prompt, s.prompt));
        if (k < 0) return s;
        const [before] = unused.splice(k, 1);
        return { ...s, id: before.id, clip: before.clip, notes: before.notes, requestJa: before.requestJa };
      });
      dropped = unused.filter((b) => b.clip).length;
      await this.commit((p) => {
        p.plan = plan;
        p.song = null; p.songApproved = false; p.lyrics = null;
        p.exportFile = null;
      });
      return { lookChanged, droppedClips: dropped };
    });
  }

  async editTitle(title) {
    if (!this.project.plan) return;
    await this.commit((p) => { p.plan.title = String(title).trim().slice(0, 60); });
  }

  // ---- 2. song ----

  async makeSong(request = '') {
    const plan = this.project.plan;
    if (!plan) return;
    return this.run('Lyria が曲を作っています（1〜2分かかります）…', async () => {
      const model = this.d.gemini.models.music;
      // Checked before translating, so a translation isn't paid for in vain.
      P.checkBudget(this.project, P.musicCost(model) + (D.isAscii(request) ? 0 : P.TEXT_ESTIMATE));
      const en = await this.toEnglish(request);
      const r = await this.paid('曲', model, P.musicCost(model), (x) => P.musicCost(x.model),
        () => this.d.gemini.generateMusic({ prompt: D.songPrompt(plan, this.project, en) }));
      const file = await this.saveFile(`song-${Date.now()}`, r.blob);
      await this.commit((p) => {
        p.song = { file, text: r.text || '', request: String(request ?? '').trim() };
        p.songApproved = false; p.lyrics = null; p.exportFile = null;
      });
    });
  }

  /** Drops the song so the lyrics can be edited again. */
  async discardSong() {
    if (this.busy) throw new BusyError('ほかの作業が終わるまでお待ちください。');
    await this.commit((p) => { p.song = null; p.songApproved = false; p.lyrics = null; p.exportFile = null; });
  }

  /**
   * Accepts the song and works out when each lyric line is sung: Lyria's
   * own timestamps, else Gemini listens to the song, else the planned times.
   */
  async approveSong() {
    const plan = this.project.plan;
    if (!plan || !this.project.song) return;
    return this.run('歌詞の表示時刻を合わせています…', async () => {
      const audio = await this.file(this.project.song.file);
      const songDuration = (await this.d.probeDuration(audio, 'audio')) ?? this.project.durationSeconds;
      let timed = L.parseLyria(this.project.song.text, songDuration);
      const lines = plan.sections.flatMap((x) => x.lines);
      if (!timed && lines.length && audio && audio.size < 15_000_000) {
        try {
          const r = await this.paid('歌詞の時刻', TEXT_MODEL, P.TEXT_ESTIMATE, (x) => P.textActual(x.usage),
            () => this.d.gemini.generateJSON({ prompt: D.timingPrompt(lines), schema: D.timingSchema, audio }));
          timed = L.sanitize(D.decodeTiming(r.text), songDuration);
        } catch (e) {
          if (e instanceof P.BudgetExceeded) throw e;
          timed = null; // fall back to the planned times below
        }
      }
      if (!timed) {
        const scale = songDuration / Math.max(1, this.project.durationSeconds);
        timed = L.fromPlan(plan.sections.map((x) => ({ ...x, start: x.start * scale, end: x.end * scale })), songDuration);
      }
      // Lyria often runs 10-20 % long; past 20 % the song is cut with a fade.
      const videoDuration = Math.min(songDuration, this.project.durationSeconds * 1.2);
      timed = timed.filter((l) => l.start < videoDuration - 0.5).map((l) => ({ ...l, end: Math.min(l.end, videoDuration) }));
      await this.commit((p) => {
        p.plan.scenes = D.normalizeScenes(p.plan.scenes, videoDuration);
        p.lyrics = timed;
        p.songApproved = true;
      });
    });
  }

  // ---- 3. style ----

  /**
   * Makes the style picture and the character sheet.
   * request: what the user wants changed. With a request and existing
   * pictures, the current style picture is edited (the rest kept) and the
   * request is remembered for the character sheet and every scene.
   * fresh: start over without earlier requests.
   */
  async makeStyle({ request = '', fresh = false } = {}) {
    if (!this.project.plan) return;
    return this.run('キャラクターと画風の見本を作っています…', async () => {
      const g = this.d.gemini;
      const img = (prompt, references, aspect, kind) => this.paid(kind, g.models.image, P.imageCost(g.models.image), (x) => P.imageCost(x.model),
        () => g.generateImage({ prompt, references, aspect }));
      P.checkBudget(this.project, 2 * P.imageCost(g.models.image) + (D.isAscii(request) ? 0 : P.TEXT_ESTIMATE));
      const en = await this.toEnglish(request);
      const current = !fresh && en ? await this.file(this.project.styleImage) : null;
      // The request is saved only together with the picture it changed, so a
      // failed call leaves no note behind (and a retry adds no duplicate).
      const base = fresh ? { notes: [], ja: [] } : { notes: this.project.plan.styleNotes ?? [], ja: this.project.plan.styleRequestsJa ?? [] };
      const notes = en ? [...base.notes, en].slice(-8) : base.notes;
      const ja = en ? [...base.ja, String(request).trim()].slice(-8) : base.ja;
      const plan = { ...this.project.plan, styleNotes: notes };
      const frame = current
        ? await img(D.imageEditPrompt(en), [current], this.project.aspect, '画風の見本（手直し）')
        : await img(D.styleFramePrompt(plan) + (en ? `\nAlso: ${en}` : ''), [], this.project.aspect, '画風の見本');
      const frameFile = await this.saveFile(`style-${Date.now()}`, frame.blob);
      await this.commit((p) => {
        p.styleImage = frameFile; p.styleApproved = false;
        p.plan.styleNotes = notes; p.plan.styleRequestsJa = ja;
      });
      const sheet = await img(D.characterSheetPrompt(plan), [frame.blob], '16:9', 'キャラクター');
      const sheetFile = await this.saveFile(`character-${Date.now()}`, sheet.blob);
      await this.commit((p) => {
        p.characterImage = sheetFile;
        p.styleApproved = false;
        for (const s of p.plan.scenes) s.clip = null; // old clips no longer match
        p.exportFile = null;
      });
    });
  }

  async approveStyle() {
    if (!this.project.styleImage || !this.project.characterImage) return;
    await this.commit((p) => { p.styleApproved = true; });
  }

  // ---- 4. scenes ----

  get remainingScenes() { return this.project.plan?.scenes.filter((s) => !s.clip).length ?? 0; }

  /** Makes (or remakes) one scene; `request` is how the user wants it changed. */
  async makeScene(sceneId, request) {
    const n = this.project.plan?.scenes.findIndex((s) => s.id === sceneId) ?? -1;
    if (n < 0) return;
    return this.run(`場面 ${n + 1} の動画を作っています（数分かかります）…`, async () => {
      // Looked up again after run() reloaded the saved copy.
      const i = this.project.plan?.scenes.findIndex((s) => s.id === sceneId) ?? -1;
      if (i < 0) return;
      const text = String(request ?? '').trim();
      let change = null;
      if (text) {
        const g = this.d.gemini;
        P.checkBudget(this.project, P.videoEstimate(g.models.video) + (D.isAscii(text) ? 0 : P.TEXT_ESTIMATE));
        change = { notes: await this.toEnglish(text), requestJa: text };
      }
      return this.generateScene(i, change);
    });
  }

  async makeRemainingScenes() {
    const scenes = this.project.plan?.scenes ?? [];
    const todo = scenes.map((s, i) => (s.clip ? -1 : i)).filter((i) => i >= 0);
    return this.run('動画を作っています…', async () => {
      for (let n = 0; n < todo.length; n++) {
        this.setBusy(`動画を作っています（${n + 1}/${todo.length}本目。1本に数分かかります）…`, { done: n, total: todo.length });
        await this.generateScene(todo[n]);
      }
    });
  }

  /** change: { notes, requestJa } — the user's request, saved only if the clip is made. */
  async generateScene(index, change = null) {
    const plan = this.project.plan;
    const scene = change ? { ...plan.scenes[index], ...change } : plan.scenes[index];
    const refs = [];
    for (const f of [this.project.characterImage, this.project.styleImage]) {
      const b = await this.file(f);
      if (b) refs.push(b);
    }
    const g = this.d.gemini;
    const prompt = D.scenePrompt(scene, plan, this.project.aspect);
    // The real cost depends on the clip length, so this settles by itself.
    const id = await this.reserve(`動画 場面${index + 1}`, g.models.video, P.videoEstimate(g.models.video));
    try {
      const r = await g.generateVideo({ prompt, references: refs, aspect: this.project.aspect });
      const file = await this.saveFile(`clip-${scene.id}-${Date.now()}`, r.blob);
      const seconds = await this.d.probeDuration(r.blob, 'video');
      await this.settle(id, 'ok', P.videoActual(r.model, r.usage, seconds), (p) => {
        const s = p.plan.scenes.find((x) => x.id === scene.id);
        if (s) { s.clip = file; if (change) Object.assign(s, change); }
        const e = p.ledger.find((x) => x.id === id);
        if (e) { e.model = r.model; e.assumed = P.priceSource(r.model) === 'assumed'; }
        p.exportFile = null;
      });
    } catch (e) {
      await this.settleFailure(id, e);
      throw e;
    }
  }

  // ---- 5. export ----

  get canExport() {
    const s = this.project.plan?.scenes;
    return !!(this.project.songApproved && s?.length && s.every((x) => x.clip));
  }

  async exportVideo() {
    if (!this.canExport) return;
    return this.run('動画をつないで書き出しています…', async () => {
      const p = this.project;
      const clips = [];
      for (const s of p.plan.scenes) {
        const blob = await this.file(s.clip);
        if (!blob) throw new Error('動画ファイルが見つかりません。その場面を作り直してください。');
        clips.push({ blob, duration: s.end - s.start });
      }
      const song = await this.file(p.song.file);
      const out = await this.d.assemble({
        clips, song, lyrics: p.lyrics ?? [], aspect: p.aspect,
        onProgress: (f) => this.setBusy('動画をつないで書き出しています…（このタブは表示したままにしてください）', { done: f, total: 1 }),
      });
      const file = await this.saveFile(`export-${Date.now()}`, out);
      await this.commit((x) => { x.exportFile = { file, mime: out.type }; });
    });
  }
}

/** Which step the MV is on (1-5) for the step bar. */
export function currentStep(p) {
  if (!p.plan) return 1;
  if (!p.songApproved) return p.song ? 2 : 1;
  if (!p.styleApproved) return 3;
  const scenes = p.plan.scenes;
  if (!scenes.every((s) => s.clip)) return 4;
  return 5;
}
