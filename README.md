# HunkMark

GitHub Pull Request の **Files changed** 画面に、hunk・行単位の `Viewed` と折りたたみ機能を追加する Chrome 拡張です。

> HunkMark は独立したオープンソースプロジェクトであり、GitHub, Inc. とは提携していません。GitHub は GitHub, Inc. の商標です。

## 主な機能

- hunk と追加・削除行を個別に `Viewed` に設定
- 行のコントロールを上下へドラッグして範囲をまとめて切り替え
- 確認済み hunk の自動折りたたみと、任意の `Collapse / Expand`
- ファイルごと・ページ全体のレビュー進捗を表示
- Split diff の左右を連動、または独立して操作
- GitHub アカウント、PR、表示コミット範囲ごとに状態をローカル保存
- ファイル内の diff が完全に読み込まれた場合だけ、GitHub 公式のファイル単位 `Viewed` と一方向に同期
- GitHub の遅延読み込みやページ内遷移後にも自動復帰

## インストール

Chrome Web Store 公開前は、リポジトリを取得してデベロッパーモードで読み込みます。

```sh
git clone https://github.com/Pon57/HunkMark.git
```

1. Chrome で `chrome://extensions` を開く
2. 「デベロッパー モード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」を選ぶ
4. クローンした `HunkMark` フォルダーを指定する
5. GitHub の PR の **Files changed** を再読み込みする

更新後は `chrome://extensions` で HunkMark を再読み込みしてください。

## レビュー状態

- 確認状態は `chrome.storage.local` にだけ保存し、外部へ送信しません
- 内容・変更ブロック・前後の文脈が安定した行だけ状態を引き継ぎ、編集・移動・不可視 Unicode の変更は未確認へ戻します
- `Reset page` は現在表示しているコミット範囲の状態だけを削除します
- GitHub 公式の `Viewed` は自動解除せず、ユーザーが手動解除した場合はその操作を尊重します

保存期間や処理するデータの詳細は [PRIVACY.md](PRIVACY.md)、状態引き継ぎと同期の設計は [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

## 対応範囲

- GitHub.com の Pull Request の **Files changed** 画面
- Unified / Split のソース diff
- 従来の table 型 diff と React/grid 型 diff
- Chrome Manifest V3

GitHub Enterprise Server、コミット単体の diff、リッチ diff は現在の対象外です。

## 開発

Node.js 22.13 以降で次を実行できます。

```sh
npm install
npm run verify
npm run package
```

`npm run package` は Chrome Web Store 用の `dist/hunkmark-<version>.zip` を生成します。

## ドキュメント

- [CHANGELOG.md](CHANGELOG.md): 変更履歴
- [CONTRIBUTING.md](CONTRIBUTING.md): 開発・コントリビューション手順

## License

MIT © Pon
