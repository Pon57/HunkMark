(function defineHunkMarkContentApp(root) {
  "use strict";

  const namespace = root.HunkMarkContent ?? {};
  const ACTIVE_DIFF_LOADING_SELECTOR = [
    "include-fragment[src]",
    '[data-testid*="diff-loading"]',
    '[data-component="loadingSpinner"]',
    '[data-component="Spinner"]',
    '[role="region"][aria-label^="Loading "][id^="diff-"]',
    '[role="progressbar"]',
  ].join(", ");
  const UNRESOLVED_DIFF_SELECTOR = [
    ACTIVE_DIFF_LOADING_SELECTOR,
    '[data-testid*="load-diff"]',
    '[data-testid*="load-more"]',
  ].join(", ");
  const CURRENT_FILE_DIFF_REGION_SELECTOR = [
    '[role="region"][id^="diff-"]',
    '[role="region"][class*="Diff-module__diff"]',
  ].join(", ");

  namespace.constants = Object.freeze({
    ACTIVE_DIFF_LOADING_SELECTOR,
    CONTROL_CLASS: "hunkmark-control",
    CURRENT_FILE_DIFF_REGION_SELECTOR,
    FILE_DIFF_VISIBILITY_EXPECTATION_TIMEOUT_MS: 30_000,
    FILE_PATH_EVIDENCE_SELECTOR: [
      "[data-file-path]",
      ".file-header[data-path]",
      '[data-testid*="file-header"][data-path]',
      '[data-testid*="file-name"]',
      "clipboard-copy[value]",
      '[role="grid"][aria-label^="Diff for: "]',
      'a[href^="#diff-"]',
    ].join(", "),
    FILE_CONTAINER_SELECTOR: [
      ".js-file",
      '[data-details-container-group="file"]',
      '[data-testid="diff-file"]',
      '[data-testid^="diff-file-"]',
      '[data-testid$="-diff-file"]',
      "[data-file-path]",
      "copilot-diff-entry",
    ].join(", "),
    FILE_REVEAL_LOADING_INDICATOR_SELECTOR: [
      '[data-component="loadingSpinner"]',
      '[data-component="Spinner"]',
      '[role="progressbar"]',
    ].join(", "),
    HUNK_ELEMENT_SELECTOR: [
      "td.blob-code-hunk",
      ".blob-code-hunk",
      '[data-testid="diff-hunk"]',
      '[data-testid*="hunk-header"]',
      '[data-testid*="diff-hunk"]',
      '[class*="hunk-header"]',
      '[class*="diff-hunk"]',
      "[data-hunk]",
    ].join(", "),
    HUNK_EXPANSION_CONTROL_SELECTOR: [
      ".js-expand",
      ".js-expand-full",
      ".js-expand-all-difflines-button",
      'button[class*="ExpandableHunkHeaderDiffLine-module__"]',
      '[aria-label^="Expand up" i]',
      '[aria-label^="Expand down" i]',
      '[aria-label^="Expand all" i]',
      '[aria-label^="Expand file from" i]',
      '[aria-label^="Expand file up" i]',
      '[aria-label^="Expand file down" i]',
    ].join(", "),
    HOST_CONTEXT_EXPANSION_SETTLE_MS: 250,
    HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS: 30_000,
    LAZY_LINE_CONTROL_CHUNK_SIZE: 16,
    LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD: 500,
    OFFICIAL_FILE_VIEWED_SELECTOR: [
      'button[aria-pressed][aria-label="Not Viewed"]',
      'button[aria-pressed][aria-label="Viewed"]',
      'button[aria-pressed][class*="MarkAsViewedButton"]',
      'input[type="checkbox"].js-reviewed-checkbox',
      'input[type="checkbox"][name="viewed"]',
    ].join(", "),
    NAVIGATION_POLL_INTERVAL_MS: 250,
    UNRESOLVED_DIFF_SELECTOR,
    PANEL_ID: "hunkmark-panel",
    PANEL_SETTINGS_ID: "hunkmark-panel-settings",
    PANEL_SPACER_ID: "hunkmark-panel-spacer",
    RECONNECT_NOTICE_ID: "hunkmark-reconnect-notice",
    REFRESH_DELAY_MS: 120,
    REVIEW_ACCESS_TOUCH_INTERVAL_MS: 24 * 60 * 60 * 1000,
    REVIEW_RETENTION_MS: 180 * 24 * 60 * 60 * 1000,
    REVIEW_STORAGE_LOCK_NAME: "hunkmark:review-storage:v3",
    REVIEW_STORAGE_PRUNE_INTERVAL_MS: 24 * 60 * 60 * 1000,
    REVIEW_STORAGE_MAX_ENTRIES: 25_000,
    STICKY_HUNK_HEIGHT_PX: 24,
    ROW_CANDIDATE_SELECTOR: [
      "tr",
      '[role="row"]',
      '[data-testid="diff-line"]',
      '[data-testid^="diff-line-"]',
      "[data-line-type]",
    ].join(", "),
  });

  namespace.App = class HunkMarkContentApp {
    constructor({ chromeApi, core, windowObject }) {
      this.chrome = chromeApi;
      this.Core = core;
      this.window = windowObject;
      this.document = windowObject.document;
      this.constants = namespace.constants;

      this.autoCollapsePreferenceKey =
        `${core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
      this.linkSplitPreferenceKey =
        `${core.PREFERENCE_STORAGE_NAMESPACE}:preference:link-split-sides`;
      this.officialViewedSyncPreferenceKey =
        `${core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`;

      this.controllersByRow = new Map();
      this.lineControllersByElement = new WeakMap();
      this.lineControlVisibilityObserver = null;
      this.hunkStickyHeaderObserver = null;
      this.hunkStickyRowObserver = null;
      this.hunkStickyControllerByRow = new WeakMap();
      this.hunkStickyFileLayoutObserver = null;
      this.hunkStickyFileVisibilityObserver = null;
      this.hunkStickyFileByHeader = new WeakMap();
      this.hunkStickyLayoutFrameId = null;
      this.hunkStickyScrollFrameId = null;
      this.hunkStickyNavigationGeneration = 0;
      this.hunkStickyStateByFile = new Map();
      this.hunkStickyVisibleStates = new Set();
      this.officialViewedProgrammaticClicks = new WeakSet();
      this.officialViewedIntentGenerationByKey = new Map();
      this.officialViewedReconcileGenerationByKey = new Map();
      this.officialViewedReviewPendingByKey = new Map();
      this.officialViewedStorageIntentGenerationByKey = new Map();
      this.nextOfficialViewedIntentGeneration = 0;
      this.fileDiffVisibilityPending = new Map();
      this.fileIdentityByElement = new WeakMap();
      this.officialViewedRestoreGuards = new Map();
      this.fileRevealPrepaintRestores = new Map();
      this.officialViewedSyncPending = new WeakSet();
      this.officialViewedSyncSuppressed = new Set();
      this.fileRevealRestorePending = new Set();
      this.fileProgressStateByKey = new Map();
      this.fileReviewSnapshotsByKey = new Map();
      this.hostContextExpansionIntents = new Set();
      this.lineReviewBaselineContextByKey = new Map();
      this.lineReviewContextByKey = new Map();
      this.reviewTimestampByKey = new Map();
      this.reviewContextAccessedAtById = new Map();
      this.reviewStorageKeys = new Set();
      this.reviewAppearancePersistenceCountByController = new Map();
      this.sharedHunkCompletionByKey = new Map();

      this.currentScope = null;
      this.currentReviewScope = null;
      this.currentReviewVariant = null;
      this.dragState = null;
      this.autoCollapseViewed = true;
      this.linkSplitSides = true;
      this.syncOfficialViewedEnabled = true;
      this.preferencesLoaded = false;
      this.panelClearanceObserver = null;
      this.panelClearanceFileTarget = null;
      this.panelClearanceTarget = null;
      this.panelEventController = null;
      this.refreshQueued = false;
      this.refreshRunning = false;
      this.refreshAgain = false;
      this.refreshAgainImmediate = false;
      this.refreshTimer = null;
      this.stopped = false;
      this.reviewStoragePruned = false;
      this.reviewStoragePrunePromise = null;
      this.reviewStoragePrunedAt = 0;
      this.lastObservedUrl = windowObject.location.href;
      this.navigationPollTimer = null;
      this.observer = null;
    }

    localStorageArea() {
      const area = this.chrome?.storage?.local;
      if (!area) {
        throw new Error(
          "Extension context invalidated: chrome.storage.local is unavailable.",
        );
      }
      return area;
    }

    async getLocalStorage(keys) {
      return this.localStorageArea().get(keys);
    }

    async setLocalStorage(values) {
      return this.localStorageArea().set(values);
    }

    async removeLocalStorage(keys) {
      return this.localStorageArea().remove(keys);
    }
  };
  namespace.extendApp = (methods) =>
    Object.assign(namespace.App.prototype, methods);

  root.HunkMarkContent = namespace;
})(globalThis);
