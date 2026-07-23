(function defineHunkMarkContentApp(root) {
  "use strict";

  const namespace = root.HunkMarkContent ?? {};

  namespace.constants = Object.freeze({
    CONTROL_CLASS: "hunkmark-control",
    FILE_CONTAINER_SELECTOR: [
      ".js-file",
      '[data-details-container-group="file"]',
      '[data-testid="diff-file"]',
      '[data-testid^="diff-file-"]',
      '[data-testid$="-diff-file"]',
      "[data-file-path]",
      "copilot-diff-entry",
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
      '[aria-busy="true"]',
    ].join(", "),
    PANEL_ID: "hunkmark-panel",
    PANEL_SPACER_ID: "hunkmark-panel-spacer",
    RECONNECT_NOTICE_ID: "hunkmark-reconnect-notice",
    REFRESH_DELAY_MS: 120,
    REVIEW_ACCESS_TOUCH_INTERVAL_MS: 24 * 60 * 60 * 1000,
    REVIEW_RETENTION_MS: 180 * 24 * 60 * 60 * 1000,
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
        `${core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
      this.linkSplitPreferenceKey =
        `${core.STORAGE_NAMESPACE}:preference:link-split-sides`;

      this.controllersByRow = new Map();
      this.lineControllersByElement = new WeakMap();
      this.officialViewedProgrammaticClicks = new WeakSet();
      this.officialViewedStateByKey = new Map();
      this.officialViewedSyncPending = new WeakSet();
      this.officialViewedSyncSuppressed = new Set();
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
      this.refreshTimer = null;
      this.stopped = false;
      this.storagePruned = false;
      this.storagePrunePromise = null;
      this.storagePrunedAt = 0;
      this.lastObservedUrl = windowObject.location.href;
      this.navigationPollTimer = null;
      this.observer = null;
    }
  };

  root.HunkMarkContent = namespace;
})(globalThis);
