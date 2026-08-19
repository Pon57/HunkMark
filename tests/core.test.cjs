"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");
const LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v1";

async function lineReviewContextFingerprint(options) {
  const blockFingerprint =
    await Core.lineReviewBlockFingerprint(options);
  return Core.lineReviewContextFingerprint({
    blockFingerprint,
    blockLineIndex: options.blockLineIndex,
  });
}

test("uses separate stable namespaces for preferences and review state", () => {
  assert.equal(Core.PREFERENCE_STORAGE_NAMESPACE, "hunkmark:v1");
  assert.equal(Core.REVIEW_STORAGE_NAMESPACE, "hunkmark:v3");
});

test("uses domain-separated SHA-256 review identifiers", async () => {
  const domains = Object.values(Core.IDENTIFIER_DOMAINS);
  const identifiers = await Promise.all(
    domains.map((domain) =>
      Core.hashIdentifier(domain, "abc"),
    ),
  );
  const lineIdentifier =
    identifiers[domains.indexOf(
      Core.IDENTIFIER_DOMAINS.LINE,
    )];
  const contextIdentifier = await Core.hashIdentifier(
    Core.IDENTIFIER_DOMAINS.LINE_CONTEXT,
    "abc",
  );

  assert.equal(
    lineIdentifier,
    "BH8e-hizxDjNRoRcNhR9qMR299BLJSvI4xEgpA9SJSE",
  );
  assert.match(lineIdentifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Core.isReviewIdentifier(lineIdentifier), true);
  assert.equal(Core.isReviewIdentifier(`${lineIdentifier}x`), false);
  assert.equal(Core.isReviewIdentifier("not-a-review-identifier"), false);
  assert.equal(Core.isReviewIdentifier(null), false);
  assert.notEqual(lineIdentifier, contextIdentifier);
  assert.equal(new Set(identifiers).size, identifiers.length);
});

test("clears completed identifier inputs from the current-page cache", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const key = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+new",
    0,
  );
  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+new", 0),
    key,
  );

  Core.clearIdentifierCache();
  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+new", 0),
    null,
  );
});

test("formats asynchronous and cached review keys identically", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  Core.clearIdentifierCache();
  const [hunkKey, lineKey, suppressionKey] = await Promise.all([
    Core.hunkStorageKey(scope, "src/a.js", "@@\n+new", 2),
    Core.lineStorageKey(
      scope,
      "src/a.js",
      "addition",
      "+new",
      3,
      4,
    ),
    Core.officialSyncSuppressionKey(scope, "src/a.js"),
  ]);

  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+new", 2),
    hunkKey,
  );
  assert.equal(
    Core.cachedLineStorageKey(
      scope,
      "src/a.js",
      "addition",
      "+new",
      3,
      4,
    ),
    lineKey,
  );
  assert.equal(
    Core.cachedOfficialSyncSuppressionKey(scope, "src/a.js"),
    suppressionKey,
  );
});

test("retains only the current and previous identifier generations", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  Core.clearIdentifierCache();
  const firstKey = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+first",
  );

  const secondGeneration = Core.beginIdentifierCacheGeneration();
  const secondKey = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+second",
  );
  Core.commitIdentifierCacheGeneration(secondGeneration);

  const repeatedGeneration = Core.beginIdentifierCacheGeneration();
  await Core.hunkStorageKey(scope, "src/a.js", "@@\n+second");
  Core.commitIdentifierCacheGeneration(repeatedGeneration);
  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+first"),
    firstKey,
  );

  const thirdGeneration = Core.beginIdentifierCacheGeneration();
  const thirdKey = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+third",
  );
  Core.commitIdentifierCacheGeneration(thirdGeneration);

  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+first"),
    null,
  );
  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+second"),
    secondKey,
  );
  assert.equal(
    Core.cachedHunkStorageKey(scope, "src/a.js", "@@\n+third"),
    thirdKey,
  );
});

test("rejects overlapping identifier cache generations", () => {
  Core.clearIdentifierCache();
  const generation = Core.beginIdentifierCacheGeneration();

  try {
    assert.throws(
      () => Core.beginIdentifierCacheGeneration(),
      /identifier cache generation is already active/i,
    );
  } finally {
    Core.abortIdentifierCacheGeneration(generation);
  }

  const nextGeneration = Core.beginIdentifierCacheGeneration();
  Core.abortIdentifierCacheGeneration(nextGeneration);
});

test("does not promote synchronous cache reads into a new generation", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  Core.clearIdentifierCache();
  const keys = new Map();
  const keyFor = (name) =>
    Core.hunkStorageKey(scope, `src/${name}.js`, `@@\n+${name}`);
  const cachedKeyFor = (name) =>
    Core.cachedHunkStorageKey(scope, `src/${name}.js`, `@@\n+${name}`);

  for (const name of ["a", "b", "c", "d", "e"]) {
    const generation = Core.beginIdentifierCacheGeneration();
    keys.set(name, await keyFor(name));
    for (const cachedName of keys.keys()) {
      cachedKeyFor(cachedName);
    }
    Core.commitIdentifierCacheGeneration(generation);
  }

  for (const name of ["a", "b", "c"]) {
    assert.equal(cachedKeyFor(name), null);
  }
  for (const name of ["d", "e"]) {
    assert.equal(cachedKeyFor(name), keys.get(name));
  }
});

test("does not embed raw review inputs in persisted keys", async () => {
  const scope = Core.reviewStateScope(
    "github.com:private-owner/private-repository:pull:123",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const key = await Core.lineStorageKey(
    scope,
    "secret/internal-file.js",
    "addition",
    "+privateImplementationDetail();",
  );

  assert.match(
    key,
    /^hunkmark:v3:line:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}:0$/,
  );
  for (const rawInput of [
    "private-owner",
    "private-repository",
    "secret/internal-file.js",
    "privateImplementationDetail",
  ]) {
    assert.equal(key.includes(rawInput), false);
  }
});

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

test("isolates review state by the displayed commit range", async () => {
  const scope = "github.com:octo/repo:pull:123";
  const allCommits = Core.reviewStateScope(
    scope,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const selectedCommit = Core.reviewStateScope(scope, "selected:abc");

  assert.notEqual(allCommits, selectedCommit);
  const [allHunk, selectedHunk, allLine, selectedLine] = await Promise.all([
    Core.hunkStorageKey(allCommits, "src/a.js", "@@\n+new", 0),
    Core.hunkStorageKey(selectedCommit, "src/a.js", "@@\n+new", 0),
    Core.lineStorageKey(allCommits, "src/a.js", "addition", "+new"),
    Core.lineStorageKey(selectedCommit, "src/a.js", "addition", "+new"),
  ]);
  assert.notEqual(
    allHunk,
    selectedHunk,
  );
  assert.notEqual(allLine, selectedLine);
});

test("does not expose GitHub viewer scoping", () => {
  assert.equal("reviewViewerScope" in Core, false);
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

test("compares hunk semantic suffixes when GitHub renders both", () => {
  const original = "@@ -181,7 +181,7 @@ async fn cleanup_test_db() {";
  const lineOnly = "@@ -181,7 +181,7 @@";
  const relocated = "@@ -181,7 +181,7 @@ async fn relocated() {";

  assert.equal(
    Core.hunkHeaderSemanticSuffix(original),
    "async fn cleanup_test_db() {",
  );
  assert.equal(
    Core.hunkHeadersSemanticallyCompatible(original, lineOnly),
    true,
  );
  assert.equal(
    Core.hunkHeadersSemanticallyCompatible(lineOnly, original),
    true,
  );
  assert.equal(
    Core.hunkHeadersSemanticallyCompatible(original, relocated),
    false,
  );
});

test("preserves security-significant invisible Unicode in review identities", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const plain = "+if (isAdmin) allow();";
  const withBidiOverride = "+if (is\u202eAdmin) allow();";

  assert.notEqual(
    await Core.lineStorageKey(scope, "src/auth.js", "addition", plain),
    await Core.lineStorageKey(
      scope,
      "src/auth.js",
      "addition",
      withBidiOverride,
    ),
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

test("hunk storage key isolates files, PRs, and duplicate occurrences", async () => {
  const signature = "@@ function example()\n-old\n+new";
  const firstPr = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const secondPr = Core.reviewStateScope(
    "github.com:a/r:pull:2",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const base = await Core.hunkStorageKey(
    firstPr,
    "src/a.js",
    signature,
    0,
  );

  assert.notEqual(
    base,
    await Core.hunkStorageKey(secondPr, "src/a.js", signature, 0),
  );
  assert.notEqual(
    base,
    await Core.hunkStorageKey(firstPr, "src/b.js", signature, 0),
  );
  assert.notEqual(
    base,
    await Core.hunkStorageKey(firstPr, "src/a.js", signature, 1),
  );
});

test("review storage prefixes include hunk descendants and line marks", async () => {
  const context = "github.com:a/r:pull:1";
  const scope = Core.reviewStateScope(
    context,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const hunkKey = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+new",
    0,
  );
  const lineKey = await Core.lineStorageKey(
    scope,
    "src/a.js",
    "addition",
    "+new",
  );

  const scopePrefixes = await Core.reviewStoragePrefixes(scope);
  const contextPrefixes =
    await Core.reviewStoragePrefixesForContext(context);
  const matchesScope = (key) =>
    scopePrefixes.some((prefix) => key.startsWith(prefix));
  const matchesContext = (key) =>
    contextPrefixes.some((prefix) => key.startsWith(prefix));

  assert.equal(matchesScope(hunkKey), true);
  assert.equal(matchesScope(`${hunkKey}:collapsed`), true);
  assert.equal(matchesScope(lineKey), true);
  const metadataKey = await Core.reviewContextMetadataKey(context);
  assert.equal(matchesScope(metadataKey), false);
  assert.equal(matchesContext(hunkKey), true);
  assert.equal(matchesContext(metadataKey), false);
  assert.equal(
    matchesScope(
      await Core.officialSyncSuppressionKey(scope, "src/a.js"),
    ),
    true,
  );
  assert.equal(
    matchesScope(
      await Core.hunkStorageKey(
        Core.reviewStateScope(
          "github.com:a/r:pull:2",
          Core.ALL_COMMITS_REVIEW_VARIANT,
        ),
        "src/a.js",
        "@@\n+new",
        0,
      ),
    ),
    false,
  );
  assert.equal(
    matchesScope(
      `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
    ),
    false,
  );
});

test("maps all ranges in a pull request to one review context", async () => {
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
  const contextId = await Core.reviewContextId(context);
  const hunkKey = await Core.hunkStorageKey(
    scope,
    "src/a.js",
    "@@\n+new",
    0,
  );
  const selectedKey = await Core.hunkStorageKey(
    selected,
    "src/b.js",
    "@@\n+other",
    0,
  );
  const metadataKey = await Core.reviewContextMetadataKey(context);

  assert.equal(Core.reviewStorageContextId(hunkKey), contextId);
  assert.equal(Core.reviewStorageContextId(selectedKey), contextId);
  assert.equal(Core.reviewStorageContextId(metadataKey), contextId);
  assert.equal(await Core.reviewContextId(selected), contextId);
  assert.equal(await Core.reviewContextId(selectedWithDelimiter), contextId);
  assert.equal(Core.isReviewContextMetadataKey(metadataKey), true);
  assert.equal(Core.isReviewStorageKey(metadataKey), false);
  assert.equal(
    Core.isObsoleteReviewStorageKey(
      `${Core.REVIEW_STORAGE_NAMESPACE}:review-context:not-a-context-id`,
    ),
    true,
  );
  assert.equal(
    Core.reviewStorageContextId(
      `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
    ),
    null,
  );
});

test("rejects review-state keys without a displayed commit range", async () => {
  await assert.rejects(
    async () =>
      Core.hunkStorageKey(
        "github.com:a/r:pull:1",
        "src/a.js",
        "@@\n+new",
      ),
    /view variant/,
  );
});

test("review storage matching excludes global preferences", () => {
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.REVIEW_STORAGE_NAMESPACE}:mark:scope:hunk:0`,
    ),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.REVIEW_STORAGE_NAMESPACE}:line:scope:line:0`,
    ),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:scope:file`,
    ),
    true,
  );
  assert.equal(
    Core.isReviewStorageKey(
      `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`,
    ),
    false,
  );
  assert.equal(
    Core.isObsoleteReviewStorageKey(
      `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:mark:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc:0`,
    ),
    true,
  );
  assert.equal(
    Core.isObsoleteReviewStorageKey(
      `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-context:aaaaaaaaaaaaaaaa`,
    ),
    true,
  );
});

test("line storage key is stable across hunk line-number movement", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/a.js";
  const before = await Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+newValue",
  );
  const after = await Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+newValue",
  );

  assert.equal(before, after);
  assert.notEqual(
    before,
    await Core.lineStorageKey(
      scope,
      filePath,
      "deletion",
      "-oldValue",
    ),
  );
});

test("line storage keys survive hunk merging and fail closed when duplicate counts change", async () => {
  const scope = Core.reviewStateScope(
    "github.com:a/r:pull:1",
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/a.js";
  const firstOfTwo = await Core.lineStorageKey(
    scope,
    filePath,
    "addition",
    "+return null;",
    0,
    2,
  );

  assert.notEqual(
    firstOfTwo,
    await Core.lineStorageKey(
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
    await Core.lineStorageKey(
      scope,
      filePath,
      "addition",
      "+return null;",
      0,
      3,
    ),
  );
});

test("line review context survives line-number movement and rejects relocation", async () => {
  const stable = await lineReviewContextFingerprint({
    headerText: "@@ -10,3 +10,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (user) {",
    afterAnchor: "context:unified:}",
    blockSignature: "addition:unified:+return true;",
  });
  const movedByEarlierLines = await lineReviewContextFingerprint({
    headerText: "@@ -210,3 +210,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (user) {",
    afterAnchor: "context:unified:}",
    blockSignature: "addition:unified:+return true;",
  });
  const relocated = await lineReviewContextFingerprint({
    headerText: "@@ -210,3 +210,4 @@ function checkAccess() {",
    beforeAnchor: "context:unified:if (isAdmin) {",
    afterAnchor: "context:unified:audit();",
    blockSignature: "addition:unified:+return true;",
  });
  const unanchoredBefore = await lineReviewContextFingerprint({
    headerText: "@@ -10 +10 @@ function checkAccess() {",
    blockSignature: "addition:unified:+return true;",
  });
  const unanchoredAfter = await lineReviewContextFingerprint({
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
