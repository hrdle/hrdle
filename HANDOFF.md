# Hrdle 移行作業 — 引き継ぎ

CC Hub (`m0a/cc-hub`) を Hrdle に改名するプロジェクト（[#459](https://github.com/m0a/cc-hub/issues/459)）。
このリポジトリは `m0a/cc-hub` の fork で、**改名作業はここで行う**。

## なぜ改名するのか

「CC Hub」という名前が Claude Code に紐づきすぎている。実際にはもう Claude / Codex / Grok / Kimi を扱う。
最終的に Hrdle へ全面移行し、cchub は畳む。並走は移行期間だけの措置。

## 現在地

上流（`m0a/cc-hub`）側の前提工事は**完了している**。以下は全て本番リリース済みで、
fork は v0.2.93 時点の upstream と同期済み。

| リリース | PR | 内容 |
|---|---|---|
| v0.2.84 | #635 | identity 一元化（インストーラ・サービス系） |
| v0.2.85 | #637 | identity 一元化（実行時パス） |
| v0.2.92 | #653 | localStorage キーの名前空間化 + legacy fallback |
| v0.2.93 | #655 | herdr named session 対応（`HERDR_SESSION`） |

### `identity.json`

改名に必要な値は**全てこの1ファイル**にある。ここを書き換えるのが改名作業の中心。

```json
{
  "productName": "CC Hub",        → "Hrdle"
  "tagline": "Claude Code Session Manager",
  "binaryName": "cchub",          → "hrdle"
  "repo": "m0a/cc-hub",           → "hrdle/hrdle"
  "assetPrefix": "cchub",         → "hrdle"
  "defaultPort": 5923,            → 5924（並走期。切替時に 5923 へ戻す）
  "dataDirName": ".cc-hub",       → ".hrdle"
  "dataDirEnv": "CC_HUB_DATA_DIR",→ "HRDLE_DATA_DIR"
  "configDirName": "cchub",       → "hrdle"
  "serviceName": "cchub",         → "hrdle"
  "launchdPrefix": "com.cchub",   → "com.hrdle"
  "storagePrefix": "cchub-",      → "hrdle-"
  "legacyStoragePrefixes": ["cc-hub-"], → ["cchub-", "cc-hub-"]
  "tmpPrefix": "cchub",           → "hrdle"
  "browserLogName": "cc-hub-browser.log", → 正規化するなら "hrdle-browser.log"
  "keychainService": "cchub"      → "hrdle"
}
```

`shared/identity.ts` がここから `SERVICE`（unit 名・launchd ラベル）、`TMP_PATHS`、
`assetName()`、`HOOK_COMMAND` を合成する。**呼び出し側を書き換える必要はない。**

### 例外（`identity.json` を読めない2箇所）

- `install.sh` — `curl | bash` で走るのでチェックアウトが存在しない
- `.github/workflows/release.yml` — matrix はどのステップより先に評価される

この2つは自前のコピーを持ち、`backend/tests/unit/identity-consistency.test.ts` がズレを検出する。
**`identity.json` を書き換えたらこのテストが落ちるので、2ファイルも一緒に直すこと。**

## 残っている作業

### 1. 表示文字列・ログの IDENTITY 経由化（未着手・上流でやるべき）

`backend/src` / `frontend/src` / `glasses/src` に 434箇所（文字列249・その他40・コメント145）。
コメントは放置でよい（改名時に掃く。衝突しても解決は自明）。

**これは upstream（`m0a/cc-hub`）でやってから取り込むほうが良い。**
fork 側で全識別子を書き換えると、upstream 取り込みが毎回ほぼ全ファイルで衝突する。
upstream は1日に数回リリースが走るくらい動いている。

### 2. 並走の実地検証（このリポジトリの本題）

```bash
# hrdle 側
HERDR_SESSION=hrdle  # 別 herdr セッション（別サーバー・別ワークスペース・別 session.json）
port 5924
~/.hrdle             # 別データディレクトリ
```

**検証すること**（ここまで机上で詰めたが、実地では未確認）:

- 2つのサービスが同時に常駐して干渉しないか
- hook がどちらに飛ぶか（`~/.claude/settings.json` の `cchub notify` をどう扱うか）
- 両方の UI を同時に開いて #520（takeover 合戦）が起きないこと
  — herdr セッションが分かれているので理論上は起きないはず
- peer discovery が 5923/5924 をどう見るか

### 3. 切替（promote）

- `HERDR_SESSION` を**外して**再起動 → default セッション（＝既存の全ワークスペース）を引き継ぐ
- port を 5924 → 5923 へ
- cchub は uninstall せず disable で数週間残す（rollback 用）
- 引き継ぎたい設定があれば `cp -r ~/.cc-hub ~/.hrdle` を1回。**コードの fallback は作らない**
  （並走期に split-brain を作り、切替後は確実に死ぬコードになるため）

### 4. リポジトリ

- **`m0a/hrdle` はまだ空いている。** rename の選択肢を残すため、この名前は取らないこと
- Issue は `gh issue transfer` で移せる
- 更新経路は分離済み: cchub は `m0a/cc-hub` から、hrdle は `hrdle/hrdle` から。
  リダイレクト依存が無い

## 実測で分かっている落とし穴

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

## 参照

- 設計議論の本体: [m0a/cc-hub#459](https://github.com/m0a/cc-hub/issues/459)
  ただし**本文は古い**。方針が3回変わっていて、本文・コメント1・コメント2・コメント3が
  互いに矛盾している。現行方針はこの HANDOFF.md が正
- 関連 issue: #520（takeover 合戦）、#514（タップ領域）、#515/#516（レイアウト統合）
