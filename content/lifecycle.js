(function attachHunkMarkLifecycle(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    expectFileDiffVisibility(fileElement, visible) {
      const previous = this.fileDiffVisibilityPending.get(fileElement);
      if (previous) {
        this.cancelExpectedFileDiffVisibility(fileElement, previous);
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

    cancelExpectedFileDiffVisibility(fileElement, expectation) {
      if (this.fileDiffVisibilityPending.get(fileElement) === expectation) {
        this.fileDiffVisibilityPending.delete(fileElement);
      }
      if (expectation.timeoutId !== null) {
        this.window.clearTimeout(expectation.timeoutId);
        expectation.timeoutId = null;
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
          this.cancelExpectedFileDiffVisibility(fileElement, expectation);
          settled.changed = true;
          settled.fileElements.add(fileElement);
          settled.revealed ||= expectation.visible;
          return;
        }
        const visible =
          this.findHunkMarkers(fileElement).length > 0;
        if (visible === expectation.visible) {
          this.cancelExpectedFileDiffVisibility(fileElement, expectation);
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

    async refresh() {
      const nextScope = this.Core.parseReviewScope(this.window.location);
      const nextReviewVariant = this.Core.parseReviewVariant(
        this.window.location,
      );
      const nextReviewScope = this.Core.reviewStateScope(
        nextScope,
        nextReviewVariant,
      );
      if (nextReviewScope !== this.currentReviewScope) {
        this.Core.clearIdentifierCache();
        this.cleanupExtensionElements();
        this.resetOfficialViewedState();
        this.currentScope = nextScope;
        this.currentReviewScope = nextReviewScope;
        this.currentReviewVariant = nextReviewVariant;
      }

      if (!this.currentReviewScope) {
        return;
      }

      const now = Date.now();
      const reviewStoragePruneDue =
        !this.reviewStoragePruned ||
        now - this.reviewStoragePrunedAt >=
          this.constants.REVIEW_STORAGE_PRUNE_INTERVAL_MS;
      if (reviewStoragePruneDue) {
        try {
          await this.ensureStoredReviewStatePruned();
          this.reviewStoragePruned = true;
          this.reviewStoragePrunedAt = now;
        } catch (error) {
          if (this.isExtensionContextInvalidated(error)) {
            throw error;
          }
          console.warn("HunkMark could not prune old review state.", error);
        }
      } else {
        try {
          await this.touchReviewContextAccess();
        } catch (error) {
          if (this.isExtensionContextInvalidated(error)) {
            throw error;
          }
          console.warn("HunkMark could not update review access time.", error);
        }
      }

      await this.loadPreferences();

      const previousControllers = Array.from(this.controllersByRow.values());
      const cacheGeneration =
        this.Core.beginIdentifierCacheGeneration();
      let discovered;
      try {
        discovered = await this.discoverHunks();
      } catch (error) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
        throw error;
      }
      if (this.stopped) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
        return;
      }
      const discoveredScope = this.Core.reviewStateScope(
        this.Core.parseReviewScope(this.window.location),
        this.Core.parseReviewVariant(this.window.location),
      );
      if (discoveredScope !== this.currentReviewScope) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
        this.scheduleRefresh({ immediate: true });
        return;
      }
      this.Core.commitIdentifierCacheGeneration(cacheGeneration);
      const previousByHunk = new Map(
        discovered.map((hunk) => [
          hunk,
          this.previousControllersForHunk(previousControllers, hunk),
        ]),
      );
      const seenRows = new Set(discovered.map((hunk) => hunk.hunkRow));
      const lineCountsByFile = new Map();
      discovered.forEach((hunk) => {
        lineCountsByFile.set(
          hunk.fileElement,
          (lineCountsByFile.get(hunk.fileElement) ?? 0) + hunk.lines.length,
        );
      });
      const lazyLineControlFiles = new Set(
        Array.from(lineCountsByFile)
          .filter(
            ([, lineCount]) =>
              lineCount >=
              this.constants.LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD,
          )
          .map(([fileElement]) => fileElement),
      );
      const newControllers = [];
      const previousByController = new Map();

      Array.from(this.controllersByRow.values()).forEach((controller) => {
        if (!controller.hunkRow.isConnected || !seenRows.has(controller.hunkRow)) {
          this.destroyController(controller);
        }
      });

      discovered.forEach((hunk) => {
        const existing = this.controllersByRow.get(hunk.hunkRow);

        if (existing && !this.controllerMatchesHunk(existing, hunk)) {
          this.destroyController(existing);
        }

        const controller = this.controllersByRow.get(hunk.hunkRow);
        if (controller) {
          controller.fileElement = hunk.fileElement;
          controller.filePath = hunk.filePath;
          this.updateControllerRows(controller, hunk.groupRows);
        } else {
          const lazyLineControls = lazyLineControlFiles.has(
            hunk.fileElement,
          );
          const newController = this.createController(hunk, {
            deferLineControls:
              lazyLineControls ||
              this.reviewStorageKeys.has(`${hunk.key}:collapsed`),
            lazyLineControls,
          });
          newControllers.push(newController);
          previousByController.set(
            newController,
            previousByHunk.get(hunk) ?? [],
          );
        }
      });

      if (newControllers.length > 0) {
        const suppressionIntentGenerationByKey = new Map(
          newControllers.map((controller) => [
            controller.officialSuppressionKey,
            this.officialViewedIntentGenerationByKey.get(
              controller.officialSuppressionKey,
            ),
          ]),
        );
        const keys = [
          ...new Set(
            newControllers.flatMap((controller) => [
              ...controller.reviewKeys,
              controller.officialSuppressionKey,
            ]),
          ),
        ];
        await this.withReviewStorageLock(async () => {
          const stored = await this.getLocalStorage(keys);
          const migrations = {};
          const migrationRemovals = new Set();
          const migrationTime = Date.now();

          newControllers.forEach((controller) => {
            const previous = previousByController.get(controller) ?? [];
            const previousLineMarks = new Map(
              previous.flatMap((candidate) =>
                candidate.lines.map((line) => [
                  line.key,
                  {
                    contextFingerprint: line.contextFingerprint,
                    element: line.element,
                    marked: line.marked,
                  },
                ]),
              ),
            );
            const hunkStored =
              controller.lines.length === 0 &&
              Boolean(stored[controller.key]);
            const expandedByHost =
              previous.length > 1 ||
              (previous.length === 1 &&
                controller.groupRows.length > previous[0].groupRows.length);
            const suppressionKey = controller.officialSuppressionKey;
            if (
              this.officialViewedIntentGenerationByKey.get(suppressionKey) ===
              suppressionIntentGenerationByKey.get(suppressionKey)
            ) {
              const generation =
                this.createOfficialViewedIntentGeneration();
              this.registerOfficialViewedIntent(
                [suppressionKey],
                generation,
              );
              this.applyOfficialViewedIntent(
                [suppressionKey],
                Boolean(stored[suppressionKey]),
                generation,
              );
            }
            controller.collapsed =
              !expandedByHost && Boolean(stored[controller.collapsedKey]);
            controller.marked = hunkStored;
            let invalidatedLineReview = false;
            let preservedLineReviewForOtherContext = false;
            controller.lines.forEach((line) => {
              const storedLineReview = stored[line.key];
              const storedMatches = this.storedLineReviewMatches(
                line,
                storedLineReview,
              );
              const previousLine = previousLineMarks.get(line.key);
              const previousMatches =
                storedLineReview === undefined &&
                previousLine?.marked === true &&
                (previousLine.contextFingerprint === line.contextFingerprint ||
                  (expandedByHost && previousLine.element === line.element));
              line.marked = storedMatches || previousMatches;
              if (line.control) {
                line.control.disabled = false;
              }
              if (storedLineReview !== undefined && !storedMatches) {
                invalidatedLineReview = true;
                if (this.storedLineReviewHasContext(storedLineReview)) {
                  preservedLineReviewForOtherContext = true;
                } else {
                  migrationRemovals.add(line.key);
                }
              }
              if (line.marked && !storedMatches) {
                migrations[line.key] = this.lineReviewStorageValue(
                  line,
                  migrationTime,
                  { migratedFromHostExpansion: true },
                );
              }
            });
            this.updateAggregateFromLines(controller);
            if (invalidatedLineReview) {
              controller.collapsed = false;
              if (!preservedLineReviewForOtherContext) {
                migrationRemovals.add(controller.collapsedKey);
              }
            }
            if (
              expandedByHost &&
              !preservedLineReviewForOtherContext
            ) {
              migrationRemovals.add(controller.collapsedKey);
              previous.forEach((candidate) =>
                migrationRemovals.add(candidate.collapsedKey),
              );
            }
            controller.input.disabled = false;
            this.applyControllerAppearance(controller);
          });

          Object.keys(migrations).forEach((key) =>
            migrationRemovals.delete(key),
          );
          await this.mutateReviewStorageUnlocked({
            values: migrations,
            removals: Array.from(migrationRemovals),
            scope: this.currentReviewScope,
            now: migrationTime,
          });
        });
      }

      this.updateProgress();
      this.finishReadyFileRevealPrepaintRestores();
      this.clearSettledOfficialViewedRestoreGuards();
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
      if (pageAppearanceChanged) {
        this.updateProgress();
      }
    },

    checkForNavigation() {
      const nextUrl = this.window.location.href;
      if (nextUrl === this.lastObservedUrl) {
        return false;
      }
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
      const hostDiffMutations = expectedFileDiffVisibility.changed
        ? []
        : mutations.filter(
            (mutation) =>
              !this.mutationIsExtensionOnly(mutation) &&
              this.mutationAffectsDiff(mutation),
          );
      if (
        expectedFileDiffVisibility.changed ||
        hostDiffMutations.length > 0
      ) {
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
        const restored = expectedHideOnly
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
            (progressRemoved ||
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
})(globalThis);
