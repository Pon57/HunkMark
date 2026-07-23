"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("recognizes GitHub pull request files pages", () => {
  const allCommitsLocation = {
    hostname: "github.com",
    pathname: "/octo/repo/pull/123/files",
  };
  assert.equal(
    Core.parseReviewScope(allCommitsLocation),
    "github.com:octo/repo:pull:123",
  );
  assert.equal(
    Core.parseReviewVariant(allCommitsLocation),
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );

  const selectedCommitLocation = {
    hostname: "github.com",
    pathname: "/octo/repo/pull/123/files/abc",
  };
  assert.equal(
    Core.parseReviewScope(selectedCommitLocation),
    "github.com:octo/repo:pull:123",
  );
  assert.equal(
    Core.parseReviewVariant(selectedCommitLocation),
    "selected:abc",
  );

  assert.equal(
    Core.parseReviewScope({
      hostname: "github.com",
      pathname: "/octo/repo/pull/123/changes",
    }),
    "github.com:octo/repo:pull:123",
  );
  assert.equal(
    Core.parseReviewVariant({
      hostname: "github.com",
      pathname: "/octo/repo/pull/123/changes/abc..def",
    }),
    "selected:abc..def",
  );
});

test("isolates review state by the displayed commit range", () => {
  const scope = "github.com:octo/repo:pull:123";
  const allCommits = Core.reviewStateScope(
    scope,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const selectedCommit = Core.reviewStateScope(scope, "selected:abc");

  assert.notEqual(allCommits, selectedCommit);
  assert.notEqual(
    Core.storageKey(allCommits, "src/a.js", "@@\n+new", 0),
    Core.storageKey(selectedCommit, "src/a.js", "@@\n+new", 0),
  );
  assert.notEqual(
    Core.lineStorageKey(allCommits, "src/a.js", "addition", "+new"),
    Core.lineStorageKey(selectedCommit, "src/a.js", "addition", "+new"),
  );
});

test("isolates review state by the signed-in GitHub viewer", () => {
  const scope = "github.com:octo/repo:pull:123";

  assert.notEqual(
    Core.reviewViewerScope(scope, "alice"),
    Core.reviewViewerScope(scope, "bob"),
  );
  assert.equal(
    Core.reviewViewerScope(scope, "Alice"),
    Core.reviewViewerScope(scope, "alice"),
  );
  assert.equal(Core.reviewViewerScope(scope, null), null);
  assert.equal(Core.reviewViewerScope(scope, "  "), null);
});

test("ignores unrelated and non-GitHub pages", () => {
  assert.equal(
    Core.parseReviewScope({ hostname: "github.com", pathname: "/octo/repo/pull/123" }),
    null,
  );
  assert.equal(
    Core.parseReviewScope({ hostname: "example.com", pathname: "/octo/repo/pull/123/files" }),
    null,
  );
});

test("handles malformed encoded path segments without breaking page detection", () => {
  assert.equal(
    Core.parseReviewScope({
      hostname: "github.com",
      pathname: "/octo%ZZ/repo/pull/123/files",
    }),
    "github.com:octo%ZZ/repo:pull:123",
  );
});

test("hunk signature survives line-number-only movement", () => {
  const changedLines = [
    { kind: "deletion", text: "-const oldValue = 1;" },
    { kind: "addition", text: "+const newValue = 1;" },
  ];
  const before = Core.buildHunkSignature({
    headerText: "@@ -10,7 +10,7 @@ function example() {",
    changedLines,
  });
  const after = Core.buildHunkSignature({
    headerText: "@@ -210,7 +210,7 @@ function example() {",
    changedLines,
  });

  assert.equal(before, after);
});

test("hunk signature changes with diff content", () => {
  const first = Core.buildHunkSignature({
    headerText: "@@ -10 +10 @@",
    changedLines: [{ kind: "addition", text: "+alpha" }],
  });
  const second = Core.buildHunkSignature({
    headerText: "@@ -10 +10 @@",
    changedLines: [{ kind: "addition", text: "+beta" }],
  });

  assert.notEqual(first, second);
});

test("preserves security-significant invisible Unicode in review identities", () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const plain = "+if (isAdmin) allow();";
  const withBidiOverride = "+if (is\u202eAdmin) allow();";

  assert.notEqual(
    Core.lineStorageKey(scope, "src/auth.js", "addition", plain),
    Core.lineStorageKey(scope, "src/auth.js", "addition", withBidiOverride),
  );
  assert.notEqual(
    Core.buildHunkSignature({
      headerText: "@@ -1 +1 @@",
      changedLines: [{ kind: "addition", text: plain }],
    }),
    Core.buildHunkSignature({
      headerText: "@@ -1 +1 @@",
      changedLines: [{ kind: "addition", text: withBidiOverride }],
    }),
  );
});

test("finds a hunk header inside accessible row text", () => {
  const rowText = "Expand up  @@ -42,6 +42,8 @@ function render() {  Viewed";

  assert.equal(
    Core.findHunkHeader(rowText),
    "@@ -42,6 +42,8 @@ function render() {  Viewed",
  );
  assert.equal(Core.isHunkHeaderText(rowText), true);
  assert.equal(Core.isHunkHeaderText("ordinary diff content"), false);
});

test("recognizes file paths without mistaking UI labels for paths", () => {
  assert.equal(Core.looksLikeFilePath("src/components/Diff.tsx"), true);
  assert.equal(Core.looksLikeFilePath("\u200esrc/components/Diff.tsx\u200e"), true);
  assert.equal(Core.looksLikeFilePath("README"), true);
  assert.equal(Core.looksLikeFilePath("Copy"), false);
  assert.equal(Core.looksLikeFilePath("Diff settings"), false);
});

test("storage key isolates files, PRs, and duplicate hunk occurrences", () => {
  const signature = "@@ function example()\n-old\n+new";
  const firstPr = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const secondPr = Core.reviewStateScope(
    "github.com:a/r:pull:2",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const base = Core.storageKey(firstPr, "src/a.js", signature, 0);

  assert.notEqual(base, Core.storageKey(secondPr, "src/a.js", signature, 0));
  assert.notEqual(base, Core.storageKey(firstPr, "src/b.js", signature, 0));
  assert.notEqual(base, Core.storageKey(firstPr, "src/a.js", signature, 1));
});

test("review storage scope matching includes hunk descendants and line marks", () => {
  const context = "github.com:a/r:pull:1";
  const scope = Core.reviewStateScope(
    context,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const hunkKey = Core.storageKey(scope, "src/a.js", "@@\n+new", 0);
  const lineKey = Core.lineStorageKey(
    scope,
    "src/a.js",
    "addition",
    "+new",
  );

  assert.equal(Core.isReviewStorageKeyForScope(hunkKey, scope), true);
  assert.equal(
    Core.isReviewStorageKeyForScope(`${hunkKey}:collapsed`, scope),
    true,
  );
  assert.equal(Core.isReviewStorageKeyForScope(lineKey, scope), true);
  const metadataKey = Core.reviewContextMetadataKey(context);
  assert.equal(Core.isReviewStorageKeyForScope(metadataKey, scope), false);
  assert.equal(Core.isReviewStorageKeyForContext(hunkKey, context), true);
  assert.equal(Core.isReviewStorageKeyForContext(metadataKey, context), false);
  assert.equal(
    Core.isReviewStorageKeyForScope(
      Core.officialSyncSuppressionKey(scope, "src/a.js"),
      scope,
    ),
    true,
  );
  assert.equal(
      Core.isReviewStorageKeyForScope(
      Core.storageKey(
        Core.reviewStateScope(
          "github.com:a/r:pull:2",
          Core.ALL_COMMITS_REVIEW_VARIANT,
        ),
        "src/a.js",
        "@@\n+new",
        0,
      ),
      scope,
    ),
    false,
  );
  assert.equal(
    Core.isReviewStorageKeyForScope(
      `${Core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
      scope,
    ),
    false,
  );
});

test("maps all ranges in a pull request to one review context", () => {
  const context = "github.com:a/r:pull:1";
  const scope = Core.reviewStateScope(
    context,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const selected = Core.reviewStateScope(context, "selected:abc");
  const selectedWithDelimiter = Core.reviewStateScope(
    context,
    "selected:abc:view:def",
  );
  const contextId = Core.reviewContextId(context);
  const hunkKey = Core.storageKey(scope, "src/a.js", "@@\n+new", 0);
  const selectedKey = Core.storageKey(selected, "src/b.js", "@@\n+other", 0);
  const metadataKey = Core.reviewContextMetadataKey(context);

  assert.equal(Core.reviewStorageContextId(hunkKey), contextId);
  assert.equal(Core.reviewStorageContextId(selectedKey), contextId);
  assert.equal(Core.reviewStorageContextId(metadataKey), contextId);
  assert.equal(Core.reviewContextId(selected), contextId);
  assert.equal(Core.reviewContextId(selectedWithDelimiter), contextId);
  assert.equal(Core.isReviewContextMetadataKey(metadataKey), true);
  assert.equal(Core.isReviewStorageKey(metadataKey), false);
  assert.equal(
    Core.isObsoleteReviewStorageKey(
      `${Core.STORAGE_NAMESPACE}:review-context:not-a-context-id`,
    ),
    true,
  );
  assert.equal(
    Core.reviewStorageContextId(
      `${Core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
    ),
    null,
  );
});

test("rejects review-state keys without a displayed commit range", () => {
  assert.throws(
    () => Core.storageKey("github.com:a/r:pull:1", "src/a.js", "@@\n+new"),
    /view variant/,
  );
});

test("review storage matching excludes global preferences", () => {
  assert.equal(
    Core.isReviewStorageKey(`${Core.STORAGE_NAMESPACE}:mark:scope:hunk:0`),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(`${Core.STORAGE_NAMESPACE}:line:scope:line:0`),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.STORAGE_NAMESPACE}:official-sync-suppressed:scope:file`,
    ),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
    ),
    false,
  );
});

test("line storage key is stable across hunk line-number movement", () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/a.js";
  const before = Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+newValue",
  );
  const after = Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+newValue",
  );

  assert.equal(before, after);
  assert.notEqual(
    before,
    Core.lineStorageKey(
      scope,
      filePath,
      "deletion",
      "-oldValue",
    ),
  );
});

test("line storage keys survive hunk merging and fail closed when duplicate counts change", () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/a.js";
  const firstOfTwo = Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+return null;",
    0,
    2,
  );

  assert.notEqual(
    firstOfTwo,
    Core.lineStorageKey(
      scope,
      filePath,
      "addition",
      "+return null;",
      1,
      2,
    ),
  );
  assert.notEqual(
    firstOfTwo,
    Core.lineStorageKey(
      scope,
      filePath,
      "addition",
      "+return null;",
      0,
      3,
    ),
  );
});

test("line review context survives line-number movement and rejects relocation", () => {
  const stable = Core.lineReviewContextFingerprint({
    headerText: "@@ -10,3 +10,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (user) {",
    afterAnchor: "context:unified:}",
    blockSignature: "addition:unified:+return true;",
  });
  const movedByEarlierLines = Core.lineReviewContextFingerprint({
    headerText: "@@ -210,3 +210,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (user) {",
    afterAnchor: "context:unified:}",
    blockSignature: "addition:unified:+return true;",
  });
  const relocated = Core.lineReviewContextFingerprint({
    headerText: "@@ -210,3 +210,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (isAdmin) {",
    afterAnchor: "context:unified:audit();",
    blockSignature: "addition:unified:+return true;",
  });
  const unanchoredBefore = Core.lineReviewContextFingerprint({
    headerText: "@@ -10 +10 @@ function checkAccess() {",
    blockSignature: "addition:unified:+return true;",
  });
  const unanchoredAfter = Core.lineReviewContextFingerprint({
    headerText: "@@ -900 +900 @@ function checkAccess() {",
    blockSignature: "addition:unified:+return true;",
  });

  assert.equal(stable, movedByEarlierLines);
  assert.notEqual(stable, relocated);
  assert.notEqual(unanchoredBefore, unanchoredAfter);
});

test("all viewed lines promote their hunk while partial lines are indeterminate", () => {
  assert.deepEqual(Core.aggregateLineState([true, true]), {
    marked: true,
    indeterminate: false,
  });
  assert.deepEqual(Core.aggregateLineState([true, false]), {
    marked: false,
    indeterminate: true,
  });
  assert.deepEqual(Core.aggregateLineState([false, false]), {
    marked: false,
    indeterminate: false,
  });
  assert.deepEqual(Core.aggregateLineState([], true), {
    marked: true,
    indeterminate: false,
  });
});
