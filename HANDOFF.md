# Hrdle — 移行の記録と、いま動いている構成

CC Hub (`m0a/cc-hub`) を Hrdle に改名するプロジェクト（[#459](https://github.com/m0a/cc-hub/issues/459)）。
**2026-07-29 に移行は完了した。**この文書は「これからやること」ではなく、
**何が起きたか・いま何が動いているか・どう戻すか**の記録。

## 移行は完了している

```
m0a/cc-hub    archived / v0.2.98 で凍結 / open issue 0 / open PR 0
hrdle/hrdle   v0.3.0 リリース済み / issue 8件（cc-hub から移行）
```

`hrdle` が 5924 で default herdr セッション（＝全ワークスペース）を持つ。
**cchub は畳んでいない** — 独自 herdr セッションに移して 5923 で生かしてある。

### いま動いている構成

```
herdr.service        active / enabled     default セッション  ← hrdle が使う
herdr-cchub.service  active / enabled     cchub セッション    ← cchub が使う
herdr-hrdle.service  inactive / disabled  並走期の名残。役目を終えた

hrdle.service   active / enabled   :5924  default セッション  11 workspaces
cchub.service   active / enabled   :5923  cchub セッション     0 workspaces（空）
```

**役割が入れ替わっただけで、並走は続いている。**移行前は cchub が default で hrdle が
named session、いまはその逆。どちらも `EnvironmentFile` の `HERDR_SESSION` 一行で決まる:

| | env | 意味 |
|---|---|---|
| `~/.config/hrdle/env` | （無し） | default セッションを掴む |
| `~/.config/cchub/env` | `HERDR_SESSION=cchub` | 自分専用セッション |

cchub 側は**空のセッションから始まる**。既存の11ワークスペースは hrdle が持っているので、
cchub からは見えない。新しく作れば普通に使える。

### 継続手段は2段階ある

**1. そのまま cchub で作業する** — 5923 は生きているので、新しいワークスペースを
作って作業できる。hrdle に何かあっても**止める必要すらない**。

**2. 11ワークスペースごと引き継ぐ** — hrdle が使えなくなった場合:

```bash
systemctl --user stop hrdle
# ~/.config/cchub/env から HERDR_SESSION=cchub の行を消す
systemctl --user restart cchub          # :5923 が default セッションを掴む
```

**先に hrdle を止めること。**両方が default を見ると同じペインを奪い合う（#520）。

生命線:

- `~/bin/cchub`（v0.2.98）と `~/bin/cchub-v0.2.98-frozen`
  — 後者は `cchub-update.timer` の射程外に置いた凍結コピー
- `~/.cc-hub` — 中身は健在（`herdr-last-known-sessions.json` だけ、default 時代の
  lost 19件が並ぶので空にした。バックアップは `.bak-preswap`）
- `cchub.service` / `herdr-cchub.service` — どちらも enabled、再起動後も自動で上がる

cc-hub はアーカイブされても**読み取りは変わらない**ので、リリース資産と `install.sh` は
残り、`cchub update` は v0.2.98 まで解決し続ける（実測確認済み）。

### 配布経路は通しで検証済み

```
タグ push → release.yml → GitHub Release → install.sh → hrdle update
```

v0.3.0 で全部通した。`hrdle update` は Release から取得 → SHA256 検証 → バイナリ差し替え
→ **systemd サービス自動再起動**まで動き、11 workspaces も無事だった（v0.2.97 → v0.3.0）。
`install.sh` のワンライナーも `HRDLE_INSTALL_DIR` を temp に向けて実走確認済み。

### 上流の準備工事（すべてリリース済み）

| リリース | PR | 内容 |
|---|---|---|
| v0.2.84 | #635 | identity 一元化（インストーラ・サービス系） |
| v0.2.85 | #637 | identity 一元化（実行時パス） |
| v0.2.92 | #653 | localStorage キーの名前空間化 + legacy fallback |
| v0.2.93 | #655 | herdr named session 対応（`HERDR_SESSION`） |
| v0.2.94 | #658 | メッセージカタログの identity 経由化 |
| v0.2.97 | #668 | 改名で壊れる3つの穴（build.sh / テストの dataDirEnv / operational scan） |
| v0.2.98 | #672 | ポートと表示名の identity 経由化（**cc-hub 最終リリース**） |

### identity.json の値

`identity.json` は以下の値になっている。`shared/identity.ts` がここから `SERVICE`（unit 名・
launchd ラベル）、`TMP_PATHS`、`assetName()`、`HOOK_COMMAND` を合成する。**呼び出し側は無変更**。

```json
{
  "productName": "Hrdle",
  "tagline": "Coding Agent Session Manager",
  "binaryName": "hrdle",
  "repo": "hrdle/hrdle",
  "assetPrefix": "hrdle",
  "defaultPort": 5924,
  "dataDirName": ".hrdle",
  "dataDirEnv": "HRDLE_DATA_DIR",
  "configDirName": "hrdle",
  "serviceName": "hrdle",
  "launchdPrefix": "com.hrdle",
  "storagePrefix": "hrdle-",
  "legacyStoragePrefixes": ["cchub-", "cc-hub-"],
  "tmpPrefix": "hrdle",
  "browserLogName": "hrdle-browser.log",
  "keychainService": "hrdle"
}
```

検証済み: 全テスト green（backend 535 / frontend 90 / glasses 120）、lint / typecheck green、
`bun run build:binary` → `dist/hrdle`、`--help` が `hrdle` を名乗り default port 5924。

**注意: `bun install` を先に走らせること。** 依存が無いと `hono` の解決に失敗して backend の
テストが大量に落ち、改名由来の失敗と見分けがつかなくなる。

### `identity.json` を読めない箇所 — 2つではなく3つ

- `install.sh` — `curl | bash` で走るのでチェックアウトが存在しない
- `.github/workflows/release.yml` — matrix はどのステップより先に評価される
- `scripts/build.sh` — **読める位置にあるのに `dist/cchub` を自前で持っていた**。
  release.yml 側は `mv dist/<binaryName>` を期待しているので、ズレると**CI ビルドだけが壊れる**。
  テストは release.yml の文字列しか見ておらず、この2つの一致は誰も検査していなかった。
  現在は `bun -e` で identity.json を読む形にしてあるので、コピーは2つに戻っている

前2つは `backend/tests/unit/identity-consistency.test.ts` がズレを検出する。

## 実測で分かっている落とし穴

### `dataDirEnv` の改名はテストを実データディレクトリに向ける（最重要）

4つのテストが `process.env.CC_HUB_DATA_DIR = tempDir` で書き込み先を一時ディレクトリに
逃がしている。env 名を変えると、この行は**何も設定しない行**になり、テストは実データ
ディレクトリに書く。

```
backend/tests/unit/sessions.test.ts
backend/tests/unit/jwt-secret.test.ts
backend/src/services/__tests__/peer-registry-lock.test.ts
backend/src/services/__tests__/session-metadata-lock.test.ts
```

実際に `~/.hrdle` が作られ、偽セッション20件とテスト用メタデータ（`ses-a` / `ses-b` …）が
残った。**失敗ではなく汚染として出る**ので、テストが赤くなければ気づけない。
現在は4ファイルとも `IDENTITY.dataDirEnv` 経由。**同じ形の env 参照を新しく書かないこと。**

### `identity-operational.test.ts` は改名しても落ちない

v0.2.94 で入ったこのスキャンは `cchub.service` / `com.cchub` / `/tmp/cc-hub` /
`.cc-hub` / `CC_HUB_DATA_DIR` を探す。改名後も **pass し続けるが、存在しない名前を
探しているだけ**になる。現在はパターンを `IDENTITY` から合成しているので、次の改名でも
追従する。

### 改名で落ちるテストは「2ファイル」では済まない

`identity.json` を書き換えると backend で21件落ちた。内訳と対処方針:

- **golden text**（`setup-units.test.ts` の systemd unit / launchd plist、
  `identity-consistency.test.ts` の scratch パスと keychain）→ **リテラルのまま手で更新する**。
  identity から合成し直した golden はどんな出力とも一致するので、golden の意味が消える
- **ロジックのテストがたまたま名前を使っているもの**（hook 検出、codex hook 移行、
  notifyCommandFor、herdr-agent-indicator）→ `HOOK_COMMAND` / `IDENTITY` 経由にする

### herdr は全ペインに `HERDR_SOCKET_PATH` を注入する

```
$ env | grep HERDR
HERDR_ENV=1
HERDR_PANE_ID=w4Q:p1
HERDR_SOCKET_PATH=/home/m0a/.config/herdr/herdr.sock
HERDR_TAB_ID=w4Q:t1
HERDR_WORKSPACE_ID=w4Q
```

つまりこの変数は**環境由来であって意図的な指定ではない**。
だから `HERDR_SESSION` のほうが優先する実装になっている（#655）。
これを逆にすると、「別インスタンスのターミナルから起動して試す」という
一番自然な検証手順でセッション指定が無視され、しかも動いているように見える。

### エージェントの中から検証サーバーを起動すると transcript が保存されない

上の `HERDR_SOCKET_PATH` と同族で、**こちらのほうが静か**。

Claude Code は子プロセスに `CLAUDE_CODE_CHILD_SESSION=1` を立てる。この環境から
検証用サーバーを起動すると、そのマーカーが伝播する:

```
私 (Claude Code)  CLAUDE_CODE_CHILD_SESSION=1
      ↓ ここから手動で hrdle を起動
hrdle → herdr(hrdle) → pane → claude
                                 └ 「子セッション」判定 → transcript 保存 OFF
```

ペインには `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`
と出るが、**ターミナルを覗かない限り気づかない**。会話は普通に動くので、
壊れていることが分かるのは**再起動して復元が走ったとき**:

```
claude --resume 25c60a6b-...
No conversation found with session ID: 25c60a6b-...
```

`resume_agents_on_restore` が正しく resume を試みても、**復元すべきログが最初から
存在しない**。2026-07-29 の再起動でこれを踏んだ。

systemd から起動すれば環境はクリーンなので起きない（実測: unit 経由で起動した
hrdle の MainPID の environ には `HERDR_SESSION` しかなく、そこで作ったセッションは
`~/.claude/projects/<cwd>/<id>.jsonl` を 31KB 書いた）。**検証もサービス経由でやること。**

### `HERDR_SOCKET_PATH` だけではセッションは分離できない

```
$ HERDR_SOCKET_PATH=.../sessions/x/herdr.sock herdr server
api socket: .../sessions/x/herdr.sock   ← 分離される
logs:       ~/.config/herdr/herdr-server.log  ← default のまま
```

ソケットは動くがセッションディレクトリは動かない。そこに `session.json`
（ワークスペース復元情報）があるので、2つ起動すると互いの状態を潰す。
**必ず `herdr --session <name> server` で起動すること。**

### `herdr session attach` は herdr ペイン内から実行できない

nested herdr 判定で弾かれる。installer が必要なのは attach ではなくサーバー起動なので実害は無い。

### 名前について（未解決の懸念）

`herdr` と `hrdle` は5文字で1回の転置違い。CLI・ログ・docs で並ぶと打ち間違える。
またこのリポジトリは tmux → herdr を一度やっているので、バックエンド由来の命名は
「また名前が実態と合わなくなる」実績がある。
汎用性を上げるための改名で依存先の名前に寄せるのは方向が逆かもしれない、と一度提起したが、
**ユーザーは Hrdle で進める判断を明示している**。蒸し返さないこと。

## 移行の各段階（すべて完了）

### 1〜2. 上流への還元（完了 — v0.2.97 #668 / v0.2.98 #672）

改名の過程で見つかった「identity を通っていない値」は、**cchub 名のまま上流に戻してから**
取り込んだ。fork に置いたままだと同期のたびに衝突するし、どれも改名と無関係に
cc-hub 側のバグだったため。

結果として **fork と upstream のコード差分はゼロ**になり、違いは `identity.json` の値と
アイコンとこの文書だけになった。フリーズが「remote を見るのをやめる」だけの操作で済んだ。

還元したもの: `build.sh` の自前コピー / テストの `dataDirEnv` リテラル /
operational scan の自己無効化 / `cli.ts` と `glasses.ts` のポート /
`index.html` の FOUC スクリプト / 表示文字列 / `frontendDevPort` /
`identity.json` の Node import 対応。

**上流で1件差し戻された。**`backend/package.json` から `-p 3456` を外したのは誤りで、
`isDev = process.argv.some(a => a.includes('--watch'))` が**常に false**（bun は
`--watch` を子プロセスの argv に渡さない）。明示ポートという唯一の防波堤を外したことで、
**死んでいたコードが初めて実行経路になり dev が本番ポートを掴む**状態になっていた。
上流が `scripts/dev-backend.sh` + 判定削除で修正（4c9864a）。
教訓は「分岐の中身だけ見て分岐自体を検証しなかった」こと。

### 3. 並走の実地検証（完了）

```bash
# hrdle 側
HERDR_SESSION=hrdle  # 別 herdr セッション（別サーバー・別ワークスペース・別 session.json）
port 5924            # dev は 3457 / 5174（cchub の 3456 / 5173 から1つずらし）
~/.hrdle             # 別データディレクトリ
```

**ポート番号を identity に通していない箇所が複数あった。**改名で最も静かに壊れる種類のもの:

- `backend/src/cli.ts` の `DEFAULT_PORT = isDev ? 3456 : 5923` — `--help` は identity から
  5924 と表示する一方、実際には **5923 を bind しに行く**。つまり改名ビルドが cchub の
  ポートを奪いに行き、両方入っているマシンでは EADDRINUSE で落ちる。
  `-p` を明示している限り顕在化しないので、検証中ずっと気づかなかった
- `backend/src/commands/glasses.ts` の `PRODUCTION_PORT = 5923` / `DEV_PORT = 3456` —
  `hrdle glasses` のメモが cchub へ飛ぶ
- `frontend/playwright.config.ts` の `webServer.url` — vite の port と食い違うとテストは
  失敗せず、120秒待って「サーバーが起動しなかった」と報告する

`identity-operational` のスキャンは**ポート番号を見ていない**（数字なので誤検知しやすい）。
この層は今のところ人力で探すしかない。

**先に `rm -rf ~/.hrdle`**（上記の汚染で偽セッション20件が入っている場合）。

**検証すること**（ここまで机上で詰めたが、実地では未確認）:

- 2つのサービスが同時に常駐して干渉しないか
- hook がどちらに飛ぶか（`~/.claude/settings.json` の `cchub notify` をどう扱うか）
- 両方の UI を同時に開いて #520（takeover 合戦）が起きないこと
  — herdr セッションが分かれているので理論上は起きないはず
- peer discovery が 5923/5924 をどう見るか

### 3.5 再起動検証（supervised 構成の答え合わせ）

2026-07-29 に systemd 構成を組み直した。**再起動しないと確かめられない部分が残っている。**

組んだもの:

```
herdr.service         inactive/enabled   default セッション（cchub 用）
herdr-hrdle.service   inactive/enabled   hrdle セッション（新規作成）
cchub.service         Wants/After=herdr.service
hrdle.service         Wants/After=herdr-hrdle.service, EnvironmentFile に HERDR_SESSION=hrdle
```

依存を足したのは、**cchub が herdr より先に起動すると herdr を systemd の外に spawn し、
`herdr.service` が「already running」で無限に失敗する**ため。実際 7/26 から 3 日間、
2 秒ごとに 114,629 回失敗し続けていた（`systemctl --user stop herdr` で停止済み・
**disable はしていない**。次回起動で systemd に先を取らせるため）。

#### 再起動前スナップショット（2026-07-29 20:28）

```
port 5923 (cchub): 19 sessions (working 1 / lost 8)
port 5924 (hrdle):  2 sessions (Welcome, parallel-check)
default のワークスペース: hrdle, cchub-work-3, cchub-work-1, cchub-work-2, wheel-leg-bot,
                          life, linux, pixel-customrom, repos, lifestyle-app-work-1, 汎用質問
```

#### 再起動後に確認すること

```bash
# 1. herdr が systemd 管理下で上がったか（両方 active なら成功）
systemctl --user is-active herdr herdr-hrdle cchub hrdle

# 2. ループが再発していないか（No entries なら成功）
journalctl --user -u herdr --since '2 minutes ago' | tail -5

# 3. セッションが復元されたか
curl -sk https://localhost:5923/api/sessions | jq '.sessions | length'   # 19 期待
curl -sk https://localhost:5924/api/sessions | jq '.sessions | length'   # 下記参照
```

**hrdle セッションは復元されない可能性が高い。**`~/.config/herdr/sessions/hrdle/` に
`session.json` が無い（default 側にはある）。named session が復元情報を書かないのか、
書くタイミングが来ていないだけなのかは未確認。**再起動がその答え合わせになる。**
復元されなくても hrdle 側は検証用の 2 セッションだけなので実害はないが、
**切替後は hrdle が全ワークスペースを持つので、ここが復元されないなら切替を止める理由になる。**

失敗時の復旧: `systemctl --user start herdr` で default セッションは `session.json` から復元される。

### 3.9 「動かして初めて見つかる」層は最後まで出続けた

改名の穴は**テストでも CI でも見つからず、実際に起動して目で見るまで分からない**ものが
最後まで出続けた。時系列で:

| 見つけ方 | 見つかったもの |
|---|---|
| サーバーを起動した | 起動バナーが `🚀 CC Hub` |
| 会話画面を開いた | 画像が生パス表示（正規表現が `/tmp/cchub-images` 固定） |
| 引数なしで起動した | `--help` と違うポートを bind（`cli.ts` の `isDev` ベタ書き） |
| 再起動した | `claude --resume` が `No conversation found` |
| **`update --check` を叩いた** | **「更新するには: cchub update」** |

最後のものは v0.3.0 リリース後、アップデータの実走検証で出た。案内どおり打つと
`command not found` になる。**更新を促すメッセージという、改名で最も目立つ場所**だった。

共通するのは「値が間違っていても例外にならず、テストは緑のまま」という点。
`identity-operational.test.ts` のスキャンはこの層を狙ったものだが、
**ポート番号（数字なので誤検知しやすい）と表示文字列は今も対象外**。

### 4. 切替（promote — 完了 2026-07-29 21:44）

`~/.config/hrdle/env` から `HERDR_SESSION=hrdle` を消し、`hrdle.service` の依存を
`herdr-hrdle.service` → `herdr.service` に付け替えて再起動。cchub を先に停止してから
切り替える（逆順だと同じワークスペースを両者が掴んで #520 になる）。

引き継ぎ結果は**実ワークスペース11件が完全一致**。`lost` が 19→0 になったのは
正しい挙動で、19 のうち 8 は cchub 側 `~/.cc-hub` のキャッシュに残っていた lost。
hrdle は `~/.hrdle` を見るので過去の lost を持ち込まない。**実体は1件も欠けていない。**

port は 5924 のまま据え置いた。5923 を空けておけば cchub を enable するだけで戻せる。
この判断により `peer-discovery.ts` の `DEFAULT_PORT = 5923` は「移行期の小問題」ではなく
**恒久的な問題**になった（他マシンの hrdle を永久に発見できない）。

### 5. リポジトリ（完了）

- `m0a/cc-hub` は **archived**（v0.2.98 で凍結、open issue / PR とも 0）
- **`m0a/hrdle` はまだ空いている。** rename の選択肢を残すため、この名前は取らないこと
- **`gh issue transfer` は使えなかった** — GitHub の transfer は**同一 owner 内でのみ**動く。
  `m0a`（個人）→ `hrdle`（organization）は不可で `New repository must have the same owner`
  になる。issue 8件は**コピーで移行**し（hrdle#3〜#10）、cc-hub 側は移行先リンク付きで close した。
  **コメント履歴は引き継げない**が、cc-hub は読めるまま残るので元 URL から辿れる
- open PR 2件（#664 音声認識の語彙プロンプト / #496 ペイン indicator の偽バッジ）は
  **cherry-pick して hrdle#2 でマージ**。フリーズ済みの上流でマージせず fork に移した
- 更新経路は分離済み: cchub は `m0a/cc-hub` から、hrdle は `hrdle/hrdle` から

## いま残っているもの

**どれも家業の継続には関わらない。**急ぐ理由はない。

- **hrdle#3〜#10** — cc-hub から移行した宿題8件
- **probe ポートのリスト化** — `peer-discovery.ts`。「他人を叩きに行くポート」は
  `IDENTITY.defaultPort`（＝うちのポート）ではなくプロトコル定数で、正しい形は
  **probe ポートのリスト**、`defaultPort` はその1要素。上流レビューでの指摘
- **置換漏れガード** — `transformIndexHtml` で `/%[A-Z_]+%/` が残ったら throw する。
  残ると FOUC スクリプトが SyntaxError になる
- **ポートのガード（スキャン）** — probe リストと同時に。注意: 素の `\b3456\b` は
  `formatUsd(12.3456)` にマッチする（`.` が word boundary を作る）。`(?<![\d.])` か
  `:PORT` の文脈で。スキャン対象に `frontend/tests` / `glasses/src` / `scripts` / 各 config を追加
- **glasses の表示名** — `phone-ui.ts` / `verify.html` の `CC Hub` / `cchub` リテラル。
  `__DEFAULT_PORT__` と同じ define 経路で通せる
- **`legacyNames`** — 改名後に残った旧名リテラル（`cchub.service` など）は
  存在しない unit を指す実バグなので拾う価値がある。`legacyStoragePrefixes` に倣った形で
- **#664 の実機検証** — 音声認識の語彙プロンプトは**合成音声でしか検証されていない**。
  実機マイクでの効き目は未確認のまま取り込んである
- **`~/.cc-hub` のメタデータ移行** — テーマ・カスタムタイトルは `~/.hrdle` に
  引き継いでいない（hrdle 側は初期状態）。必要なら手で `cp`。
  **コードの fallback は作らない**（split-brain を生み、切替後は確実に死ぬコードになる）

## 参照

- 設計議論の本体: [m0a/cc-hub#459](https://github.com/m0a/cc-hub/issues/459)（完了 close 済み）
  ただし**本文は古い**。方針が3回変わっていて、本文・コメント1・コメント2・コメント3が
  互いに矛盾している。**現行の正はこの HANDOFF.md**。だから #459 は hrdle にコピーしなかった
- 移行した issue: hrdle#3（wire プロトコル）/ #4（Web Push）/ #5（glasses × kimi）/
  #6（takeover 合戦）/ #7〜#9（レイアウト統合・UI統一・タップ領域）/ #10（グラス連絡チャンネル）
