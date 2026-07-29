# Hrdle

日本語 | [English](README.md)

コーディングエージェントのセッションをリモート管理するWebベースのターミナルマネージャー。Claude Code / Codex / Grok / Kimi をサーバーで動かし、タブレットやスマートフォンから操作できます。

> **旧称 CC Hub。** [`m0a/cc-hub`](https://github.com/m0a/cc-hub) は v0.2.98 でアーカイブされ、開発はこちらに移りました — 名前が Claude Code を指していましたが、実際にはとうにそれだけではなくなっていたためです。既存のインストールはそのまま動きます: あちらは読み取り可能なまま残るので、リリース資産と `install.sh` は利用でき、`cchub update` も解決し続けます。Hrdle は上書きではなく**並べて**インストールされる（別バイナリ・別サービス・別ポート・別 herdr セッション）ので、1台で両方動かせます。

## 機能

- **マルチセッション管理** - 複数のエージェントセッション（Claude Code / Codex / Grok / Kimi）を同時に実行・切り替え
- **マルチペインターミナル** - herdrバックエンドによるペイン分割・リアルタイムレイアウト同期（全クライアント共有）
- **ペイン操作** - ズーム、リサイズ、フォーカス、クローズをキーボードショートカットまたはセッションモーダルUIから操作
- **チームエージェント表示** - ペイン一覧やモバイルタブバーにエージェント名と色を表示
- **セッション色テーマ** - セッションごとに色を設定して視覚的に区別
- **デスクトップ対応** - テキスト選択＆自動コピー、フォントサイズ調整（Ctrl+=/-)
- **タブレット最適化UI** - 分割レイアウト、フローティングキーボード、ピンチズーム
- **モバイル対応** - タップ/長押しでカスタムキーボード表示、ペインタブバーで複数ペイン切り替え、慣性スクロール
- **ファイルビューア** - シンタックスハイライト付きコード表示、画像・Markdown・HTMLプレビュー
- **変更追跡** - Claude Codeの編集差分とGit差分の表示（Claude/Gitモード切替対応）
- **ブラウザバックナビゲーション** - ブラウザの戻るジェスチャーでFileViewer内を遷移
- **Tailscale連携** - Tailscale証明書による安全なHTTPS接続
- **パスワード認証** - `-P`オプションでアクセス制限
- **自動更新** - GitHub Releasesからの自動アップデート
- **サービス連携** - systemd（Linux）/ launchd（macOS）によるサービス登録・自動再起動
- **ダッシュボード** - 使用量リミット表示、日別統計、コスト推定、システムメトリクス、ネットワーク遅延
- **セッション履歴** - 過去のClaude Codeセッション閲覧・再開・全文検索
- **会話ビューア** - Markdownレンダリング、画像表示、システムサマリー区別表示
- **プロンプト検索** - 全セッションにまたがるプロンプト履歴の検索
- **セッションインジケータ** - 処理中・入力待ち・完了を一覧で把握（ペイン自体から検出するのでhook不要）
- **Hook通知** - Claude Codeイベント（応答完了、入力待ち等）のブラウザプッシュ通知
- **Codex対応** - Claude Codeと並行してCodex CLIセッションを実行（会話ビュー、使用量トラッキング）
- **チャットビュー** - ターミナルの代わりに現在のセッションを会話形式で表示
- **Peerサーバー** - 複数のHrdleサーバーをTailscale経由で連携（自動検出、セッション/履歴/ダッシュボードの集約）
- **リモートペイン制御** - `hrdle send` / `hrdle peek` でローカル・peerサーバーのペインをCLIから操作
- **スマートグラス** - EVEN Realities G2 でセッションを読み、質問に答える（下記）
- **多言語対応** - 英語・日本語UIの自動言語検出
- **オンボーディング** - 初回ユーザー向けスポットライト式操作ガイド

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

## インストール

### ワンラインインストール（推奨）

```bash
curl -fsSL https://raw.githubusercontent.com/hrdle/hrdle/main/install.sh | bash
```

### 手動インストール

1. [Releases](https://github.com/hrdle/hrdle/releases/latest) から対応するバイナリをダウンロード
   - Linux x64: `hrdle-linux-x64`
   - macOS ARM64: `hrdle-macos-arm64`

2. 実行権限を付与して配置

```bash
chmod +x hrdle-linux-x64
mv hrdle-linux-x64 ~/bin/hrdle
```

3. PATHに追加（未設定の場合）

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## 必要環境

| 依存関係 | 必須 | インストール方法 |
|---------|-----|----------------|
| [Tailscale](https://tailscale.com/) | ○ | Linux: https://tailscale.com/download / macOS: `brew install tailscale` |
| [herdr](https://herdr.dev/) | ○ | `curl -fsSL https://herdr.dev/install.sh \| sh` / `brew install herdr` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ○ | `npm install -g @anthropic-ai/claude-code` |

## クイックスタート

```bash
# 1. Tailscale証明書生成を許可（初回のみ）
sudo tailscale set --operator=$USER

# 2. Hrdle起動
hrdle
# または パスワード付き
hrdle -P mypassword

# 3. ブラウザでアクセス
#    https://<your-hostname>:5924
```

### サービスとして登録

```bash
hrdle setup -P mypassword
```

これにより以下が有効になります：
- システム起動時に自動起動（LinuxはsystemD、macOSはlaunchd）
- クラッシュ時の自動再起動
- `hrdle update` による自動更新

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

# Hook通知（Claude Code hookから使用）
hrdle notify                 # hookイベント送信（stdinからJSON読み取り）

# 状態確認
hrdle status

# リモートペイン制御（target: <peer>:<session>:<paneId>）
hrdle send <target> [text]   # ローカル/peerサーバーのペインに入力を送信
hrdle peek <target>          # ペインの現在のビューポートを取得

# デバッグ
hrdle debug <sub>            # 稼働中サービスのBunインスペクタ操作
                             # sub: enable | disable | profile | status
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `-p, --port` | ポート番号 | 5924 |
| `-H, --host` | バインドアドレス | 0.0.0.0 |
| `-P, --password` | 認証パスワード | なし |
| `-h, --help` | ヘルプ表示 | - |
| `-v, --version` | バージョン表示 | - |

**`hrdle send` オプション** — `<target>` は `<peer>:<session>:<paneId>`（peer は `local`、peer ID、ニックネームのいずれか）:

| オプション | 説明 |
|-----------|------|
| `--stdin` | 引数の代わりにstdinからペイロードを読み取る |
| `--newline` | ペイロードに `\r` を追加（Enterを1回押す動作） |
| `--submit` | ブラケットペースト + Enter でラップ（Claude Code / Codex TUIへの送信、長文対応） |
| `--base64` | ペイロードをbase64として扱う（バイナリセーフ） |
| `--wait` | 送信後にペインのビューポートと検出状態（idle / processing / permission_prompt / ask_user_question）を表示 |
| `--wait-ms <n>` | `--wait` 時のスナップショットまでの遅延（デフォルト 800） |
| `--lines <n>` | ビューポートに含める末尾行数（デフォルト 20、`hrdle peek` でも使用可） |

**`hrdle debug` オプション**: `--seconds <n>`（`profile` 用: N秒後に自動無効化）

### Tailscale設定

初回のみ証明書生成を許可する設定が必要です：

```bash
sudo tailscale set --operator=$USER
```

> **macOSの場合**: App Store版ではなく、`brew install tailscale`でインストールしてください。App Store版はCLIコマンドが使えないため、証明書生成が動作しません。

### herdrバックエンド

Hrdleは全セッションを [herdr](https://herdr.dev/) のワークスペースとして実行します。`hrdle setup` が必要な設定を一通り行います：常駐する `herdr server`（Linux: systemd / macOS: launchd）、`~/.config/herdr/config.toml` の `resume_agents_on_restore = true`（サーバー再起動をまたいでエージェントの会話が復元される）、Claude Code integration hook（ネイティブなセッションID連携）。

セッションはherdrサーバーのプロセス内にあるため、**hrdleの再起動・更新ではセッションは落ちません**。

herdrを後から更新する場合は `herdr update` → `systemctl --user restart herdr`。`herdr update` はバイナリを置き換えるだけで稼働中のサーバーは旧版のまま動き続けるため、反映には再起動が必要です。Hrdleはこのズレを検知してダッシュボードに警告を出し、ボタンから両方を代行できます（再起動すると全ペインが張り直され、エージェントの会話は自動復元されますが実行中のコマンドは失われるため、実行はユーザーが押したときだけです）。

> systemd/launchd配下では `herdr update --handoff` を使わないでください。ハンドオフ先のサーバーが監視外に出てしまいます。

## 使い方

1. ブラウザでHrdleを開く
2. 「新規セッション」でClaude Codeセッションを作成
3. ターミナルでClaude Codeを操作
4. ファイルアイコンでファイルビューアを開く

### キーボードショートカット

Hrdleはペインレイアウトをリアルタイムで同期します。接続中の全クライアントが同じペインレイアウトを共有します。

**ペイン・セッション操作**:
| ショートカット | 操作 |
|--------------|------|
| `Ctrl+B` | セッションモーダルの切替 |
| `Ctrl+Shift+B` | ダッシュボードパネルの切替 |
| `Ctrl+D` | 縦分割（右） |
| `Ctrl+Shift+D` | 横分割（下） |
| `Ctrl+W` | ペインを閉じる |
| `Ctrl+Shift+Arrow` | アクティブペインのリサイズ |
| `Ctrl+Shift+=` | ペインサイズの均等化 |
| `Ctrl+Arrow` | ペイン間のフォーカス移動 |
| `Ctrl+1-9` | 番号でセッション切り替え |

**フォントサイズ・クリップボード（デスクトップ）**:
| ショートカット | 操作 |
|--------------|------|
| `Ctrl+=` または `Ctrl++` | フォントサイズ拡大 |
| `Ctrl+-` | フォントサイズ縮小 |
| `Ctrl+0` | フォントサイズをデフォルトにリセット |
| `Ctrl+C`（選択時） | 選択テキストをコピー |
| `Ctrl+V` | クリップボードから貼り付け |

**セッションモーダル**（`Ctrl+B`）: ペイン数バッジ付きのセッション一覧を表示。展開すると個別ペインのフォーカス・クローズ・分割操作が可能。

### セッション色テーマ

セッションに色を設定して視覚的に区別できます：

1. セッション一覧でセッションを**長押し**
2. 色選択メニューが表示される
3. 9色（red, orange, amber, green, teal, blue, indigo, purple, pink）+ なしから選択
4. ターミナル背景色が選択した色に変化

### タブレットモード

画面幅640px以上、高さ500px以上で自動的にタブレットレイアウトに切り替わります：
- 左: ターミナル（分割ペイン対応、ピンチズームで拡大縮小可能）
- セッションモーダル（`Ctrl+B`）でセッション切り替え
- フローティングキーボード（ドラッグ移動、最小化対応）

**ピンチズーム**: ターミナル部分を2本指でピンチすると拡大縮小できます。UIコントロールはズームの影響を受けません。

### キーボード機能

**モバイル（スマートフォン）**:
- ターミナルを**タップ**または**長押し**でカスタムキーボードを表示
- OSの標準キーボードは起動しません
- スクロールでキーボードを閉じる

**フローティングキーボード（タブレット）**:
- ヘッダーをドラッグして位置を移動
- 最小化ボタンでコンパクト表示
- 日本語モードとキーボードモードで位置を別々に記憶

**キー操作**:
- **長押し** - 数字キーで記号入力（1→!, 2→@など）
- **あ** - 日本語入力モードに切り替え（OS標準IMEを使用）
- **ABC** - キーボードモードに戻る

### ダッシュボード

「Dashboard」タブで以下の情報を確認できます：

- **使用量リミット** - 5時間/7日サイクルの使用率、リセットまでの時間
- **リミット到達予測** - 現在のペースでリミットに到達する時間の予測
- **日別統計** - メッセージ数・セッション数の推移グラフ
- **モデル使用量** - Opus/Sonnetのトークン使用量比較
- **コスト推定** - API使用料金の概算
- **システムメトリクス** - CPU・メモリ・スワップ使用率の履歴グラフ
- **ネットワーク遅延** - WebSocketの往復遅延

### セッション履歴

「履歴」タブで過去のClaude Codeセッションを閲覧できます：

- プロジェクト別にグループ化
- 会話内容の表示（Markdown対応）
- セッションの再開（`claude -r`で続きから）
- 全文検索（全ユーザーメッセージを検索）

### Hook通知

Claude Codeが応答完了・入力待ち状態になった時にブラウザプッシュ通知を受け取れます。`~/.claude/settings.json` に以下を追加してください：

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

Hrdleサーバーが起動している必要があります。初回アクセス時にブラウザの通知権限を許可してください。

セッションのインジケータ（処理中・入力待ち・完了）にhookは不要です — herdrがエージェントの状態を自身で検出します。上記2つのhookは、herdrからは見えない情報だけを運びます：通知の本文（`Stop`）と、質問を出したツール名（`PostToolUse`/`AskUserQuestion`）。

> v0.2.2より前は `PreToolUse` / `UserPromptSubmit` も必要でしたが、今は不要です。設定済みのまま残しても害はありませんが、`PreToolUse` はツール呼び出しのたびに `hrdle notify` プロセスを起動するので、外すと無駄が減ります。

## 開発環境セットアップ

開発やソースからビルドする場合は [Bun](https://bun.sh/) 1.0+ が必要です。

```bash
# 依存関係のインストール
bun install

# 開発サーバー起動
bun run dev
```

ブラウザで http://localhost:5174 を開きます（開発モード）。

### ソースからビルド

```bash
# シングルバイナリとしてビルド
bun run build:binary
./dist/hrdle
```

### 開発コマンド

```bash
bun run dev:frontend    # フロントエンドのみ
bun run dev:backend     # バックエンドのみ
bun run test            # テスト実行
bun run test:e2e        # E2Eテスト
bun run lint            # リント
```

## 技術スタック

- **Backend**: Bun, Hono, WebSocket
- **Frontend**: React 19, Vite, Tailwind CSS v4, xterm.js, react-i18next
- **Terminal**: herdr（NDJSONソケットAPI + ペインごとの制御ストリーム）

## アーキテクチャ

バックエンドサービス・API ルート・フロントエンドコンポーネント・hooks・WebSocket プロトコル・共有型・主要データフローを 1 画面で確認できるインタラクティブなビューアを [`architecture.html`](architecture.html)（データソース: [`architecture.json`](architecture.json)）に同梱しています。

- ブラウザでレンダリングしたい場合は [raw.githack 経由](https://raw.githack.com/hrdle/hrdle/main/architecture.html)。JSON は HTML に埋め込み済みで追加 fetch 不要です。
- `architecture.json` を編集したら `python3 scripts/build-architecture-html.py` で埋め込みを更新してください。

## ライセンス

MIT
