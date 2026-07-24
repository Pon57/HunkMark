# HunkMark

[日本語](README.ja.md)

A Chrome extension that adds hunk-level and line-level `Viewed` controls and hunk collapsing to GitHub pull request **Files changed** pages.

> HunkMark is an independent open-source project and is not affiliated with GitHub, Inc. GitHub is a trademark of GitHub, Inc.

## Features

- Mark individual hunks and added or deleted lines as `Viewed`
- Drag line controls up or down to update a range at once
- Automatically collapse reviewed hunks, with manual `Collapse / Expand` controls
- Track review progress per file and across the page
- Link the two sides of a split diff or review them independently
- Save state locally per pull request and displayed commit range
- One-way sync to GitHub's file-level `Viewed` control only when the complete file diff is loaded
- Restore controls after GitHub lazy loading and client-side navigation

## Installation

Until HunkMark is available in the Chrome Web Store, clone the repository and load it in developer mode.

```sh
git clone https://github.com/Pon57/HunkMark.git
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the cloned `HunkMark` directory.
5. Reload the **Files changed** page of a GitHub pull request.

After updating the repository, reload HunkMark from `chrome://extensions`.

## Review state

- Review state is stored only in `chrome.storage.local` and is never sent elsewhere.
- A line keeps its state only while its content, changed block, and surrounding context remain stable. Edits, relocation to a different context, and invisible Unicode changes reset it to unviewed.
- `Reset page` removes state only for the currently displayed commit range.
- HunkMark never automatically clears GitHub's file-level `Viewed` state and respects manual changes made by the user.

See [PRIVACY.md](PRIVACY.md) for retention and data-handling details, and [ARCHITECTURE.md](ARCHITECTURE.md) for the state-restoration and synchronization design.

## Supported pages

- GitHub.com pull request **Files changed** pages
- Unified and split source diffs
- Legacy table-based diffs and React/grid-based diffs
- Chrome Manifest V3

GitHub Enterprise Server, individual commit diffs, and rich diffs are not currently supported.

## Development

Use the active Node.js LTS release.

```sh
npm install
npm run verify
npm run package
```

`npm run package` creates `dist/hunkmark-<version>.zip` for the Chrome Web Store.

## Documentation

- [README.ja.md](README.ja.md): Japanese README
- [CHANGELOG.md](CHANGELOG.md): release history
- [CONTRIBUTING.md](CONTRIBUTING.md): development and contribution guide

## License

MIT © Pon
