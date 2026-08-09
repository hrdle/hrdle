# Hrdle

日本語 | [English](README.md)

**机を離れても、エージェントに届く。**
パソコンの前に、あなたはもういない。それでも、仕事は進んでいる。

Hrdle は Claude Code、Codex、Grok、Kimi、OpenCode といったコーディングエージェントを
あなたのマシンで動かし、スマホと EVEN Realities G2 から操作できるようにします。

**PC を開かずに仕事を始める。** 見るだけでなく、始められます。セッションを作り、声で頼み、
質問にはグラスで答える。パソコンは、開かないままでいい。

マシンはヘッドレスで構いません。ディスプレイもキーボードも、そこに座る人も不要です。
Tailscale 越しに届くので、そのマシンに求めるのは起き続けていることだけです。

*Hrdle = herdr + handle。セッションを束ねる herdr を、G2 から握るハンドル、という名前です。
導入にハードル (hurdle) があることも、由来のひとつです。*

> **旧称 CC Hub。** [`m0a/cc-hub`](https://github.com/m0a/cc-hub) は v0.2.98 でアーカイブされ、開発はこちらに移りました。既存のインストールはそのまま動きます — あちらは読み取り可能なまま残るので `cchub update` も解決し続けます。Hrdle は上書きではなく**並べて**インストールされる（別バイナリ・別サービス・別ポート・別 herdr セッション）ので、1台で両方動かせます。

## できること

- **セッションとペイン** — 複数のエージェントを並べて動かし、ペインを分割・ズーム・リサイズ・クローズできます。レイアウトは接続中の全クライアントで共有されます。処理中・入力待ち・完了のインジケータはペイン自体から検出するので hook は不要です。セッションを長押しすると色を割り当てられます。
- **タッチのための設計** — タブレットは分割レイアウトとドラッグ可能なフローティングキーボード、モバイルはペインタブバー付きのカスタムキーボード。ピンチズームと慣性スクロールに対応し、数字キーの長押しで記号を入力できます。デスクトップでは選択と同時にコピー、フォントサイズもショートカットで調整できます。
- **作業を読む** — 現在のセッションを会話形式で表示するチャットビューと、シンタックスハイライト・画像・Markdown・HTML に対応したファイルビューア。差分は Claude Code の編集と git のどちらでも表示できます。
- **履歴と検索** — 過去のセッションを閲覧・再開でき、全メッセージの全文検索と、全セッションを横断するプロンプト履歴検索が使えます。
- **ダッシュボード** — 5時間 / 7日サイクルの使用率、リセットまでの時間と現在のペースでのリミット到達予測、モデル別トークン使用量、コスト推定、CPU / メモリ / スワップの履歴、WebSocket の往復遅延。
- **複数マシン** — Tailscale 経由の peer サーバーを自動検出し、セッション・履歴・ダッシュボードを集約します。`hrdle send` / `hrdle peek` でそのいずれのペインも CLI から操作できます。
- **無人運用** — Tailscale 証明書による HTTPS、任意のパスワード認証、自動再起動と自動更新つきの systemd / launchd サービス。

UI は英語と日本語で、言語は自動判定されます。

## スマートグラス（EVEN Realities G2）

G2 用のコンパニオンアプリ（`glasses/`、EvenHub SDK 製）を使うと、グラスがセッションの
**読み取りと応答**の窓口になる。エージェントが判断を求めているのに画面の前にいない、
という場面のためのもの。

- **読んで答える** — 状態インジケータ付きのセッション一覧、会話ビュー、
  キーボードに触らず `AskUserQuestion` に答える choice モード
- **通知はブラウザではなくレンズに出る** — アプリが接続している間、hook イベントは
  90秒 TTL のリレーアイテムとして G2 の画面に載る。グラスが居ない・セッションを解決
  できない場合は従来どおりブラウザ通知が出るので、**通知が消えることはない**
- **音声入力** — G2 の SDK は生の PCM しか出さないため、書き起こしはサーバ側の
  `POST /api/glasses/stt`（Groq `whisper-large-v3-turbo`）で行う。
  **音声も API キーもこのホストから出ない**
- **エージェント自筆のメモ** — `hrdle glasses "<text>"` で、エージェントが一行だけ
  目の前に出せる。選択肢を付ければその場で answer できる。セッションは working directory
  から解決されるので、通常は指定不要
- **シミュレータ** — 同じアプリがブラウザ向けにもビルドされ `/glasses` で配信される。
  実機が無くても試せる

ビルドと配布は [`glasses/README.md`](glasses/README.md) を参照。
生成された `out.ehpk` を EVEN Hub にアップロードして配る。

## 必要環境

| 依存関係 | インストール方法 |
|---------|----------------|
| [Tailscale](https://tailscale.com/) | **最初に入れてください。** Linux: `curl -fsSL https://tailscale.com/install.sh \| sh` / macOS: `brew install tailscale`（App Store 版には証明書生成に必要な CLI が入っていません）。そのうえで `sudo tailscale set --operator=$USER` を一度だけ |
| [herdr](https://herdr.dev/) | 入っていなければインストーラが導入します（自分で入れる場合は `HRDLE_SKIP_HERDR=1`） |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` のあと一度サインイン。Codex / Grok Build / Kimi Code / OpenCode も使えます |

## インストール

**グラスまで含めて設定するなら**、[セットアップガイド](https://hrdle-setup.abe00makoto.workers.dev)
がマシン・エージェント・Tailscale・インストール・音声キー・接続まで一通り案内します（10分ほど）。
以下はその要約です。

Tailscale が入っていれば、これだけです:

```bash
curl -fsSL https://raw.githubusercontent.com/hrdle/hrdle/main/install.sh | bash
```

herdr が無ければ導入し、証明書生成を許可し、サービスを登録し、最後にスマホアプリで読む
ためのサーバーアドレスを QR コードで表示します。

インストーラが代行できないことが2つあります:

- **`sudo tailscale set --operator=$USER`** — パイプ経由のスクリプトから sudo はパスワード
  を尋ねられないので、認証情報がキャッシュされていない場合はこの行を表示してサービス登録
  の手前で止まります。実行してから `hrdle setup` を叩いてください。
- **パスワード。** 初期状態では、あなたの tailnet にサインインしているものなら何でも開け
  ます。ブラウザで認証を求めるには `hrdle setup -P mypassword` を実行してください。

`HRDLE_NO_SERVICE=1` でバイナリのみのインストール、`HRDLE_SKIP_HERDR=1` で herdr を自分で
入れる指定になります。

<details>
<summary>手動インストール</summary>

[Releases](https://github.com/hrdle/hrdle/releases/latest) から対応するバイナリ
（`hrdle-linux-x64` または `hrdle-macos-arm64`）をダウンロードし、PATH に置きます:

```bash
chmod +x hrdle-linux-x64
mv hrdle-linux-x64 ~/bin/hrdle
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

</details>

### サービスとして登録

`hrdle setup` で、システム起動時の自動起動（Linux は systemd、macOS は launchd）、
クラッシュ時の自動再起動、`hrdle update` による自動更新、そして再起動をまたいで
エージェントの会話を復元する常駐 herdr サーバーが有効になります。

セッションは herdr サーバーのプロセス内にあるため、**hrdle の再起動・更新ではセッションは
落ちません**。

## コマンド

```bash
# サーバー起動
hrdle                        # ポート5924で起動
hrdle -p 8080                # ポート指定
hrdle -P mypassword          # パスワード付きで起動

# サービス登録（自動再起動・自動更新）
hrdle setup -P mypassword
hrdle uninstall              # サービス登録を解除

# 更新
hrdle update                 # 最新版に更新
hrdle update --check         # 更新確認のみ
hrdle update --auto          # 自動更新モード（タイマー用）

hrdle status                 # サービスの状態
hrdle notify                 # hookイベント送信（stdinからJSON読み取り）

# このサーバーのアドレスを表示: グラスアプリの Connect 用の短縮形と、
# ブラウザ用の URL。（`hrdle qr` は旧名）
hrdle address

# リモートペイン制御（target: <peer>:<session>:<paneId>）
hrdle send <target> [text]   # ローカル/peerサーバーのペインに入力を送信
hrdle peek <target>          # ペインの現在のビューポートを取得

hrdle debug <sub>            # 稼働中サービスのBunインスペクタ操作
                             # sub: enable | disable | profile | status
```

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-p, --port` | ポート番号 | 5924 |
| `-H, --host` | バインドアドレス | 0.0.0.0 |
| `-P, --password` | 認証パスワード | なし |
| `-h, --help` | ヘルプ表示 | - |
| `-v, --version` | バージョン表示 | - |

**`hrdle send`** — `<target>` は `<peer>:<session>:<paneId>`（peer は `local`、peer ID、ニックネームのいずれか）:

| オプション | 説明 |
|-----------|------|
| `--stdin` | 引数の代わりにstdinからペイロードを読み取る |
| `--newline` | ペイロードに `\r` を追加（Enterを1回押す動作） |
| `--submit` | ブラケットペースト + Enter でラップ（Claude Code / Codex TUIへの送信、長文対応） |
| `--base64` | ペイロードをbase64として扱う（バイナリセーフ） |
| `--wait` | 送信後にペインのビューポートと検出状態（idle / processing / permission_prompt / ask_user_question）を表示 |
| `--wait-ms <n>` | `--wait` 時のスナップショットまでの遅延（デフォルト 800） |
| `--lines <n>` | ビューポートに含める末尾行数（デフォルト 20、`hrdle peek` でも使用可） |

**`hrdle debug`** — `--seconds <n>`（`profile` 用: N秒後に自動無効化）

## キーボードショートカット

| ショートカット | 操作 |
|--------------|------|
| `Ctrl+B` | セッションモーダルの切替 |
| `Ctrl+Shift+B` | ダッシュボードパネルの切替 |
| `Ctrl+D` | 縦分割（右） |
| `Ctrl+Shift+D` | 横分割（下） |
| `Ctrl+W` | ペインを閉じる |
| `Ctrl+Arrow` | ペイン間のフォーカス移動 |
| `Ctrl+Shift+Arrow` | アクティブペインのリサイズ |
| `Ctrl+Shift+=` | ペインサイズの均等化 |
| `Ctrl+1-9` | 番号でセッション切り替え |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | フォントサイズ 拡大 / 縮小 / リセット |
| `Ctrl+C`（選択時）/ `Ctrl+V` | コピー / 貼り付け |

## Hook通知

Claude Code が応答完了・入力待ちになったときにブラウザプッシュ通知を受け取れます。
`~/.claude/settings.json` に以下を追加してください:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "hrdle notify" }] }],
    "PostToolUse": [{
      "matcher": "AskUserQuestion",
      "hooks": [{ "type": "command", "command": "hrdle notify" }]
    }]
  }
}
```

Hrdle サーバーが起動している必要があります。初回アクセス時にブラウザの通知権限を許可して
ください。

セッションのインジケータ（処理中・入力待ち・完了）に hook は不要です — herdr がエージェント
の状態を自身で検出します。上記2つは、herdr からは見えない情報だけを運びます: 通知の本文と、
質問を出したツール名です。

hook は**非対話シェル**で実行されるため `.zshrc` / `.bashrc` は読まれません。PATH の追加を
そこに書いている場合（`~/bin` や `~/.local/bin` へのインストール）、名前だけでは解決できず
`command not found` で死にます。その場合は `which hrdle` の絶対パスを書いてください
（Hrdle の「hookを設定」ボタンは既に解決済みのパスを書き込みます）:

```json
{ "type": "command", "command": "/home/you/bin/hrdle notify" }
```

> v0.2.2 より前は `PreToolUse` / `UserPromptSubmit` も必要でしたが、今は不要です。残しても
> 害はありませんが、`PreToolUse` はツール呼び出しのたびに `hrdle notify` プロセスを起動する
> ので、外すと無駄が減ります。

## herdrバックエンド

Hrdle は全セッションを [herdr](https://herdr.dev/) のワークスペースとして実行し、
`hrdle setup` が必要な設定を一通り行います: 常駐する `herdr server`、
`~/.config/herdr/config.toml` の `resume_agents_on_restore = true`、そしてネイティブな
セッションID連携のための Claude / Codex integration hook。

herdr を後から更新する場合は `herdr update` → `systemctl --user restart herdr`。
`herdr update` はバイナリを置き換えるだけで稼働中のサーバーは旧版のまま動き続けるため、
反映には再起動が必要です。Hrdle はこのズレを検知してダッシュボードに警告を出し、ボタンから
両方を代行できます（再起動すると全ペインが張り直され、エージェントの会話は自動復元されます
が実行中のコマンドは失われるため、実行はユーザーが押したときだけです）。

> systemd/launchd 配下では `herdr update --handoff` を使わないでください。ハンドオフ先の
> サーバーが監視外に出てしまいます。

## 開発

[Bun](https://bun.sh/) 1.0+ が必要です。

```bash
bun install
bun run dev             # バックエンド + フロントエンド。http://localhost:5174 を開く

bun run dev:frontend    # フロントエンドのみ
bun run dev:backend     # バックエンドのみ
bun run test            # テスト実行
bun run test:e2e        # E2Eテスト
bun run lint            # リント
bun run build:binary    # シングルバイナリを ./dist/hrdle に生成
```

**技術スタック** — バックエンドは Bun / Hono / WebSocket、フロントエンドは React 19 /
Vite / Tailwind CSS v4 / xterm.js / react-i18next、ターミナルは herdr のソケット API と
ペインごとの制御ストリーム。

## アーキテクチャ

バックエンドサービス・API ルート・フロントエンドコンポーネント・hooks・WebSocket
プロトコル・共有型・主要データフローを 1 画面で確認できるインタラクティブなビューアを
[`architecture.html`](architecture.html)（データソース:
[`architecture.json`](architecture.json)）に同梱しています。

- ブラウザでレンダリングしたい場合は [raw.githack 経由](https://raw.githack.com/hrdle/hrdle/main/architecture.html)。JSON は HTML に埋め込み済みで追加 fetch 不要です。
- `architecture.json` を編集したら `python3 scripts/build-architecture-html.py` で埋め込みを更新してください。

## ライセンス

MIT
