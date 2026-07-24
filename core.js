(function initializeCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.HunkMarkCore = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createCore() {
  "use strict";

  const PREFERENCE_STORAGE_NAMESPACE = "hunkmark:v1";
  const REVIEW_STORAGE_NAMESPACE = "hunkmark:v2";
  const LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v1";
  const ALL_COMMITS_REVIEW_VARIANT = "all";
  const REVIEW_STORAGE_PREFIXES = [
    `${REVIEW_STORAGE_NAMESPACE}:mark:`,
    `${REVIEW_STORAGE_NAMESPACE}:line:`,
    `${REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:`,
  ];
  const REVIEW_CONTEXT_METADATA_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:review-context:`;
  const OBSOLETE_REVIEW_SCOPE_METADATA_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:review-scope:`;
  const LEGACY_ACCOUNT_SCOPED_REVIEW_PREFIXES = [
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:mark:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:line:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-context:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-scope:`,
  ];
  const HUNK_HEADER_PATTERN = /@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@[^\r\n]*/;

  function decodePathSegment(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function parseReviewLocation(locationLike) {
    const hostname = locationLike?.hostname;
    const pathname = locationLike?.pathname;

    if (hostname !== "github.com" || typeof pathname !== "string") {
      return null;
    }

    const match = pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)(?:\/([^/]+))?\/?$/,
    );
    if (!match) {
      return null;
    }

    const [, owner, repository, pullNumber, selection] = match;
    return {
      reviewVariant: selection
        ? `selected:${decodePathSegment(selection)}`
        : ALL_COMMITS_REVIEW_VARIANT,
      scope: `${hostname}:${decodePathSegment(owner)}/${decodePathSegment(repository)}:pull:${pullNumber}`,
    };
  }

  function parseReviewScope(locationLike) {
    return parseReviewLocation(locationLike)?.scope ?? null;
  }

  function parseReviewVariant(locationLike) {
    return parseReviewLocation(locationLike)?.reviewVariant ?? null;
  }

  function reviewStateScope(scope, reviewVariant) {
    if (!scope || !reviewVariant) {
      return null;
    }
    return `${scope}:view:${reviewVariant}`;
  }

  function reviewContextScope(reviewStateScope) {
    if (typeof reviewStateScope !== "string") {
      return null;
    }
    const markerIndex = reviewStateScope.indexOf(":view:");
    return markerIndex > 0 ? reviewStateScope.slice(0, markerIndex) : null;
  }

  function reviewContextId(scope) {
    return hashString(reviewContextScope(scope) ?? scope);
  }

  function reviewRangeId(scope) {
    return hashString(scope);
  }

  function reviewStorageIds(scope) {
    const contextScope = reviewContextScope(scope);
    if (!contextScope) {
      throw new TypeError("Review state scope must include a view variant");
    }
    return {
      contextId: reviewContextId(contextScope),
      rangeId: reviewRangeId(scope),
    };
  }

  function reviewContextMetadataKeyForId(contextId) {
    return `${REVIEW_CONTEXT_METADATA_PREFIX}${contextId}`;
  }

  function reviewContextMetadataKey(scope) {
    return reviewContextMetadataKeyForId(reviewContextId(scope));
  }

  function normalizeHunkHeader(headerText) {
    const normalized = findHunkHeader(headerText) || normalizeLineBreaks(headerText).trim();
    return normalized.replace(
      /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/,
      "@@",
    );
  }

  function findHunkHeader(value) {
    const normalized = normalizeLineBreaks(value);
    return normalized.match(HUNK_HEADER_PATTERN)?.[0]?.trim() ?? null;
  }

  function isHunkHeaderText(value) {
    return findHunkHeader(value) !== null;
  }

  function looksLikeFilePath(value) {
    const candidate = normalizeLineBreaks(value).trim();
    if (
      candidate.length === 0 ||
      candidate.length > 500 ||
      candidate.includes("\n") ||
      candidate.includes("://") ||
      isHunkHeaderText(candidate)
    ) {
      return false;
    }

    return (
      candidate.includes("/") ||
      /\.[A-Za-z0-9_-]{1,16}$/.test(candidate) ||
      /^(?:Makefile|Dockerfile|Gemfile|Rakefile|LICENSE|README)$/i.test(candidate)
    );
  }

  function normalizeLineBreaks(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function buildHunkSignature({ headerText, changedLines }) {
    const header = normalizeHunkHeader(headerText);
    const changes = (changedLines ?? []).map(({ kind, text }) => {
      const marker = kind === "addition" ? "+" : kind === "deletion" ? "-" : "?";
      return `${marker}${normalizeLineBreaks(text)}`;
    });

    return [header, ...changes].join("\n");
  }

  function hashString(value) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const input = String(value);

    for (let index = 0; index < input.length; index += 1) {
      const codeUnit = input.charCodeAt(index);
      hash ^= BigInt(codeUnit & 0xff);
      hash = BigInt.asUintN(64, hash * prime);
      hash ^= BigInt(codeUnit >>> 8);
      hash = BigInt.asUintN(64, hash * prime);
    }

    return hash.toString(16).padStart(16, "0");
  }

  function hunkStorageKey(scope, filePath, signature, occurrence = 0) {
    const { contextId, rangeId } = reviewStorageIds(scope);
    const hunkHash = hashString(`${filePath}\n${signature}`);
    return `${REVIEW_STORAGE_NAMESPACE}:mark:${contextId}:${rangeId}:${hunkHash}:${occurrence}`;
  }

  function lineStorageKey(
    scope,
    filePath,
    kind,
    lineText,
    occurrence = 0,
    identicalCount = 1,
  ) {
    const { contextId, rangeId } = reviewStorageIds(scope);
    const lineIdentity = [
      filePath,
      kind,
      normalizeLineBreaks(lineText),
      `identical-count:${identicalCount}`,
    ].join("\n");
    return `${REVIEW_STORAGE_NAMESPACE}:line:${contextId}:${rangeId}:${hashString(lineIdentity)}:${occurrence}`;
  }

  function lineReviewContextFingerprint({
    headerText,
    beforeAnchor = "",
    afterAnchor = "",
    blockSignature = "",
    blockLineIndex = 0,
  }) {
    const before = normalizeLineBreaks(beforeAnchor);
    const after = normalizeLineBreaks(afterAnchor);
    const stableHeader = normalizeHunkHeader(headerText);
    const exactHeader =
      findHunkHeader(headerText) || normalizeLineBreaks(headerText).trim();
    const locationFallback =
      before && after ? "" : exactHeader;

    return hashString(
      [
        `header:${stableHeader}`,
        `before:${before}`,
        `after:${after}`,
        `block:${normalizeLineBreaks(blockSignature)}`,
        `block-line-index:${blockLineIndex}`,
        `fallback:${locationFallback}`,
      ].join("\n"),
    );
  }

  function reviewStoragePrefixes(scope) {
    const { contextId, rangeId } = reviewStorageIds(scope);
    return [
      `${REVIEW_STORAGE_NAMESPACE}:mark:${contextId}:${rangeId}:`,
      `${REVIEW_STORAGE_NAMESPACE}:line:${contextId}:${rangeId}:`,
      `${REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:${contextId}:${rangeId}:`,
    ];
  }

  function reviewStoragePrefixesForContext(scope) {
    const contextId = reviewContextId(scope);
    return REVIEW_STORAGE_PREFIXES.map(
      (prefix) => `${prefix}${contextId}:`,
    );
  }

  function isReviewStorageKeyForScope(key, scope) {
    return (
      typeof key === "string" &&
      reviewStoragePrefixes(scope).some((prefix) => key.startsWith(prefix))
    );
  }

  function isReviewStorageKeyForContext(key, scope) {
    return (
      typeof key === "string" &&
      reviewStoragePrefixesForContext(scope).some((prefix) =>
        key.startsWith(prefix),
      )
    );
  }

  function isReviewStorageKey(key) {
    return (
      typeof key === "string" &&
      REVIEW_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
  }

  function isReviewContextMetadataKey(key) {
    return (
      typeof key === "string" &&
      key.startsWith(REVIEW_CONTEXT_METADATA_PREFIX) &&
      /^[0-9a-f]{16}$/.test(
        key.slice(REVIEW_CONTEXT_METADATA_PREFIX.length),
      )
    );
  }

  function reviewStateKeyIdentity(key) {
    if (typeof key !== "string") {
      return null;
    }

    const prefix = REVIEW_STORAGE_PREFIXES.find((candidate) =>
      key.startsWith(candidate),
    );
    if (!prefix) {
      return null;
    }

    const parts = key.slice(prefix.length).split(":");
    const identifierPattern = /^[0-9a-f]{16}$/;
    const validIdentifiers =
      identifierPattern.test(parts[0] ?? "") &&
      identifierPattern.test(parts[1] ?? "") &&
      identifierPattern.test(parts[2] ?? "");
    if (!validIdentifiers) {
      return null;
    }

    const valid =
      prefix === REVIEW_STORAGE_PREFIXES[0]
        ? (parts.length === 4 && /^\d+$/.test(parts[3])) ||
          (parts.length === 5 &&
            /^\d+$/.test(parts[3]) &&
            parts[4] === "collapsed")
        : prefix === REVIEW_STORAGE_PREFIXES[1]
          ? parts.length === 4 && /^\d+$/.test(parts[3])
          : parts.length === 3;
    return valid
      ? { contextId: parts[0], rangeId: parts[1] }
      : null;
  }

  function reviewStorageContextId(key) {
    if (isReviewContextMetadataKey(key)) {
      return key.slice(REVIEW_CONTEXT_METADATA_PREFIX.length) || null;
    }
    return reviewStateKeyIdentity(key)?.contextId ?? null;
  }

  function isObsoleteReviewStorageKey(key) {
    return (
      (typeof key === "string" &&
        key.startsWith(OBSOLETE_REVIEW_SCOPE_METADATA_PREFIX)) ||
      (typeof key === "string" &&
        LEGACY_ACCOUNT_SCOPED_REVIEW_PREFIXES.some((prefix) =>
          key.startsWith(prefix),
        )) ||
      (typeof key === "string" &&
        key.startsWith(REVIEW_CONTEXT_METADATA_PREFIX) &&
        !isReviewContextMetadataKey(key)) ||
      (isReviewStorageKey(key) && reviewStateKeyIdentity(key) === null)
    );
  }

  function officialSyncSuppressionKey(scope, filePath) {
    const suppressionPrefix = reviewStoragePrefixes(scope)[2];
    return `${suppressionPrefix}${hashString(filePath)}`;
  }

  function aggregateLineState(lineMarks, fallbackMarked = false) {
    if (!Array.isArray(lineMarks) || lineMarks.length === 0) {
      return { marked: Boolean(fallbackMarked), indeterminate: false };
    }

    const markedCount = lineMarks.filter(Boolean).length;
    return {
      marked: markedCount === lineMarks.length,
      indeterminate: markedCount > 0 && markedCount < lineMarks.length,
    };
  }

  return Object.freeze({
    ALL_COMMITS_REVIEW_VARIANT,
    PREFERENCE_STORAGE_NAMESPACE,
    REVIEW_STORAGE_NAMESPACE,
    aggregateLineState,
    buildHunkSignature,
    findHunkHeader,
    hashString,
    isObsoleteReviewStorageKey,
    isReviewContextMetadataKey,
    isReviewStorageKey,
    isReviewStorageKeyForContext,
    isReviewStorageKeyForScope,
    isHunkHeaderText,
    lineStorageKey,
    lineReviewContextFingerprint,
    looksLikeFilePath,
    normalizeLineBreaks,
    officialSyncSuppressionKey,
    parseReviewScope,
    parseReviewVariant,
    reviewContextId,
    reviewContextMetadataKey,
    reviewContextMetadataKeyForId,
    reviewContextScope,
    reviewStateScope,
    reviewStorageContextId,
    hunkStorageKey,
  });
});
