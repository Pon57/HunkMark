# Privacy Policy

Last updated: July 23, 2026

HunkMark has one purpose: to add hunk-level and line-level review controls to GitHub pull request diff pages.

HunkMark handles the current GitHub account identifier (a user ID or login name), pull request URL, and visible website content locally on the user's device. It does not transmit that content to the developer or any third party.

## Data handled by the extension

The extension reads the current GitHub account identifier, pull request URL, and visible diff structure, including file paths, hunk headers, changed-line text, and adjacent context, only to separate accounts, provide its review controls, and calculate stable local identifiers. This is local processing of personally identifiable information, web browsing activity, and website content under Chrome Web Store terminology, even though the raw content never leaves the device.

It stores the following information in `chrome.storage.local`:

- 64-bit identifiers derived from the GitHub account identifier, repository, pull request, file, hunk, changed-line content, and surrounding review context
- Local Viewed and collapsed states
- The last-accessed time for each account and pull request that has saved review state
- Local display preferences
- Whether automatic synchronization with GitHub's file-level Viewed control has been manually suppressed

Raw GitHub account identifiers, URLs, file paths, hunk headers, changed-line or context text, account credentials, cookies, authentication tokens, form data, and GitHub messages are not stored by the extension.

## Data sharing and network access

The extension does not send data to the developer, analytics providers, advertising services, or any other third party. It contains no analytics, telemetry, advertising, or remote code.

When all hunks in a file are marked Viewed through the extension and GitHub exposes its own file-level Viewed control in the displayed commit range, the extension may activate that control. It does not activate the control in ranges where GitHub does not render it. Any resulting request is made by the GitHub page directly to GitHub under the user's existing session. The extension does not receive or transmit the user's GitHub credentials.

## Retention and deletion

Saved review state is retained locally for up to 180 days after its account-specific pull-request context was most recently accessed. To avoid unnecessary writes, the extension updates that context's last-accessed time at most once per 24 hours. To keep storage use bounded, it retains at most 25,000 review-state and context-metadata entries; when the limit is exceeded, it removes the least recently accessed account-and-pull-request contexts, including all of their saved commit-range views, as complete units instead of leaving partial review state. The user can remove the current diff view's state sooner with `Reset page`, clear all extension data through Chrome, or uninstall the extension. `Reset page` removes locally saved hunk marks, line marks, and per-hunk collapsed state only for the displayed account and All commits or selected commit-range view. Other account or commit-range views and global display preferences remain unchanged; shared context access metadata is removed when no saved view remains for that account and pull request.

## Permissions

- `storage`: saves review state and display preferences locally on the user's device.
- Access to `https://github.com/*`: identifies the current GitHub viewer locally, reads the visible pull request diff, adds the review interface, and detects GitHub's client-side navigation into diff pages.

## Limited Use disclosure

The extension's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide and improve the extension's single review-workflow purpose, and is not transferred to third parties.

## Changes

Material changes to this policy will be documented with a new “Last updated” date before an extension update is published.
