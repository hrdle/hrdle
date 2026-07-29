# Hrdle 移行作業 — 引き継ぎ

CC Hub (`m0a/cc-hub`) を Hrdle に改名するプロジェクト（[#459](https://github.com/m0a/cc-hub/issues/459)）。
このリポジトリは `m0a/cc-hub` の fork で、**改名作業はここで行う**。

## なぜ改名するのか

「CC Hub」という名前が Claude Code に紐づきすぎている。実際にはもう Claude / Codex / Grok / Kimi を扱う。
最終的に Hrdle へ全面移行し、cchub は畳む。並走は移行期間だけの措置。

## 現在地

**identity.json の書き換えは完了している**（ブランチ `feat/rename-to-hrdle`）。
fork は upstream v0.2.94 と同期済み（`8c45396` でマージ、origin へ push 済み）。

| リリース | PR | 内容 |
|---|---|---|
| v0.2.84 | #635 | identity 一元化（インストーラ・サービス系） |
| v0.2.85 | #637 | identity 一元化（実行時パス） |
| v0.2.92 | #653 | localStorage キーの名前空間化 + legacy fallback |
| v0.2.93 | #655 | herdr named session 対応（`HERDR_SESSION`） |
| v0.2.94 | #658 | メッセージカタログの identity 経由化 |

### 済んだこと

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

## 残っている作業

### 1. 表示文字列・ログの IDENTITY 経由化（上流でやるべき）

`backend/src` / `frontend/src` / `glasses/src` に残っている。v0.2.94 (#658) で i18n
カタログ分は上流が消化した。コメントは放置でよい（改名時に掃く。衝突しても解決は自明）。

**これは upstream（`m0a/cc-hub`）でやってから取り込むほうが良い。**
fork 側で全識別子を書き換えると、upstream 取り込みが毎回ほぼ全ファイルで衝突する。
upstream は1日に数回リリースが走るくらい動いている。

### 2. 上流に還元すべき修正（改名と無関係な cc-hub 側のバグ）

改名の過程で見つかった以下は cchub のままでも有効な修正。fork に置いたままだと
次の同期で毎回衝突する。

- `scripts/build.sh` が `dist/cchub` を自前で持っている（release.yml とズレると CI が壊れる）
- 4つのテストが `CC_HUB_DATA_DIR` をリテラルで持ち、env 名が変わると実データを汚す
- `identity-operational.test.ts` のスキャンが改名で無効化される

### 3. 並走の実地検証（このリポジトリの本題・次にやること）

```bash
# hrdle 側
HERDR_SESSION=hrdle  # 別 herdr セッション（別サーバー・別ワークスペース・別 session.json）
port 5924
~/.hrdle             # 別データディレクトリ
```

**先に `rm -rf ~/.hrdle`**（上記の汚染で偽セッション20件が入っている場合）。

**検証すること**（ここまで机上で詰めたが、実地では未確認）:

- 2つのサービスが同時に常駐して干渉しないか
- hook がどちらに飛ぶか（`~/.claude/settings.json` の `cchub notify` をどう扱うか）
- 両方の UI を同時に開いて #520（takeover 合戦）が起きないこと
  — herdr セッションが分かれているので理論上は起きないはず
- peer discovery が 5923/5924 をどう見るか

### 4. 切替（promote）

- `HERDR_SESSION` を**外して**再起動 → default セッション（＝既存の全ワークスペース）を引き継ぐ
- port を 5924 → 5923 へ（`identity.json` の `defaultPort`）
- cchub は uninstall せず disable で数週間残す（rollback 用）
- 引き継ぎたい設定があれば `cp -r ~/.cc-hub ~/.hrdle` を1回。**コードの fallback は作らない**
  （並走期に split-brain を作り、切替後は確実に死ぬコードになるため）
- `hrdle update` は `hrdle/hrdle` の Releases を見る。まだ 0 リリースなので、
  リリース整備までは自前ビルド（`bun run build:binary`）で回す

### 5. リポジトリ

- **`m0a/hrdle` はまだ空いている。** rename の選択肢を残すため、この名前は取らないこと
- Issue は `gh issue transfer` で移せる
- 更新経路は分離済み: cchub は `m0a/cc-hub` から、hrdle は `hrdle/hrdle` から。
  リダイレクト依存が無い

## 参照

- 設計議論の本体: [m0a/cc-hub#459](https://github.com/m0a/cc-hub/issues/459)
  ただし**本文は古い**。方針が3回変わっていて、本文・コメント1・コメント2・コメント3が
  互いに矛盾している。現行方針はこの HANDOFF.md が正
- 関連 issue: #520（takeover 合戦）、#514（タップ領域）、#515/#516（レイアウト統合）
