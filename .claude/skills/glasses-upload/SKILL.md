---
name: glasses-upload
description: G2グラスアプリをビルドしてEVEN Hubにアップロードする。「/glasses-upload」「グラスアップロード」「ehpkアップロード」「グラスデプロイ」などで起動する。
---

# G2 Glasses EVEN Hub Upload

EVEN Hub 上のアプリは **Hrdle**（Plugin ID `com.hrdle.glasses`）。表示名は本体と同じで、
「Glasses」が付くのはリポジトリ内で区別するときだけ。

**Plugin ID は変更できない。** Console の Store listing → Project details に表示専用で
出るだけで、Edit があるのは App name / tagline / icon / description / privacy のみ。ID を
変えるには ehpk を「Upload package」に落として**別プロジェクトを新規作成**するしかなく、
ビルド履歴・Testing group・Store listing は引き継がれない（2026-07-29 に cchub →
hrdle でこれを実施済み。旧 `com.m0a.cchubglasses` は Private のまま退避先として残置）。

## Workflow

1. **バージョンバンプ**: `glasses/app.json` の `version` をpatchインクリメント

2. **ビルド**:
   ```bash
   cd <repo>/glasses      # 例: /home/m0a/repos/hrdle-work-1/glasses
   bun run build
   ```
   ※ ルートが bun workspaces なので `npm run build` ではなく `bun run build` を使う
   ※ ワークスペースは複数ある（hrdle-work-1/2/3）ので、作業中のリポジトリの `glasses/` を使う

3. **ehpkパック**:
   ```bash
   bun run pack
   ```
   → `out.ehpk` が生成される。**版数が `app.json` とバンドルで一致していなければ止まる** —
   バンプしてビルドを忘れると、Hub は新しい番号を表示するのに実機は古い番号を名乗る、
   という一番たちの悪いずれ方をするため（`glasses/scripts/pack.ts`）
   ※ `npx @evenrealities/evenhub-cli pack` は npm が workspace の package.json を見てしまい "Missing script" で失敗する。`bunx evenhub` の形が確実

4. **コミット** & PR (必要に応じて main にマージ):
   ```bash
   git checkout -b chore/glasses-build-vX.X.X origin/main
   git add glasses/app.json glasses/out.ehpk glasses/src/
   git commit -m "chore(glasses): build vX.X.X ehpk ..."
   git push -u origin chore/glasses-build-vX.X.X
   gh pr create --base main --title "..." --body "..."
   gh pr merge --merge
   ```

5. **EVEN Hubにログイン**（agent-browser使用）:
   ```bash
   agent-browser --session-name evenhub open https://hub.evenrealities.com/hub
   agent-browser --session-name evenhub wait --load networkidle
   agent-browser --session-name evenhub set viewport 1280 800  # ← 必須: デフォルトは 393x852 (mobile) でレイアウト要素が viewport 外に出てしまい click が無視される
   agent-browser --session-name evenhub snapshot -i
   ```
   - ログイン済みセッションがあればスキップ
   - 未ログインの場合: 「Email」textbox に `$EVENHUB_EMAIL` を fill → 「Continue」 → 「Password」textbox に `$EVENHUB_PASSWORD` を fill → 「Continue」 (**2画面の段階フロー**)
   - クレデンシャルは環境変数から読み取る

6. **アプリ詳細ページに移動**:
   ```bash
   # "Hrdle" をクリック (viewport が 1280x800 以上ないと URL 遷移しないので注意)
   agent-browser --session-name evenhub click @eXX  # snapshot結果の Hrdle の ref
   agent-browser --session-name evenhub wait --load networkidle
   ```

7. **ビルドアップロード**:
   ```bash
   agent-browser --session-name evenhub click @eXX  # "Upload a build" のref
   sleep 3
   ```

   ファイル入力はCDP経由で設定する（modal は drag & drop ベースで通常の click では動作しない）。Page WS URL の取得:
   ```bash
   # /json/list を一度ファイルに落とす (シェルラッパで stdout 切り詰めが起きるため pipe で直接渡さない)
   rtk proxy curl -s http://127.0.0.1:<port>/json/list > /tmp/cdp-list.json
   python3 -c "
   import json
   with open('/tmp/cdp-list.json') as f:
       data = json.load(f)
   for t in data:
       if t.get('type') == 'page':
           print(t['webSocketDebuggerUrl'])
           break
   "
   # port は `agent-browser --session-name evenhub get cdp-url` の出力から
   ```

   取得した PAGE_WS で setFileInputFiles:
   ```python
   python3 << 'EOF'
   import json, asyncio, websockets

   PAGE_WS = "ws://127.0.0.1:<port>/devtools/page/<id>"

   async def main():
       async with websockets.connect(PAGE_WS, max_size=10*1024*1024) as ws:
           msg_id = 0
           async def send_cmd(method, params=None):
               nonlocal msg_id
               msg_id += 1
               await ws.send(json.dumps({'id': msg_id, 'method': method, 'params': params or {}}))
               while True:
                   resp = json.loads(await ws.recv())
                   if resp.get('id') == msg_id:
                       return resp

           await send_cmd('DOM.enable')
           doc = await send_cmd('DOM.getDocument', {'depth': -1})
           root = doc['result']['root']['nodeId']
           found = await send_cmd('DOM.querySelector', {'nodeId': root, 'selector': 'input[type=file]'})
           result = await send_cmd('DOM.setFileInputFiles', {
               'nodeId': found['result']['nodeId'],
               'files': ['<repo>/glasses/out.ehpk'],
           })
           print(f'Result: {json.dumps(result)}')

   asyncio.run(main())
   EOF
   ```

8. **チェンジログ入力 & 送信**:
   ```bash
   sleep 3
   agent-browser --session-name evenhub snapshot -i
   agent-browser --session-name evenhub fill @eXX "変更内容"  # Change log
   agent-browser --session-name evenhub click @eXX           # "Add build"
   agent-browser --session-name evenhub wait --load networkidle
   ```

9. **確認**: snapshot で新バージョンが `"vX.X.X Uploaded N seconds ago Private"` として表示されること

10. **Beta切り替え**:

    **Step A: 既存 Beta ビルドを Private に戻す**
    - ビルドリストで現 Beta ビルド (`"... Published ... Beta"`) を `agent-browser click` で展開
    - 展開パネル内の Beta バッジの位置を動的に取得:
      ```bash
      agent-browser --session-name evenhub eval '(() => {
        const badges = Array.from(document.querySelectorAll("*"))
          .filter(e => e.textContent === "Beta" && e.children.length === 0);
        return JSON.stringify(badges.map(b => {
          const r = b.getBoundingClientRect();
          return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
        }));
      })()'
      ```
      返ってきた座標のうち、**panel 内のもの (x が 800 前後 = 中央付近)** を選ぶ (panel 外の collapsed row 内バッジは x=1200 付近)
    - 中心座標 (x+w/2, y+h/2) に対して `document.elementFromPoint(...)?.click()`:
      ```bash
      agent-browser --session-name evenhub eval '(() => { document.elementFromPoint(826, 292)?.click(); return "clicked"; })()'
      ```
    - snapshot → 「Private」ref を click → 「Confirm」ref を click

    **Step B: 新ビルドを Beta に昇格**
    - リロードは**不要**（A 完了後そのまま続行可能）
    - 新ビルドを click で展開
    - 同じ要領で展開パネル内の `"Private"` バッジ座標を取得 → `elementFromPoint` で click
    - snapshot → 「Beta」ref を click → 「Promote to Beta」ref を click

    ※ snapshot ref ではバッジ click が効かないので必ず `elementFromPoint()` を使う
    ※ 座標は viewport やビルド件数で変わるので **必ず動的に取得** (固定座標はハードコードしない)

11. **ブラウザ終了**:
    ```bash
    agent-browser --session-name evenhub close
    ```

## Important Notes

- **viewport 設定が必須**: agent-browser のデフォルトは 393x852 (mobile)。Hrdle 詳細ページに遷移できなかったり、Beta バッジが viewport の外 (x=1200+) に出る。先頭で必ず `set viewport 1280 800`
- **bun を使う**: ルートが bun workspaces なので、`npm run build` / `npx evenhub pack` は workspace package.json と干渉して失敗する。`bun run build` / `bun run pack` を使う（`pack` は版数一致を検査してから evenhub CLI に渡す）
- **EVEN Hub CLI にアップロードコマンドはない**: ブラウザ自動化が必要
- **session-name evenhub でセッション永続化**: 一度ログインすれば再実行時はスキップできる
- **Beta バッジは snapshot ref では操作できない**: `elementFromPoint(x, y)?.click()` を使う。座標はバッジを `querySelectorAll` + `getBoundingClientRect` で動的取得
- **CDP `/json/list` の curl は file 経由で**: シェルラッパが stdout を `...(N bytes total)` に切り詰めることがある。直接 pipe ではなく `> /tmp/cdp-list.json` してから python3 で読む
- **EVEN Hub は public web (`hub.evenrealities.com`)** — Tailscale IP は不要 (Hrdle 本体の話と混同しないこと)
