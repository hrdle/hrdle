# CC Hub Glasses

EVEN Realities G2 スマートグラス用の CC Hub クライアントアプリ（EvenHub SDK 製、
`com.m0a.cchubglasses`）。CC Hub サーバに接続し、セッション一覧・会話・選択肢への
応答をグラスのディスプレイに表示する。スマホ側にはコンパニオン UI を出す。

## 機能

- セッション一覧（状態インジケータ付き）/ 会話ビュー / choice（AskUserQuestion への応答）の3モード
- `/ws/mux` WebSocket で `sessions-updated` 購読 + ターミナル出力受信（ANSI・非ASCII は除去して表示）
- REST（`/api/sessions`, `/api/dashboard`, 会話取得）でデータ補完
- 接続先 URL は localStorage（`cchub-url`）に保存

## 構成

- `src/main.ts` — アプリ状態・モード遷移・ページング
- `src/display.ts` — G2 ディスプレイ描画。実機計測値: 描画領域 576×288、ボディは 7 行 ×
  半角 52 字/行（CJK は約 1.86 倍幅として折り返し計算）
- `src/ws-client.ts` — CC Hub `/ws/mux` クライアント
- `src/api.ts` — REST クライアント
- `src/phone-ui.ts` — スマホ側コンパニオン UI
- `src/types.ts` — 型定義と整形ヘルパ

## ビルドと配布

```bash
bun run build       # 実機用 (--mode device) → dist、ehpk の中身
bun run build:web   # ブラウザ用 (base=/glasses/) → dist-web、CC Hub が配信
bun run pack        # evenhub pack → out.ehpk
bun run typecheck   # tsgo --noEmit
```

生成された `out.ehpk` を EVEN Hub にアップロードして配布する（`/glasses-upload`
スキルでビルド〜アップロードを自動化）。バージョンは `app.json` の `version` で管理。

ビルドが2種類あるのは、ehpk がルート基準のパスを必要とするのに対し、CC Hub 配信版は
`/glasses/` 配下に置かれるため。`public/` の背景写真も実機側には不要なので、
`--mode device` で除外している（`vite.config.ts` の `publicDir`）。

## ブラウザシミュレータ

実機なしで画面を確認できる。CC Hub が起動していれば `/glasses` で開ける。

```
https://<host>:5923/glasses
https://<host>:5923/glasses?bg=<画像URL>   # 背景を差し替える
```

表示は実機と同じ `screenText()` を通し、576×288 の canvas に描いて 16 階調へ量子化
しているので、折り返し・行数制限・解像度感が実機と一致する。「画面をコピー」で
枠付きテキストとして取得できる。

背景の既定は `public/scene-meeting.jpg`。
出典: [Unsplash](https://unsplash.com/photos/a-group-of-people-sitting-around-a-conference-room-LJ8vdm37J7Y)
（撮影: Walls.io、Unsplash License — 商用利用可・帰属不要）。表示比率に合わせて
1152×576 にクロップ済み。読み込めない場合は CSS で描いた室内シーンにフォールバックする。

## 注意: shared/types.ts との手動結合

このワークスペースは `shared/types.ts` を import せず、必要な型を `src/types.ts` に
複製している。バックエンド側で `MuxServerMessage` / `ControlServerMessage` などの
WebSocket プロトコルを変更した場合は、`src/ws-client.ts`・`src/types.ts` を追従させて
ehpk を再ビルドし、EVEN Hub で Beta 昇格まで行うこと。
