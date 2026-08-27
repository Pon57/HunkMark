"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    async yieldForLargeRefreshInteraction(controllerCount) {
      if (
        controllerCount <
        this.constants.LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD
      ) {
        return;
      }
      if (typeof this.window.scheduler?.yield === "function") {
        await this.window.scheduler.yield();
        return;
      }
      await new Promise((resolve) => this.window.setTimeout(resolve, 0));
    },

    abortRefreshForStaleDiff(
      cacheGeneration = null,
      { discardControllers = [] } = {},
    ) {
      if (cacheGeneration !== null) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
      }
      if (this.stopped) {
        return;
      }
      discardControllers.forEach((controller) => {
        if (this.reviewControllerIsCurrent(controller)) {
          this.destroyController(controller);
        }
      });
      if (this.unsettledDiffLoadReviewSuspensionPaths().size > 0) {
        return;
      }
      this.scheduleRefresh({ immediate: true });
    },

    async hydrateDiffLoadFile(
      fileElement,
      filePath,
      { isCurrent = () => true } = {},
    ) {
      if (
        this.stopped ||
        !isCurrent() ||
        !this.currentReviewScope ||
        !fileElement?.isConnected ||
        this.refreshRunning ||
        this.refreshQueued
      ) {
        return null;
      }
      const reviewScope = this.currentReviewScope;
      const hydrationSnapshot = this.hunkDiscoverySnapshot(fileElement, {
        isCurrent,
      });
      const hydrationIsCurrent = () =>
        this.currentReviewScope === reviewScope &&
        fileElement.isConnected &&
        !this.refreshRunning &&
        !this.refreshQueued &&
        this.hunkDiscoverySnapshotIsCurrent(hydrationSnapshot);
      const discovered = await this.discoverHunks(fileElement, {
        snapshot: hydrationSnapshot,
      });
      if (!discovered || !hydrationIsCurrent()) {
        return null;
      }

      const fileHunks = discovered.filter(
        (hunk) =>
          hunk.filePath === filePath &&
          hunk.hunkRow.isConnected &&
          fileElement.contains(hunk.hunkRow),
      );
      const previousControllers = Array.from(
        this.controllersByRow.values(),
      ).filter((controller) => controller.filePath === filePath);
      const seenRows = new Set(fileHunks.map((hunk) => hunk.hunkRow));
      previousControllers.forEach((controller) => {
        if (
          controller.fileElement !== fileElement ||
          !seenRows.has(controller.hunkRow)
        ) {
          this.destroyController(controller);
        }
      });
      fileHunks.forEach((hunk) => {
        const existing = this.controllersByRow.get(hunk.hunkRow);
        if (existing && !this.controllerMatchesHunk(existing, hunk)) {
          this.destroyController(existing);
          return;
        }
        if (existing) {
          existing.fileElement = hunk.fileElement;
          existing.filePath = hunk.filePath;
          this.updateControllerRows(existing, hunk.groupRows, {
            hostRevealedRowsCanExpand: false,
          });
          this.attachStickyHunkRow(existing);
        }
      });
      const newHunks = fileHunks.filter(
        (hunk) => !this.controllersByRow.has(hunk.hunkRow),
      );
      const loadingFilePaths =
        this.unsettledDiffLoadReviewSuspensionPaths();
      if (loadingFilePaths.has(filePath)) {
        this.suspendReviewControllersForDiffMutation(
          new Set([filePath]),
          { allowFileReveal: true },
        );
      }
      if (newHunks.length === 0) {
        return 0;
      }

      const lazyLineControls =
        discovered.reduce((total, hunk) => total + hunk.lines.length, 0) >=
        this.constants.LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD;
      const expansionAssessmentByController = new Map();
      const expansionAssessmentByHunk = new Map();
      const controllerOptionsByHunk = new Map();
      newHunks.forEach((hunk) => {
        const assessment = this.hostContextExpansionAssessment(
          hunk,
          this.previousControllersForHunk(previousControllers, hunk),
          [],
          new Set(),
        );
        expansionAssessmentByHunk.set(hunk, assessment);
        const initialCollapsed = Boolean(
          assessment.previous.length > 0 &&
          assessment.previous.every((controller) => controller.collapsed) &&
          !assessment.opensHunk,
        );
        const deferLineControls =
          lazyLineControls ||
          initialCollapsed ||
          this.reviewStorageKeys.has(`${hunk.key}:collapsed`);
        const options = {
          deferLineControls,
          initialCollapsed,
          lazyLineControls,
        };
        options.hostLayout = this.measureControllerHostLayout(hunk, options);
        controllerOptionsByHunk.set(hunk, options);
      });

      const newControllers = newHunks.map((hunk) => {
        const controller = this.createController(
          hunk,
          controllerOptionsByHunk.get(hunk),
        );
        expansionAssessmentByController.set(
          controller,
          expansionAssessmentByHunk.get(hunk),
        );
        if (controller.collapsed) {
          this.applyControllerAppearance(controller);
        }
        return controller;
      });
      if (loadingFilePaths.has(filePath)) {
        this.suspendReviewControllersForDiffMutation(
          new Set([filePath]),
          { allowFileReveal: true },
        );
      }
      const reconciled = await this.reconcileNewReviewControllers({
        deferStorageMigrations: true,
        expansionAssessmentByController,
        isCurrent: hydrationIsCurrent,
        newControllers,
      });
      if (!reconciled || !hydrationIsCurrent()) {
        newControllers.forEach((controller) =>
          this.destroyController(controller),
        );
        return null;
      }
      const currentControllers = newControllers.filter((controller) =>
        this.reviewControllerIsCurrent(controller),
      );
      if (currentControllers.length > 0) {
        this.scheduleProgressUpdate(currentControllers);
        this.finishReadyFileRevealPrepaintRestores();
      }
      return currentControllers.length;
    },

    diffLoadFileViewportPriority(fileElement) {
      const rect = fileElement.getBoundingClientRect();
      const viewportHeight = this.window.innerHeight;
      if (rect.bottom >= 0 && rect.top <= viewportHeight) {
        return {
          distance: Math.abs(
            (rect.top + rect.bottom) / 2 - viewportHeight / 2,
          ),
          tier: 0,
        };
      }
      if (
        rect.bottom >= -viewportHeight &&
        rect.top <= viewportHeight * 2
      ) {
        return {
          distance:
            rect.bottom < 0
              ? -rect.bottom
              : Math.max(0, rect.top - viewportHeight),
          tier: 1,
        };
      }
      return { distance: Number.POSITIVE_INFINITY, tier: 2 };
    },

    armDiffLoadFileHydration(filePath, state, delay) {
      if (state.timerId !== null) {
        this.window.clearTimeout(state.timerId);
      }
      state.ready = false;
      state.dueAt = Date.now() + delay;
      state.timerId = this.window.setTimeout(() => {
        state.timerId = null;
        if (
          this.diffLoadHydrations.get(filePath) !== state ||
          state.running
        ) {
          return;
        }
        state.ready = true;
        this.pumpDiffLoadFileHydrations();
      }, delay);
    },

    nextDiffLoadFileHydration({ allowOffscreen }) {
      let best = null;
      const runningFilePaths = new Set(
        Array.from(
          this.diffLoadHydrationRunningStates,
          (runningState) => runningState.filePath,
        ),
      );
      for (const [filePath, state] of this.diffLoadHydrations) {
        if (
          !state.ready ||
          state.running ||
          !state.fileElement.isConnected ||
          runningFilePaths.has(filePath)
        ) {
          continue;
        }
        if (!allowOffscreen && !state.nearViewport) {
          continue;
        }
        const candidate = { filePath, state };
        if (
          !best ||
          state.viewportPriority.tier <
            best.state.viewportPriority.tier ||
          (state.viewportPriority.tier ===
            best.state.viewportPriority.tier &&
            state.viewportPriority.distance <
              best.state.viewportPriority.distance)
        ) {
          best = candidate;
        }
      }
      return best;
    },

    pumpDiffLoadFileHydrations() {
      if (
        this.stopped ||
        this.refreshQueued ||
        this.refreshRunning
      ) {
        return;
      }
      while (
        this.diffLoadHydrationRunningStates.size <
        this.constants.DIFF_LOAD_FILE_HYDRATION_CONCURRENCY
      ) {
        const activeOffscreen = Array.from(
          this.diffLoadHydrationRunningStates,
        ).filter((state) => !state.nearViewport).length;
        const next = this.nextDiffLoadFileHydration({
          allowOffscreen:
            activeOffscreen <
            this.constants.DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_CONCURRENCY,
        });
        if (!next) {
          return;
        }
        next.state.ready = false;
        next.state.running = true;
        this.diffLoadHydrationRunningStates.add(next.state);
        void next.state.run();
      }
    },

    resumeRefreshAfterDiffLoadHydrations() {
      if (
        this.stopped ||
        !this.refreshAfterDiffLoadHydrations ||
        this.diffLoadHydrationRunningStates.size > 0
      ) {
        return false;
      }
      this.refreshAfterDiffLoadHydrations = false;
      this.scheduleRefresh({ immediate: true });
      return true;
    },

    updateDiffLoadHydrationViewportState(filePath, state, now) {
      if (!state.fileElement.isConnected) {
        return;
      }
      state.viewportPriority = this.diffLoadFileViewportPriority(
        state.fileElement,
      );
      state.nearViewport = state.viewportPriority.tier < 2;
      if (state.running || !state.nearViewport || state.ready) {
        return;
      }
      const delay = Math.max(0, state.quietUntil - now);
      if (state.dueAt > now + delay) {
        this.armDiffLoadFileHydration(filePath, state, delay);
      }
    },

    reprioritizeViewportHydrations() {
      const now = Date.now();
      this.diffLoadHydrations.forEach((state, filePath) =>
        this.updateDiffLoadHydrationViewportState(filePath, state, now),
      );
      this.pumpDiffLoadFileHydrations();
    },

    scheduleViewportHydrationPriority() {
      if (
        this.stopped ||
        this.diffLoadHydrations.size === 0
      ) {
        return;
      }
      if (this.diffLoadHydrationViewportTimer !== null) {
        this.window.clearTimeout(this.diffLoadHydrationViewportTimer);
      }
      this.diffLoadHydrationViewportTimer = this.window.setTimeout(() => {
        this.diffLoadHydrationViewportTimer = null;
        this.reprioritizeViewportHydrations();
      }, this.constants.DIFF_LOAD_HYDRATION_SCROLL_SETTLE_MS);
    },

    viewportDiffLoadFileElements() {
      if (typeof this.document.elementsFromPoint !== "function") {
        return null;
      }
      const width = Math.max(1, this.window.innerWidth);
      const height = Math.max(1, this.window.innerHeight);
      const fileElements = new Set();
      const xPositions = [width * 0.55, width * 0.8];
      for (let sample = 0; sample < 8; sample += 1) {
        const y = height * ((sample + 0.5) / 8);
        xPositions.forEach((x) => {
          this.document.elementsFromPoint(x, y).forEach((element) => {
            const fileElement = this.diffLoadFileElementForNode(element);
            if (fileElement?.isConnected) {
              fileElements.add(fileElement);
            }
          });
        });
      }
      return fileElements;
    },

    reprioritizeViewportReflowHydrations() {
      const fileElements = this.viewportDiffLoadFileElements();
      if (!fileElements) {
        return false;
      }
      const now = Date.now();
      fileElements.forEach((fileElement) => {
        const filePath = this.diffLoadFilePath(fileElement);
        const state = filePath && this.diffLoadHydrations.get(filePath);
        if (!state || state.fileElement !== fileElement) {
          return;
        }
        this.updateDiffLoadHydrationViewportState(filePath, state, now);
      });
      this.pumpDiffLoadFileHydrations();
      return true;
    },

    scheduleViewportHydrationReflowPriority() {
      if (
        this.stopped ||
        this.diffLoadHydrations.size === 0 ||
        this.diffLoadHydrationReflowTimer !== null
      ) {
        return;
      }
      this.diffLoadHydrationReflowTimer = this.window.setTimeout(() => {
        this.diffLoadHydrationReflowTimer = null;
        this.reprioritizeViewportReflowHydrations();
      }, this.constants.DIFF_LOAD_HYDRATION_SCROLL_SETTLE_MS);
    },

    renderedDiffLoadFileElements() {
      const currentSelector =
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR;
      const fileElements = new Set(
        Array.from(
          this.document.querySelectorAll(currentSelector),
        ).filter((fileElement) => fileElement.isConnected),
      );
      this.document
        .querySelectorAll(this.constants.FILE_CONTAINER_SELECTOR)
        .forEach((candidate) => {
          if (!candidate.isConnected) {
            return;
          }
          const currentRegion = candidate.matches(currentSelector)
            ? candidate
            : candidate.closest(currentSelector);
          if (currentRegion) {
            fileElements.add(currentRegion);
            return;
          }
          if (!candidate.querySelector(currentSelector)) {
            fileElements.add(candidate);
          }
        });
      return fileElements;
    },

    bootstrapRenderedDiffLoadHydrations() {
      this.diffLoadHydrationBatchBootstrapped = true;
      const fileElementsByPath = new Map();
      this.renderedDiffLoadFileElements().forEach((fileElement) => {
        const filePath = this.diffLoadFilePath(fileElement);
        if (filePath) {
          fileElementsByPath.set(filePath, fileElement);
        }
      });
      let scheduled = 0;
      const activeFilePaths = new Set();
      fileElementsByPath.forEach((fileElement, filePath) => {
        this.rememberDeferredDiffLoadRefresh(filePath, fileElement);
        if (this.fileDiffHasActiveLoadingContent(fileElement)) {
          activeFilePaths.add(filePath);
        }
        if (
          this.diffLoadHydrations.get(filePath)?.fileElement === fileElement
        ) {
          return;
        }
        scheduled += Number(
          this.scheduleDiffLoadFileHydration(filePath, fileElement),
        );
      });
      if (activeFilePaths.size > 0) {
        this.suspendReviewControllersForDiffMutation(activeFilePaths, {
          allowFileReveal: true,
        });
      }
      return scheduled;
    },

    diffLoadFileHydrationCanRetry(filePath, state) {
      return Boolean(
        !this.stopped &&
        this.currentReviewScope &&
        state.fileElement.isConnected &&
        this.deferredDiffLoadRefreshes.get(filePath)?.fileElement ===
          state.fileElement,
      );
    },

    scheduleDiffLoadFileHydration(filePath, fileElement) {
      if (
        this.stopped ||
        !filePath ||
        !fileElement?.isConnected
      ) {
        return false;
      }
      const previous = this.diffLoadHydrations.get(filePath);
      if (previous) {
        this.window.clearTimeout(previous.timerId);
      }
      const state = {
        dueAt: null,
        fileElement,
        filePath,
        viewportPriority: this.diffLoadFileViewportPriority(fileElement),
        quietUntil:
          Date.now() +
          this.constants.DIFF_LOAD_FILE_HYDRATION_SETTLE_MS,
        ready: false,
        run: null,
        running: false,
        timerId: null,
      };
      state.nearViewport = state.viewportPriority.tier < 2;
      state.run = async () => {
        if (this.diffLoadHydrations.get(filePath) !== state) {
          this.diffLoadHydrationRunningStates.delete(state);
          this.pumpDiffLoadFileHydrations();
          return;
        }
        state.timerId = null;
        let completed = false;
        let failed = false;
        try {
          if (
            state.fileElement.isConnected
          ) {
            completed =
              (await this.hydrateDiffLoadFile(
                state.fileElement,
                filePath,
                {
                  isCurrent: () =>
                    this.diffLoadHydrations.get(filePath) === state,
                },
              )) !== null;
          }
        } catch (error) {
          if (!this.stopForInvalidatedContext(error)) {
            console.warn(
              "HunkMark could not hydrate a settled diff file.",
              error,
            );
          }
          failed = true;
        } finally {
          state.running = false;
          this.diffLoadHydrationRunningStates.delete(state);
          if (this.diffLoadHydrations.get(filePath) === state) {
            if (
              !completed &&
              !failed &&
              this.diffLoadFileHydrationCanRetry(filePath, state)
            ) {
              this.armDiffLoadFileHydration(
                filePath,
                state,
                this.constants.DIFF_LOAD_FILE_HYDRATION_RETRY_MS,
              );
            } else {
              this.diffLoadHydrations.delete(filePath);
              if (completed) {
                this.settleDeferredDiffLoadFile(
                  filePath,
                  state.fileElement,
                );
              }
              if (this.deferredDiffLoadRefreshes.size > 0) {
                this.scheduleDeferredDiffLoadRefreshSettlement();
              }
            }
          }
          this.pumpDiffLoadFileHydrations();
          this.resumeRefreshAfterDiffLoadHydrations();
        }
      };
      this.diffLoadHydrations.set(filePath, state);
      this.armDiffLoadFileHydration(
        filePath,
        state,
        this.constants.DIFF_LOAD_FILE_HYDRATION_SETTLE_MS +
          (state.nearViewport
            ? 0
            : this.constants.DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_DELAY_MS),
      );
      return true;
    },

    async refresh() {
      const forceFullRefreshAfterDiffLoadTimeout =
        this.deferredDiffLoadRefreshTimedOut;
      this.deferredDiffLoadRefreshTimedOut = false;
      if (this.diffLoadHydrationRunningStates.size > 0) {
        this.refreshAfterDiffLoadHydrations = true;
        this.deferredDiffLoadRefreshTimedOut ||=
          forceFullRefreshAfterDiffLoadTimeout;
        return;
      }
      this.refreshAfterDiffLoadHydrations = false;
      const nextScope = this.Core.parseReviewScope(this.window.location);
      const nextReviewVariant = this.Core.parseReviewVariant(
        this.window.location,
      );
      const nextReviewScope = this.Core.reviewStateScope(
        nextScope,
        nextReviewVariant,
      );
      if (nextReviewScope !== this.currentReviewScope) {
        this.clearAllHostContextExpansionIntents();
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

      // Progressive diff mutations can arrive while the initial refresh is
      // still awaiting storage or preferences. Once a deferred batch exists,
      // let its bounded viewport-first queue hydrate ready files instead of
      // starting a document-wide discovery from an already partial DOM.
      if (
        !forceFullRefreshAfterDiffLoadTimeout &&
        !this.diffLoadHydrationBatchBootstrapped &&
        (this.deferredDiffLoadRefreshes.size > 0 ||
          this.activeDiffLoadFileElements().size > 0)
      ) {
        this.bootstrapRenderedDiffLoadHydrations();
      }
      if (
        !forceFullRefreshAfterDiffLoadTimeout &&
        this.deferredDiffLoadRefreshes.size > 0
      ) {
        this.ensureDeferredDiffLoadRefreshTimeout();
        this.settleDeferredDiffLoadRefreshes();
        return;
      }

      const refreshSnapshot = this.hunkDiscoverySnapshot(this.document);
      const previousControllers = Array.from(this.controllersByRow.values());
      const cacheGeneration =
        this.Core.beginIdentifierCacheGeneration();
      let discovered;
      try {
        discovered = await this.discoverHunks(this.document, {
          snapshot: refreshSnapshot,
        });
      } catch (error) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
        throw error;
      }
      if (!discovered) {
        this.abortRefreshForStaleDiff(cacheGeneration);
        return;
      }
      if (this.stopped) {
        this.Core.abortIdentifierCacheGeneration(cacheGeneration);
        return;
      }
      const refreshControllerCount = Math.max(
        previousControllers.length,
        discovered.length,
      );
      this.suspendReviewControllersForDiffMutation();
      await this.yieldForLargeRefreshInteraction(refreshControllerCount);
      if (!this.hunkDiscoverySnapshotIsCurrent(refreshSnapshot)) {
        this.abortRefreshForStaleDiff(cacheGeneration);
        return;
      }
      this.restoreDiffMutationSuspendedReviewControls({
        keepFilePaths: this.unsettledDiffLoadReviewSuspensionPaths(),
      });
      this.Core.commitIdentifierCacheGeneration(cacheGeneration);
      this.attachCachedHostContextExpansionBaselines(discovered);
      const hostContextExpansionIntents =
        this.currentHostContextExpansionIntents(
          previousControllers,
          discovered,
        );
      const hostContextExpansionIntentsByFilePath = new Map();
      hostContextExpansionIntents.forEach((intent) => {
        const fileIntents =
          hostContextExpansionIntentsByFilePath.get(intent.filePath) ?? [];
        fileIntents.push(intent);
        hostContextExpansionIntentsByFilePath.set(intent.filePath, fileIntents);
      });
      const previousByHunk = new Map(
        discovered.map((hunk) => [
          hunk,
          this.previousControllersForHunk(previousControllers, hunk),
        ]),
      );
      const observedHostContextExpansionIntents = new Set();
      discovered.forEach((hunk) => {
        const previous = previousByHunk.get(hunk) ?? [];
        const fileIntents =
          hostContextExpansionIntentsByFilePath.get(hunk.filePath) ?? [];
        fileIntents.forEach((intent) => {
          if (
            this.hostContextExpansionTransitionObserved(
              intent,
              previous,
              hunk,
            )
          ) {
            observedHostContextExpansionIntents.add(intent);
          }
        });
      });
      const newlyObservedHostContextExpansionFilePaths = new Set(
        Array.from(
          observedHostContextExpansionIntents,
          (intent) => intent.filePath,
        ),
      );
      const expansionAssessmentByHunk = new Map(
        discovered.map((hunk) => {
          const previous = previousByHunk.get(hunk) ?? [];
          const fileIntents =
            hostContextExpansionIntentsByFilePath.get(hunk.filePath) ?? [];
          return [
            hunk,
            this.hostContextExpansionAssessment(
              hunk,
              previous,
              fileIntents,
              observedHostContextExpansionIntents,
            ),
          ];
        }),
      );
      const collapsedLayoutAnchor =
        this.hostContextExpansionCollapsedLayoutAnchor(
          observedHostContextExpansionIntents,
          previousByHunk,
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
      const expansionAssessmentByController = new Map();
      const stickyControllersByFile = new Map();

      Array.from(this.controllersByRow.values()).forEach((controller) => {
        if (!controller.hunkRow.isConnected || !seenRows.has(controller.hunkRow)) {
          this.destroyController(controller);
        }
      });

      discovered.forEach((hunk) => {
        const existing = this.controllersByRow.get(hunk.hunkRow);
        if (
          existing &&
          (newlyObservedHostContextExpansionFilePaths.has(hunk.filePath) ||
            !this.controllerMatchesHunk(existing, hunk))
        ) {
          this.destroyController(existing);
        }
      });

      // Batch every host style read for new hunks before any controller starts
      // mutating the diff DOM. This avoids a read/write cycle per hunk on
      // large files with many small hunks.
      const newControllerOptionsByHunk = new Map();
      discovered.forEach((hunk) => {
        if (this.controllersByRow.has(hunk.hunkRow)) {
          return;
        }
        const lazyLineControls = lazyLineControlFiles.has(
          hunk.fileElement,
        );
        const assessment = expansionAssessmentByHunk.get(hunk);
        const initialCollapsed = Boolean(
          assessment.previous.length > 0 &&
            assessment.previous.every((controller) => controller.collapsed) &&
            !assessment.opensHunk,
        );
        if (initialCollapsed) {
          hunk.groupRows.forEach((row) => {
            if (row !== hunk.hunkRow) {
              row.classList.add("hunkmark-collapsed");
            }
          });
        }
        const deferLineControls =
          lazyLineControls ||
          initialCollapsed ||
          this.reviewStorageKeys.has(`${hunk.key}:collapsed`);
        newControllerOptionsByHunk.set(hunk, {
          deferLineControls,
          initialCollapsed,
          lazyLineControls,
        });
      });
      newControllerOptionsByHunk.forEach((options, hunk) => {
        options.hostLayout = this.measureControllerHostLayout(
          hunk,
          options,
        );
      });

      discovered.forEach((hunk) => {
        let controller = this.controllersByRow.get(hunk.hunkRow);
        if (controller) {
          controller.fileElement = hunk.fileElement;
          controller.filePath = hunk.filePath;
          const assessment = expansionAssessmentByHunk.get(hunk);
          this.updateControllerRows(controller, hunk.groupRows, {
            hostRevealedRowsCanExpand:
              assessment.hostRevealedRowsCanExpand,
          });
          this.attachStickyHunkRow(controller);
        } else {
          controller = this.createController(
            hunk,
            newControllerOptionsByHunk.get(hunk),
          );
          newControllers.push(controller);
          expansionAssessmentByController.set(
            controller,
            expansionAssessmentByHunk.get(hunk),
          );
          if (controller.collapsed) {
            this.applyControllerAppearance(controller);
          }
        }
        const stickyControllers =
          stickyControllersByFile.get(hunk.fileElement) ?? [];
        stickyControllers.push(controller);
        stickyControllersByFile.set(hunk.fileElement, stickyControllers);
      });

      const orderedControllers = discovered
        .map((hunk) => this.controllersByRow.get(hunk.hunkRow))
        .filter(Boolean);
      this.controllersByRow.clear();
      orderedControllers.forEach((controller) =>
        this.controllersByRow.set(controller.hunkRow, controller),
      );

      // Discovery already returns hunks in document order. Reuse that order
      // and refresh only visible file headers once instead of sorting and
      // measuring them again for every existing controller.
      stickyControllersByFile.forEach((controllers, fileElement) => {
        const state = this.hunkStickyStateByFile.get(fileElement);
        if (!state) {
          return;
        }
        this.syncStickyHunkControllerOrder(state, controllers);
        if (state.visible) {
          this.syncStickyHunkHeader(state);
        }
      });
      // GitHub has already completed the host mutation. Correct only the
      // additional synchronous displacement caused by HunkMark revealing
      // previously collapsed rows, before any asynchronous storage read.
      this.restoreHostContextExpansionCollapsedLayout(
        collapsedLayoutAnchor,
      );

      this.suspendReviewControllersForDiffMutation();
      await this.yieldForLargeRefreshInteraction(refreshControllerCount);
      if (!this.hunkDiscoverySnapshotIsCurrent(refreshSnapshot)) {
        this.abortRefreshForStaleDiff(null, {
          discardControllers: newControllers,
        });
        return;
      }

      const reconciliationCompleted =
        await this.reconcileNewReviewControllers({
          expansionAssessmentByController,
          isCurrent: () =>
            this.hunkDiscoverySnapshotIsCurrent(refreshSnapshot),
          newControllers,
        });
      if (!reconciliationCompleted) {
        if (!this.hunkDiscoverySnapshotIsCurrent(refreshSnapshot)) {
          this.abortRefreshForStaleDiff(null, {
            discardControllers: newControllers,
          });
        }
        return;
      }
      if (!this.hunkDiscoverySnapshotIsCurrent(refreshSnapshot)) {
        this.abortRefreshForStaleDiff(null, {
          discardControllers: newControllers,
        });
        return;
      }

      this.restoreDiffMutationSuspendedReviewControls({
        keepFilePaths: this.unsettledDiffLoadReviewSuspensionPaths(),
      });
      this.updateProgress();
      hostContextExpansionIntents.forEach((hostContextExpansionIntent) => {
        if (
          observedHostContextExpansionIntents.has(
            hostContextExpansionIntent,
          )
        ) {
          hostContextExpansionIntent.phase = "observed";
        }
        if (
          this.hostContextExpansionSettlementReady(
            hostContextExpansionIntent,
          )
        ) {
          this.scheduleHostContextExpansionSettlement(
            hostContextExpansionIntent,
          );
        } else {
          this.cancelHostContextExpansionSettlement(
            hostContextExpansionIntent,
          );
        }
      });
      this.finishReadyFileRevealPrepaintRestores();
      this.clearSettledOfficialViewedRestoreGuards();
    },
  });
}
