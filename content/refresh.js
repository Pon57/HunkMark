"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
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

      const reconciliationCompleted =
        await this.reconcileNewReviewControllers({
          expansionAssessmentByController,
          newControllers,
        });
      if (!reconciliationCompleted) {
        return;
      }

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
