# Architecture

HunkMark runs as a set of ordered Manifest V3 content scripts. Chrome loads the files listed in `manifest.json` into the same isolated world, so the modules extend one `HunkMarkContent.App` class without a runtime bundler or remote code.

## Modules

| File | Responsibility |
| --- | --- |
| `core.js` | Pure URL parsing, hashing, storage-key generation, and aggregate review state |
| `content/app.js` | Application state, constants, and dependency injection |
| `content/discovery.js` | GitHub DOM adaptation and hunk/changed-line discovery |
| `content/storage.js` | Review-state retention and storage bounds |
| `content/official-viewed.js` | One-way synchronization with GitHub's file-level Viewed control |
| `content/controllers.js` | Hunk and line controllers, UI state, and persistence |
| `content/drag.js` | Drag-range selection and persistence |
| `content/panel.js` | Progress UI, preferences, and current-page reset |
| `content/lifecycle.js` | Refresh scheduling, DOM/storage observation, navigation, and teardown |
| `content.js` | Dependency checks and application startup only |

## Invariants

- Review state is scoped by the signed-in GitHub viewer, pull request, and displayed commit range. `All commits` and each selection made through GitHub's commit picker are independent. Signed-out GitHub uses a separate anonymous scope. If neither a viewer identity nor an explicit signed-out state can be established, HunkMark fails closed and does not initialize review state.
- A hunk key includes the displayed-review scope, file path, normalized hunk signature, and duplicate-hunk occurrence.
- A line key is independent of hunk boundaries and includes the displayed-review scope, file path, change kind, exact content after line-ending normalization, file-wide occurrence, and total identical-line count. Its stored value also carries a context fingerprint derived from the contiguous changed block, its position in that block, adjacent rendered context, and a positional fallback when both context anchors are unavailable.
- Changed content produces a new key; line-number-only movement does not.
- Unchanged unique lines retain state after new commits only while their changed block and semantic context remain stable. Edited lines, security-significant invisible Unicode changes, relocated lines, changed blocks, and changed duplicate counts fail closed to unviewed and expand any stale collapsed hunk.
- UI updates are optimistic, but storage failures restore the previous in-memory and DOM state.
- GitHub's official Viewed state is enabled only when GitHub exposes a file-level Viewed control, no unresolved diff-loading marker is present, every rendered hunk maps to a live controller, and a user interaction completes all of those hunks. Eligibility is detected from rendered state rather than inferred from the commit-range URL. It is never automatically disabled.
- Only an explicit user click that removes GitHub's Viewed state suppresses automatic re-selection until the user changes HunkMark state again. A host-side reset after new commits does not discard unchanged local line state or create suppression.
- `Reset page` removes state only for the displayed commit range. Other commit selections retain their state.
- Extension-owned and diff-unrelated DOM mutations do not schedule a diff rediscovery. Outside a recognized pull-request diff route, DOM mutations are not inspected for diff changes.
- Review state is local-only. State keys have an account-and-pull-request parent identity and a displayed-commit-range child identity, so accounts, `All commits`, and selected ranges remain independent while lifecycle management can operate on one account-specific pull request. One last-access metadata entry per account-and-pull-request context with saved state is refreshed at most once per 24 hours. Retention pruning is repeated at most once per 24 hours while review pages remain active. Contexts inactive for more than 180 days are removed as complete units with all of their saved ranges, and writes or cross-tab changes that exceed the 25,000-entry limit trigger eviction of the least recently accessed whole contexts rather than partial line state. Preferences are not pruned.

## Tests

`tests/core.test.cjs` covers URL/view/viewer scoping, parent/child storage identity, account-specific pull-request metadata, invisible-Unicode identity, context fingerprints, and pure state rules. `tests/content.integration.test.cjs` boots the exact manifest script order in jsdom with a Chrome storage fake and exercises legacy-table and modern-grid discovery, commit evolution, semantic relocation and invisible-Unicode fail-closed behavior, viewer isolation, selected-commit isolation, duplicate-line fail-closed behavior, split linking, unresolved-diff gating, official Viewed synchronization and persisted manual suppression, reload restoration, client-side navigation, DOM replacement, drag shrinking, storage failure rollback, account-specific pull-request retention and eviction, range-scoped reset, post-write capacity enforcement, and mutation filtering both inside and outside review routes.

GitHub Actions runs `npm ci` and `npm run verify` for pushes to `main` and for pull requests.
