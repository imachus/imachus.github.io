# MV「まだ ここから」

`storyboard.json` のストーリーボード（10 セクション／45 カット）から、FAL で映像を生成して曲に合わせて編集します。

- セクションの開始秒は曲ファイルに埋め込まれた歌詞タイミング（`assets/lyrics_timed.srt`）から取得しています。
- 各カットの尺は、セクションの長さをカット数で均等に割って決めます（`"weight"` を付けると配分を変えられます）。

## 準備

```sh
pip install fal-client imageio-ffmpeg pillow
export FAL_KEY=...                 # fal.ai の API キー
cp <曲ファイル> assets/song.m4a
cp <イメージ画像> assets/reference.png
```

## 実行

```sh
python3 make_mv.py --ref assets/reference.png --stage keyframes   # まず静止画だけ作って確認
python3 make_mv.py --ref assets/reference.png                     # 動画化して out/mv.mp4 を書き出し
```

| オプション | 内容 |
|---|---|
| `--only s05_old_photo ...` | 指定したカットだけ生成 |
| `--video-mode kenburns` | 動画モデルを使わず、静止画のズームで仮編集（安価なプレビュー） |
| `--burn-subs` | 歌詞を画面に焼き込む（字幕なしの場合は `out/lyrics.srt` を別途アップロード） |
| `--image-model` / `--video-model` | FAL のモデル ID（既定: `fal-ai/nano-banana/edit` / `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`） |
| `--dry-run` | FAL を呼ばずにプレースホルダで全工程をテスト |

生成物は `work/` にキャッシュされるため、再実行すると足りない分だけ作ります。
カットを作り直すときは `work/keyframes/<id>.png` と `work/clips/<id>.mp4` を消して再実行してください。
