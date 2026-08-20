# Architecture

HunkMark runs as a set of ordered Manifest V3 content scripts. Chrome loads the files listed in `manifest.json` into the same isolated world, so modules register methods on one `HunkMarkContent.App` class through `HunkMarkContent.extendApp` without a runtime bundler or remote code. Modules that need private helpers keep an IIFE-local scope.

## Modules

| File | Responsibility |
| --- | --- |
| `core.js` | URL parsing, Web Crypto identifier generation and caching, review-state key generation, and aggregate review state |
| `content/app.js` | Application state, constants, and dependency injection |
| `content/discovery.js` | GitHub DOM adaptation and hunk/changed-line discovery |
| `content/review-context.js` | Primary fingerprints, bounded aliases, and line-review context matching |
| `content/review-storage.js` | Review-state retention and storage bounds |
| `content/official-viewed.js` | One-way synchronization with GitHub's file-level Viewed control |
| `content/controllers.js` | Hunk and line controllers, UI state, and persistence |
| `content/sticky-hunk-*.js`, `content/sticky-hunks.js` | Shared sticky-hunk helpers, geometry, navigation, scroll layout, and observer/controller lifecycle |
| `content/context-expansion-controls.js` | Native GitHub expansion-control classification, file ownership, and identity |
| `content/context-expansion-evidence.js` | Current GitHub DOM ownership, changed-line/context evidence, and source-control validation |
| `content/context-expansion-baselines.js` | Immutable per-file review snapshots and bounded baseline aliases |
| `content/context-expansion-state.js` | Expansion phase/evidence transitions, ownership, and per-hunk assessment |
| `content/context-expansion-intents.js` | Expansion activation, captured source evidence, settlement, timers, and teardown |
| `content/drag.js` | Drag-range selection and persistence |
| `content/panel.js` | Progress UI, preferences, and current-page reset |
| `content/review-reconciliation.js` | Locked restoration and fail-closed migration for newly discovered controllers |
| `content/refresh.js` | Review-scope changes, discovery, controller replacement, and reconciliation orchestration |
| `content/lifecycle.js` | Refresh scheduling, DOM/storage observation, navigation, and teardown |
| `content.js` | Dependency checks and application startup only |

### Context-expansion domains

Native controls and rendered diff rows are host evidence. `FileReviewSnapshot` is the single immutable hunk/line/context representation retained when a file disappears; UI progress counters are stored separately. An activation captures that evidence with a native control descriptor, then advances through explicit `awaiting` / `candidate` / `observed` phases and `matched` / `pending` evidence. `review-context.js` is the single definition of primary-fingerprint and bounded-alias equivalence. After discovery validates an intent, `review-reconciliation.js` applies that mapping under the review-storage lock, while `refresh.js` only orchestrates discovery, per-hunk transition assessment, controller replacement, reconciliation, and presentation updates.

## Invariants

- Review state is scoped by pull request and displayed commit range. `All commits` and each selection made through GitHub's commit picker are independent. Matching state in `chrome.storage.local` is restored.
- Current GitHub React file identity preserves path-specific metadata and the raw `Diff for: <path>` grid label exactly, including extensionless root names and significant whitespace, instead of applying a UI-label filename heuristic. A rendered grid outranks staged descendant controls. When only the file heading is available, the path-bearing diff anchor is authoritative and exactly one outer U+200E pair added by GitHub is removed; a genuine U+200E inside the repository path is retained. HunkMark records the presentation evidence behind a cached or pending path so a reused React region can upgrade safely when that evidence changes.
- Every persisted identity is a full SHA-256 digest encoded with Base64URL. Separate domains are used for pull-request contexts, displayed ranges, files, hunks, lines, changed blocks, and line-context fingerprints so an identifier from one purpose cannot be reused as another.
- A hunk key includes the displayed-review scope, file path, normalized hunk signature, and duplicate-hunk occurrence.
- A line key is independent of hunk boundaries and includes the displayed-review scope, file path, change kind, exact content after line-ending normalization, file-wide occurrence, and total identical-line count. Its stored value also carries a context fingerprint derived from the contiguous changed block, its position in that block, adjacent rendered context, and a positional fallback when both context anchors are unavailable.
- Changed content produces a new key; line-number-only movement does not.
- Unchanged unique lines retain state after new commits only while their changed block and semantic context remain stable. Edited lines, security-significant invisible Unicode changes, relocated lines, changed blocks, and changed duplicate counts fail closed to unviewed and expand any stale collapsed hunk.

### Context-expansion invariants

- A trusted, non-rejected primary click on a native GitHub expansion control captures the affected file's complete changed-line keys, context anchors, and fingerprints. Modifier-key primary clicks follow the same path. Authoritative review state is re-read under the storage lock; the click alone never authorizes migration.
- A directional activation must observe structural growth that still contains its captured boundary line or source hunk. `Expand all` may observe the first hunk that grows. Candidate stages remain unreviewed until the clicked control disappears or changes identity, and the complete interleaved sequence of captured context anchors and changed-line identities must remain monotonic.
- A collapsed React file may start `Expand all` from its file header with no mounted hunk controllers. HunkMark then requires an authoritative file path, no rendered or unresolved diff rows, and the last complete snapshot for that exact review scope and file. Revealed hunks must map uniquely and in order to the cached interleaved evidence. Only changed blocks with independent context on both sides may migrate; one-sided or unanchored blocks re-read normally and remain unviewed if their fingerprint changed. A pending activation may survive an explicit hide/reveal cycle, but its original 30-second deadline is never extended.
- Settlement waits for the clicked control and active diff-loading markers to clear. File-wide activation also waits for every expansion control in the file; a directional activation may settle while the opposite-direction control remains.
- An authorized migration may retain at most one validated contracted baseline beside the current expanded fingerprint. Reload, hidden-file restoration, and cross-tab adoption require an exact primary fingerprint plus the complete changed-line and context-anchor sequence; semantic replacement starts a new baseline instead of reviving a stale one.
- Each activation keeps an independent review intent. Migration and concurrent review writes serialize under the storage lock, where the current stored value is authoritative only when it matches a captured or immediately preceding fingerprint.
- Mutation ownership is limited to the discovered file boundary, including current React `role="region"` roots. Unrelated files keep normal debouncing, and controller reconstruction preserves unrelated review and collapsed presentation.
- GitHub owns ordinary expansion layout. HunkMark compensates only the synchronous displacement it causes when a trusted expansion opens HunkMark-collapsed rows, and only for a connected, non-sticky source hunk already inside the viewport. Ordinary host expansion, offscreen sources, and later render stages receive no viewport correction.
- Failed migration writes reconcile from authoritative storage. If storage cannot be read, affected controls remain disabled and unreviewed. Rejected activations, unprompted rerenders, and changed-line or context-evidence replacement fail closed.
- A staged React expansion may omit the semantic suffix from every unrelated `@@` header while leaving its changed lines untouched. Such a controller may adopt the trusted file snapshot only when it maps to exactly one previous controller, its complete changed-line key sequence is identical, and its semantic suffixes match whenever both are present. A controllerless cached activation remains pending while its leading mapped suffix is missing, then resumes only if that suffix returns compatibly; two present but different suffixes remain fail-closed. Later context-only stages obey the same intent ownership before they may open a collapsed hunk.
- A context-expansion click is ignored unless every rendered hunk signature, line-context fingerprint, row, changed line, and context anchor in its file still matches the mounted controllers exactly. Hunk line-number movement remains stable only when the changed block has the same semantic anchors; an unanchored block keeps its exact `@@` header as the positional fallback. This prevents a delayed refresh from letting the click authorize a mutation that was already visible before the click.
- An authorized React expansion remains trusted across later render stages only while the captured interleaved context-anchor and changed-line sequence stays monotonic. An empty collapsed file defers that decision until changed lines return; any non-empty render that replaces, removes, or reorders captured evidence revokes the intent and fails closed even if an earlier stage was accepted.
- Current React blank context rows remain structural expansion evidence even though their code text is empty, so moving one across a changed line revokes the intent. Empty one-cell hunk and expansion-boundary rows are excluded from that evidence.

### UI, lifecycle, and storage invariants

- UI updates are optimistic, but storage failures restore the previous in-memory and DOM state.
- When `Sync GitHub file Viewed` is enabled, GitHub's official Viewed state is enabled only when GitHub exposes a file-level Viewed control, no unresolved diff-loading marker is present, every rendered hunk maps to a live controller, and a user interaction completes all of those hunks. Eligibility is detected from rendered state rather than inferred from the commit-range URL. Disabling the preference does not clear an existing official Viewed state; enabling it re-evaluates complete rendered files in every open tab through the shared preference update. It is never automatically disabled.
- Only an explicit user click that removes GitHub's Viewed state suppresses automatic re-selection until the user changes HunkMark state again. A host-side reset after new commits does not discard unchanged local line state or create suppression.
- `Reset page` removes state only for the displayed commit range. Other commit selections retain their state.
- Extension-owned and diff-unrelated DOM mutations do not schedule a diff rediscovery. Outside a recognized pull-request diff route, DOM mutations are not inspected for diff changes.
- SHA-256 generation is asynchronous. Shared changed-block context is hashed once before per-line fingerprints are derived. A bounded cache retains identifiers for the current and immediately preceding discovered DOM state so replacement elements can be restored before paint. Only asynchronous discovery populates a generation; synchronous recovery is read-only. The cache is cleared on review-scope changes and teardown.
- Review state is local-only. State keys have a pull-request parent identity and a displayed-commit-range child identity, so `All commits` and selected ranges remain independent while lifecycle management can operate on one pull request. One last-access metadata entry per pull-request context with saved state is refreshed at most once per 24 hours. Retention pruning is repeated at most once per 24 hours while review pages remain active. Contexts inactive for more than 180 days are removed as complete units with all of their saved ranges, and writes or cross-tab changes that exceed the 25,000-entry limit trigger eviction of the least recently accessed whole contexts rather than partial line state. Review state uses the `hunkmark:v3` namespace; storage cleanup removes legacy `hunkmark:v1` and `hunkmark:v2` review keys without removing `hunkmark:v1` preferences.

## Tests

`tests/core.test.cjs` covers URL and commit-range scoping, domain-separated SHA-256 identity, two-generation cache rotation, parent/child storage identity, pull-request metadata, legacy review-key cleanup, invisible-Unicode identity, context fingerprints, and pure state rules. The content integration suite shares its jsdom and Chrome-storage harness through `tests/content-test-support.cjs`: the `tests/content.context-expansion-*.test.cjs` files cover activation, evidence, baseline migration, and settlement; the discovery, visibility, persistence, official Viewed, storage, and lifecycle files cover their corresponding application paths; and `tests/content.sticky-and-panel.test.cjs` covers sticky hunks, the floating panel, and drag handling. Together they boot the exact manifest script order and exercise both legacy-table and modern-grid GitHub diff DOMs.

GitHub Actions runs `npm ci` and `npm run verify` for pushes to `main` and for
pull requests.
