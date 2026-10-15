// Screens. All DOM is built with createElement/textContent (never innerHTML),
// which the page's Trusted Types policy also enforces.

import * as V from './vault.js';
import { GeminiClient, explainError } from './gemini.js';
import { DemoGemini } from './demo.js';
import { openStore } from './store.js';
import { Runner, newProject, currentStep, MAX_BUDGET_USD } from './runner.js';
import * as P from './pricing.js';
import { probeDuration, assemble, canExport, extensionFor } from './media.js';
import { TEXT_MODEL } from './models.js';
import { mmss } from './director.js';
import { sanitizeTable } from './price-parser.js';

/**
 * Loads prices read from Google's official pricing page: first the live
 * reading (/api/prices on Vercel, refreshed daily), then the bundled
 * snapshot (prices.json). Without either, the built-in table is used.
 */
async function loadPrices() {
  for (const url of ['/api/prices', 'prices.json']) {
    try {
      const res = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const doc = await res.json();
      const table = sanitizeTable(doc);
      if (!Object.keys(table).length) continue;
      const at = Date.parse(doc.checkedAt);
      P.setOfficialPrices(table, { source: url === 'prices.json' ? 'snapshot' : 'live', checkedAt: Number.isFinite(at) ? at : null });
      return;
    } catch { /* try the next one */ }
  }
}

const root = document.getElementById('app');

const S = {
  mode: null, // 'real' | 'demo'
  gemini: null,
  store: null,
  view: 'loading', // loading | welcome | home | new | project
  runner: null,
  viewStep: null,
  error: null,
  keyError: null,
  checking: false,
  remember: false,
  projects: [],
  form: null,
  busySince: 0,
  drafts: {}, // text typed into the "how to change it" boxes, by box id
};

// ---- DOM helper -------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'muted' || k === 'controls' || k === 'loop' || k === 'playsInline') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const extLink = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

// ---- small helpers ------------------------------------------------------------

const prefs = {
  get() { try { return JSON.parse(localStorage.getItem('mvmaker-model-prefs') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('mvmaker-model-prefs', JSON.stringify(v)); } catch { /* private mode */ } },
};

export function friendlyModel(id) {
  let m;
  if ((m = /^lyria-(.+)$/.exec(id))) return `Lyria ${m[1]}`;
  if ((m = /^gemini-nano-banana-(.+)$/.exec(id))) return `Nano Banana ${m[1]}`;
  if ((m = /^gemini-omni-(.+)-flash$/.exec(id))) return `Gemini Omni ${m[1]} Flash`;
  if ((m = /^gemini-(\d[\d.]*)-flash$/.exec(id))) return `Gemini ${m[1]} Flash`;
  return id;
}

function safeName(s) {
  const t = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60).replace(/^[. ]+|[. ]+$/g, '');
  return t || 'MV';
}

const urlCache = new Map();
async function fileURL(name) {
  if (!name) return null;
  if (urlCache.has(name)) return urlCache.get(name);
  const blob = await S.runner.file(name);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urlCache.set(name, u);
  return u;
}
function clearURLs() { for (const u of urlCache.values()) URL.revokeObjectURL(u); urlCache.clear(); }

const cost = (n, prefix = '約 ') => h('span', { class: 'cost' }, `（${prefix}${P.usd(n)}）`);

function confirmDialog(title, body, okLabel = 'はい', { danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' },
      h('h2', { id: 'dlg-title', text: title }),
      ...[].concat(body).map((t) => h('p', { text: t })),
      h('div', { class: 'actions' },
        h('button', { class: danger ? 'danger' : 'primary', onclick: () => { dlg.close(); dlg.remove(); resolve(true); } }, okLabel),
        h('button', { onclick: () => { dlg.close(); dlg.remove(); resolve(false); } }, 'やめる')));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

async function act(fn) {
  S.error = null;
  S.notice = null;
  render();
  try { await fn(); } catch (e) { S.error = e; console.warn(V.redact(e?.message)); }
  render();
}

// ---- start-up -----------------------------------------------------------------

const LOCAL_HOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

async function boot() {
  if (window.top !== window.self) {
    // Never run inside someone else's frame (clickjacking).
    root.replaceChildren(h('p', { text: 'このページは、ほかのページの中では使えません。' }));
    return;
  }
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    root.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'msg error' }, 'このページは https:// で開いたときだけ使えます。')));
    return;
  }
  window.addEventListener('beforeunload', (e) => {
    if (S.runner?.busy) { e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(() => {
    const el = document.getElementById('elapsed');
    if (el && S.busySince) el.textContent = elapsedText();
  }, 1000);
  if (await V.loadRememberedKey()) {
    S.checking = true;
    S.view = 'welcome';
    render();
    try { await startReal(); return; } catch (e) {
      S.keyError = e;
      S.checking = false;
    }
  }
  S.view = 'welcome';
  render();
}

async function startReal() {
  S.gemini = new GeminiClient(V.apiRequest, { prefs });
  await Promise.all([S.gemini.validateKey(), loadPrices()]);
  S.mode = 'real';
  S.store = openStore('mvmaker-projects');
  S.checking = false;
  S.keyError = null;
  navigator.storage?.persist?.().catch(() => {});
  await goHome();
}

async function startDemo() {
  S.mode = 'demo';
  S.gemini = new DemoGemini();
  await loadPrices();
  S.store = openStore('mvmaker-demo');
  await goHome();
}

async function goHome() {
  if (S.runner?.busy) return;
  clearURLs();
  S.runner = null;
  S.error = null;
  S.projects = await S.store.list();
  S.view = 'home';
  render();
  window.scrollTo(0, 0);
}

async function submitKey(input) {
  const value = input.value;
  input.value = '';
  const n = V.normalizeKey(value);
  if (!n.ok) { S.keyError = new Error(n.reason); render(); return; }
  S.checking = true;
  S.keyError = null;
  render();
  try {
    await V.setKey(n.key, { remember: false });
    await startReal();
    if (S.remember) await V.setKey(n.key, { remember: true });
    render();
  } catch (e) {
    await V.forgetKey();
    S.gemini = null;
    S.checking = false;
    S.keyError = e;
    render();
  }
}

async function leave() {
  if (S.runner?.busy) return;
  if (S.mode === 'real') {
    const ok = await confirmDialog('キーを外しますか？', [
      'このブラウザから API キーを消します。' + (V.isRemembered() ? 'この端末に保存したキーも消えます。' : ''),
      '作った MV は残ります。次に使うときは、もう一度キーを貼り付けてください。',
    ], 'キーを外す');
    if (!ok) return;
    await V.forgetKey();
  }
  clearURLs();
  Object.assign(S, { mode: null, gemini: null, store: null, runner: null, view: 'welcome', error: null, keyError: null, checking: false });
  render();
}

// ---- rendering ------------------------------------------------------------------

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const y = window.scrollY;

  let view;
  if (S.view === 'loading') view = h('div', { class: 'wrap' }, h('p', { class: 'muted', text: '読み込んでいます…' }));
  else if (S.view === 'welcome') view = welcomeView();
  else if (S.view === 'home') view = homeView();
  else if (S.view === 'new') view = newView();
  else view = projectView();

  root.replaceChildren(topBar(), view);

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
    }
  }
  window.scrollTo(0, y);
}

function topBar() {
  const right = [];
  if (S.mode === 'real') {
    right.push(h('span', { class: 'badge', text: `キー ••••${V.keyHint()}` }),
      h('span', { text: V.isRemembered() ? 'この端末に暗号化して保存中' : 'タブを閉じると消えます' }),
      h('button', { class: 'link', onclick: leave, disabled: !!S.runner?.busy }, 'キーを外す'));
  } else if (S.mode === 'demo') {
    right.push(h('span', { class: 'badge demo', text: 'お試しモード（料金なし）' }),
      h('button', { class: 'link', onclick: leave, disabled: !!S.runner?.busy }, 'お試しを終わる'));
  }
  return h('header', { class: 'topbar' }, h('div', { class: 'inner' },
    h('button', { class: 'brand', onclick: () => S.mode && goHome(), 'aria-label': 'MVメーカー（MV の一覧へ）' }, h('img', { src: 'icon.svg', alt: '' }), 'MVメーカー'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'keystate' }, right)));
}

function errorBox(e, onClose) {
  if (!e) return null;
  const { head, detail } = explainError(e);
  return h('div', { class: 'msg error', role: 'alert' },
    h('b', { text: head }),
    detail ? h('details', {}, h('summary', { text: 'くわしい内容' }), h('pre', { text: V.redact(detail) })) : null,
    onClose ? h('div', {}, h('button', { class: 'link', onclick: onClose }, 'このお知らせを閉じる')) : null);
}

// ---- welcome / key --------------------------------------------------------------

function welcomeView() {
  const input = h('input', {
    // type=text + CSS masking: a password field makes browsers offer to save
    // (and sync) the key as a password.
    id: 'key', type: 'text', class: 'masked', autocomplete: 'off', 'data-lpignore': 'true', 'data-1p-ignore': 'true', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'ここに API キーを貼り付け', 'aria-describedby': 'key-hint', disabled: S.checking,
    onkeydown: (e) => { if (e.key === 'Enter') submitKey(input); },
  });
  const choice = (val, title, desc) => h('label', { class: 'choice' + (S.remember === val ? ' on' : '') },
    h('input', { type: 'radio', name: 'remember', checked: S.remember === val, onchange: (e) => {
      // No re-render here: that would clear the key field.
      S.remember = val;
      for (const c of document.querySelectorAll('.choice')) c.classList.toggle('on', c.contains(e.target));
    } }),
    h('span', {}, h('b', { text: title }), h('span', { class: 'small muted', text: desc })));

  return h('main', { class: 'wrap' },
    h('h1', { text: 'テーマを書くだけで、ミュージックビデオができます' }),
    h('p', { class: 'lead', text: 'Google の AI が歌詞を考え、曲を作り、キャラクターと映像を描いて、歌詞の字幕付きの MV に仕上げます。むずかしい操作はありません。画面の案内に沿って進めるだけです。' }),

    h('section', { class: 'card' },
      h('h2', { text: 'はじめに：Google の API キーを用意します' }),
      h('p', { text: 'API キーは、このページがあなたの Google アカウントで AI を使うための「鍵」です。料金は Google からあなたに直接請求されます。' }),
      h('ol', { class: 'steps' },
        h('li', {}, extLink('https://aistudio.google.com/apikey', 'Google AI Studio の「API キー」の画面'), 'を開き、Google アカウントでログインします。'),
        h('li', { text: '「API キーを作成」を押し、表示されたキーをコピーします。' }),
        h('li', {}, '曲・画像・動画を作るには支払いの設定が必要です。', extLink('https://aistudio.google.com/projects', 'プロジェクトの画面'), 'で支払い（クレジットカード）を設定してください。'),
        h('li', { text: '下の欄にキーを貼り付けて「キーを確認して始める」を押します。' })),
      h('p', { class: 'small muted', text: '料金の目安：60 秒の MV 1 本で、作り直しなしなら約 7 ドル、作り直しを含めて 10 ドル前後です（いちばん大きいのは動画で、1 秒あたり約 0.10 ドル）。' })),

    h('section', { class: 'card' },
      h('label', { class: 'field', for: 'key', text: 'API キー' }),
      h('div', { class: 'keyrow' }, input,
        h('button', { class: 'primary', onclick: () => submitKey(input), disabled: S.checking }, S.checking ? '確認しています…' : 'キーを確認して始める')),
      h('p', { id: 'key-hint', class: 'hint', text: 'キーは画面に表示されません。確認には料金のかからない問い合わせを使います。' }),
      S.keyError ? errorBox(S.keyError) : null,
      h('p', { class: 'field', text: 'キーをどこまで覚えておくか' }),
      choice(false, 'このタブを閉じるまで（おすすめ）', 'タブを閉じたり再読み込みしたりすると、キーは消えます。次に使うときにもう一度貼り付けます。'),
      LOCAL_HOST
        ? h('p', { class: 'hint', text: '（確認用の環境では、ほかのアプリと保存場所を共有するため「このパソコンに保存する」は選べません。）' })
        : choice(true, 'このパソコンに保存する', '次回から貼り付けなくて済みます。ただし、このパソコンでこのページを開けば、誰でもあなたのキーで AI を使える状態になります。自分だけが使うパソコンのときだけ選んでください。「キーを外す」でいつでも消せます。')),

    h('section', { class: 'card soft' },
      h('h2', { text: 'お金をかけずに試したいとき' }),
      h('p', { text: 'お試しモードでは AI を使わず、仮の歌詞・絵・音で、MV ができるまでの流れを最後まで体験できます。キーも料金も不要です。' }),
      h('button', { onclick: () => act(startDemo), disabled: S.checking }, 'お試しモードで始める')),

    safetyCard(),
    h('p', { class: 'footer', text: 'このページは、あなたのブラウザの中だけで動きます。作った MV もこのブラウザの中に保存され、どこにも送られません（AI に作ってもらうための内容だけを Google に送ります）。' }));
}

function safetyCard() {
  return h('details', { class: 'card' },
    h('summary', { text: 'API キーの安全について（くわしく）' }),
    h('ul', {},
      h('li', { text: 'キーは Google（generativelanguage.googleapis.com）にだけ、暗号化された通信で直接送ります。このページの作者のサーバーはなく、キーが送られる先はほかにありません。' }),
      h('li', { text: 'ページには外部のプログラム・広告・アクセス解析を一切読み込みません。ブラウザの安全機能で、Google 以外への通信と外部のプログラムの実行を禁止しています。' }),
      h('li', { text: 'キーは画面・アドレス欄・エラーの表示に出しません（末尾の 4 文字だけを表示します）。' }),
      h('li', { text: '「このパソコンに保存」を選んだときだけ、キーを暗号化してこのブラウザの中に保存します。選ばなければ、タブを閉じると消えます。暗号化は、パソコンのファイルを直接のぞかれたときの備えです。このパソコンでこのページを開いた人は誰でもキーを使えるので、共用のパソコンでは保存しないでください。' }),
      h('li', { text: 'キーをコピーすると、クリップボードの履歴を残すアプリにキーが残ることがあります。貼り付けたあとは、その履歴から消しておくと安心です。' })),
    h('p', { class: 'field', text: 'さらに安全にするために（おすすめ）' }),
    h('ul', {},
      h('li', { text: 'この MV メーカー専用のキーを作り、ほかの用途と分けてください。' }),
      h('li', {}, extLink('https://console.cloud.google.com/apis/credentials', 'Google Cloud の「認証情報」'), 'でキーを選び、「API の制限」を Generative Language API だけにしてください。'),
      LOCAL_HOST ? null : h('li', { text: `同じ画面の「アプリケーションの制限」で「ウェブサイト」を選び、${location.origin}/* を追加すると、このページ以外からはキーを使えなくなります（ほかのアプリでは使えなくなるので、専用のキーで行ってください）。` }),
      h('li', {}, extLink('https://console.cloud.google.com/billing/budgets', 'Google Cloud の「予算とアラート」'), 'で、使いすぎたときにメールが届くように設定してください。'),
      h('li', { text: 'キーを他人に教えたり、メールや SNS に貼ったりしないでください。漏れたかもしれないときは、Google AI Studio でそのキーを削除して作り直してください。' }),
      h('li', { text: 'ほかの人と共用のパソコンでは「このタブを閉じるまで」を選び、使い終わったら「キーを外す」を押してください。' })));
}

// ---- home -------------------------------------------------------------------------

function stepLabel(p) {
  const n = currentStep(p);
  const names = ['歌詞', '曲', 'キャラクター', '映像', '完成'];
  if (n === 5 && p.exportFile) return '完成しました';
  return `ステップ ${n}/5：${names[n - 1]}`;
}

function homeView() {
  const g = S.gemini;
  const list = S.projects.map((p) => h('div', { class: 'card mvitem' },
    h('div', { class: 'info' },
      h('div', { class: 'title', text: p.plan?.title || p.theme }),
      h('div', { class: 'small muted', text: `${new Date(p.createdAt).toLocaleDateString('ja-JP')} ・ ${p.durationSeconds} 秒 ・ ${p.aspect === '9:16' ? '縦長' : '横長'} ・ 使った金額 ${P.usd(P.spent(p))}` }),
      h('div', { class: 'small', text: stepLabel(p) })),
    h('button', { class: 'primary', onclick: () => openProject(p) }, '開く'),
    h('button', { class: 'danger', onclick: () => deleteProject(p) }, '削除')));

  return h('main', { class: 'wrap' },
    S.mode === 'demo' ? h('div', { class: 'msg warn', text: 'お試しモードです。AI は使わず、仮の歌詞・絵・音で流れを体験できます。料金はかかりません。ここで作ったものは本番とは別に保存されます。' }) : null,
    h('h1', { text: 'あなたの MV' }),
    h('button', { class: 'primary big', onclick: openNewForm }, '＋ 新しい MV を作る'),
    errorBox(S.error, () => { S.error = null; render(); }),
    S.projects.length ? h('div', { class: 'mvlist' }, list) : h('div', { class: 'card soft', text: 'まだ MV はありません。上の「新しい MV を作る」から始めましょう。' }),
    h('section', { class: 'card' },
      h('h2', { text: '使う AI' }),
      h('ul', {},
        h('li', { text: `歌詞と絵コンテ：${friendlyModel(TEXT_MODEL)}` }),
        h('li', { text: `曲：${friendlyModel(g.models.music)}` }),
        h('li', { text: `キャラクターと画風：${friendlyModel(g.models.image)}` }),
        h('li', { text: `映像：${friendlyModel(g.models.video)}` })),
      h('p', { class: 'small muted', text: '曲・画像・映像の AI は、Google から新しい版が出ると自動で最新版を使います。新しい版を Google に断られたときは、このページが基準にしている版（Lyria 3.5・Nano Banana 2.1・Omni 1.1 Flash）に自動で戻します。' }),
      priceInfoLine(),
      assumedNotice(['music', 'image', 'video'].map((k) => g.models[k]))),
    safetyCard());
}

async function deleteProject(p) {
  const ok = await confirmDialog(`「${p.plan?.title || p.theme}」を削除しますか？`, ['作った曲・画像・動画も、このブラウザから消えます。元に戻せません（書き出してダウンロードした MV は消えません）。'], '削除する', { danger: true });
  if (!ok) return;
  await S.store.remove(p.id);
  await goHome();
}

// ---- new MV form --------------------------------------------------------------------

const MOODS = ['おまかせ', '明るく元気なポップ', 'ノリのいい EDM', '疾走感のあるロック', 'しっとりしたバラード', 'ゆったりした lo-fi', 'アニメの主題歌風', 'かっこいいヒップホップ'];
const EXAMPLES = ['夏の海で始まる恋', 'ふるさとの町のいいところ', '受験をがんばる友だちへの応援歌', 'ねこと過ごすのんびりした休日', '新しいことに挑戦する春'];

function openNewForm() {
  S.form = { theme: '', mood: 'おまかせ', vocal: 'female', duration: 60, aspect: '16:9', budget: null, error: null };
  S.view = 'new';
  render();
  window.scrollTo(0, 0);
}

function suggestedBudget(duration) {
  return Math.ceil(P.roughTotal(duration, S.gemini.models) * 2);
}

function newView() {
  const f = S.form;
  const rough = P.roughTotal(f.duration, S.gemini.models);
  const budget = f.budget ?? suggestedBudget(f.duration);
  const tile = (key, val, title, desc, shape) => h('button', {
    class: 'tile' + (f[key] === val ? ' on' : ''), 'aria-pressed': String(f[key] === val), type: 'button',
    onclick: () => { f[key] = val; render(); },
  }, shape, h('span', { text: title }), desc ? h('span', { class: 'small muted', text: desc }) : null);
  const shapeEl = (w, hh) => { const d = h('div', { class: 'shape' }); d.style.width = w + 'px'; d.style.height = hh + 'px'; return d; };

  return h('main', { class: 'wrap' },
    h('h1', { text: '新しい MV を作る' }),
    h('p', { class: 'lead', text: 'どんな MV にしたいかを教えてください。あとから歌詞を書き換えることもできます。' }),
    h('section', { class: 'card' },
      h('label', { class: 'field', for: 'f-theme', text: 'テーマ（何についての歌？）' }),
      h('textarea', { id: 'f-theme', rows: 3, maxlength: 400, placeholder: '例：夏の海で始まる恋。ふたりで見た夕焼けが忘れられない。', value: f.theme, oninput: (e) => { f.theme = e.target.value; } }),
      h('div', { class: 'chips', 'aria-label': 'テーマの例' }, h('span', { class: 'small muted', text: '例を使う：' }),
        EXAMPLES.map((x) => h('button', { type: 'button', onclick: () => { f.theme = x; render(); } }, x))),

      h('label', { class: 'field', for: 'f-mood', text: '曲の雰囲気' }),
      h('select', { id: 'f-mood', onchange: (e) => { f.mood = e.target.value; } }, MOODS.map((m) => h('option', { value: m, selected: f.mood === m, text: m }))),

      h('p', { class: 'field', text: '歌う人の声' }),
      h('div', { class: 'tiles' },
        tile('vocal', 'female', '女性の声', null, null),
        tile('vocal', 'male', '男性の声', null, null)),

      h('label', { class: 'field', for: 'f-dur' }, 'MV の長さ：', h('span', { class: 'rangeval', text: `${f.duration} 秒` })),
      h('input', { id: 'f-dur', type: 'range', min: 30, max: 90, step: 10, value: f.duration, oninput: (e) => { f.duration = Number(e.target.value); if (f.budgetTouched !== true) f.budget = null; render(); } }),
      h('p', { class: 'hint', text: '長いほど場面の数が増え、料金と時間がかかります。はじめては 30〜60 秒がおすすめです。' }),

      h('p', { class: 'field', text: '画面の向き' }),
      h('div', { class: 'tiles' },
        tile('aspect', '16:9', '横長（16:9）', 'パソコン・YouTube 向け', shapeEl(64, 36)),
        tile('aspect', '9:16', '縦長（9:16）', 'スマホ・TikTok・リール向け', shapeEl(27, 48))),

      h('label', { class: 'field', for: 'f-budget', text: '使ってよい金額の上限（ドル）' }),
      h('input', { id: 'f-budget', type: 'number', min: 1, max: 500, step: 1, value: budget, oninput: (e) => { f.budget = Number(e.target.value); f.budgetTouched = true; } }),
      h('p', { class: 'hint', text: `目安は作り直しなしで約 ${P.usd(rough)} です。このページの見積もりで上限に届きそうになると、自動で止まります（あとから変えられます。最大 $500）。実際の請求額は Google AI Studio で確かめられます。` }),
      assumedNotice([S.gemini.models.music, S.gemini.models.image, S.gemini.models.video]),
      S.mode === 'demo' ? h('p', { class: 'hint', text: 'お試しモードでは実際には料金はかかりません。' }) : null,

      f.error ? h('div', { class: 'msg error', role: 'alert', text: f.error }) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'primary big', onclick: createProject }, '歌詞づくりから始める', cost(P.TEXT_ESTIMATE)),
        h('button', { onclick: goHome }, '戻る'))));
}

async function createProject() {
  const f = S.form;
  if (!f.theme.trim()) { f.error = 'テーマを入力してください（例のボタンを押しても入ります）。'; render(); document.getElementById('f-theme')?.focus(); return; }
  const budget = f.budget ?? suggestedBudget(f.duration);
  if (!(budget >= 1 && budget <= MAX_BUDGET_USD)) { f.error = `上限の金額は 1〜${MAX_BUDGET_USD} ドルで入力してください。`; render(); return; }
  const p = newProject({
    theme: f.theme.trim().slice(0, 400), mood: f.mood === 'おまかせ' ? '' : f.mood, vocal: f.vocal,
    durationSeconds: f.duration, aspect: f.aspect, budgetUSD: budget, demo: S.mode === 'demo',
  });
  await S.store.save(p);
  openProject(p);
  await act(() => S.runner.makePlan());
}

// ---- project ------------------------------------------------------------------------

function openProject(p) {
  clearURLs();
  S.runner = new Runner(p, {
    gemini: S.gemini,
    store: S.store,
    probeDuration,
    assemble,
    onChange: (_p, busy) => {
      if (busy && !S.busySince) S.busySince = Date.now();
      if (!busy) S.busySince = 0;
      scheduleRender();
    },
  });
  S.view = 'project';
  S.viewStep = null;
  S.error = null;
  render();
  window.scrollTo(0, 0);
}

function elapsedText() {
  const s = Math.floor((Date.now() - S.busySince) / 1000);
  return `経過 ${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

const STEP_NAMES = ['歌詞', '曲', 'キャラクター', '映像', '完成'];

function projectView() {
  const r = S.runner;
  const p = r.project;
  const step = currentStep(p);
  if (S.viewStep && S.viewStep > step) S.viewStep = null;
  const view = S.viewStep ?? step;

  const bar = h('ol', { class: 'stepbar', 'aria-label': '進み具合' }, STEP_NAMES.map((name, i) => {
    const n = i + 1;
    const cls = n === view ? 'now' : n < step || (n === 5 && p.exportFile) ? 'done' : n === step ? '' : 'later';
    return h('li', { class: cls }, h('button', {
      disabled: n > step, 'aria-current': n === view ? 'step' : null,
      onclick: () => { S.viewStep = n === step ? null : n; S.error = null; render(); },
    }, h('span', { class: 'num', text: n < step ? `${n} ✓` : `ステップ ${n}` }), h('span', { text: name })));
  }));

  const panels = [panelLyrics, panelSong, panelStyle, panelScenes, panelExport];
  return h('main', { class: 'wrap' },
    h('div', { class: 'actions' }, h('button', { class: 'link', onclick: goHome, disabled: !!r.busy }, '← MV の一覧へ')),
    h('h1', { text: p.plan?.title || p.theme }),
    h('p', { class: 'muted small', text: `テーマ：${p.theme} ・ ${p.durationSeconds} 秒 ・ ${p.aspect === '9:16' ? '縦長' : '横長'} ・ ${p.vocal === 'male' ? '男性' : '女性'}の声` }),
    bar,
    r.busy ? busyBox(r) : null,
    errorBox(S.error, () => { S.error = null; render(); }),
    S.notice ? h('div', { class: 'msg info', role: 'status' }, S.notice, h('div', {}, h('button', { class: 'link', onclick: () => { S.notice = null; render(); } }, 'このお知らせを閉じる'))) : null,
    panels[view - 1](r, p),
    moneyCard(r, p));
}

function busyBox(r) {
  const prog = r.progress;
  const fill = h('div');
  if (prog) fill.style.width = `${Math.round((prog.done / prog.total) * 100)}%`;
  return h('div', { class: 'card busy', role: 'status' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('div', { style: null },
      h('b', { text: r.busy }),
      h('div', { class: 'small muted' }, h('span', { id: 'elapsed', text: S.busySince ? elapsedText() : '' }), ' ・ この画面を開いたままお待ちください'),
      prog ? h('div', { class: 'bar' }, fill) : null));
}

/**
 * "How should it change?" box: a text area and a button. The typed text
 * survives re-renders (S.drafts) and is cleared once the work succeeds.
 */
function requestBox({ id, label, placeholder, button, price, busy, onSubmit, note, optional = false }) {
  const box = h('textarea', {
    id, rows: 2, maxlength: 1000, placeholder, value: S.drafts[id] ?? '', disabled: busy,
    oninput: (e) => { S.drafts[id] = e.target.value; },
  });
  const go = async () => {
    const text = (S.drafts[id] ?? '').trim();
    if (!text && !optional) { S.error = new Error('どう直したいかを、上の欄に書いてください。'); render(); document.getElementById(id)?.focus(); return; }
    let ok = false;
    // onSubmit returns false when the user cancels; the text is kept then.
    await act(async () => { ok = (await onSubmit(text)) !== false; });
    if (ok) { delete S.drafts[id]; render(); }
  };
  return h('div', { class: 'request' },
    h('label', { class: 'field', for: id, text: label }),
    box,
    note ? h('p', { class: 'hint', text: note }) : null,
    h('div', { class: 'actions' }, h('button', { class: optional ? 'primary' : null, disabled: busy, onclick: go }, button, price === undefined ? null : cost(price))));
}

/** Translation of a non-ASCII request costs one small text call. */
const withTranslation = (n, id) => n + (/^[\x00-\x7F]*$/.test(S.drafts[id] ?? '') ? 0 : P.TEXT_ESTIMATE);

function panelLyrics(r, p) {
  const busy = !!r.busy;
  if (!p.plan) {
    return h('section', { class: 'card' },
      h('h2', { text: 'ステップ 1：歌詞と絵コンテ' }),
      busy ? h('p', { text: 'AI が歌詞と、場面ごとの映像の流れ（絵コンテ）を考えています。30 秒ほどお待ちください。' })
        : h('div', {}, h('p', { text: '歌詞と映像の流れを AI に考えてもらいます。' }),
          h('button', { class: 'primary big', onclick: () => act(() => r.makePlan()) }, '歌詞を作る', cost(P.TEXT_ESTIMATE))));
  }
  const locked = !!p.song;
  const sections = p.plan.sections.map((sec, i) => h('div', { class: 'section-edit' },
    h('label', { class: 'name', for: `sec-${i}`, text: `${sec.name || 'パート'}（${mmss(sec.start)}〜${mmss(sec.end)}）` }),
    sec.lines.length || !locked
      ? h('textarea', { id: `sec-${i}`, rows: Math.max(2, sec.lines.length + 1), value: sec.lines.join('\n'), disabled: locked || busy, placeholder: '（歌のない部分）', onchange: (e) => act(() => r.editLyrics(i, e.target.value)) })
      : h('p', { class: 'muted small', text: '（歌のない部分）' })));
  const request = h('textarea', { id: 'replan', rows: 2, placeholder: '例：もっと明るい歌詞に。サビに「ありがとう」を入れて。' });
  return h('section', { class: 'card' },
    h('h2', { text: 'ステップ 1：歌詞を確かめましょう' }),
    locked
      ? h('div', { class: 'msg info', text: '曲ができたので、歌詞は変えられません。歌詞を直すときは、ステップ 2 の「歌詞に戻る」を押してください。' })
      : h('p', { text: 'AI が考えた歌詞です。直したいところは、そのまま書き換えられます（1 行が 1 フレーズです）。' }),
    h('label', { class: 'field', for: 'title' , text: '曲名' }),
    h('input', { id: 'title', type: 'text', value: p.plan.title, maxlength: 60, disabled: locked || busy, onchange: (e) => act(() => r.editTitle(e.target.value)) }),
    sections,
    h('details', {}, h('summary', { text: `映像の流れ（${p.plan.scenes.length} 場面）を見る` }),
      h('ol', {}, p.plan.scenes.map((s) => h('li', { text: `${mmss(s.start)}〜${mmss(s.end)}　${s.summary}` })))),
    !locked ? h('div', { class: 'actions' },
      h('button', { class: 'primary big', disabled: busy, onclick: () => act(async () => { await r.makeSong(); S.viewStep = null; }) }, 'この歌詞で曲を作る', cost(P.musicCost(S.gemini.models.music)))) : null,
    h('div', { class: 'card soft' },
      h('h3', { text: 'AI に直してもらう' }),
      requestBox({
        id: 'revise', busy, price: P.TEXT_ESTIMATE,
        label: 'どう直したいか',
        placeholder: '例：サビに叫ぶような短い言葉を入れて／2 番の歌詞をもっと前向きに／曲名をもっと短く',
        button: 'この指示で歌詞を直す',
        note: locked ? '歌詞が変わるので、曲はもう一度作ることになります。' : 'いまの歌詞をもとに、指示したところだけを直します。',
        onSubmit: async (text) => {
          if (p.song || p.styleImage) {
            const ok = await confirmDialog('歌詞を直しますか？', ['直した歌詞で、曲はもう一度作ることになります。', '場面の内容が変わった場合は、その場面の動画も作り直しになります（変わらなかった場面と絵はそのまま残ります）。'], '直す');
            if (!ok) return false;
          }
          const res = await r.revisePlan(text);
          S.viewStep = null;
          const msgs = ['指示に合わせて直しました。'];
          if (res?.droppedClips) msgs.push(`内容が変わった ${res.droppedClips} 場面は、動画を作り直す必要があります。`);
          if (res?.lookChanged && p.styleImage) msgs.push('主人公や画風の説明も変わりました。いまの絵のままでよいか、ステップ 3 で確かめてください（必要なら「この指示で絵を直す」で直せます）。');
          S.notice = msgs.join('');
        },
      })),
    h('details', { class: 'card soft' },
      h('summary', { text: '歌詞と絵コンテを最初から作り直す' }),
      h('label', { class: 'field', for: 'replan', text: '希望（なくてもかまいません）' }),
      request,
      h('div', { class: 'actions' }, h('button', { disabled: busy, onclick: async () => {
        if (p.song || p.styleImage) {
          const ok = await confirmDialog('最初から作り直しますか？', ['いまの曲・キャラクター・動画は使わなくなり、歌詞から作り直しになります。'], '作り直す');
          if (!ok) return;
        }
        const text = request.value;
        await act(async () => { await r.makePlan(text); S.viewStep = null; });
      } }, '作り直す', cost(P.TEXT_ESTIMATE)))));
}

function panelSong(r, p) {
  const busy = !!r.busy;
  const music = S.gemini.models.music;
  if (!p.song) {
    return h('section', { class: 'card' }, h('h2', { text: 'ステップ 2：曲' }),
      busy ? h('p', { text: '曲を作っています。1〜2 分お待ちください。' })
        : h('button', { class: 'primary big', onclick: () => act(() => r.makeSong()) }, '曲を作る', cost(P.musicCost(music))));
  }
  const audio = h('audio', { controls: true, preload: 'metadata' });
  fileURL(p.song.file).then((u) => { if (u) audio.src = u; });
  return h('section', { class: 'card' },
    h('h2', { text: 'ステップ 2：曲を聴いてみましょう' }),
    h('p', { text: p.songApproved ? 'この曲に決まっています。' : '再生ボタンを押して聴いてください。気に入ったら「この曲に決める」、別の曲にしたければ「もう一度作る」を押します。' }),
    audio,
    p.song.request ? h('p', { class: 'small muted', text: `この曲への指示：${p.song.request}` }) : null,
    !p.songApproved ? h('div', { class: 'actions' },
      h('button', { class: 'primary big', disabled: busy, onclick: () => act(async () => { await r.approveSong(); S.viewStep = null; }) }, 'この曲に決める'),
      h('button', { disabled: busy, onclick: () => act(() => r.makeSong()) }, 'もう一度作る', cost(P.musicCost(music))))
      : h('div', { class: 'actions' }, h('button', { disabled: busy, onclick: () => act(() => r.makeSong()) }, '曲を作り直す', cost(P.musicCost(music)))),
    h('div', { class: 'card soft' },
      requestBox({
        id: 'song-req', busy, price: withTranslation(P.musicCost(music), 'song-req'),
        label: '曲をどう変えたいか',
        placeholder: '例：もっと速く激しく／ギターをもっと歪ませて／歌うより叫ぶように',
        button: 'この指示で曲を作り直す',
        note: '歌詞はそのままで、曲の雰囲気や演奏を指示どおりに変えて作り直します。',
        onSubmit: (text) => r.makeSong(text),
      })),
    h('div', { class: 'actions' }, h('button', { class: 'link', disabled: busy, onclick: async () => {
      const ok = await confirmDialog('歌詞に戻りますか？', ['いまの曲は使わなくなります。歌詞を直してから、もう一度曲を作ります。'], '歌詞に戻る');
      if (ok) await act(async () => { await r.discardSong(); S.viewStep = null; });
    } }, '歌詞を直したいとき：歌詞に戻る')));
}

function panelStyle(r, p) {
  const busy = !!r.busy;
  const img = S.gemini.models.image;
  const two = 2 * P.imageCost(img);
  const pics = [];
  for (const [file, cap] of [[p.styleImage, '画風の見本'], [p.characterImage, 'キャラクター']]) {
    if (!file) continue;
    const el = h('img', { alt: cap });
    fileURL(file).then((u) => { if (u) el.src = u; });
    pics.push(h('figure', {}, el, h('figcaption', { text: cap })));
  }
  const hasClips = p.plan.scenes.some((s) => s.clip);
  const confirmClips = async () => !hasClips || confirmDialog('絵を作り直しますか？', ['すでに作った場面の動画は、新しい絵に合わせて作り直しになります。'], '作り直す');
  const redo = async () => {
    if (!(await confirmClips())) return;
    await act(() => r.makeStyle({ fresh: true }));
  };
  const hasPics = p.styleImage && p.characterImage;
  const notes = p.plan.styleRequestsJa ?? [];
  const styleBox = requestBox({
    id: 'style-req', busy, price: withTranslation(two, 'style-req'), optional: !hasPics,
    label: hasPics ? '絵をどう直したいか' : '絵の希望（なくてもかまいません）',
    placeholder: '例：左の黒い四角を消して／髪を青に／もっとアニメ風の絵に／背景をライブハウスに',
    button: hasPics ? 'この指示で絵を直す' : 'キャラクターと画風を作る',
    note: hasPics ? 'いまの絵をもとに、指示したところだけを直します。指示は、このあと作る場面の動画にも反映されます。' : null,
    onSubmit: async (text) => {
      if (hasPics && !(await confirmClips())) return false;
      await r.makeStyle({ request: text });
    },
  });
  return h('section', { class: 'card' },
    h('h2', { text: 'ステップ 3：キャラクターと画風' }),
    h('p', { text: 'MV の主人公と、絵のタッチを決めます。見本の絵を 2 枚作り、映像はこの絵に合わせて作られます。' }),
    pics.length ? h('div', { class: 'media-row' }, pics) : null,
    notes.length ? h('p', { class: 'small muted', text: `これまでの指示（場面の動画にも反映されます）：${notes.join(' → ')}` }) : null,
    !hasPics
      ? (busy ? null : h('div', { class: 'card soft' }, styleBox))
      : h('div', {},
        !p.styleApproved
          ? h('div', { class: 'actions' },
            h('button', { class: 'primary big', disabled: busy, onclick: () => act(async () => { await r.approveStyle(); S.viewStep = null; }) }, 'この絵で決める'))
          : h('div', { class: 'actions' }, h('span', { class: 'muted', text: 'この絵に決まっています。' })),
        h('div', { class: 'card soft' }, styleBox),
        h('div', { class: 'actions' }, h('button', { class: 'link', disabled: busy, onclick: redo }, 'まったく新しく作り直す（これまでの指示も消えます）', cost(two)))));
}

function panelScenes(r, p) {
  const busy = !!r.busy;
  const video = S.gemini.models.video;
  const per = 10 * (P.videoEstimate(video) / P.VIDEO_MAX_SECONDS); // a typical 10 s clip
  const remaining = r.remainingScenes;
  const cards = p.plan.scenes.map((s, i) => {
    let media;
    if (s.clip) {
      media = h('video', { controls: true, muted: true, loop: true, playsInline: true, preload: 'metadata' });
      fileURL(s.clip).then((u) => { if (u) media.src = u; });
    } else {
      media = h('div', { class: 'ph', text: 'まだ作っていません' });
      media.style.aspectRatio = p.aspect === '9:16' ? '9 / 16' : '16 / 9';
    }
    return h('div', { class: 'scene' },
      h('div', { class: 'head' }, `場面 ${i + 1}`, h('span', { class: 'time', text: `${mmss(s.start)}〜${mmss(s.end)}` })),
      h('div', { class: 'small', text: s.summary }),
      media,
      s.requestJa ? h('div', { class: 'small muted', text: `この場面への指示：${s.requestJa}` }) : null,
      h('button', { disabled: busy, onclick: () => act(() => r.makeScene(s.id)) }, s.clip ? '作り直す' : 'この場面を作る', cost(per)),
      h('details', { open: S.drafts[`scene-req-${i}`] ? true : null },
        h('summary', { class: 'small', text: '指示して作り直す' }),
        requestBox({
          id: `scene-req-${i}`, busy, price: withTranslation(per, `scene-req-${i}`),
          label: 'この場面をどう変えたいか',
          placeholder: '例：もっとカメラを激しく動かして／夜の街で走っている場面に',
          button: 'この指示で作る',
          onSubmit: (text) => r.makeScene(s.id, text),
        })));
  });
  const all = async () => {
    const ok = await confirmDialog(`${remaining} 本の動画を作りますか？`, [
      `合計で約 ${P.usd(per * remaining)} かかります。1 本に数分かかるので、全部で ${remaining * 2}〜${remaining * 5} 分ほどが目安です。`,
      'そのあいだ、このページを開いたままにしてください（ほかのタブを見ていてもかまいません）。',
    ], '作りはじめる');
    if (ok) await act(() => r.makeRemainingScenes());
  };
  return h('section', { class: 'card' },
    h('h2', { text: 'ステップ 4：場面の動画を作りましょう' }),
    h('p', { text: `AI が場面ごとに数秒の動画を作ります。1 本あたり約 ${P.usd(per)} です。気に入らない場面は、あとから 1 本ずつ作り直せます。` }),
    h('p', { class: 'small muted', text: `使いすぎを防ぐため、1 本ごとに最大 ${P.usd(P.videoEstimate(video))} を見込んで上限額と比べます。Google 側で 1 日に作れる本数に上限があり（使いはじめは 1 日 20 本ほど）、上限に達したら翌日の午前 9 時ごろ以降に続きを作れます。` }),
    remaining ? h('div', { class: 'actions' }, h('button', { class: 'primary big', disabled: busy, onclick: all }, `残りの ${remaining} 本をまとめて作る`, cost(per * remaining)))
      : h('div', { class: 'actions' }, h('button', { class: 'primary big', disabled: busy, onclick: () => { S.viewStep = null; render(); } }, '書き出しへ進む')),
    h('div', { class: 'scenes' }, cards));
}

function panelExport(r, p) {
  const busy = !!r.busy;
  if (!canExport()) {
    return h('section', { class: 'card' }, h('h2', { text: 'ステップ 5：書き出し' }),
      h('div', { class: 'msg error', text: 'このブラウザは動画の書き出しに対応していません。パソコンの Chrome・Edge・Safari の最新版で開いてください。' }));
  }
  let result = null;
  if (p.exportFile) {
    const v = h('video', { class: 'final', controls: true, playsInline: true, preload: 'metadata' });
    const ext = extensionFor(p.exportFile.mime);
    const dl = h('a', { class: 'button primary big', download: `${safeName(p.plan.title || p.theme)}.${ext}` }, 'ダウンロードして保存');
    fileURL(p.exportFile.file).then((u) => { if (u) { v.src = u; dl.href = u; } });
    result = h('div', {},
      h('div', { class: 'msg ok', text: 'MV ができました！ 再生して確かめ、「ダウンロードして保存」でパソコンに保存してください。' }),
      v,
      h('div', { class: 'actions' }, dl, h('button', { disabled: busy, onclick: () => act(() => r.exportVideo()) }, 'もう一度書き出す')),
      ext === 'webm' ? h('p', { class: 'small muted', text: 'このブラウザでは WebM 形式で保存されます。Chrome や VLC で再生できます。MP4 形式が必要なときは、Safari か最新の Chrome で書き出してください。' }) : null);
  }
  return h('section', { class: 'card' },
    h('h2', { text: 'ステップ 5：MV を書き出しましょう' }),
    h('p', { text: '場面の動画と曲、歌詞の字幕をつないで、1 本の動画にします。料金はかかりません。' }),
    h('div', { class: 'msg warn', text: `書き出しには MV と同じくらいの時間（約 ${Math.round(p.plan.scenes.at(-1).end)} 秒）がかかります。そのあいだ、この画面を表示したままにしてください。ほかのタブやアプリに切り替えると中止されます。` }),
    !p.exportFile ? h('div', { class: 'actions' }, h('button', { class: 'primary big', disabled: busy, onclick: () => act(() => r.exportVideo()) }, 'MV を書き出す')) : null,
    result,
    h('div', { class: 'actions' }, h('button', { class: 'link', disabled: busy, onclick: () => { S.viewStep = 4; render(); } }, '場面を作り直したいとき：ステップ 4 へ')));
}

const STATUS = { ok: '完了', failed: '失敗（請求なし）', uncertain: '不明（見込み額で計上）', reserved: '実行中' };

function priceInfoLine() {
  const g = S.gemini.models;
  const info = P.officialPriceInfo();
  const date = info?.checkedAt ? new Date(info.checkedAt).toLocaleDateString('ja-JP') : null;
  const how = info?.source === 'live' ? '毎日自動で読み取り' : '保存してある読み取り結果';
  const labels = { music: '曲', image: '画像', video: '映像' };
  const by = { official: [], builtin: [], assumed: [] };
  for (const k of ['music', 'image', 'video']) by[P.priceSource(g[k])].push(labels[k]);
  const parts = [];
  if (by.official.length) parts.push(`${by.official.join('・')}の料金は、Google の公式料金ページから読み取った値です（${how}${date ? `、${date} 時点` : ''}）。`);
  if (by.builtin.length) parts.push(`${by.builtin.join('・')}の料金は、このページに書き込んである値（2026-10-13 に公式料金ページで確認）です。`);
  if (by.assumed.length) parts.push(`${by.assumed.join('・')}の料金は、下の注意書きのとおり仮定した値です。`);
  parts.push('文章の AI の料金は、高めに見積もった固定の値です。');
  return h('p', { class: 'small muted' }, parts.join(''), extLink('https://ai.google.dev/gemini-api/docs/pricing', '公式の料金ページ'));
}

/** Shown wherever an amount uses a model with no listed price yet. */
function assumedNotice(models) {
  const assumed = [...new Set(models.filter((m) => P.priceSource(m) === 'assumed'))];
  if (!assumed.length) return null;
  return h('div', { class: 'msg warn', role: 'note' },
    h('b', { text: `${assumed.map(friendlyModel).join('・')} は、Google の料金表から料金を読み取れなかった版です（まだ新しく、料金表に載っていない可能性が高い版です）。` }),
    h('p', { class: 'small', text: `まだ新しい版なので、料金が基準の版の ${P.ASSUMED_FACTOR} 倍かかると仮定して、金額を換算しています。料金表から読み取れるようになると、自動で正しい金額に切り替わります。` }),
    h('p', { class: 'small', text: '実際の料金がこれを超える可能性もあるので、上限額による自動停止は目安と考えてください。実際の請求額は Google AI Studio で確かめられます。' }));
}

function moneyCard(r, p) {
  const spentUSD = P.spent(p);
  const fill = h('div');
  fill.style.width = `${Math.min(100, (spentUSD / Math.max(0.01, p.budgetUSD)) * 100)}%`;
  const input = h('input', { id: 'budget', type: 'number', min: 1, max: 500, step: 1, value: p.budgetUSD, 'aria-label': '上限額（ドル）' });
  return h('section', { class: 'card' },
    h('h2', { text: S.mode === 'demo' ? '使った金額（お試しなので実際にはかかりません）' : '使った金額' }),
    h('div', { class: 'money' },
      h('span', { class: 'amount', text: `${P.usd(spentUSD)} / 上限 ${P.usd(p.budgetUSD)}` }),
      h('span', { class: 'spacer' }),
      h('label', { for: 'budget', class: 'small', text: '上限を変える：$' }), input,
      h('button', { disabled: !!r.busy, onclick: () => act(() => r.updateBudget(input.value)) }, '変更')),
    h('div', { class: 'bar' }, fill),
    h('p', { class: 'hint', text: 'このページが記録した見込みの金額です。実際の請求額は Google AI Studio の「使用状況」で確かめられます。' }),
    assumedNotice([S.gemini.models.music, S.gemini.models.image, S.gemini.models.video, ...p.ledger.filter((e) => e.assumed).map((e) => e.model)].filter((m) => P.priceSource(m) === 'assumed')),
    p.ledger.length ? h('details', {}, h('summary', { text: 'くわしい記録' }),
      h('div', { class: 'tablewrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, ['日時', '内容', 'AI', '金額', '状態'].map((t) => h('th', { text: t })))),
        h('tbody', {}, p.ledger.map((e) => h('tr', {},
          h('td', { text: new Date(e.date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
          h('td', { text: e.kind }),
          h('td', { text: friendlyModel(e.model) }),
          h('td', { class: 'num', text: P.usd(P.counted(e)) + (e.assumed ? `（${P.ASSUMED_FACTOR} 倍で仮定）` : '') }),
          h('td', { text: STATUS[e.status] ?? e.status }))))))) : null);
}

boot();
