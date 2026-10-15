# CLAUDE.md（MVメーカー ウェブ版）

ブラウザだけで動く MV メーカー。利用者が自分の Gemini API キーを貼り、ブラウザから `generativelanguage.googleapis.com` を直接呼ぶ。サーバーなし・外部ライブラリなし・ビルドなし（素の ES モジュール）。使う人向けの説明は [README.md](README.md)。

公開しない運用のメモ（デプロイ先の ID、依頼の経緯など）は `CLAUDE.local.md` にある。このファイルは git に入れない。このリポジトリは GitHub で公開しているので、ここ（CLAUDE.md）と README.md には、個人名・ローカルのパス・サービスの ID を書かないこと。

## 構成

- `index.html`：meta の CSP（`connect-src` は自分のオリジン（料金の読み込み）と Gemini API だけ、`script-src 'self'`、Trusted Types で `innerHTML` 等を禁止）。`vercel.json`：Vercel で付ける HTTP ヘッダー（`frame-ancestors 'none'`、HSTS など）。`_headers` は同じ内容の Cloudflare Pages / Netlify 形式。**CSP を変えるときは index.html・vercel.json・_headers の 3 か所をそろえる。**
- `js/vault.js`：**キーを持つ唯一のモジュール**。他のコードはキーを受け取らず `apiRequest(method, path)` だけ使う。https の Gemini オリジン・`/v1beta/` のパスだけ許可、キーは `x-goog-api-key` ヘッダーのみ、`redirect: 'error'`・`credentials: 'omit'`・`cache: 'no-store'`・`referrerPolicy: 'strict-origin'`（キーに「ウェブサイトの制限」をかけても動くように、オリジンだけ送る）。エラー文からキーを除去（`redact`）。「保存する」を選んだときだけ、取り出し不可の AES-GCM 鍵（IndexedDB `mvmaker-key`）で暗号化して保存。既定は記憶なし（タブを閉じると消える）。
- `js/models.js`：`models.list` から系統ごとに最新版を選ぶ（`lyria-X`、`gemini-nano-banana-X`、`gemini-omni-X-flash` の正規表現。preview / lite / pro / clip は対象外。確認済みの版より古いものは選ばない）。文章は `gemini-3.8-flash` 固定。
- `js/gemini.js`：Interactions API の呼び出し（前身の Mac アプリで 2026-09-29 に実 API 確認済みの形）。最新版が送信段階の 400/404 で断られ、確認済みの版で成功したときだけ、その版を「壊れている」と localStorage（`mvmaker-model-prefs`）に記録して以後使わない。プロンプトの問題（確認済みの版でも失敗）では記録しない。
- 料金（方針：料金表にない版は 3 倍と仮定する旨を表示し、できるだけ正しい料金を表示する）：
  - `js/price-parser.js`：公式料金ページ（https://ai.google.dev/gemini-api/docs/pricing）の文章から、3 系統の全モデルの料金を読む。動画は「$X (video)」と「N tokens per second of 720p video」から 1 秒の料金を計算し、「approximately $Y per second」と比べて大きいほうを使う。画像は「$X per 1K image」の 1.2 倍（参照画像の入力の分）。料金は、そのモデルの見出しから次のモデル名・次の「Try it in Google AI Studio」・「Used to improve our products」（Standard の表の終わり）・「Batch」までの範囲で読み、複数あれば最大値を使う（Batch や短い曲の安い料金を拾わないため。2026-10-15 の独立レビューで指摘）。基準値の 0.6 倍未満は読み間違いとして捨てる（安く読む方向が危険なため）。100 倍を超える値も捨てる。
  - `api/prices.js`：Vercel Function（`GET /api/prices`）。料金ページを読んで JSON で返す。CDN に 1 日キャッシュ（`s-maxage=86400`）。入力を受け取らず（クエリ付きは 400。CDN のキャッシュを迂回させないため）、キーにも触れない。
  - `prices.json`：読み取り結果の保存版。`node scripts/update-prices.mjs` で更新する。`/api/prices` が使えないとき（ローカルの確認環境を含む）に使う。
  - `js/pricing.js`：使う順番は、公式ページの読み取り結果 → 書き込み済みの表（2026-10-13 確認）→ どちらにもない版は基準の版の 3 倍（`priceSource` が 'assumed'）。'assumed' の場合は、ホーム・新規作成・使った金額の 3 か所に注意書きを出し、記録の行に「3 倍で仮定」と付ける（記録の `assumed`）。
  - 文章モデル（gemini-3.8-flash）の料金は、読み取りの対象外で固定（2027 年の 2 倍の単価で計上している）。
- `js/runner.js`：工程（企画→曲→画風→場面→書き出し）。有料呼び出しは「予算確認 → 見込み額で `reserved` を保存 → 実行 → 実額か failed/uncertain に確定」。読み込み時に残った `reserved` は uncertain（見込み額で計上）。`navigator.locks` で MV ごとに 1 タブだけ作業できる。動画は 1 本ごとに 40 秒分（4 ドル）を見込む。
- 指示して直す：各ステップの「どう直したいか」欄（`app.js` の `requestBox`、入力中の文字は `S.drafts` に残す）。
  - 歌詞：`revisePlan` が、いまの企画の JSON と指示を Gemini に渡して直させる。曲は必ず作り直しになる。主人公と画風の文章が変わらなければ絵を残し、場面の文章が変わらなかった場面は動画も残す。
  - 曲：指示を Lyria の指示文の末尾に足す。
  - 絵：いまの「画風の見本」を参照画像にして、指示どおりに直す（Nano Banana の編集）。続けてキャラクターの絵を作り直す。指示は `plan.styleNotes`（英語）と `plan.styleRequestsJa` に貯め、キャラクターの絵とすべての場面の動画の指示文に入れる。「まったく新しく作り直す」で消える。
  - 場面：指示は `scene.notes`（英語）と `scene.requestJa` に入れ、その場面の指示文に足す。
  - 生成 AI への指示文は英語にそろえている（Omni は英語でしか動作が確認されていないため）。日本語の指示は、文章の AI で英語に訳してから使う（記録上は「指示の翻訳」。1 回 1 円未満）。英数字だけの指示は訳さない。訳す前に、生成の分も含めて予算を確かめる。
- `js/store.js`：IndexedDB（本番 `mvmaker-projects`、お試し `mvmaker-demo`）。キーは入れない。
- `js/media.js`：書き出し。canvas に動画と字幕を描き、WebAudio の曲と合わせて MediaRecorder で実時間で録画（MP4 優先、無理なら WebM）。タブが隠れると rAF が止まるので、その時点で中止してやり直してもらう。
- `js/demo.js`：お試しモードの偽 Gemini（通信なし）。
- `js/app.js`：画面。DOM は `h()`（createElement + textContent）だけで作る。`innerHTML` は CSP の Trusted Types で使えないので使わないこと。

## 起動・テスト

- テスト：このフォルダで `node --test tests/`（Node 18 以上。外部パッケージなし。2026-10-15 時点で 43 件）。`tests/security.test.mjs` がキーの扱いを確かめる。
- python の http.server は、ブラウザに古いプログラムを使い回させることがある。変更後に画面を確かめるときは、`fetch(url, {cache:'reload'})` で読み直すか、強制再読み込みをする。確認用のブラウザ画面が隠れていると、画面の書き換え（requestAnimationFrame）が止まって表示が遅れる。
- 画面：このフォルダで `python3 -m http.server 8765 --bind 127.0.0.1` を起動し、http://localhost:8765 を開く。「お試しモードで始める」で全工程を通せる（通信・課金なし）。
- Claude が本物のキーで生成してはいけない（キーの入力と有料の生成は人が行う）。偽の文字列でキー確認のエラー表示を試すのはかまわない（`GET /v1beta/models` は無料）。

## 公開

公開中：https://mvmaker-web.vercel.app （Vercel Hobby）。デプロイの手順と ID は `CLAUDE.local.md`。

- フレームワークなし・ビルドなしの静的サイト ＋ `api/prices.js`。`package.json` の `"type": "module"` は関数のために必要。`.vercelignore` でテスト・スクリプト・md を除く。
- **専用のオリジン（独自ドメインかサブドメイン）で公開すること。** IndexedDB と localStorage はオリジン単位なので、同じオリジンにほかのアプリがあると、そのアプリから暗号化キーごと読まれる。例：`username.github.io/他のリポジトリ` は同じオリジンになるので不可。
- Vercel の Toolbar（プレビューの URL に自動で入るコメント機能）は外部スクリプトなので、CSP で止まる。CSP をゆるめず、プロジェクトの設定で Toolbar をオフにする。Web Analytics と Speed Insights も使わない。
- Hobby プランは個人の非営利の利用に限られる（Vercel の Fair Use Guidelines。2026-10-15 確認）。
- `*.vercel.app` のサブドメインは、それだけで専用のオリジンになる。プレビューの URL も、それぞれ別のオリジンになる（保存したキーは共有されない）。
- 公開したら確かめること：配信されたファイルが手元と一致すること（SHA-1）、`/api/prices` が 200 を返すこと、レスポンスヘッダーに CSP が付いていること、画面に「毎日自動で読み取り」と出ること。

## 独立レビュー（2026-10-13、Fable）

漏えいの経路は見つからなかった。指摘のうち対応したもの：
- 料金表にない新しい版は 3 倍で見積もり、画面に警告を出す（「常に最新版を使う」方針を保つため、自動では止めない）。
- 複数タブで古い台帳が上書きされる問題：`rev` を保存ごとに増やし、保存済みと違えば `StaleError` で保存しない。`run()` は開始時に保存済みを読み直す。
- 保存の説明を正直な文言に変更。ローカル（localhost）では保存の選択肢を出さない（他アプリと同じオリジンのため）。
- iframe の中では動かない。キー欄は `type=text` と CSS の伏せ字（パスワード保存の提案を避ける）。上限額は 500 ドルまで。「壊れた版」の記録は 14 日で消える。

対応していないもの：
- 基準の版（fallback）自体が Google に廃止されると、そのときは止まる（課金はされない）。
- 公式料金ページの書き方が変わると、読み取りに失敗する。その場合は `prices.json` か書き込み済みの表に戻る（どちらにもない新しい版は 3 倍で計算）。`node scripts/update-prices.mjs` が「no prices found」で止まったら、`js/price-parser.js` を直す。

## 既知の問題・未確認事項

- 本物のキーでは、2026-10-15 に歌詞・曲・画像（Nano Banana 2.1）まで生成できたことを確認した。動画（Omni）の生成と、その動画の受け取り・書き出しは、本物ではまだ確認していない。「指示して直す」も本物では未確認。
- 書き出しは Chrome（MP4）で確認した。Safari・Firefox（WebM になる）は未確認。書き出した MP4 を QuickTime で再生できるかは未確認。
- Omni の動画は `delivery: 'uri'` で受け取り、`/files/{id}:download` を CORS で取得する（プリフライトは許可されていることを確認済み。実際のダウンロードは未確認）。
- キー欄の伏せ字（`-webkit-text-security`）が Firefox で効くかは未確認。効かない場合は、キーがそのまま画面に見える（送信や保存には影響しない）。
- 1 回の書き出しで動画を全部メモリに読むので、90 秒・縦長でメモリの少ない端末だと重い可能性がある。
