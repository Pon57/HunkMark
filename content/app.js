(function defineHunkMarkContentApp(root) {
  "use strict";

  const namespace = root.HunkMarkContent ?? {};

  namespace.constants = Object.freeze({
    CONTROL_CLASS: "hunkmark-control",
    FILE_DIFF_VISIBILITY_EXPECTATION_TIMEOUT_MS: 30_000,
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
      '[aria-busy="true"]',
      '[aria-label^="Loading "]',
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
    OFFICIAL_FILE_VIEWED_SELECTOR: [
      'button[aria-pressed][aria-label="Not Viewed"]',
      'button[aria-pressed][aria-label="Viewed"]',
      'button[aria-pressed][class*="MarkAsViewedButton"]',
      'input[type="checkbox"].js-reviewed-checkbox',
      'input[type="checkbox"][name="viewed"]',
    ].join(", "),
    NAVIGATION_POLL_INTERVAL_MS: 250,
    UNRESOLVED_DIFF_SELECTOR: [
      "include-fragment[src]",
      ".js-diff-load-container",
      ".js-diff-progressive-container",
      '[data-testid*="diff-loading"]',
      '[data-testid*="load-diff"]',
      '[data-testid*="load-more"]',
      '[role="region"][aria-label^="Loading "][id^="diff-"]',
      '[aria-busy="true"]',
    ].join(", "),
    PANEL_ID: "hunkmark-panel",
    PANEL_SPACER_ID: "hunkmark-panel-spacer",
    RECONNECT_NOTICE_ID: "hunkmark-reconnect-notice",
    REFRESH_DELAY_MS: 120,
    REVIEW_ACCESS_TOUCH_INTERVAL_MS: 24 * 60 * 60 * 1000,
    REVIEW_RETENTION_MS: 180 * 24 * 60 * 60 * 1000,
    REVIEW_STORAGE_LOCK_NAME: "hunkmark:review-storage:v3",
    REVIEW_STORAGE_PRUNE_INTERVAL_MS: 24 * 60 * 60 * 1000,
    REVIEW_STORAGE_MAX_ENTRIES: 25_000,
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

      this.controllersByRow = new Map();
      this.lineControllersByElement = new WeakMap();
      this.officialViewedProgrammaticClicks = new WeakSet();
      this.officialViewedIntentGenerationByKey = new Map();
      this.officialViewedReconcileGenerationByKey = new Map();
      this.officialViewedReviewPendingByKey = new Map();
      this.officialViewedStorageIntentGenerationByKey = new Map();
      this.nextOfficialViewedIntentGeneration = 0;
      this.fileDiffVisibilityPending = new Map();
      this.officialViewedRestoreGuards = new Map();
      this.fileRevealPrepaintRestores = new Map();
      this.officialViewedSyncPending = new WeakSet();
      this.officialViewedSyncSuppressed = new Set();
      this.fileRevealRestorePending = new Set();
      this.fileProgressStateByKey = new Map();
      this.lineReviewContextByKey = new Map();
      this.reviewContextAccessedAtById = new Map();
      this.reviewStorageKeys = new Set();

      this.currentScope = null;
      this.currentReviewScope = null;
      this.currentReviewVariant = null;
      this.dragState = null;
      this.autoCollapseViewed = true;
      this.linkSplitSides = true;
      this.preferencesLoaded = false;
      this.panelClearanceObserver = null;
      this.panelClearanceTarget = null;
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

  root.HunkMarkContent = namespace;
})(globalThis);
