// Owns the Gemini API key. The key never leaves this module: the rest of the
// app calls apiRequest(), which only talks HTTPS to the Gemini API origin and
// sends the key in a header (never in a URL).
//
// Storage:
// - default: memory only (gone when the tab is closed or reloaded)
// - "remember": encrypted with AES-GCM under a non-extractable CryptoKey kept
//   in IndexedDB. The raw key bytes of the CryptoKey can't be read by script,
//   and the API key is never written to localStorage or anywhere in plain text.

export const API_ORIGIN = 'https://generativelanguage.googleapis.com';

let apiKey = null;
let remembered = false;
let storage = null;
let fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null;
let subtle = globalThis.crypto?.subtle ?? null;

/** For tests: replace storage / fetch. */
export function _configure({ storage: s, fetch: f, subtle: c } = {}) {
  if (s !== undefined) storage = s;
  if (f !== undefined) fetchImpl = f;
  if (c !== undefined) subtle = c;
}

/** Cleans up pasted text and checks it looks like an API key. */
export function normalizeKey(input) {
  const key = String(input ?? '').replace(/[\s​-‍﻿]/g, '');
  if (!key) return { ok: false, reason: 'API キーを貼り付けてください。' };
  if (!/^[\x21-\x7E]+$/.test(key)) return { ok: false, reason: 'API キーに使えない文字が含まれています。コピーし直してください。' };
  if (key.length < 20 || key.length > 200) return { ok: false, reason: 'API キーの長さが正しくありません。全部コピーできているか確かめてください。' };
  return { ok: true, key };
}

export function hasKey() { return apiKey !== null; }
export function isRemembered() { return remembered; }

/** Last 4 characters only, for "the key ending in …" display. */
export function keyHint() { return apiKey ? apiKey.slice(-4) : ''; }

/** Removes any occurrence of the key from a text before it is shown. */
export function redact(text) {
  let s = String(text ?? '');
  if (apiKey) s = s.split(apiKey).join('［キー］');
  // Anything that looks like a Google API key, just in case.
  return s.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '［キー］');
}

/**
 * Sets the key. With remember=true it is also encrypted and saved on this
 * device; otherwise any saved copy is deleted.
 */
export async function setKey(input, { remember = false } = {}) {
  const n = normalizeKey(input);
  if (!n.ok) throw new Error(n.reason);
  apiKey = n.key;
  remembered = false;
  if (remember) {
    await saveEncrypted(n.key);
    remembered = true;
  } else {
    await clearSaved();
  }
}

/** Forgets the key in memory and on this device. */
export async function forgetKey() {
  apiKey = null;
  remembered = false;
  await clearSaved();
}

/** Loads a key saved with remember=true. Returns true if one was found. */
export async function loadRememberedKey() {
  const st = storage ?? (await defaultStorage());
  if (!st || !subtle) return false;
  try {
    const rec = await st.get('apiKey');
    if (!rec?.cryptoKey || !rec?.iv || !rec?.data) return false;
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, rec.cryptoKey, rec.data);
    const n = normalizeKey(new TextDecoder().decode(plain));
    if (!n.ok) return false;
    apiKey = n.key;
    remembered = true;
    return true;
  } catch {
    return false;
  }
}

async function saveEncrypted(key) {
  const st = storage ?? (await defaultStorage());
  if (!st || !subtle) throw new Error('このブラウザではキーを保存できません。「このタブを閉じるまで」を選んでください。');
  const cryptoKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(key));
  await st.set('apiKey', { cryptoKey, iv, data });
}

async function clearSaved() {
  const st = storage ?? (await defaultStorage());
  if (st) { try { await st.del('apiKey'); } catch { /* nothing saved */ } }
}

/** Error carrying the HTTP status and the API's (redacted) message. */
export class ApiError extends Error {
  constructor(status, stage, apiMessage) {
    super(apiMessage);
    this.status = status; // null when the request never got a response
    this.stage = stage; // 'submit' or 'afterSubmit'
    this.apiMessage = apiMessage;
  }
}

/**
 * Sends one request to the Gemini API with the key.
 * path: e.g. "/v1beta/interactions". Returns the Response (status 2xx) or
 * throws ApiError.
 */
export async function apiRequest(method, path, { json, stage = 'submit', signal } = {}) {
  if (!apiKey) throw new ApiError(null, stage, 'API キーが設定されていません。');
  if (!['GET', 'POST'].includes(method)) throw new ApiError(null, stage, '許可されていない操作です。');
  if (typeof path !== 'string' || !path.startsWith('/v1beta/') || path.includes('//') || /[@\\\s]/.test(path) || /[?&]key=/i.test(path)) {
    throw new ApiError(null, stage, '許可されていない通信先です。');
  }
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN) throw new ApiError(null, stage, '許可されていない通信先です。');
  const headers = { 'x-goog-api-key': apiKey };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetchImpl(url.href, {
      method,
      headers,
      body,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error', // never re-send the key header somewhere else
      referrerPolicy: 'strict-origin', // lets a "website" key restriction work; no path is sent
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(null, stage, redact(e?.message || '通信に失敗しました'));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, stage, redact(errorMessage(text)));
  }
  return res;
}

function errorMessage(text) {
  try {
    const obj = JSON.parse(text);
    if (obj?.error) return [obj.error.status, obj.error.message].filter(Boolean).join(': ');
    if (obj?.message) return obj.message;
  } catch { /* not JSON */ }
  return String(text).slice(0, 1000);
}

// IndexedDB storage for the encrypted key. Kept in its own database so
// project data and the key never share a store.
let dbPromise = null;
async function defaultStorage() {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('mvmaker-key', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  const db = await dbPromise;
  if (!db) return null;
  const run = (mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const r = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    del: (k) => run('readwrite', (s) => s.delete(k)),
  };
}
