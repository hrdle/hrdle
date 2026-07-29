---
name: hrdle-profile
description: Hrdle 本番サービスの Bun inspector を一時的に on にして、Chrome DevTools で CPU プロファイル / heap snapshot を取得するためのスキル。「CPUが高い」「プロファイル取って」「flame chart 見たい」「inspect modeで見たい」「heap snapshot 取って」「JS関数レベルでホットスポット調べて」などのリクエストで起動する。アイドル時はオーバーヘッドゼロで、必要な時だけ inspector を開いて閉じる運用。
---

# hrdle-profile

## 起動条件

`hrdle.service` が systemd-user 上で稼働している前提。Linux 限定 (macOS launchd は未対応)。`hrdle --version` が `v0.1.127` 以上。

## 基本コマンド

```bash
hrdle debug profile --seconds N   # N 秒だけ inspector を開いて自動 disable
hrdle debug enable                 # 開けっぱなしモード (手動 disable 必要)
hrdle debug disable                # 通常モードへ戻す
hrdle debug status                 # 現在の状態
```

## デフォルトのフロー — Claude 側で完結 (推奨)

同梱の `scripts/profile.ts` が CDP の WebSocket を直接叩いて `.cpuprofile` を取る。
**Chrome / DevTools を立ち上げる必要はなく、Claude セッション内で完結する。**

```bash
# Hrdle プロジェクト内から:
bun .claude/skills/hrdle-profile/scripts/profile.ts profile --seconds 30 --out /tmp/p.json
```

内部の流れ:
1. `hrdle debug enable` で inspector を起動
2. journal から WS URL を取得
3. WebSocket で `ScriptProfiler.startTracking` → `--seconds N` sleep → `ScriptProfiler.stopTracking`
4. `trackingComplete` のサンプル群を `--out` のパスに JSON で保存
5. `hrdle debug disable` で元に戻す (`try/finally` 保護)

集計:

```bash
# 全体トップ (self time + total time)
bun .claude/skills/hrdle-profile/scripts/profile.ts analyze /tmp/p.json

# 特定関数を含むスタックの leaf 集計
bun .claude/skills/hrdle-profile/scripts/profile.ts drill /tmp/p.json buildSessionsList
```

サンプル取得中は **実負荷をかける** こと (curl で `/api/dashboard` や `/api/sessions` をループ叩き、または実 UI 操作)。アイドル時に取っても何も浮かばない。

## ローカル Chrome 経由 (オプション)

`.cpuprofile` を Chrome DevTools / VS Code の Performance / CPU profiler で開きたい場合:

1. `hrdle debug profile --seconds 60` を実行
2. journal から `https://debug.bun.sh/#<IP>:9229/<token>` を取り出す
3. ローカル Chrome の `chrome://inspect` で Configure に `<TAILSCALE_IP>:9229` を追加 → hrdle remote target → inspect
4. Performance タブ → Record → 操作再現 → Stop → 右クリックで `.cpuprofile` 保存
5. 60s 経過で自動 disable

> **agent-browser 経由は不可**: HTTPS の debug.bun.sh から `ws://` の mixed-content / WebSocket 接続まわりの制約で Timeline のイベント列が空になる。Claude 側からの取得は必ず上記の `scripts/profile.ts` ルートを使う。

## 開けっぱなしモード

調査を対話的に続けたい場合のみ:

```bash
hrdle debug enable
# … 調査 …
hrdle debug disable    # 必ず手動で戻すこと
```

`hrdle debug status` が `🟢 Inspector enabled` のままなら忘れているサイン。必ず元に戻す。

## 接続検証 (UI を使わず)

inspector が生きているかだけ確認したい時:

```bash
curl -s http://localhost:9229/json/version
# {"Protocol-Version":"1.3","Browser":"Bun","User-Agent":"Bun/...","WebKit-Version":"...","Bun-Version":"..."}
```

レスポンスが返れば inspector は健全。

## 取れるもの

- **CPU profile** (.cpuprofile): JS 関数名・ファイル・行番号付きで実行時間サンプリング。`buildSessionsList` の中のどの関数が遅い、までわかる
- **Heap snapshot**: メモリ使用量の object grouping。リーク調査
- **Sources**: 実行中の TS/JS にブレークポイントを置いて step 実行 (本番では基本やらない)

## 注意事項

- inspector mode への切替時にサーバを **systemctl restart** する。WebSocket クライアントは一旦切断 → 自動再接続するが、進行中のリクエストは落ちる。アクティブな操作中は避ける
- inspector port (9229) は `0.0.0.0` で listen する。tailnet 経由でしかアクセスできないなら良いが、もしポート公開設定があるなら enable 中は要注意
- `profile.ts profile ...` / `hrdle debug profile` は途中で Ctrl-C すると drop-in が残る可能性がある。中断したら `hrdle debug disable` を手動で実行
- 仕組み的には `~/.config/systemd/user/hrdle.service.d/99-inspect.conf` の有無で切り替わる。直接編集も可能だが、CLI 経由が安全
- アイドル時に profile を取っても `stackTraces: []` で空になりやすい。**サンプリング中は必ず curl / 実 UI 操作で負荷をかける**こと
- 🚨 `scripts/profile.ts` の中で `Inspector.enable` / `Debugger.enable` / `Runtime.enable` を呼ばないこと。これらは JSC を debugger-attached 状態にして `ScriptProfiler` のサンプリングを止める。`ScriptProfiler.startTracking` を直接叩くだけで十分

## 参照

- 実装: `backend/src/commands/debug.ts`
- 追加バージョン: v0.1.127 (CHANGELOG 参照)
- Bun docs: https://bun.sh/docs/runtime/debugger
