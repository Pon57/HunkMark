# Changelog

All notable changes to this project are documented in this file.

## 1.0.0 - 2026-07-23

Initial public release.

### Added

- Hunk-level and line-level Viewed controls on GitHub pull request diffs
- Drag selection for marking or unmarking multiple changed lines
- Linked and independent split-diff operation
- Hunk collapse and automatic collapsing of completed hunks
- Per-file and page-wide review progress
- One-way synchronization to GitHub's file-level Viewed state wherever GitHub exposes the control
- Local persistence across reloads and GitHub client-side navigation
- Responsive bottom clearance for the fixed progress panel

### Reliability

- Supports GitHub's signed-in React/grid diff and legacy table diff
- Ignores context lines during line selection
- Preserves manual removal of GitHub's file-level Viewed state
- Distinguishes explicit manual removal from GitHub resetting Viewed after later commits
- Waits for asynchronous GitHub file-level Viewed re-renders before reconciling state
- Locks line and hunk controls while their stored state is loading or saving
- Debounces DOM refresh work and scopes fallback hunk discovery to diff containers
- Ignores extension-owned and diff-unrelated DOM mutations to avoid unnecessary full-page rescans
- Skips diff-mutation inspection entirely outside pull-request diff routes
- Rechecks retention once per day and enforces the 25,000-entry bound after later writes and cross-tab storage changes
- Reduces repeated row lookup and line fingerprint work during large diff discovery
- Resets hunk and line state only for the currently displayed commit range
- Isolates All commits and each range chosen with Select commits to view
- Keeps unique lines reviewed after new commits only while their changed block and semantic context remain stable, and fails closed when identical-line counts change
- Preserves line state when GitHub merges or splits hunk boundaries
- Fails closed when a reviewed line moves to a different semantic context or gains security-significant invisible Unicode
- Separates saved review state by the active GitHub login without storing the raw login name
- Ignores line marks that do not carry semantic-context evidence instead of restoring them
- Blocks automatic GitHub Viewed synchronization while diff content is unresolved or rendered hunks are not fully mapped
- Pins GitHub Actions dependencies to full commit SHAs
- Produces deterministic release ZIPs with a SHA-256 checksum
- Attaches the ZIP and checksum to GitHub Releases when they are published
- Tracks one last-access time per account-and-pull-request context at most once per 24 hours and removes all saved ranges as a complete unit after 180 inactive days
- Enforces the 25,000-entry bound by evicting least recently accessed whole account-and-pull-request contexts instead of partial range or line state
- Covers unified and split diffs, persistence, drag shrinking, commit-range switching, view-scoped reset, persisted official Viewed suppression, post-write storage eviction, non-review-route mutation filtering, and GitHub DOM replacement with automated DOM integration tests

### Presentation

- Reworked the extension icon into a higher-contrast design that remains legible at 16 px and on dark browser chrome
- Updated the Chrome Web Store promotional tile to use the simplified icon
