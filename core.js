(function initializeCore(root, factory) {
  const api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.HunkMarkCore = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createCore(root) {
  "use strict";

  const PREFERENCE_STORAGE_NAMESPACE = "hunkmark:v1";
  const REVIEW_STORAGE_NAMESPACE = "hunkmark:v3";
  const LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v1";
  const LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v2";
  const ALL_COMMITS_REVIEW_VARIANT = "all";
  const HUNK_REVIEW_STORAGE_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:mark:`;
  const LINE_REVIEW_STORAGE_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:line:`;
  const OFFICIAL_SYNC_SUPPRESSION_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:`;
  const REVIEW_STORAGE_PREFIXES = [
    HUNK_REVIEW_STORAGE_PREFIX,
    LINE_REVIEW_STORAGE_PREFIX,
    OFFICIAL_SYNC_SUPPRESSION_PREFIX,
  ];
  const REVIEW_CONTEXT_METADATA_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:review-context:`;
  const OBSOLETE_REVIEW_SCOPE_METADATA_PREFIX =
    `${REVIEW_STORAGE_NAMESPACE}:review-scope:`;
  const LEGACY_REVIEW_PREFIXES = [
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:mark:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:line:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-context:`,
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-scope:`,
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:mark:`,
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:line:`,
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:official-sync-suppressed:`,
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:review-context:`,
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:review-scope:`,
  ];
  const IDENTIFIER_DOMAINS = Object.freeze({
    CONTEXT: `${REVIEW_STORAGE_NAMESPACE}:context`,
    FILE: `${REVIEW_STORAGE_NAMESPACE}:file`,
    HUNK: `${REVIEW_STORAGE_NAMESPACE}:hunk`,
    LINE: `${REVIEW_STORAGE_NAMESPACE}:line`,
    LINE_BLOCK: `${REVIEW_STORAGE_NAMESPACE}:line-block`,
    LINE_CONTEXT: `${REVIEW_STORAGE_NAMESPACE}:line-context`,
    RANGE: `${REVIEW_STORAGE_NAMESPACE}:range`,
  });
  const IDENTIFIER_DOMAIN_SET = new Set(Object.values(IDENTIFIER_DOMAINS));
  const identifierEncoder =
    typeof root.TextEncoder === "function" ? new root.TextEncoder() : null;
  // Cache values are in-flight digest Promises while hashing and Base64URL
  // strings after completion. Synchronous recovery uses completed values only.
  let currentIdentifierCache = new Map();
  let previousIdentifierCache = new Map();
  let pendingIdentifierGeneration = null;
  const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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

  async function reviewContextId(scope) {
    return hashIdentifier(
      IDENTIFIER_DOMAINS.CONTEXT,
      reviewContextScope(scope) ?? scope,
    );
  }

  async function reviewRangeId(scope) {
    return hashIdentifier(IDENTIFIER_DOMAINS.RANGE, scope);
  }

  async function reviewStorageIds(scope) {
    const contextScope = reviewContextScope(scope);
    if (!contextScope) {
      throw new TypeError("Review state scope must include a view variant");
    }
    const [contextId, rangeId] = await Promise.all([
      reviewContextId(contextScope),
      reviewRangeId(scope),
    ]);
    return {
      contextId,
      rangeId,
    };
  }

  function reviewContextMetadataKeyForId(contextId) {
    return `${REVIEW_CONTEXT_METADATA_PREFIX}${contextId}`;
  }

  async function reviewContextMetadataKey(scope) {
    return reviewContextMetadataKeyForId(await reviewContextId(scope));
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

  function identifierCacheKey(domain, value) {
    return `${domain}\u0000${String(value)}`;
  }

  function cachedIdentifier(domain, value) {
    if (!IDENTIFIER_DOMAIN_SET.has(domain)) {
      throw new TypeError("A recognized identifier domain is required");
    }
    const cacheKey = identifierCacheKey(domain, value);
    const pending = pendingIdentifierGeneration?.get(cacheKey);
    if (typeof pending === "string") {
      return pending;
    }
    const current = currentIdentifierCache.get(cacheKey);
    const cached =
      typeof current === "string"
        ? current
        : previousIdentifierCache.get(cacheKey);
    if (typeof cached !== "string") {
      return null;
    }
    return cached;
  }

  function clearIdentifierCache() {
    currentIdentifierCache.clear();
    previousIdentifierCache.clear();
    pendingIdentifierGeneration?.clear();
    pendingIdentifierGeneration = null;
  }

  function beginIdentifierCacheGeneration() {
    if (pendingIdentifierGeneration) {
      throw new Error("An identifier cache generation is already active");
    }
    pendingIdentifierGeneration = new Map();
    return pendingIdentifierGeneration;
  }

  function commitIdentifierCacheGeneration(generation) {
    if (pendingIdentifierGeneration !== generation) {
      return;
    }
    for (const [key, value] of generation) {
      // Event handlers can add work that discovery does not await. Never expose
      // an in-flight Promise to synchronous recovery.
      if (typeof value !== "string") {
        generation.delete(key);
      }
    }
    let sameIdentitySet = generation.size === currentIdentifierCache.size;
    if (sameIdentitySet) {
      for (const key of generation.keys()) {
        if (!currentIdentifierCache.has(key)) {
          sameIdentitySet = false;
          break;
        }
      }
    }
    if (!sameIdentitySet) {
      previousIdentifierCache = currentIdentifierCache;
    }
    currentIdentifierCache = generation;
    pendingIdentifierGeneration = null;
  }

  function abortIdentifierCacheGeneration(generation) {
    if (pendingIdentifierGeneration !== generation) {
      return;
    }
    generation.clear();
    pendingIdentifierGeneration = null;
  }

  function buildHunkSignature({ headerText, changedLines }) {
    const header = normalizeHunkHeader(headerText);
    const changes = (changedLines ?? []).map(({ kind, text }) => {
      const marker = kind === "addition" ? "+" : kind === "deletion" ? "-" : "?";
      return `${marker}${normalizeLineBreaks(text)}`;
    });

    return [header, ...changes].join("\n");
  }

  async function hashIdentifier(domain, value) {
    if (!IDENTIFIER_DOMAIN_SET.has(domain)) {
      throw new TypeError("A recognized identifier domain is required");
    }
    if (!root.crypto?.subtle || !identifierEncoder) {
      throw new Error("Web Crypto SHA-256 is unavailable");
    }
    const cacheKey = identifierCacheKey(domain, value);
    const generation = pendingIdentifierGeneration;
    const cached =
      generation?.get(cacheKey) ??
      currentIdentifierCache.get(cacheKey) ??
      previousIdentifierCache.get(cacheKey);
    if (cached) {
      if (generation && !generation.has(cacheKey)) {
        generation.set(cacheKey, cached);
      }
      const identifier = await cached;
      if (generation?.get(cacheKey) === cached) {
        generation.set(cacheKey, identifier);
      }
      return identifier;
    }
    const targetCache = generation ?? currentIdentifierCache;
    const digestPromise = (async () => {
      const input = identifierEncoder.encode(cacheKey);
      const digest = new Uint8Array(
        await root.crypto.subtle.digest("SHA-256", input),
      );
      const binary = String.fromCharCode(...digest);
      return root
        .btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/u, "");
    })();
    targetCache.set(cacheKey, digestPromise);
    try {
      const identifier = await digestPromise;
      if (
        targetCache.get(cacheKey) === digestPromise
      ) {
        targetCache.set(cacheKey, identifier);
      }
      return identifier;
    } catch (error) {
      if (targetCache.get(cacheKey) === digestPromise) {
        targetCache.delete(cacheKey);
      }
      throw error;
    }
  }

  function cachedReviewStorageIds(scope) {
    const contextScope = reviewContextScope(scope);
    if (!contextScope) {
      throw new TypeError("Review state scope must include a view variant");
    }
    const contextId = cachedIdentifier(
      IDENTIFIER_DOMAINS.CONTEXT,
      contextScope,
    );
    const rangeId = cachedIdentifier(IDENTIFIER_DOMAINS.RANGE, scope);
    return contextId && rangeId ? { contextId, rangeId } : null;
  }

  function scopedReviewStoragePrefix(prefix, { contextId, rangeId }) {
    return `${prefix}${contextId}:${rangeId}:`;
  }

  function formatHunkStorageKey(ids, hunkId, occurrence) {
    const prefix = scopedReviewStoragePrefix(
      HUNK_REVIEW_STORAGE_PREFIX,
      ids,
    );
    return `${prefix}${hunkId}:${occurrence}`;
  }

  function formatLineStorageKey(ids, lineId, occurrence) {
    const prefix = scopedReviewStoragePrefix(
      LINE_REVIEW_STORAGE_PREFIX,
      ids,
    );
    return `${prefix}${lineId}:${occurrence}`;
  }

  function formatOfficialSyncSuppressionKey(ids, fileId) {
    const prefix = scopedReviewStoragePrefix(
      OFFICIAL_SYNC_SUPPRESSION_PREFIX,
      ids,
    );
    return `${prefix}${fileId}`;
  }

  function cachedHunkStorageKey(
    scope,
    filePath,
    signature,
    occurrence = 0,
  ) {
    const ids = cachedReviewStorageIds(scope);
    const hunkHash = cachedIdentifier(
      IDENTIFIER_DOMAINS.HUNK,
      `${filePath}\n${signature}`,
    );
    return ids && hunkHash
      ? formatHunkStorageKey(ids, hunkHash, occurrence)
      : null;
  }

  function lineIdentityValue(filePath, kind, lineText, identicalCount) {
    return [
      filePath,
      kind,
      normalizeLineBreaks(lineText),
      `identical-count:${identicalCount}`,
    ].join("\n");
  }

  function cachedLineStorageKey(
    scope,
    filePath,
    kind,
    lineText,
    occurrence = 0,
    identicalCount = 1,
  ) {
    const ids = cachedReviewStorageIds(scope);
    const lineHash = cachedIdentifier(
      IDENTIFIER_DOMAINS.LINE,
      lineIdentityValue(filePath, kind, lineText, identicalCount),
    );
    return ids && lineHash
      ? formatLineStorageKey(ids, lineHash, occurrence)
      : null;
  }

  async function hunkStorageKey(scope, filePath, signature, occurrence = 0) {
    const [{ contextId, rangeId }, hunkHash] = await Promise.all([
      reviewStorageIds(scope),
      hashIdentifier(
        IDENTIFIER_DOMAINS.HUNK,
        `${filePath}\n${signature}`,
      ),
    ]);
    return formatHunkStorageKey({ contextId, rangeId }, hunkHash, occurrence);
  }

  async function lineStorageKey(
    scope,
    filePath,
    kind,
    lineText,
    occurrence = 0,
    identicalCount = 1,
  ) {
    const { contextId, rangeId } = await reviewStorageIds(scope);
    const lineIdentity = lineIdentityValue(
      filePath,
      kind,
      lineText,
      identicalCount,
    );
    const lineHash = await hashIdentifier(
      IDENTIFIER_DOMAINS.LINE,
      lineIdentity,
    );
    return formatLineStorageKey({ contextId, rangeId }, lineHash, occurrence);
  }

  function lineReviewBlockValue({
    headerText,
    beforeAnchor = "",
    afterAnchor = "",
    blockSignature = "",
  }) {
    const before = normalizeLineBreaks(beforeAnchor);
    const after = normalizeLineBreaks(afterAnchor);
    const stableHeader = normalizeHunkHeader(headerText);
    const exactHeader =
      findHunkHeader(headerText) || normalizeLineBreaks(headerText).trim();
    const locationFallback = before && after ? "" : exactHeader;

    return [
      `header:${stableHeader}`,
      `before:${before}`,
      `after:${after}`,
      `block:${normalizeLineBreaks(blockSignature)}`,
      `fallback:${locationFallback}`,
    ].join("\n");
  }

  async function lineReviewBlockFingerprint(options) {
    return hashIdentifier(
      IDENTIFIER_DOMAINS.LINE_BLOCK,
      lineReviewBlockValue(options),
    );
  }

  function cachedLineReviewBlockFingerprint(options) {
    return cachedIdentifier(
      IDENTIFIER_DOMAINS.LINE_BLOCK,
      lineReviewBlockValue(options),
    );
  }

  function lineReviewContextValue(blockFingerprint, blockLineIndex = 0) {
    if (!IDENTIFIER_PATTERN.test(blockFingerprint)) {
      throw new TypeError("A line review block fingerprint is required");
    }
    return `${blockFingerprint}\u0000${blockLineIndex}`;
  }

  async function lineReviewContextFingerprint({
    blockFingerprint,
    blockLineIndex = 0,
  }) {
    return hashIdentifier(
      IDENTIFIER_DOMAINS.LINE_CONTEXT,
      lineReviewContextValue(blockFingerprint, blockLineIndex),
    );
  }

  function cachedLineReviewContextFingerprint({
    blockFingerprint,
    blockLineIndex = 0,
  }) {
    return cachedIdentifier(
      IDENTIFIER_DOMAINS.LINE_CONTEXT,
      lineReviewContextValue(blockFingerprint, blockLineIndex),
    );
  }

  async function reviewStoragePrefixes(scope) {
    const ids = await reviewStorageIds(scope);
    return REVIEW_STORAGE_PREFIXES.map((prefix) =>
      scopedReviewStoragePrefix(prefix, ids),
    );
  }

  async function reviewStoragePrefixesForContext(scope) {
    const contextId = await reviewContextId(scope);
    return REVIEW_STORAGE_PREFIXES.map(
      (prefix) => `${prefix}${contextId}:`,
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
      IDENTIFIER_PATTERN.test(
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
    const validIdentifiers =
      IDENTIFIER_PATTERN.test(parts[0] ?? "") &&
      IDENTIFIER_PATTERN.test(parts[1] ?? "") &&
      IDENTIFIER_PATTERN.test(parts[2] ?? "");
    if (!validIdentifiers) {
      return null;
    }

    const valid =
      prefix === HUNK_REVIEW_STORAGE_PREFIX
        ? (parts.length === 4 && /^\d+$/.test(parts[3])) ||
          (parts.length === 5 &&
            /^\d+$/.test(parts[3]) &&
            parts[4] === "collapsed")
        : prefix === LINE_REVIEW_STORAGE_PREFIX
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
        LEGACY_REVIEW_PREFIXES.some((prefix) =>
          key.startsWith(prefix),
        )) ||
      (typeof key === "string" &&
        key.startsWith(REVIEW_CONTEXT_METADATA_PREFIX) &&
        !isReviewContextMetadataKey(key)) ||
      (isReviewStorageKey(key) && reviewStateKeyIdentity(key) === null)
    );
  }

  async function officialSyncSuppressionKey(scope, filePath) {
    const [ids, fileHash] = await Promise.all([
      reviewStorageIds(scope),
      hashIdentifier(IDENTIFIER_DOMAINS.FILE, filePath),
    ]);
    return formatOfficialSyncSuppressionKey(ids, fileHash);
  }

  function cachedOfficialSyncSuppressionKey(scope, filePath) {
    const ids = cachedReviewStorageIds(scope);
    const fileHash = cachedIdentifier(IDENTIFIER_DOMAINS.FILE, filePath);
    return ids && fileHash
      ? formatOfficialSyncSuppressionKey(ids, fileHash)
      : null;
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
    abortIdentifierCacheGeneration,
    aggregateLineState,
    beginIdentifierCacheGeneration,
    buildHunkSignature,
    cachedHunkStorageKey,
    cachedLineReviewBlockFingerprint,
    cachedLineReviewContextFingerprint,
    cachedLineStorageKey,
    cachedOfficialSyncSuppressionKey,
    clearIdentifierCache,
    commitIdentifierCacheGeneration,
    findHunkHeader,
    hashIdentifier,
    IDENTIFIER_DOMAINS,
    isObsoleteReviewStorageKey,
    isReviewContextMetadataKey,
    isReviewStorageKey,
    isHunkHeaderText,
    lineStorageKey,
    lineReviewBlockFingerprint,
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
    reviewStoragePrefixes,
    reviewStoragePrefixesForContext,
    hunkStorageKey,
  });
});
