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
          // a connected replacement/prepaint root will establish that itself.
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

    scheduleRefresh({ immediate = false } = {}) {
      if (this.stopped) {
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
        try {
          await this.refresh();
        } catch (error) {
          if (!this.stopForInvalidatedContext(error)) {
            this.finishAllFileRevealPrepaintRestores();
            console.warn("HunkMark could not refresh the page.", error);
          }
        } finally {
          this.refreshRunning = false;
          if (!this.stopped && this.refreshAgain) {
            const rerunImmediately = this.refreshAgainImmediate;
            this.refreshAgain = false;
            this.refreshAgainImmediate = false;
            this.scheduleRefresh({ immediate: rerunImmediately });
          }
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

      this.applyOfficialSuppressionChanges(changes);

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
        let controllerAppearanceChanged = false;
        if (changes[controller.collapsedKey]) {
          const collapsed = Boolean(
            changes[controller.collapsedKey].newValue,
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
            const storedMatches = this.storedLineReviewMatches(
              line,
              nextValue,
            );
            controllerAppearanceChanged ||= line.marked !== storedMatches;
            line.marked = storedMatches;
            invalidatedLineReview ||= (
              nextValue !== undefined && !storedMatches
            );
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

        if (controllerAppearanceChanged) {
          this.applyControllerAppearance(controller);
          pageAppearanceChanged = true;
        }
      });
      if (pageAppearanceChanged || cachedReviewEvidenceChanged) {
        this.updateProgress();
      }
    },

    checkForNavigation() {
      const nextUrl = this.window.location.href;
      if (nextUrl === this.lastObservedUrl) {
        return false;
      }
      this.cancelStickyHunkReturn();
      this.lastObservedUrl = nextUrl;
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
        // Host DOM outside the diff can still move every cached hunk origin.
        // Invalidate positions without paying for an unrelated rediscovery.
        this.invalidateVisibleStickyHunkOrigins();
      }
      const hostDiffMutations = expectedFileDiffVisibility.changed
        ? []
        : hostMutations.filter(
            (mutation) => this.mutationAffectsDiff(mutation),
          );
      if (
        expectedFileDiffVisibility.changed ||
        hostDiffMutations.length > 0
      ) {
        const activeHostContextExpansionIntents =
          this.activeHostContextExpansionIntents();
        let pendingHostContextExpansionIntents = [];
        if (activeHostContextExpansionIntents.length > 0) {
          const affectedFilePaths =
            this.hostContextExpansionMutationFilePaths(
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
          this.removeProgressForFilesWithoutRenderedHunks();
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
        const restoreRoot = expectedFileDiffVisibility.changed
          ? uniqueExpectedRestoreRoots.length === 1
            ? uniqueExpectedRestoreRoots[0]
            : this.document
          : this.fileRevealRestoreRootForMutations(hostDiffMutations);
        const expectedHideOnly =
          expectedFileDiffVisibility.changed &&
          !expectedFileDiffVisibility.revealed &&
          this.fileRevealPrepaintRestores.size === 0;
        // Removing a diff cannot expose review state that needs restoring.
        // Avoid rediscovering every still-rendered file before the host can
        // paint its Viewed/collapse update; the queued refresh handles cleanup.
        const restored = expectedHideOnly || hostContextExpansionPending
          ? false
          : this.finishCleanCachedFileReveal(restoreRoot) ||
            this.preserveOfficialViewedRestoredState(restoreRoot) ||
            this.restoreCachedFileControllers(restoreRoot);
        this.finishReadyFileRevealPrepaintRestores();
        const canDeferRefresh =
          restoreRoot !== this.document &&
          restored &&
          !this.fileRevealPrepaintRestores.has(restoreRoot);
        this.scheduleRefresh({
          immediate:
            !expectedHideOnly &&
            (hostContextExpansionPending ||
              progressRemoved ||
              (!canDeferRefresh &&
                (expectedFileDiffVisibility.changed || restored))),
        });
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
      this.boundNavigationChange = () => this.checkForNavigation();
      this.boundStickyHunkLayout = () => this.scheduleStickyHunkLayout();
      this.boundStickyHunkNavigationIntent = () => {
        if (this.hunkStickyStateByFile.size > 0) {
          this.cancelStickyHunkReturn();
        }
      };
      this.boundStickyHunkResize = () => {
        if (this.hunkStickyStateByFile.size > 0) {
          this.invalidateVisibleStickyHunkLayouts({ refreshHeaders: true });
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
      this.window.addEventListener("popstate", this.boundScheduleRefresh);
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
      this.window.removeEventListener("popstate", this.boundScheduleRefresh);
      this.window.removeEventListener("scroll", this.boundStickyHunkLayout);
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
