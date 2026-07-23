# Contributing to HunkMark

Thank you for helping improve HunkMark.

## Development

Use Node.js 22.13 or later.

```sh
npm ci
npm run verify
```

Build the Chrome Web Store package with:

```sh
npm run package
```

The generated ZIP and SHA-256 checksum are written to `dist/`.

## Releases

Publishing a GitHub Release from a `v<version>` tag runs the release workflow
and attaches the generated ZIP and SHA-256 checksum to that release. The tag
must match the version in `manifest.json`.

## Pull requests

- Keep changes focused on GitHub pull-request diff review.
- Add or update tests for behavior changes.
- Run `npm run verify` before opening a pull request.
- Update user-facing documentation when behavior, permissions, or data handling changes.
- Do not commit credentials, private diff fixtures, personal data, or generated release archives.
- Preserve the extension's minimum-permission, no-remote-code, and local-data-handling boundaries.

Bug reports should avoid private repository URLs, diff contents, account identifiers, and other confidential information.

By submitting a contribution, you agree that it is licensed under the repository's MIT License.
