// Gemini API calls (all through POST /v1beta/interactions, the same shapes the
// Mac app verified with the real API on 2026-09-29). The key is handled only
// by vault.js; this module receives a `request(method, path, opts)` function.

import { ApiError, redact } from './vault.js';
import { TEXT_MODEL, FAMILIES, choose, idsFromList, isFallback } from './models.js';

// ---- response parsing -------------------------------------------------------

function contentItems(response) {
  const items = [];
  for (const step of response?.steps ?? []) {
    if (step?.type && step.type !== 'model_output') continue; // skip thoughts
    items.push(...(step?.content ?? []));
  }
  // SDK-style convenience fields, in case the REST response carries them.
  for (const k of ['output_video', 'output_image', 'output_audio']) {
    if (response?.[k]) items.push({ type: k.slice(7), ...response[k] });
  }
  return items;
}

export function texts(response) {
  return contentItems(response).filter((i) => i?.type === 'text' && typeof i.text === 'string').map((i) => i.text);
}

/** kind: "video" | "audio" | "image". Returns [{ data: base64 } | { uri }]. */
export function media(response, kind) {
  const out = [];
  for (const i of contentItems(response)) {
    const mime = typeof i?.mime_type === 'string' ? i.mime_type : '';
    if (i?.type !== kind && !mime.startsWith(kind + '/')) continue;
    if (typeof i.data === 'string' && i.data) out.push({ data: i.data, mime });
    else if (typeof i.uri === 'string') out.push({ uri: i.uri, mime });
  }
  return out;
}

/** "files/abc-123" or ".../v1beta/files/abc-123:download?alt=media" -> "abc-123". */
export function fileID(uri) {
  const at = uri.indexOf('files/');
  if (at < 0) return null;
  const m = /^[A-Za-z0-9_-]+/.exec(uri.slice(at + 6));
  return m ? m[0] : null;
}

// ---- binary helpers ---------------------------------------------------------

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sniffMime(bytes, kind) {
  const b = bytes;
  if (kind === 'image') {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return 'image/png';
  }
  if (kind === 'audio') {
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'audio/wav';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4';
    return 'audio/mpeg';
  }
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return 'video/mp4';
}

async function blobToPart(blob, kind) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { type: kind, mime_type: blob.type || sniffMime(bytes, kind), data: bytesToBase64(bytes) };
}

/** Clear refusal before any work was done: not charged. */
export function isClearFailure(e) {
  return e instanceof ApiError && e.stage === 'submit' && e.status >= 400 && e.status < 500;
}

const BROKEN_TTL_MS = 14 * 24 * 3600 * 1000;

// ---- client -----------------------------------------------------------------

export class GeminiClient {
  /**
   * request: vault.apiRequest-compatible function.
   * prefs: { get(), set(v) } holding { broken: [{ id, at }] } so refused models are
   * skipped next time.
   */
  constructor(request, { prefs, pollMs = 5000, pollAttempts = 120, sleep } = {}) {
    this.request = request;
    this.prefs = prefs ?? memoryPrefs();
    this.pollMs = pollMs;
    this.pollAttempts = pollAttempts;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.modelIds = [];
    this.models = choose([], this.brokenIds());
  }

  /** Free request: checks the key and reads the model list. */
  async validateKey() {
    const ids = [];
    let token = '';
    for (let page = 0; page < 5; page++) {
      const q = '?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
      const res = await this.request('GET', '/v1beta/models' + q, { stage: 'submit' });
      const obj = await res.json().catch(() => ({}));
      ids.push(...idsFromList(obj));
      token = typeof obj?.nextPageToken === 'string' ? obj.nextPageToken : '';
      if (!token) break;
    }
    this.modelIds = ids;
    this.models = choose(ids, this.brokenIds());
    return this.models;
  }

  /** Refused models, retried again after 14 days (a fixed release may follow). */
  brokenIds(now = Date.now()) {
    return (this.prefs.get().broken ?? [])
      .filter((b) => typeof b?.id === 'string' && now - (b.at ?? 0) < BROKEN_TTL_MS)
      .map((b) => b.id);
  }

  async interact(payload) {
    const res = await this.request('POST', '/v1beta/interactions', { json: payload, stage: 'submit' });
    const obj = await res.json().catch(() => null);
    if (!obj || typeof obj !== 'object') throw new ApiError(null, 'afterSubmit', '応答の形式が正しくありません');
    if (obj.status === 'failed' || obj.status === 'cancelled') {
      throw new ApiError(null, 'afterSubmit', obj?.error?.message || '生成に失敗しました');
    }
    return obj;
  }

  /**
   * Runs a call with the newest model of `family`; if that model is refused
   * outright (not charged) and the checked version then works, remembers the
   * newer one as broken and keeps using the checked version.
   */
  async withModel(family, call) {
    const model = this.models[family];
    try {
      return { ...(await call(model)), model };
    } catch (e) {
      if (isFallback(family, model) || !isClearFailure(e) || ![400, 404].includes(e.status)) throw e;
      const fallback = FAMILIES[family].fallback;
      const result = await call(fallback);
      const p = this.prefs.get();
      const kept = (p.broken ?? []).filter((b) => typeof b?.id === 'string' && b.id !== model);
      this.prefs.set({ ...p, broken: [...kept, { id: model, at: Date.now() }] });
      this.models = { ...this.models, [family]: fallback };
      return { ...result, model: fallback, fellBack: model };
    }
  }

  async fetchMedia(ref, kind) {
    if (ref.data) {
      const bytes = base64ToBytes(ref.data);
      return new Blob([bytes], { type: ref.mime || sniffMime(bytes, kind) });
    }
    const id = fileID(ref.uri);
    if (!id) throw new ApiError(null, 'afterSubmit', 'ファイルの場所が読み取れません');
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      const info = await (await this.request('GET', `/v1beta/files/${id}`, { stage: 'afterSubmit' })).json().catch(() => ({}));
      if (info.state === 'ACTIVE' || info.state === undefined) break;
      if (info.state === 'FAILED') throw new ApiError(null, 'afterSubmit', 'ファイルの処理に失敗しました');
      if (attempt === this.pollAttempts - 1) throw new ApiError(null, 'afterSubmit', 'ファイルの準備が時間内に終わりませんでした');
      await this.sleep(this.pollMs);
    }
    const res = await this.request('GET', `/v1beta/files/${id}:download?alt=media`, { stage: 'afterSubmit' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new Blob([bytes], { type: sniffMime(bytes, kind) });
  }

  /** Structured text. audio: optional Blob the model listens to. */
  async generateJSON({ prompt, schema, audio }) {
    let input = prompt;
    if (audio) input = [await blobToPart(audio, 'audio'), { type: 'text', text: prompt }];
    const r = await this.interact({
      model: TEXT_MODEL,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
    });
    const text = texts(r).join('');
    if (!text) throw new ApiError(null, 'afterSubmit', '応答に文章が含まれていません');
    return { text, usage: r.usage ?? null, model: TEXT_MODEL };
  }

  async generateImage({ prompt, references = [], aspect }) {
    const refs = await Promise.all(references.map((b) => blobToPart(b, 'image')));
    return this.withModel('image', async (model) => {
      const r = await this.interact({
        model,
        input: [...refs, { type: 'text', text: prompt }],
        response_format: { type: 'image', aspect_ratio: aspect, image_size: '1K' },
      });
      const ref = media(r, 'image')[0];
      if (!ref) throw new ApiError(null, 'afterSubmit', '応答に画像が含まれていません');
      return { blob: await this.fetchMedia(ref, 'image'), usage: r.usage ?? null };
    });
  }

  async generateMusic({ prompt }) {
    return this.withModel('music', async (model) => {
      const r = await this.interact({ model, input: prompt, response_format: { type: 'audio' } });
      const ref = media(r, 'audio')[0];
      if (!ref) throw new ApiError(null, 'afterSubmit', '応答に音声が含まれていません');
      return { blob: await this.fetchMedia(ref, 'audio'), text: texts(r).join('\n'), usage: r.usage ?? null };
    });
  }

  async generateVideo({ prompt, references = [], aspect }) {
    const refs = await Promise.all(references.slice(0, 7).map((b) => blobToPart(b, 'image')));
    return this.withModel('video', async (model) => {
      const r = await this.interact({
        model,
        input: refs.length ? [...refs, { type: 'text', text: prompt }] : prompt,
        response_format: { type: 'video', aspect_ratio: aspect, resolution: '720p', delivery: 'uri' },
      });
      const ref = media(r, 'video')[0];
      if (!ref) throw new ApiError(null, 'afterSubmit', '応答に動画が含まれていません');
      return { blob: await this.fetchMedia(ref, 'video'), usage: r.usage ?? null };
    });
  }
}

function memoryPrefs() {
  let v = {};
  return { get: () => v, set: (n) => { v = n; } };
}

/** Japanese explanation of an error for beginners. */
export function explainError(e) {
  if (e?.name === 'BudgetExceeded' || !(e instanceof ApiError)) return { head: redact(e?.message || 'エラーが起きました。'), detail: '' };
  const lower = String(e.apiMessage).toLowerCase();
  let head;
  if (lower.includes('api_key_invalid') || lower.includes('api key not valid')) head = 'API キーが正しくありません。キーを入れ直してください。';
  else if (e.status === 402 || /billing|prepay|credit/.test(lower)) head = 'Gemini API の支払い設定が必要です。Google AI Studio で支払い設定（またはクレジットの追加）をしてください。';
  else if (e.status === 429) head = 'Google 側の回数の上限に達しました。時間をおいてやり直してください（動画は 1 日に作れる本数に上限があり、日本時間の午前 9 時ごろに回復します）。';
  else if (e.status === 403) head = 'このキーでは使えない機能です（権限か地域の制限）。';
  else if (e.status >= 500) head = 'Google 側で一時的なエラーが起きました。少し待ってやり直してください。';
  else if (e.status === null) head = '通信に失敗しました。インターネット接続を確かめてやり直してください。';
  else head = 'Gemini API でエラーが起きました。';
  if (e.status) head += `（HTTP ${e.status}）`;
  return { head, detail: String(e.apiMessage || '').slice(0, 600) };
}
