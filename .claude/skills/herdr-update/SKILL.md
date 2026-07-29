---
name: herdr-update
description: herdr を新しいバージョンに上げる手順。hrdle は pane ごとに herdr のバイナリを子プロセスとして起動するので、バイナリを差し替えた瞬間から非互換が始まり、意図しないタイミングでサーバが再起動する。「herdr を更新して」「herdr のバージョンを上げて」「herdr が古い」「preview チャンネルに切り替えて」「hrdle が herdr のアップデート待ちと言っている」「更新したら壊れた/レジュームが壊れた」などで起動する。herdr 自体の操作（pane / tab / workspace）は別スキル（herdr）。
---

# herdr の更新

## まず知っておくこと: 「バイナリだけ先に、再起動は後で」は成立しない

hrdle は pane ごとに `herdr terminal session control` を**子プロセスとして起動する**
（`services/herdr-client.ts` の `PaneController`）。バイナリを差し替えた瞬間から、
新しい CLI が古いサーバと話すことになり、controller が起動即終了を繰り返す。
その混乱で systemd（`Restart=always`）が herdr を再起動し、**こちらが選んでいない
タイミングでサーバが新バイナリで上がる**。

2026-07-30 に実際に起きたこと（0.7.4 → 0.7.5）:

1. `~/.local/bin/herdr` を 0.7.5 に差し替え。サーバは 0.7.4 のまま
2. `herdr status server` が `compatible: no`、CLI の `agent list` が 0 件になる
3. hrdle のログに `controller exited` → `controller spawned` のループ（w4Y:p1）
4. herdr サーバが再起動。`session.json` から復元され、**workspace id が
   `w4W` → `w53` → `w54` と変わる**
5. ユーザーから「レジューム機能が壊れた気がした」と報告される
6. ログを見て「skew が実害を出している」と判断しバイナリを 0.7.4 に戻す —
   **しかしサーバはすでに 0.7.5 になっていた**ので、逆向きの非互換を作る
7. 気づいて 0.7.5 に戻し、ようやく整合

6 が二重の失敗になっている。**慌てて戻す前に `herdr status server` でサーバ側の
バージョンを見る。** 差し替えの結果としてサーバが再起動していれば、戻すべきは
バイナリではなく判断のほう。

## 正しい手順

### 1. 影響を確認して、必要なら合意を取る

再起動は**全 pane の PTY を張り直す**。

- エージェントの会話は戻る（`~/.config/herdr/config.toml` の
  `resume_agents_on_restore = true` を確認する）
- **実行中のコマンドは戻らない**
- workspace id は変わる（ラベルは維持される）
- **自分がその pane の中にいるなら、自分も再起動される。** 作業中なら要点を
  書き出してから実行する

### 2. 事前に記録する

復元されたかを後で言えるようにする。

```bash
herdr --version
herdr status server                      # version / protocol / compatible
herdr workspace list                     # ラベルと pane 数
herdr agent list                         # エージェント数と native session id
grep resume_agents_on_restore ~/.config/herdr/config.toml
```

### 3. hrdle 経由で適用する

```bash
curl -sk -X POST https://localhost:5924/api/herdr/apply-update
```

Web UI のダッシュボードのボタンでも同じ。中身は systemd 環境なら
`herdr update` → `systemctl --user restart herdr` の順で、`herdr update` が
成功しなければ再起動には進まない（`services/herdr-update.ts` の
`buildHerdrApplyCommands`）。

**これが唯一の正しい経路。** hrdle のサーバプロセスは herdr の外にいるので
`herdr update` が通る。pane の中から叩くと弾かれる（下記）。

`canApply: false` のときはボタンが出ない。`GET /api/dashboard` の `herdrUpdate` を見る:

```json
{"binaryVersion":"0.7.5","serverVersion":"0.7.5","restartNeeded":false,"canApply":false}
```

### 4. 復元を確認する

```bash
herdr status server                      # compatible: yes、version が新しい方
herdr agent list                         # 数が事前と一致するか
curl -sk https://localhost:5924/api/sessions | jq '.sessions | length'
```

## やらないこと

- **pane 内から `herdr update`** — `update failed: run 'herdr update' outside herdr
  after detaching from the session` で拒否される。エージェントは基本 pane の中にいる
- **`herdr update --handoff`** — `CLAUDE.md` が明示的に禁じている。引き継がれたサーバは
  supervise されない
- **バイナリを手で差し替える**（`gh release download` → `mv`）— 冒頭の事故がこれ。
  実行中のバイナリは `cp` できず `Text file busy` になるので `mv` で入れ替わるが、
  入れ替わった瞬間から非互換が始まる
- **`hrdle update --auto` のタイマーから走らせる** — hrdle 側で意図的に排除されている。
  再起動は人が選ぶ

## 特定のバージョンに上げたいとき

`herdr update` は最新の安定版に上げる。preview や特定バージョンが必要な場合、
`gh release list --repo ogulcancelik/herdr` で確認できるが、**手動差し替えは上記の
理由で避ける**。preview チャンネルへの切り替え手段が herdr 側にあるかを先に調べる
（`herdr update --help` は `[--handoff]` しか出さないので、チャンネル指定は別経路）。

## 関連

- 修正が入っているかを releases の日付で判断しない。issue の作成日と比べる。
  2026-07-23 に報告された [herdr#1789](https://github.com/ogulcancelik/herdr/issues/1789)
  は 2026-07-21 の v0.7.5 には入っておらず、v0.7.5 に上げても再現した（実測）
- herdr 自体の操作は `herdr` スキル（`~/.claude/skills/herdr/` — herdr のリポジトリ
  そのものなので書き込まない）
