"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    expectFileDiffVisibility(fileElement, visible) {
      const previous = this.fileDiffVisibilityPending.get(fileElement);
      if (previous) {
        this.cancelExpectedFileDiffVisibility(fileElement, previous);
      }
      if (!visible) {
        this.setHostContextExpansionFileHidden(fileElement, true);
      }
      const expectation = {
        timeoutId: null,
        visible,
      };
      this.fileDiffVisibilityPending.set(fileElement, expectation);
      expectation.timeoutId = this.window.setTimeout(
        () =>
          this.cancelExpectedFileDiffVisibility(fileElement, expectation),
        this.constants.FILE_DIFF_VISIBILITY_EXPECTATION_TIMEOUT_MS,
      );
      return expectation;
    },

    cancelExpectedFileDiffVisibility(
      fileElement,
      expectation,
      { settled = false } = {},
    ) {
      const wasCurrent =
        this.fileDiffVisibilityPending.get(fileElement) === expectation;
      if (wasCurrent) {
        this.fileDiffVisibilityPending.delete(fileElement);
      }
      if (expectation.timeoutId !== null) {
        this.window.clearTimeout(expectation.timeoutId);
        expectation.timeoutId = null;
      }
      if (!settled && wasCurrent && fileElement.isConnected) {
        const visible = this.findHunkMarkers(fileElement).length > 0;
        if (expectation.visible === false && visible) {
          this.setHostContextExpansionFileHidden(fileElement, false);
        } else if (expectation.visible === true && !visible) {
          // GitHub can ignore an Expand file click while leaving the diff
          // folded. Keep pending context transitions associated with that hidden
          // DOM while their original wall-clock expiry remains in force.
          this.setHostContextExpansionFileHidden(fileElement, true);
        }
      }
    },

    consumeExpectedFileDiffVisibility() {
      const settled = {
        changed: false,
        fileElements: new Set(),
        revealed: false,
      };
      this.fileDiffVisibilityPending.forEach((expectation, fileElement) => {
        if (!fileElement.isConnected) {
          this.cancelExpectedFileDiffVisibility(fileElement, expectation, {
            settled: true,
          });
          settled.changed = true;
          settled.fileElements.add(fileElement);
          // A detached container proves only that GitHub replaced or removed
          // it. Do not turn the expected state into observed reveal evidence;
          // a connected replacement/prepaint root will provide that evidence.
          return;
        }
        const visible =
          this.findHunkMarkers(fileElement).length > 0;
        if (visible === expectation.visible) {
          this.cancelExpectedFileDiffVisibility(fileElement, expectation, {
            settled: true,
          });
          settled.changed = true;
          settled.fileElements.add(fileElement);
          settled.revealed ||= visible;
        }
      });
      return settled;
    },

    controllerMatchesHunk(controller, hunk) {
      return (
        controller.key === hunk.key &&
        controller.hunkCell === hunk.hunkCell &&
        controller.lines.length === hunk.lines.length &&
        controller.lines.every(
          (line, index) =>
            line.element === hunk.lines[index].element &&
            line.key === hunk.lines[index].key &&
            line.contextFingerprint === hunk.lines[index].contextFingerprint,
        )
      );
    },

    previousControllersForHunk(previousControllers, hunk) {
      const candidates = previousControllers.filter(
        (controller) => controller.filePath === hunk.filePath,
      );
      const targetLineKeys = hunk.lines.map((line) => line.key);
      if (targetLineKeys.length === 0) {
        const exact = candidates.find(
          (controller) => controller.key === hunk.key,
        );
        return exact ? [exact] : [];
      }
      for (let start = 0; start < candidates.length; start += 1) {
        const matched = [];
        const lineKeys = [];
        for (let end = start; end < candidates.length; end += 1) {
          matched.push(candidates[end]);
          lineKeys.push(...candidates[end].lines.map((line) => line.key));
          if (lineKeys.length > targetLineKeys.length) {
            break;
          }
          if (
            lineKeys.length === targetLineKeys.length &&
            lineKeys.every((key, index) => key === targetLineKeys[index])
          ) {
            return matched;
          }
        }
      }
      return [];
    },

    isExtensionContextInvalidated(error) {
      return (
        !this.chrome?.storage?.local ||
        /extension context invalidated/i.test(
          String(error?.message ?? error ?? ""),
        )
      );
    },

    stopForInvalidatedContext(error) {
      if (!this.isExtensionContextInvalidated(error)) {
        return false;
      }
      this.stop();
      this.showReconnectNotice();
      return true;
    },

    showReconnectNotice() {
      if (
        this.document.getElementById(this.constants.RECONNECT_NOTICE_ID)
      ) {
        return;
      }

      const notice = this.document.createElement("aside");
      notice.id = this.constants.RECONNECT_NOTICE_ID;
      notice.setAttribute("role", "alert");

      const message = this.document.createElement("span");
      message.textContent =
        "HunkMark needs to reconnect. Reload this page to continue.";

      const reloadButton = this.document.createElement("button");
      reloadButton.type = "button";
      reloadButton.textContent = "Reload";
      reloadButton.addEventListener("click", () => {
        this.window.location.reload();
      });

      notice.append(message, reloadButton);
      this.document.body.append(notice);
    },

    diffLoadFileElementForNode(node) {
      const element =
        node?.nodeType === this.window.Node.ELEMENT_NODE
          ? node
          : node?.parentElement;
      if (!(element instanceof this.window.Element)) {
        return null;
      }

      const currentRegionSelector =
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR;
      const currentRegion = element.matches(currentRegionSelector)
        ? element
        : element.closest(currentRegionSelector);
      if (currentRegion) {
        return currentRegion;
      }
      const fileSelector = this.constants.FILE_CONTAINER_SELECTOR;
      return element.matches(fileSelector)
        ? element
        : element.closest(fileSelector);
    },

    diffLoadFileElementsForMutation(mutation) {
      const fileElements = new Set();
      const remember = (node, { includeDescendants = false } = {}) => {
        const direct = this.diffLoadFileElementForNode(node);
        if (direct) {
          fileElements.add(direct);
          return;
        }
        if (
          !includeDescendants ||
          typeof node?.querySelectorAll !== "function"
        ) {
          return;
        }
        const currentRegions = Array.from(
          node.querySelectorAll(
            this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
          ),
        ).filter((candidate) => candidate.isConnected);
        if (currentRegions.length > 0) {
          currentRegions.forEach((candidate) => fileElements.add(candidate));
          return;
        }
        node
          .querySelectorAll(this.constants.FILE_CONTAINER_SELECTOR)
          .forEach((candidate) => {
            if (candidate.isConnected) {
              fileElements.add(candidate);
            }
          });
      };

      remember(mutation.target);
      [...mutation.addedNodes, ...mutation.removedNodes].forEach((node) =>
        remember(node, { includeDescendants: true }),
      );
      return fileElements;
    },

    diffLoadFileElementsForMutations(
      mutations,
      expectedFileElements = [],
    ) {
      const fileElements = new Set(
        Array.from(expectedFileElements).filter(
          (fileElement) => fileElement instanceof this.window.Element,
        ),
      );
      for (const mutation of mutations) {
        const mutationFileElements =
          this.diffLoadFileElementsForMutation(mutation);
        if (mutationFileElements.size === 0) {
          return null;
        }
        mutationFileElements.forEach((fileElement) =>
          fileElements.add(fileElement),
        );
      }
      return fileElements.size > 0 ? fileElements : null;
    },

    activeDiffLoadFileElements() {
      const fileElements = new Set();
      this.document
        .querySelectorAll(this.constants.ACTIVE_DIFF_LOADING_SELECTOR)
        .forEach((loadingElement) => {
          const fileElement =
            this.diffLoadFileElementForNode(loadingElement);
          if (
            fileElement?.isConnected &&
            this.fileDiffHasActiveLoadingContent(fileElement)
          ) {
            fileElements.add(fileElement);
          }
        });
      return fileElements;
    },

    unsettledDiffLoadReviewSuspensionPaths() {
      const filePaths = new Set();
      this.activeDiffLoadFileElements().forEach((fileElement) => {
        const filePath =
          this.currentFilePathEvidence(fileElement) ??
          this.knownFilePath(fileElement);
        if (filePath) {
          filePaths.add(filePath);
        }
      });
      // A loader can disappear in the same host batch that renders a partial
      // file. Its deferred record remains authoritative through quiet settle;
      // identities are not final until the record is cleared for full refresh.
      this.deferredDiffLoadRefreshes.forEach((_, filePath) =>
        filePaths.add(filePath),
      );
      return filePaths;
    },

    diffLoadFilePath(fileElement) {
      const currentPath = this.currentFilePathEvidence(fileElement);
      if (currentPath) {
        return this.rememberFileIdentity(fileElement, currentPath);
      }
      const knownPath = this.knownFilePath(fileElement);
      if (knownPath) {
        return knownPath;
      }
      const legacyFileElements = Array.from(
        this.document.querySelectorAll(
          this.constants.FILE_CONTAINER_SELECTOR,
        ),
      );
      const fallbackIndex = legacyFileElements.indexOf(fileElement);
      const path = this.resolveFilePath(
        fileElement,
        fallbackIndex >= 0 ? fallbackIndex : 0,
      );
      return path?.startsWith("unknown-file:") ? null : path;
    },

    mutationPreservesFileHeaderReviewIdentity(mutation) {
      const target =
        mutation.target?.nodeType === this.window.Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
      if (!(target instanceof this.window.Element)) {
        return false;
      }
      const fileHeader = target.matches(this.constants.FILE_HEADER_SELECTOR)
        ? target
        : target.closest(this.constants.FILE_HEADER_SELECTOR);
      const fileElement = this.diffLoadFileElementForNode(target);
      const knownFilePath = fileElement && this.knownFilePath(fileElement);
      if (
        !fileHeader ||
        !fileElement ||
        !knownFilePath ||
        this.currentFilePathEvidence(fileElement) !== knownFilePath
      ) {
        return false;
      }
      const structuralSelector = [
        this.constants.FILE_PATH_METADATA_SELECTOR,
        this.constants.FILE_CONTAINER_SELECTOR,
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
        this.constants.HUNK_ELEMENT_SELECTOR,
        this.constants.ROW_CANDIDATE_SELECTOR,
      ].join(", ");
      return [...mutation.addedNodes, ...mutation.removedNodes].every((node) => {
        if (node.nodeType !== this.window.Node.ELEMENT_NODE) {
          return true;
        }
        return (
          !node.matches(structuralSelector) &&
          !node.querySelector(structuralSelector)
        );
      });
    },

    mutationCanWaitForDiffLoad(mutation) {
      const target =
        mutation.target?.nodeType === this.window.Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
      if (!(target instanceof this.window.Element)) {
        return false;
      }
      if (this.mutationPreservesFileHeaderReviewIdentity(mutation)) {
        return true;
      }
      const trackedIdentitySelector = [
        this.constants.ROW_CANDIDATE_SELECTOR,
        this.constants.HUNK_ELEMENT_SELECTOR,
        "td.blob-code-addition",
        "td.blob-code-deletion",
        ".diff-text-cell",
        ".hunkmark-line-cell",
        "[data-line-anchor]",
        '[role="gridcell"]',
      ].join(", ");
      const isTrackedIdentity = (element) => {
        if (
          this.controllersByRow.has(element) ||
          this.lineControllersByElement.has(element)
        ) {
          return true;
        }
        const row = this.semanticRow(element);
        return Boolean(
          (row && this.controllersByRow.has(row)) ||
          this.knownLineControllerForMutationTarget(element),
        );
      };
      let removesTrackedIdentity = false;
      for (const node of mutation.removedNodes) {
        if (node.nodeType !== this.window.Node.ELEMENT_NODE) {
          continue;
        }
        if (isTrackedIdentity(node)) {
          removesTrackedIdentity = true;
          break;
        }
        for (const element of node.querySelectorAll(
          trackedIdentitySelector,
        )) {
          if (isTrackedIdentity(element)) {
            removesTrackedIdentity = true;
            break;
          }
        }
        if (removesTrackedIdentity) {
          break;
        }
      }
      // Loader presence must never hide a semantic mutation inside an existing
      // review identity. Those changes remain fail-closed and refresh now.
      if (
        removesTrackedIdentity ||
        this.knownLineControllerForMutationTarget(target)
      ) {
        return false;
      }
      if (
        target.matches(".diff-text-cell") ||
        target.closest(".diff-text-cell")
      ) {
        return false;
      }
      if (
        target.matches(this.constants.FILE_HEADER_SELECTOR) ||
        target.closest(this.constants.FILE_HEADER_SELECTOR) ||
        target.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
        target.closest(this.constants.HUNK_ELEMENT_SELECTOR)
      ) {
        return false;
      }
      return true;
    },

    resetDiffLoadFileControllers(filePath, fileElement) {
      const affectedControllers = Array.from(
        this.controllersByRow.values(),
      ).filter(
        (controller) =>
          controller.filePath === filePath ||
          controller.fileElement === fileElement,
      );
      const fileElements = new Set(
        affectedControllers.map((controller) => controller.fileElement),
      );
      affectedControllers.forEach((controller) =>
        this.destroyController(controller),
      );
      fileElements.forEach((fileElement) =>
        this.removeFileProgress(fileElement),
      );
      return affectedControllers.length;
    },

    cancelDeferredDiffLoadRefreshSettlement() {
      if (this.deferredDiffLoadRefreshSettleTimer !== null) {
        this.window.clearTimeout(this.deferredDiffLoadRefreshSettleTimer);
        this.deferredDiffLoadRefreshSettleTimer = null;
      }
    },

    cancelDiffLoadHydrations() {
      if (this.diffLoadHydrationViewportTimer !== null) {
        this.window.clearTimeout(this.diffLoadHydrationViewportTimer);
        this.diffLoadHydrationViewportTimer = null;
      }
      if (this.diffLoadHydrationReflowTimer !== null) {
        this.window.clearTimeout(this.diffLoadHydrationReflowTimer);
        this.diffLoadHydrationReflowTimer = null;
      }
      this.diffLoadHydrations.forEach(({ timerId }) =>
        this.window.clearTimeout(timerId),
      );
      this.diffLoadHydrations.clear();
    },

    clearDeferredDiffLoadRefreshes() {
      this.cancelDiffLoadHydrations();
      this.cancelDeferredDiffLoadRefreshSettlement();
      if (this.deferredDiffLoadRefreshTimer !== null) {
        this.window.clearTimeout(this.deferredDiffLoadRefreshTimer);
        this.deferredDiffLoadRefreshTimer = null;
      }
      this.deferredDiffLoadRefreshes.forEach((record) =>
        record.attributeObserver?.disconnect(),
      );
      this.deferredDiffLoadRefreshes.clear();
      this.diffLoadHydrationBatchBootstrapped = false;
    },

    ensureDeferredDiffLoadRefreshTimeout() {
      if (this.deferredDiffLoadRefreshTimer !== null) {
        return;
      }
      this.deferredDiffLoadRefreshTimer = this.window.setTimeout(() => {
        this.deferredDiffLoadRefreshTimer = null;
        const deferred = this.deferredDiffLoadRefreshes.size > 0;
        this.deferredDiffLoadRefreshTimedOut ||= deferred;
        this.clearDeferredDiffLoadRefreshes();
        if (deferred && !this.stopped) {
          this.scheduleRefresh();
        }
      }, this.constants.DIFF_LOAD_REFRESH_MAX_WAIT_MS);
    },

    deferredDiffLoadRecordAwaitsReplacement(fileElement) {
      return Boolean(
        !fileElement.isConnected &&
          this.fileRevealPrepaintRestores.get(fileElement)
            ?.waitForResolvedContent,
      );
    },

    pruneDisconnectedDeferredDiffLoadRefreshes() {
      let pruned = 0;
      for (const [filePath, record] of this.deferredDiffLoadRefreshes) {
        if (
          record.fileElement.isConnected ||
          this.deferredDiffLoadRecordAwaitsReplacement(record.fileElement)
        ) {
          continue;
        }
        record.attributeObserver?.disconnect();
        this.deferredDiffLoadRefreshes.delete(filePath);
        pruned += 1;
      }
      return pruned;
    },

    deferredDiffLoadStatus() {
      const status = {
        active: false,
        pruned: this.pruneDisconnectedDeferredDiffLoadRefreshes(),
      };
      for (const { fileElement } of this.deferredDiffLoadRefreshes.values()) {
        if (this.deferredDiffLoadRecordAwaitsReplacement(fileElement)) {
          status.active = true;
          continue;
        }
        const explicitRestore = Boolean(
          this.fileRevealPrepaintRestores.get(fileElement)
            ?.waitForResolvedContent,
        );
        const explicitUnresolvedSkeleton = Boolean(
          explicitRestore &&
            this.fileDiffHasUnresolvedContent(fileElement) &&
            this.findHunkMarkers(fileElement).length === 0,
        );
        const active =
          this.fileDiffHasActiveLoadingContent(fileElement) ||
          explicitUnresolvedSkeleton;
        status.active ||= active;
      }
      return status;
    },

    scheduleDeferredDiffLoadRefreshSettlement() {
      this.cancelDeferredDiffLoadRefreshSettlement();
      this.deferredDiffLoadRefreshSettleTimer = this.window.setTimeout(() => {
        this.deferredDiffLoadRefreshSettleTimer = null;
        if (this.stopped) {
          return;
        }
        const status = this.deferredDiffLoadStatus();
        if (this.deferredDiffLoadRefreshes.size === 0) {
          if (status.pruned > 0) {
            this.clearDeferredDiffLoadRefreshes();
            this.scheduleRefresh({ immediate: true });
          }
          return;
        }
        if (status.active) {
          this.ensureDeferredDiffLoadRefreshTimeout();
          return;
        }
        this.clearDeferredDiffLoadRefreshes();
        this.scheduleRefresh({ immediate: true });
      }, this.constants.DIFF_LOAD_REFRESH_SETTLE_MS);
    },

    rememberDeferredDiffLoadRefresh(filePath, fileElement) {
      const previous = this.deferredDiffLoadRefreshes.get(filePath);
      if (previous?.fileElement === fileElement) {
        return previous;
      }
      previous?.attributeObserver?.disconnect();
      const record = {
        attributeObserver: null,
        fileElement,
      };
      if (typeof this.window.MutationObserver === "function") {
        record.attributeObserver = new this.window.MutationObserver(() => {
          if (this.deferredDiffLoadRefreshes.get(filePath) !== record) {
            return;
          }
          this.scheduleDeferredDiffLoadRefreshSettlement();
        });
        record.attributeObserver.observe(fileElement, {
          attributeFilter: ["aria-label"],
          attributes: true,
        });
      }
      this.deferredDiffLoadRefreshes.set(filePath, record);
      return record;
    },

    settleDeferredDiffLoadFile(filePath, fileElement) {
      const record = this.deferredDiffLoadRefreshes.get(filePath);
      if (
        record?.fileElement !== fileElement ||
        !fileElement.isConnected ||
        this.fileDiffHasActiveLoadingContent(fileElement)
      ) {
        return false;
      }
      record.attributeObserver?.disconnect();
      this.deferredDiffLoadRefreshes.delete(filePath);
      this.restoreDiffMutationSuspendedReviewControls({
        keepFilePaths: this.unsettledDiffLoadReviewSuspensionPaths(),
      });
      if (this.deferredDiffLoadRefreshes.size === 0 && !this.stopped) {
        this.clearDeferredDiffLoadRefreshes();
        this.scheduleRefresh({ immediate: true });
      }
      return true;
    },

    settleDeferredDiffLoadRefreshes() {
      const status = this.deferredDiffLoadStatus();
      if (this.stopped) {
        return false;
      }
      if (this.deferredDiffLoadRefreshes.size === 0) {
        if (status.pruned > 0) {
          this.clearDeferredDiffLoadRefreshes();
          this.scheduleRefresh({ immediate: true });
          return true;
        }
        return false;
      }
      if (status.active) {
        // Keep the bounded per-file queue intact while any loader remains.
        // Clearing it on every quiet gap would bootstrap the same active
        // batch repeatedly; the max timeout remains the fail-closed bound.
        this.ensureDeferredDiffLoadRefreshTimeout();
        this.cancelDeferredDiffLoadRefreshSettlement();
        return false;
      }
      this.scheduleDeferredDiffLoadRefreshSettlement();
      return true;
    },

    deferRefreshForActiveDiffLoads(
      mutations,
      expectedFileElements = [],
    ) {
      // GitHub can publish several structurally valid DOMs while one or more
      // large files load. Track those files across root replacement so a
      // whole-page discovery runs once after the loading contract settles.
      const fileElements = this.diffLoadFileElementsForMutations(
        mutations,
        expectedFileElements,
      );
      if (!fileElements) {
        this.clearDeferredDiffLoadRefreshes();
        return false;
      }
      const directlyAffectedFilePaths = new Set(
        Array.from(
          fileElements,
          (fileElement) => this.diffLoadFilePath(fileElement),
        ).filter(Boolean),
      );
      this.activeDiffLoadFileElements().forEach((fileElement) =>
        fileElements.add(fileElement),
      );

      const unsafeFilePaths = new Set();
      for (const mutation of mutations) {
        if (this.mutationCanWaitForDiffLoad(mutation)) {
          continue;
        }
        const mutationFilePaths = new Set(
          Array.from(
            this.diffLoadFileElementsForMutation(mutation),
            (fileElement) => this.diffLoadFilePath(fileElement),
          ).filter(Boolean),
        );
        if (mutationFilePaths.size === 0) {
          this.clearDeferredDiffLoadRefreshes();
          return false;
        }
        mutationFilePaths.forEach((filePath) =>
          unsafeFilePaths.add(filePath),
        );
      }

      const fileElementsByPath = new Map();
      for (const fileElement of fileElements) {
        const filePath = this.diffLoadFilePath(fileElement);
        if (!filePath) {
          this.clearDeferredDiffLoadRefreshes();
          return false;
        }
        const previous = fileElementsByPath.get(filePath);
        if (
          !previous ||
          (!previous.isConnected && fileElement.isConnected)
        ) {
          fileElementsByPath.set(filePath, fileElement);
        }
      }
      const files = Array.from(
        fileElementsByPath,
        ([filePath, fileElement]) => ({
          active:
            this.fileDiffHasActiveLoadingContent(fileElement) ||
            Boolean(
              this.fileRevealPrepaintRestores.get(fileElement)
                ?.waitForResolvedContent &&
                this.fileDiffHasUnresolvedContent(fileElement) &&
                this.findHunkMarkers(fileElement).length === 0,
            ),
          fileElement,
          filePath,
          unsafe: unsafeFilePaths.has(filePath),
        }),
      );
      this.pruneDisconnectedDeferredDiffLoadRefreshes();
      const previouslyTrackedFilePaths = new Set(
        this.deferredDiffLoadRefreshes.keys(),
      );
      const trackBatch =
        this.deferredDiffLoadRefreshes.size > 0 ||
        files.some(({ active }) => active);
      if (!trackBatch) {
        this.clearDeferredDiffLoadRefreshes();
        return false;
      }

      files
        .filter(
          ({ fileElement }) =>
            fileElement.isConnected ||
            this.deferredDiffLoadRecordAwaitsReplacement(fileElement),
        )
        .forEach(({ fileElement, filePath }) =>
          this.rememberDeferredDiffLoadRefresh(filePath, fileElement),
        );
      files.forEach(({ fileElement, filePath, unsafe }) => {
        if (unsafe) {
          this.resetDiffLoadFileControllers(filePath, fileElement);
        }
        if (
          fileElement.isConnected &&
          (directlyAffectedFilePaths.has(filePath) ||
            !previouslyTrackedFilePaths.has(filePath))
        ) {
          this.scheduleDiffLoadFileHydration(filePath, fileElement);
        }
      });
      if (this.deferredDiffLoadRefreshes.size === 0) {
        return false;
      }
      if (this.deferredDiffLoadStatus().active) {
        this.ensureDeferredDiffLoadRefreshTimeout();
        this.cancelDeferredDiffLoadRefreshSettlement();
        return true;
      }

      this.scheduleDeferredDiffLoadRefreshSettlement();
      return true;
    },

    scheduleRefresh({ immediate = false } = {}) {
      if (this.stopped) {
        return;
      }

      if (this.diffLoadHydrationRunningStates.size > 0) {
        this.refreshAfterDiffLoadHydrations = true;
        return;
      }

      if (this.refreshRunning) {
        this.refreshAgain = true;
        this.refreshAgainImmediate ||= immediate;
        return;
      }

      if (this.refreshQueued) {
        if (!immediate || this.refreshTimer === null) {
          return;
        }
        this.window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.refreshQueued = false;
      }

      this.refreshQueued = true;
      const runRefresh = async () => {
        this.refreshTimer = null;
        this.refreshQueued = false;
        if (this.stopped) {
          return;
        }
        this.refreshRunning = true;
        this.refreshStickyLayoutReady = false;
        try {
          await this.refresh();
        } catch (error) {
          if (!this.stopForInvalidatedContext(error)) {
            this.finishAllFileRevealPrepaintRestores();
            console.warn("HunkMark could not refresh the page.", error);
          }
        } finally {
          this.refreshRunning = false;
          this.refreshStickyLayoutReady = false;
          if (!this.stopped && this.refreshAgain) {
            const rerunImmediately = this.refreshAgainImmediate;
            this.refreshAgain = false;
            this.refreshAgainImmediate = false;
            this.scheduleRefresh({ immediate: rerunImmediately });
          } else {
            this.scheduleStickyHunkLayout();
          }
          this.pumpDiffLoadFileHydrations();
        }
      };
      if (immediate) {
        this.window.queueMicrotask(runRefresh);
      } else {
        this.refreshTimer = this.window.setTimeout(
          runRefresh,
          this.constants.REFRESH_DELAY_MS,
        );
      }
    },

    handleStorageChanged(changes, areaName) {
      if (areaName !== "local") {
        return;
      }

      this.applyReviewContextMetadataChanges(changes);
      this.applyReviewStorageKeyChanges(changes);

      if (this.reviewStorageLimitExceeded()) {
        void this.ensureStoredReviewStatePruned({
          maxEntries: this.reviewStorageEntryLimit(),
        }).catch((error) => {
          if (!this.stopForInvalidatedContext(error)) {
            console.warn(
              "HunkMark could not enforce the review storage limit.",
              error,
            );
          }
        });
      }

      const autoCollapseChanged = Boolean(
        changes[this.autoCollapsePreferenceKey],
      );
      if (autoCollapseChanged) {
        this.autoCollapseViewed =
          changes[this.autoCollapsePreferenceKey].newValue !== false;
      }

      if (autoCollapseChanged) {
        this.syncAutoCollapseInput();
      }

      if (changes[this.linkSplitPreferenceKey]) {
        this.linkSplitSides =
          changes[this.linkSplitPreferenceKey].newValue !== false;
        const linkInput = this.document.querySelector(
          `#${this.constants.PANEL_ID} input[aria-label="Link split diff sides"]`,
        );
        if (linkInput) {
          linkInput.checked = this.linkSplitSides;
        }
      }

      const officialViewedSyncChange =
        changes[this.officialViewedSyncPreferenceKey];
      const officialViewedSyncWasEnabled =
        this.syncOfficialViewedEnabled;
      if (officialViewedSyncChange) {
        this.syncOfficialViewedEnabled =
          officialViewedSyncChange.newValue !== false;
        this.syncOfficialViewedPreferenceInput();
      }

      this.applyOfficialSuppressionChanges(changes);
      if (
        officialViewedSyncChange &&
        !officialViewedSyncWasEnabled &&
        this.syncOfficialViewedEnabled
      ) {
        this.applyOfficialViewedSyncPreference();
      }

      const reviewStateChanged = Object.keys(changes).some(
        (key) =>
          key.startsWith(
            `${this.Core.REVIEW_STORAGE_NAMESPACE}:mark:`,
          ) ||
          key.startsWith(
            `${this.Core.REVIEW_STORAGE_NAMESPACE}:line:`,
          ),
      );
      if (!reviewStateChanged) {
        return;
      }

      let pageAppearanceChanged = false;
      let cachedReviewEvidenceChanged = false;
      Object.entries(changes).forEach(([key, change]) => {
        if (
          this.adoptStoredLineReviewBaselineInFileSnapshot(
            key,
            change.newValue,
          )
        ) {
          cachedReviewEvidenceChanged = true;
        }
      });
      this.controllersByRow.forEach((controller) => {
        if (this.reviewAppearancePersistencePending(controller)) {
          return;
        }
        let controllerAppearanceChanged = false;
        const sharedCompletionSourcePropagation =
          this.propagateSharedHunkCompletionSourceChanges(
            controller,
            changes,
          );
        if (sharedCompletionSourcePropagation) {
          void sharedCompletionSourcePropagation.catch((error) => {
            if (!this.stopForInvalidatedContext(error)) {
              console.warn(
                "HunkMark could not reconcile shared hunk completion aliases.",
                error,
              );
            }
          });
        }
        const sharedCompletionChange = controller.sharedCompletionKey
          ? changes[controller.sharedCompletionKey]
          : null;
        const sharedCompletionValue = sharedCompletionChange
          ? sharedCompletionChange.newValue
          : this.sharedHunkCompletionByKey.get(
              controller.sharedCompletionKey,
            );
        if (changes[controller.collapsedKey]) {
          const collapsed = this.storedCollapseSurvivesSharedClear(
            changes[controller.collapsedKey].newValue,
            sharedCompletionValue,
          );
          controllerAppearanceChanged ||= controller.collapsed !== collapsed;
          controller.collapsed = collapsed;
        }

        let lineStorageChanged = false;
        let invalidatedLineReview = false;
        controller.lines.forEach((line) => {
          if (changes[line.key]) {
            const nextValue = changes[line.key].newValue;
            if (
              this.adoptStoredLineReviewBaselineContext(line, nextValue)
            ) {
              // Keep the hidden-file snapshot aligned even when the stored
              // review already matched and no visible appearance changed.
              cachedReviewEvidenceChanged = true;
            }
            const storedState = this.storedLineReviewState(
              line,
              nextValue,
              sharedCompletionValue,
            );
            const storedMatches = storedState.marked;
            controllerAppearanceChanged ||= line.marked !== storedMatches;
            line.marked = storedMatches;
            invalidatedLineReview ||= storedState.invalidated;
            lineStorageChanged = true;
          }
        });

        const hunkChange = changes[controller.key];
        if (hunkChange?.newValue && !invalidatedLineReview) {
          controllerAppearanceChanged ||=
            !controller.marked ||
            controller.indeterminate ||
            controller.lines.some((line) => !line.marked);
          controller.marked = true;
          controller.indeterminate = false;
          controller.lines.forEach((line) => {
            line.marked = true;
          });
        } else if (
          controller.lines.length > 0 &&
          (lineStorageChanged || hunkChange)
        ) {
          const marked = controller.marked;
          const indeterminate = controller.indeterminate;
          this.updateAggregateFromLines(controller);
          controllerAppearanceChanged ||=
            controller.marked !== marked ||
            controller.indeterminate !== indeterminate;
        } else if (hunkChange) {
          controllerAppearanceChanged ||=
            controller.marked || controller.indeterminate;
          controller.marked = false;
          controller.indeterminate = false;
        }
        if (invalidatedLineReview) {
          controllerAppearanceChanged ||= controller.collapsed;
          controller.collapsed = false;
        }

        if (sharedCompletionChange) {
          const previousAppearance = {
            collapsed: controller.collapsed,
            indeterminate: controller.indeterminate,
            lineMarks: controller.lines.map((line) => line.marked),
            marked: controller.marked,
            sharedCompletion: controller.sharedCompletion,
          };
          this.applySharedHunkCompletionState(
            controller,
            sharedCompletionChange.newValue,
            { restoreLocal: true },
          );
          controllerAppearanceChanged ||=
            controller.sharedCompletion !==
              previousAppearance.sharedCompletion ||
            controller.marked !== previousAppearance.marked ||
            controller.indeterminate !== previousAppearance.indeterminate ||
            controller.collapsed !== previousAppearance.collapsed ||
            controller.lines.some(
              (line, index) =>
                line.marked !== previousAppearance.lineMarks[index],
            );
        }

        if (controllerAppearanceChanged) {
          this.applyControllerAppearance(controller);
          pageAppearanceChanged = true;
        }
      });
      if (pageAppearanceChanged || cachedReviewEvidenceChanged) {
        this.updateProgress();
      }
    },

    checkForNavigation({ previousUrl = this.lastObservedUrl, forceRefresh = false } = {}) {
      const nextUrl = this.window.location.href;
      const observedUrl = this.lastObservedUrl;
      if (nextUrl === observedUrl && !forceRefresh) {
        return false;
      }
      const nextPage = nextUrl.split("#", 1)[0];
      const pageChanged = nextPage !== observedUrl.split("#", 1)[0];
      const hashOnly = nextUrl !== previousUrl &&
        nextPage === previousUrl.split("#", 1)[0];
      this.lastObservedUrl = nextUrl;
      // An anchor traversal is still a navigation intent: a queued return
      // must not override its scroll position, even when no diff scan is due.
      this.cancelStickyHunkReturn();
      if (!pageChanged && hashOnly) {
        return false;
      }
      if (pageChanged) {
        this.cancelScheduledProgressUpdate();
        this.deferredDiffLoadRefreshTimedOut = false;
        this.refreshAfterDiffLoadHydrations = false;
        this.clearDeferredDiffLoadRefreshes();
      }
      this.scheduleRefresh();
      return true;
    },

    handleMutations(mutations) {
      if (this.checkForNavigation()) {
        return;
      }

      if (!this.currentScope) {
        if (this.Core.parseReviewScope(this.window.location)) {
          this.scheduleRefresh();
        }
        return;
      }

      if (this.fileRevealPrepaintRestores.size > 0) {
        this.maintainFileRevealPrepaintRestores();
      }

      const expectedFileDiffVisibility =
        this.consumeExpectedFileDiffVisibility();
      const hostMutations = mutations.filter(
        (mutation) => !this.mutationIsExtensionOnly(mutation),
      );
      if (hostMutations.length > 0) {
        this.updateLineControlHostLayouts(hostMutations.map((mutation) =>
          this.knownLineControllerForMutationTarget(mutation.target),
        ));
        // Host DOM can translate every file. Diff-owned mutation targets also
        // invalidate the internal geometry of their ancestor file states.
        if (this.hunkStickyFileLayoutObserver) {
          this.invalidateVisibleStickyHunkOrigins({
            translationOnly: true,
          });
          this.invalidateStickyHunkOriginsForMutations(
            hostMutations,
          );
        } else {
          this.invalidateVisibleStickyHunkOrigins();
        }
        this.scheduleViewportHydrationReflowPriority();
      }
      const generationHostDiffMutations = hostMutations.filter((mutation) => {
        if (expectedFileDiffVisibility.changed) {
          const fileElements =
            this.diffLoadFileElementsForMutation(mutation);
          // Expected visibility also identifies older host containers that
          // do not match the current diff-region selectors.
          const expectedMutation = fileElements.size > 0
            ? Array.from(fileElements).every((fileElement) =>
                expectedFileDiffVisibility.fileElements.has(fileElement),
              )
            : Array.from(expectedFileDiffVisibility.fileElements).some(
                (fileElement) =>
                  mutation.target === fileElement ||
                  fileElement.contains(mutation.target),
              );
          if (expectedMutation) {
            return false;
          }
        }
        return this.mutationAffectsDiff(mutation);
      });
      const hostDiffMutations = expectedFileDiffVisibility.changed
        ? generationHostDiffMutations.filter((mutation) => {
            const fileElements =
              this.diffLoadFileElementsForMutation(mutation);
            return (
              fileElements.size === 0 ||
              Array.from(fileElements).some(
                (fileElement) =>
                  !expectedFileDiffVisibility.fileElements.has(fileElement),
              )
            );
          })
        : generationHostDiffMutations;
      const expectedVisibilityHasHostMutation = Boolean(
        expectedFileDiffVisibility.changed &&
          hostMutations.some(
            (mutation) =>
              this.diffLoadFileElementsForMutation(mutation).size > 0,
          ),
      );
      if (
        expectedFileDiffVisibility.changed ||
        hostDiffMutations.length > 0
      ) {
        const identityUnsafeMutation =
          expectedVisibilityHasHostMutation ||
          hostDiffMutations.some(
            (mutation) => !this.mutationCanWaitForDiffLoad(mutation),
          );
        const mutationFileElements = new Set(
          expectedFileDiffVisibility.fileElements,
        );
        let hasUnscopedDiffMutation = Boolean(
          expectedFileDiffVisibility.changed &&
            mutationFileElements.size === 0,
        );
        generationHostDiffMutations.forEach((mutation) => {
          const fileElements = this.diffLoadFileElementsForMutation(mutation);
          if (fileElements.size === 0) {
            hasUnscopedDiffMutation = true;
            return;
          }
          fileElements.forEach((fileElement) =>
            mutationFileElements.add(fileElement),
          );
        });
        let affectedFilePaths;
        this.diffMutationGeneration += 1;
        mutationFileElements.forEach((fileElement) => {
          this.diffMutationGenerationByFileElement.set(
            fileElement,
            (this.diffMutationGenerationByFileElement.get(fileElement) ?? 0) +
              1,
          );
        });
        if (hasUnscopedDiffMutation) {
          this.unscopedDiffMutationGeneration += 1;
        }
        const activeHostContextExpansionIntents =
          this.activeHostContextExpansionIntents();
        let pendingHostContextExpansionIntents = [];
        if (activeHostContextExpansionIntents.length > 0) {
          affectedFilePaths = this.hostContextExpansionMutationFilePaths(
            hostDiffMutations,
            expectedFileDiffVisibility.fileElements,
          );
          pendingHostContextExpansionIntents =
            activeHostContextExpansionIntents.filter(
              (intent) =>
                affectedFilePaths === null ||
                affectedFilePaths.has(intent.filePath),
            );
        }
        const hostContextExpansionPending =
          pendingHostContextExpansionIntents.length > 0;
        if (hostContextExpansionPending) {
          pendingHostContextExpansionIntents.forEach((intent) =>
            this.cancelHostContextExpansionSettlement(intent),
          );
        }
        const progressRemoved =
          !expectedFileDiffVisibility.changed &&
          this.removeProgressForFilesWithoutRenderedHunks(
            hasUnscopedDiffMutation ? null : mutationFileElements,
          );
        const expectedRestoreRoots = [
          ...Array.from(
            this.fileRevealPrepaintRestores.keys(),
          ).filter((fileElement) => fileElement.isConnected),
          ...Array.from(
            expectedFileDiffVisibility.fileElements,
          ).filter((fileElement) => fileElement.isConnected),
        ];
        const uniqueExpectedRestoreRoots = [
          ...new Set(expectedRestoreRoots),
        ];
        const scopedRestoreRoots = new Set(mutationFileElements);
        if (expectedFileDiffVisibility.changed) {
          uniqueExpectedRestoreRoots.forEach((root) =>
            scopedRestoreRoots.add(root),
          );
        }
        const restoreRoots = hasUnscopedDiffMutation
          ? [this.document]
          : Array.from(scopedRestoreRoots).filter(
              (fileElement) => fileElement.isConnected,
            );
        const expectedHideOnly =
          expectedFileDiffVisibility.changed &&
          !expectedFileDiffVisibility.revealed &&
          this.fileRevealPrepaintRestores.size === 0 &&
          hostDiffMutations.length === 0;
        // Removing a diff cannot expose review state that needs restoring.
        // Avoid rediscovering every still-rendered file before the host can
        // paint its Viewed/collapse update; the queued refresh handles cleanup.
        // Visit every affected root even when an earlier file was restored.
        const restorationResults = restoreRoots.map((root) => {
          if (expectedHideOnly || hostContextExpansionPending) {
            return { restored: false, canDefer: false };
          }
          // Clean unreviewed reveals intentionally defer controller creation.
          if (this.finishCleanCachedFileReveal(root)) {
            return { restored: true, canDefer: true };
          }
          const controllerRestoration = {};
          const appearanceRestored = this.preserveOfficialViewedRestoredState(
            root,
            controllerRestoration,
          );
          const controllersRestored = this.restoreCachedFileControllers(
            root,
            controllerRestoration,
          );
          return {
            restored: appearanceRestored || controllersRestored,
            canDefer: controllerRestoration.complete === true,
            controlsReady: controllerRestoration.complete === true,
            cachedFileComplete: controllerRestoration.cachedFileComplete === true,
          };
        });
        const restored = restorationResults.some((result) => result.restored);
        this.finishReadyFileRevealPrepaintRestores();
        const deferredRestoreRoots = new Set(
          restoreRoots.filter((root, index) =>
            root !== this.document &&
            restorationResults[index].canDefer &&
            !this.fileRevealPrepaintRestores.has(root) &&
            this.restorationRootOwnsAllHunks(root),
          ),
        );
        const canDeferRefresh =
          restoreRoots.length > 0 &&
          deferredRestoreRoots.size === restoreRoots.length;
        // A clean paint-only reveal does not validate controller identities.
        const confirmedRestoreRoots = new Set(restoreRoots.filter((root, index) =>
          deferredRestoreRoots.has(root) &&
          restorationResults[index].controlsReady &&
          restorationResults[index].cachedFileComplete,
        ));
        if (
          expectedFileDiffVisibility.revealed &&
          hostDiffMutations.length === 0 &&
          !hasUnscopedDiffMutation &&
          confirmedRestoreRoots.size === restoreRoots.length &&
          restorationResults.every((result) => result.cachedFileComplete) &&
          this.finishConfirmedCachedFileReveals(confirmedRestoreRoots)
        ) {
          return;
        }
        const diffLoadExpectedRoots =
          uniqueExpectedRestoreRoots.length > 0
            ? uniqueExpectedRestoreRoots
            : expectedFileDiffVisibility.fileElements;
        const refreshDeferredForDiffLoad =
          !expectedHideOnly &&
          !hostContextExpansionPending &&
          this.deferRefreshForActiveDiffLoads(
            hostDiffMutations,
            diffLoadExpectedRoots,
          );
        if (identityUnsafeMutation) {
          affectedFilePaths ??=
            this.hostContextExpansionMutationFilePaths(
              hostDiffMutations,
              expectedFileDiffVisibility.fileElements,
            );
          // Complete, owned cached restores already establish these controls'
          // current identities. Keep them usable during the full refresh.
          this.suspendReviewControllersForDiffMutation(affectedFilePaths, {
            controllers: Array.from(this.controllersByRow.values()).filter(
              (controller) => !confirmedRestoreRoots.has(controller.fileElement),
            ),
          });
        }
        if (refreshDeferredForDiffLoad) {
          this.suspendReviewControllersForDiffMutation(
            this.unsettledDiffLoadReviewSuspensionPaths(),
            { allowFileReveal: true },
          );
        }
        if (
          expectedHideOnly &&
          activeHostContextExpansionIntents.length === 0
        ) {
          this.clearDeferredDiffLoadRefreshes();
        } else if (hostContextExpansionPending || expectedHideOnly) {
          this.cancelDiffLoadHydrations();
          this.diffLoadHydrationBatchBootstrapped = false;
        }
        if (!refreshDeferredForDiffLoad) {
          this.scheduleRefresh({
            immediate:
              !expectedHideOnly &&
              (hostContextExpansionPending ||
                progressRemoved ||
                (!canDeferRefresh &&
                  (expectedFileDiffVisibility.changed || restored))),
          });
        }
      }
    },

    start() {
      this.stopped = false;
      this.document
        .getElementById(this.constants.RECONNECT_NOTICE_ID)
        ?.remove();
      this.boundStorageChanged = (changes, areaName) =>
        this.handleStorageChanged(changes, areaName);
      this.boundPointerMove = (event) => this.lineDragPointerMove(event);
      this.boundPointerEnd = (event) => this.lineDragPointerEnd(event);
      this.boundLineControlClick = (event) =>
        this.handleLineControlClick(event);
      this.boundLineControlPointerDown = (event) =>
        this.handleLineControlPointerDown(event);
      this.boundHostContextExpansionClick = (event) =>
        this.handleHostContextExpansionClick(event);
      this.boundOfficialViewedClick = (event) => {
        void this.handleOfficialViewedClick(event).catch((error) => {
          if (!this.stopForInvalidatedContext(error)) {
            console.warn(
              "HunkMark could not handle GitHub's Viewed control.",
              error,
            );
          }
        });
      };
      this.boundFileVisibilityClick = (event) =>
        this.handleFileVisibilityClick(event);
      this.boundScheduleRefresh = () => this.scheduleRefresh();
      const observesHistoryEntries =
        typeof this.window.navigation?.addEventListener === "function";
      this.boundNavigationChange = (event) => this.checkForNavigation({
        previousUrl: typeof event?.from?.url === "string" ? event.from.url : undefined,
        forceRefresh: event?.navigationType === "traverse",
      });
      // Navigation API handles native traversals, including same-URL entries.
      // Preserve explicit popstate notifications and the legacy fallback.
      this.boundPopState = (event) => this.checkForNavigation({
        forceRefresh: !observesHistoryEntries || !event.isTrusted,
      });
      this.boundPageShow = (event) => {
        if (event.persisted) {
          this.cancelStickyHunkReturn();
          this.scheduleRefresh();
        }
      };
      this.boundStickyHunkLayout = () => {
        this.scheduleStickyHunkLayout();
        this.scheduleViewportHydrationPriority();
      };
      this.boundStickyHunkNavigationIntent = (event) => {
        if (this.hunkStickyStateByFile.size > 0) {
          if (event.type !== "click" || event.isTrusted) {
            this.cancelStickyHunkReturn();
          }
          // CSS may have crossed a hunk boundary before the scroll callback.
          // Synchronize interaction state before an activation, not on wheel.
          if (event.type !== "wheel") {
            const controller = this.stickyHunkControllerForInteractionTarget(event.target);
            if (controller) {
              this.updateStickyHunkInteractionsForControllers([controller]);
            }
          }
        }
      };
      this.boundStickyHunkResize = () => {
        if (this.hunkStickyStateByFile.size > 0) {
          this.invalidateVisibleStickyHunkLayouts({ refreshHeaders: true });
          this.updateLineControlHostLayouts(Array.from(this.hunkStickyVisibleStates)
            .flatMap((state) => this.materializedLinesForStickyState(state)));
        }
      };
      this.boundWindowBlur = () => {
        if (this.dragState) {
          void this.finishLineDrag(true);
        }
      };
      this.chrome.storage.onChanged.addListener(this.boundStorageChanged);
      this.observer = new this.window.MutationObserver((mutations) => {
        try {
          this.handleMutations(mutations);
        } catch (error) {
          if (!this.stopForInvalidatedContext(error)) {
            this.finishAllFileRevealPrepaintRestores();
            console.warn("HunkMark could not process a diff update.", error);
          }
        }
      });
      this.observer.observe(this.document.documentElement, {
        childList: true,
        subtree: true,
      });
      this.document.addEventListener(
        "pointermove",
        this.boundPointerMove,
        { passive: false },
      );
      this.document.addEventListener("pointerup", this.boundPointerEnd);
      this.document.addEventListener("pointercancel", this.boundPointerEnd);
      this.document.addEventListener(
        "pointerdown",
        this.boundLineControlPointerDown,
        { capture: true, passive: false },
      );
      this.document.addEventListener(
        "pointerdown",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.document.addEventListener(
        "keydown",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundHostContextExpansionClick,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundLineControlClick,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundOfficialViewedClick,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundFileVisibilityClick,
        true,
      );
      this.document.addEventListener(
        "turbo:load",
        this.boundScheduleRefresh,
      );
      this.document.addEventListener(
        "turbo:render",
        this.boundScheduleRefresh,
      );
      this.document.addEventListener(
        "turbo:frame-load",
        this.boundScheduleRefresh,
      );
      this.document.addEventListener("pjax:end", this.boundScheduleRefresh);
      this.window.addEventListener("popstate", this.boundPopState);
      this.window.addEventListener("pageshow", this.boundPageShow);
      this.window.addEventListener("scroll", this.boundStickyHunkLayout, {
        passive: true,
      });
      this.window.addEventListener(
        "wheel",
        this.boundStickyHunkNavigationIntent,
        { passive: true },
      );
      this.window.addEventListener("resize", this.boundStickyHunkResize);
      this.window.navigation?.addEventListener?.(
        "currententrychange",
        this.boundNavigationChange,
      );
      this.window.addEventListener("blur", this.boundWindowBlur);
      this.navigationPollTimer = this.window.setInterval(
        this.boundNavigationChange,
        this.constants.NAVIGATION_POLL_INTERVAL_MS,
      );

      this.scheduleRefresh();
    },

    stop() {
      if (this.stopped) {
        return;
      }
      this.stopped = true;
      if (this.refreshTimer !== null) {
        this.window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      this.refreshQueued = false;
      this.refreshAgain = false;
      this.refreshAgainImmediate = false;
      this.refreshAfterDiffLoadHydrations = false;
      this.cancelScheduledProgressUpdate();
      this.clearDeferredDiffLoadRefreshes();
      this.deferredDiffLoadRefreshTimedOut = false;
      this.reviewAppearancePersistenceCountByController.clear();
      this.clearAllHostContextExpansionIntents();
      this.observer?.disconnect();
      this.observer = null;
      try {
        this.chrome.storage.onChanged.removeListener?.(
          this.boundStorageChanged,
        );
      } catch (error) {
        if (!this.isExtensionContextInvalidated(error)) {
          console.warn(
            "HunkMark could not detach its storage listener.",
            error,
          );
        }
      }
      this.document.removeEventListener("pointermove", this.boundPointerMove);
      this.document.removeEventListener("pointerup", this.boundPointerEnd);
      this.document.removeEventListener("pointercancel", this.boundPointerEnd);
      this.document.removeEventListener(
        "pointerdown",
        this.boundLineControlPointerDown,
        true,
      );
      this.document.removeEventListener(
        "pointerdown",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.document.removeEventListener(
        "keydown",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.document.removeEventListener(
        "click",
        this.boundHostContextExpansionClick,
        true,
      );
      this.document.removeEventListener(
        "click",
        this.boundLineControlClick,
        true,
      );
      this.document.removeEventListener(
        "click",
        this.boundOfficialViewedClick,
        true,
      );
      this.document.removeEventListener(
        "click",
        this.boundFileVisibilityClick,
        true,
      );
      this.document.removeEventListener(
        "turbo:load",
        this.boundScheduleRefresh,
      );
      this.document.removeEventListener(
        "turbo:render",
        this.boundScheduleRefresh,
      );
      this.document.removeEventListener(
        "turbo:frame-load",
        this.boundScheduleRefresh,
      );
      this.document.removeEventListener("pjax:end", this.boundScheduleRefresh);
      this.window.removeEventListener("popstate", this.boundPopState);
      this.window.removeEventListener("pageshow", this.boundPageShow);
      this.window.removeEventListener("scroll", this.boundStickyHunkLayout);
      this.document.removeEventListener(
        "click",
        this.boundStickyHunkNavigationIntent,
        true,
      );
      this.window.removeEventListener(
        "wheel",
        this.boundStickyHunkNavigationIntent,
      );
      this.window.removeEventListener("resize", this.boundStickyHunkResize);
      this.window.navigation?.removeEventListener?.(
        "currententrychange",
        this.boundNavigationChange,
      );
      this.window.removeEventListener("blur", this.boundWindowBlur);
      if (this.navigationPollTimer !== null) {
        this.window.clearInterval(this.navigationPollTimer);
        this.navigationPollTimer = null;
      }
      this.cleanupExtensionElements();
      this.Core.clearIdentifierCache();
    },
  });
}
