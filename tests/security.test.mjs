// The API key must only ever go to the Gemini API origin, in a header.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../js/vault.js';

// Not shaped like a real Google key, so secret scanners don't flag the repo.
const KEY = 'TEST-KEY-not-a-real-key-0123456789abcd';
let calls;
function fakeFetch(responder = () => new Response('{}', { status: 200 })) {
  return async (url, opts) => { calls.push({ url, opts }); return responder(url, opts); };
}
function memStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
}

beforeEach(async () => {
  calls = [];
  V._configure({ storage: memStorage(), fetch: fakeFetch() });
  await V.forgetKey();
});

test('normalizeKey strips spaces and rejects junk', () => {
  assert.equal(V.normalizeKey(`  ${KEY}\n`).key, KEY);
  assert.equal(V.normalizeKey('').ok, false);
  assert.equal(V.normalizeKey('短い').ok, false);
  assert.equal(V.normalizeKey('abc').ok, false);
});

test('key is sent only as a header to the Gemini origin, with safe fetch options', async () => {
  await V.setKey(KEY);
  await V.apiRequest('POST', '/v1beta/interactions', { json: { a: 1 } });
  const { url, opts } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.ok(!url.includes(KEY));
  assert.equal(opts.headers['x-goog-api-key'], KEY);
  assert.equal(opts.redirect, 'error');
  assert.equal(opts.credentials, 'omit');
  assert.equal(opts.cache, 'no-store');
  assert.equal(opts.referrerPolicy, 'strict-origin');
  assert.ok(!opts.body.includes(KEY));
});

test('requests to anything but the Gemini API paths are refused', async () => {
  await V.setKey(KEY);
  const bad = ['https://evil.example/v1beta/x', '//evil.example/v1beta/x', '/v1beta//evil.example', '/v1/x', '/v1beta/x?key=abc',
    '/v1beta/@evil.example', '/v1beta/\\evil', 'v1beta/x', '/v1beta/a b'];
  for (const p of bad) {
    await assert.rejects(V.apiRequest('GET', p), V.ApiError, p);
  }
  await assert.rejects(V.apiRequest('DELETE', '/v1beta/files/x'), V.ApiError);
  assert.equal(calls.length, 0);
});

test('without a key nothing is sent', async () => {
  await assert.rejects(V.apiRequest('GET', '/v1beta/models'), V.ApiError);
  assert.equal(calls.length, 0);
});

test('error messages never contain the key', async () => {
  V._configure({ fetch: fakeFetch(() => new Response(JSON.stringify({ error: { status: 'INVALID', message: `bad key ${KEY} AIzaOTHERKEY12345678901234567890` } }), { status: 400 })) });
  await V.setKey(KEY);
  try {
    await V.apiRequest('GET', '/v1beta/models');
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.ok(!e.message.includes(KEY));
    assert.ok(!e.message.includes('AIzaOTHERKEY'));
    assert.match(e.message, /［キー］/);
  }
  V._configure({ fetch: async () => { throw new TypeError(`network ${KEY}`); } });
  await assert.rejects(V.apiRequest('GET', '/v1beta/models'), (e) => !e.message.includes(KEY) && e.status === null);
});

test('remember=false stores nothing; remember=true stores only ciphertext', async () => {
  const st = memStorage();
  V._configure({ storage: st });
  await V.setKey(KEY, { remember: false });
  assert.equal(st.m.size, 0);
  await V.setKey(KEY, { remember: true });
  const rec = st.m.get('apiKey');
  assert.ok(rec.data instanceof ArrayBuffer);
  assert.ok(!Buffer.from(rec.data).toString('latin1').includes(KEY));
  assert.equal(rec.cryptoKey.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', rec.cryptoKey));
  // A new page load can read it back.
  await V.forgetKey();
  assert.equal(st.m.size, 0);
  await V.setKey(KEY, { remember: true });
  const saved = st.m.get('apiKey');
  V._configure({ storage: { get: async () => saved, set: async () => {}, del: async () => {} } });
  assert.equal(await V.loadRememberedKey(), true);
  assert.equal(V.keyHint(), KEY.slice(-4));
  // Choosing "not remember" later deletes the saved copy.
  V._configure({ storage: st });
  await V.setKey(KEY, { remember: false });
  assert.equal(st.m.size, 0);
});
