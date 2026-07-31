(function attachHunkMarkOfficialViewed(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    officialViewedControlForFile(fileElement) {
      if (!fileElement) {
        return null;
      }
      // GitHub renders the control in the leading file-header subtree. Avoid
      // traversing a potentially large diff body on every review action.
      const header = fileElement.firstElementChild;
      const headerControl = header?.matches(
        this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
      )
        ? header
        : header?.querySelector(
            this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
          );
      return (
        headerControl ??
        fileElement.querySelector(
          this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
        )
      );
    },

    officialViewedSuppressionScope() {
      return this.Core.reviewStateScope(
        this.currentScope,
        this.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
    },

    async officialViewedSuppressionKey(
      filePath,
      scope = this.officialViewedSuppressionScope(),
    ) {
      return this.Core.officialSyncSuppressionKey(
        scope,
        filePath,
      );
    },

    suppressionKeysForControllers(controllers) {
      return [
        ...new Set(
          Array.from(controllers, (controller) =>
            controller.officialSuppressionKey,
          ).filter(Boolean),
        ),
      ];
    },

    beginOfficialViewedReviewPersistence(controllers) {
      const keys = this.suppressionKeysForControllers(controllers);
      keys.forEach((key) => {
        this.officialViewedReviewPendingByKey.set(
          key,
          (this.officialViewedReviewPendingByKey.get(key) ?? 0) + 1,
        );
      });
      return keys;
    },

    endOfficialViewedReviewPersistence(keys) {
      keys.forEach((key) => {
        const pending = this.officialViewedReviewPendingByKey.get(key) ?? 0;
        if (pending <= 1) {
          this.officialViewedReviewPendingByKey.delete(key);
        } else {
          this.officialViewedReviewPendingByKey.set(key, pending - 1);
        }
      });
    },

    createOfficialViewedIntentGeneration() {
      this.nextOfficialViewedIntentGeneration += 1;
      return this.nextOfficialViewedIntentGeneration;
    },

    registerOfficialViewedIntent(
      keys,
      generation,
      { storagePending = false } = {},
    ) {
      keys.filter(Boolean).forEach((key) => {
        this.officialViewedIntentGenerationByKey.set(key, generation);
        if (storagePending) {
          this.officialViewedStorageIntentGenerationByKey.set(
            key,
            generation,
          );
        }
      });
    },

    applyOfficialViewedIntent(keys, suppressed, generation) {
      keys.filter(Boolean).forEach((key) => {
        if (
          this.officialViewedIntentGenerationByKey.get(key) !== generation
        ) {
          return;
        }
        if (suppressed) {
          this.officialViewedSyncSuppressed.add(key);
        } else {
          this.officialViewedSyncSuppressed.delete(key);
        }
      });
    },

    clearOfficialViewedStorageIntent(keys, generation) {
      keys.filter(Boolean).forEach((key) => {
        if (
          this.officialViewedStorageIntentGenerationByKey.get(key) ===
          generation
        ) {
          this.officialViewedStorageIntentGenerationByKey.delete(key);
        }
      });
    },

    async discardOfficialViewedReleaseMarkers(keys) {
      return this.withReviewStorageLock(async () => {
        const stored = await this.getLocalStorage(keys);
        const markerKeys = keys.filter((key) => stored[key] === null);
        await this.removeReviewStorageUnlocked(markerKeys);
      });
    },

    scheduleOfficialViewedReleaseMarkerCleanup(keys) {
      if (keys.length === 0) {
        return;
      }
      this.window.setTimeout(() => {
        if (this.stopped) {
          return;
        }
        void this.discardOfficialViewedReleaseMarkers(keys).catch((error) => {
          if (!this.stopForInvalidatedContext(error)) {
            console.warn(
              "HunkMark could not discard an official Viewed release marker.",
              error,
            );
          }
        });
      }, 0);
    },

    async mutateReviewStorageAndReleaseOfficialViewed(
      controllers,
      mutation = {},
    ) {
      const keys = this.suppressionKeysForControllers(
        Array.from(controllers).filter((controller) =>
          this.officialViewedControlForFile(controller.fileElement),
        ),
      );
      const values = { ...mutation.values };
      const removals = new Set(mutation.removals ?? []);
      const usesReleaseMarkers =
        keys.length > 0 && Object.keys(values).length > 0;
      if (usesReleaseMarkers) {
        // Coalesce a falsey release marker into the review write so official
        // Viewed sync does not wait for a second storage round trip. Cleanup
        // removes only markers that a newer suppression intent has not replaced.
        keys.forEach((key) => {
          values[key] = null;
        });
      } else {
        keys.forEach((key) => removals.add(key));
      }
      Object.keys(values).forEach((key) => removals.delete(key));
      const runMutation = () =>
        this.mutateReviewStorageUnlocked({
          ...mutation,
          values,
          removals: Array.from(removals),
        });
      if (keys.length === 0) {
        return this.withReviewStorageLock(runMutation);
      }

      const previousSuppressedByKey = new Map(
        keys.map((key) => [
          key,
          this.officialViewedSyncSuppressed.has(key),
        ]),
      );
      const generation = this.createOfficialViewedIntentGeneration();
      this.registerOfficialViewedIntent(keys, generation, {
        storagePending: true,
      });
      this.applyOfficialViewedIntent(keys, false, generation);
      const restoreCurrentIntent = (stored = null) => {
        keys.forEach((key) => {
          if (
            this.officialViewedIntentGenerationByKey.get(key) !== generation
          ) {
            return;
          }
          const suppressed = stored !== null
            ? Boolean(stored[key])
            : previousSuppressedByKey.get(key) === true;
          if (suppressed) {
            this.officialViewedSyncSuppressed.add(key);
          } else {
            this.officialViewedSyncSuppressed.delete(key);
          }
        });
      };

      let mutationStarted = false;
      try {
        await this.withReviewStorageLock(async () => {
          mutationStarted = true;
          try {
            await runMutation();
            this.clearOfficialViewedStorageIntent(keys, generation);
          } catch (error) {
            let stored = null;
            try {
              stored = await this.getLocalStorage(keys);
            } catch {
              // Preserve the mutation error and restore the state captured
              // before the lock when storage can no longer be read.
            }
            restoreCurrentIntent(stored);
            this.clearOfficialViewedStorageIntent(keys, generation);
            throw error;
          }
        });
        if (usesReleaseMarkers) {
          this.scheduleOfficialViewedReleaseMarkerCleanup(keys);
        }
      } catch (error) {
        if (!mutationStarted) {
          restoreCurrentIntent();
          this.clearOfficialViewedStorageIntent(keys, generation);
        }
        throw error;
      }
    },

    async recordManualOfficialViewedIntent({
      filePath,
      knownKey = null,
      suppressionScope,
      suppressed,
      updatedAt = Date.now(),
    }) {
      const immediateKey = knownKey;
      let touchedKey = immediateKey;
      let persistedSuppressedOnFailure = null;
      let persistedStateKnownOnFailure = false;
      const generation = this.createOfficialViewedIntentGeneration();
      const registerIntent = (key) => {
        this.officialViewedReconcileGenerationByKey.set(key, generation);
        this.registerOfficialViewedIntent([key], generation, {
          storagePending: true,
        });
      };
      const applyLocalIntent = (key) => {
        this.applyOfficialViewedIntent([key], suppressed, generation);
      };
      const clearStorageIntent = (key) => {
        this.clearOfficialViewedStorageIntent([key], generation);
      };
      const rollBackFailedIntent = (key) => {
        if (
          !key ||
          this.officialViewedReconcileGenerationByKey.get(key) !== generation
        ) {
          return;
        }
        this.officialViewedReconcileGenerationByKey.delete(key);
        if (
          this.officialViewedIntentGenerationByKey.get(key) !== generation
        ) {
          return;
        }
        const locationSuppressionScope = this.Core.reviewStateScope(
          this.Core.parseReviewScope(this.window.location),
          this.Core.ALL_COMMITS_REVIEW_VARIANT,
        );
        if (locationSuppressionScope !== suppressionScope) {
          this.officialViewedSyncSuppressed.delete(key);
        } else if (persistedStateKnownOnFailure) {
          if (persistedSuppressedOnFailure) {
            this.officialViewedSyncSuppressed.add(key);
          } else {
            this.officialViewedSyncSuppressed.delete(key);
          }
        }
      };
      if (immediateKey) {
        // Keep the local guard synchronous with the captured click so a host
        // mutation cannot trigger automatic Viewed sync before the lock runs.
        registerIntent(immediateKey);
        applyLocalIntent(immediateKey);
      }

      // Request the shared lock before resolving a cold key. The lock queue
      // defines cross-tab click order; delayed DOM reconciliation never writes
      // suppression state and therefore cannot overwrite a newer intent.
      try {
        const result = await this.withReviewStorageLock(async () => {
          const key =
            immediateKey ??
            await this.officialViewedSuppressionKey(
              filePath,
              suppressionScope,
            );
          if (!touchedKey) {
            touchedKey = key;
            registerIntent(key);
            applyLocalIntent(key);
          }

          try {
            if (suppressed) {
              // The intent is committed by this write. Retention pruning is
              // maintenance and must not turn a successful intent into a
              // reported storage failure.
              await this.setReviewStorageUnlocked(
                { [key]: { suppressed: true, updatedAt } },
                suppressionScope,
                updatedAt,
                { prune: false },
              );
            } else {
              await this.removeReviewStorageUnlocked([key]);
            }
          } catch (error) {
            try {
              const stored = await this.getLocalStorage(key);
              persistedSuppressedOnFailure = Boolean(stored[key]);
              persistedStateKnownOnFailure = true;
            } catch {
              // Preserve the original mutation error. Without an authoritative
              // read, retaining the local intent is safer than restoring a
              // pre-lock snapshot that another tab may already have replaced.
            }
            rollBackFailedIntent(key);
            clearStorageIntent(key);
            throw error;
          }

          // Clear this marker before releasing the lock. The next lock holder
          // may publish a genuinely newer cross-tab change before the request
          // promise resumes in this tab.
          clearStorageIntent(key);
          return { generation, key };
        });
        return result;
      } catch (error) {
        // Also cover failures raised by the lock manager or key generation
        // before the storage mutation's guarded error path is reached.
        rollBackFailedIntent(touchedKey);
        clearStorageIntent(touchedKey);
        throw error;
      }
    },

    officialControlIsViewed(control) {
      return control.matches("button")
        ? control.getAttribute("aria-pressed") === "true"
        : control.checked;
    },

    fileDiffHasUnresolvedContent(fileElement) {
      if (
        fileElement.querySelector(this.constants.UNRESOLVED_DIFF_SELECTOR)
      ) {
        return true;
      }

      return Array.from(
        fileElement.querySelectorAll(
          "button:not(.hunkmark-line-control), " +
            "[role=button]:not(.hunkmark-line-control)",
        ),
      ).some((element) => {
        if (element.matches(this.constants.OFFICIAL_FILE_VIEWED_SELECTOR)) {
          return false;
        }
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          this.cleanElementText(element),
        ]
          .filter((value) => typeof value === "string")
          .join(" ")
          .trim()
          .toLowerCase();
        return /\b(?:load|show)\b.*\b(?:diff|more|lines?)\b/.test(label);
      });
    },

    controllersCoverRenderedHunks(fileElement, controllers) {
      const renderedHunkRows = new Set(
        this.findHunkMarkers(fileElement).map((marker) =>
          this.semanticRow(marker),
        ),
      );
      const controllerRows = new Set(
        controllers.map((controller) => controller.hunkRow),
      );
      return (
        renderedHunkRows.size === controllerRows.size &&
        Array.from(renderedHunkRows).every((row) => controllerRows.has(row))
      );
    },

    reconcileOfficialViewedAfterClick(
      key,
      fileElement,
      viewedBeforeClick,
      generation,
      suppressionScope,
      attempt = 0,
    ) {
      const locationSuppressionScope = this.Core.reviewStateScope(
        this.Core.parseReviewScope(this.window.location),
        this.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
      const generationIsCurrent =
        this.officialViewedReconcileGenerationByKey.get(key) === generation;
      if (!generationIsCurrent) {
        return;
      }
      if (this.stopped) {
        this.officialViewedReconcileGenerationByKey.delete(key);
        this.officialViewedRestoreGuards.delete(key);
        this.officialViewedSyncSuppressed.delete(key);
        return;
      }
      if (locationSuppressionScope !== suppressionScope) {
        this.settleOfficialViewedIntent(
          key,
          generation,
          suppressionScope,
        );
        return;
      }

      const controller = Array.from(this.controllersByRow.values()).find(
        (candidate) =>
          candidate.hunkRow.isConnected &&
          candidate.officialSuppressionKey === key,
      );
      const connectedFileElement =
        controller?.fileElement ??
        (fileElement?.isConnected ? fileElement : null);
      const control = this.officialViewedControlForFile(connectedFileElement);
      const loading =
        control?.getAttribute("data-loading") === "true" ||
        control?.getAttribute("aria-busy") === "true";
      const stateHasNotChanged =
        control && this.officialControlIsViewed(control) === viewedBeforeClick;

      if ((!control || loading || stateHasNotChanged) && attempt < 20) {
        this.window.setTimeout(
          () =>
            this.reconcileOfficialViewedAfterClick(
              key,
              fileElement,
              viewedBeforeClick,
              generation,
              suppressionScope,
              attempt + 1,
            ),
          100,
        );
        return;
      }

      this.settleOfficialViewedIntent(
        key,
        generation,
        suppressionScope,
      );
    },

    settleOfficialViewedIntent(
      key,
      generation,
      suppressionScope,
    ) {
      if (
        this.officialViewedReconcileGenerationByKey.get(key) !== generation
      ) {
        return;
      }
      this.officialViewedReconcileGenerationByKey.delete(key);

      const locationSuppressionScope = this.Core.reviewStateScope(
        this.Core.parseReviewScope(this.window.location),
        this.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
      if (
        locationSuppressionScope !== suppressionScope &&
        this.officialViewedIntentGenerationByKey.get(key) === generation
      ) {
        this.officialViewedSyncSuppressed.delete(key);
        this.officialViewedRestoreGuards.delete(key);
      }

      this.settleOfficialViewedRestoreGuard(key);
    },

    startOfficialViewedRestoreGuard(key, filePath) {
      // GitHub can replace diff rows when its Viewed state is removed. Keep the
      // existing collapsed hunk identities and stored line contexts so the
      // replacement state is restored before the debounced full refresh runs.
      const collapsedKeys = new Set(
        Array.from(this.controllersByRow.values())
          .filter(
            (controller) =>
              controller.hunkRow.isConnected &&
              controller.filePath === filePath &&
              controller.collapsed,
          )
          .map((controller) => controller.key),
      );

      const guard = {
        collapsedKeys,
        filePath,
        mutationObserved: false,
        officialStateSettled: false,
      };
      this.officialViewedRestoreGuards.set(key, guard);
      this.window.setTimeout(() => {
        if (this.officialViewedRestoreGuards.get(key) === guard) {
          this.officialViewedRestoreGuards.delete(key);
        }
      }, 3000);
    },

    preserveOfficialViewedRestoredState() {
      if (this.officialViewedRestoreGuards.size === 0) {
        return false;
      }

      let restored = false;
      const restoredFiles = new Set();
      const discovered = this.discoverCachedHunks();
      if (!discovered) {
        return false;
      }
      discovered.forEach((hunk) => {
        const key = hunk.officialSuppressionKey;
        const guard = this.officialViewedRestoreGuards.get(key);
        if (!guard || guard.filePath !== hunk.filePath) {
          return;
        }
        restored = true;
        guard.mutationObserved = true;
        if (!restoredFiles.has(hunk.fileElement)) {
          this.restoreFileProgress(hunk.fileElement, hunk.filePath);
          restoredFiles.add(hunk.fileElement);
        }
        let invalidatedLineReview = false;
        hunk.lines.forEach((line) => {
          if (!this.reviewStorageKeys.has(line.key)) {
            return;
          }
          if (
            this.lineReviewContextByKey.get(line.key) ===
            line.contextFingerprint
          ) {
            line.element.classList.add("hunkmark-line-viewed");
          } else {
            invalidatedLineReview = true;
          }
        });
        if (invalidatedLineReview) {
          return;
        }
        if (
          !guard.collapsedKeys.has(hunk.key) &&
          !this.reviewStorageKeys.has(`${hunk.key}:collapsed`)
        ) {
          return;
        }
        hunk.groupRows.forEach((row) => {
          if (row !== hunk.hunkRow) {
            row.classList.add("hunkmark-collapsed");
          }
        });
      });
      return restored;
    },

    restoreCachedOfficialViewedControllers() {
      if (!this.currentReviewScope) {
        return false;
      }

      const candidatesByFile = new Map();
      const discovered = this.discoverCachedHunks();
      if (!discovered) {
        return false;
      }
      discovered.forEach((hunk) => {
        if (this.controllersByRow.has(hunk.hunkRow)) {
          return;
        }

        const officialControl = this.officialViewedControlForFile(
          hunk.fileElement,
        );
        const progressKey = this.fileProgressStateKey(hunk.filePath);
        const explicitExpand =
          this.fileExpandRestorePending.has(progressKey);
        if (!explicitExpand && (
          !officialControl ||
          !this.officialControlIsViewed(officialControl) ||
          this.fileDiffHasUnresolvedContent(hunk.fileElement)
        )) {
          return;
        }

        const candidates = candidatesByFile.get(hunk.fileElement) ?? [];
        candidates.push({
          hunk,
          progressKey,
          lineStates: hunk.lines.map((line) => {
            const hasStoredLine = this.reviewStorageKeys.has(line.key);
            const storedContext = this.lineReviewContextByKey.get(line.key);
            return {
              invalidated:
                hasStoredLine &&
                storedContext !== line.contextFingerprint,
              marked:
                hasStoredLine &&
                storedContext === line.contextFingerprint,
            };
          }),
        });
        candidatesByFile.set(hunk.fileElement, candidates);
      });

      let restored = false;
      candidatesByFile.forEach((candidates) => {
        const progressKey = candidates[0].progressKey;
        const explicitExpand =
          this.fileExpandRestorePending.has(progressKey);
        const cachedProgress =
          this.fileProgressStateByKey.get(progressKey);
        const matchesCachedFile =
          explicitExpand &&
          cachedProgress?.hunks === candidates.length &&
          cachedProgress?.lines === candidates.reduce(
            (total, { hunk }) => total + hunk.lines.length,
            0,
          );
        const canRestoreEntireFile = candidates.every(
          ({ hunk, lineStates }) =>
            (matchesCachedFile ||
              this.reviewStorageKeys.has(hunk.key) ||
              this.reviewStorageKeys.has(`${hunk.key}:collapsed`) ||
              hunk.lines.some((line) =>
                this.reviewStorageKeys.has(line.key),
              )) &&
            lineStates.every((line) => !line.invalidated),
        );
        if (!canRestoreEntireFile) {
          return;
        }

        this.fileExpandRestorePending.delete(progressKey);
        candidates.forEach(({ hunk, lineStates }) => {
          const controller = this.createController(hunk);
          controller.lines.forEach((line, index) => {
            line.marked = lineStates[index].marked;
            line.control.disabled = false;
          });
          controller.marked =
            controller.lines.length === 0 &&
            this.reviewStorageKeys.has(controller.key);
          controller.collapsed = this.reviewStorageKeys.has(
            controller.collapsedKey,
          );
          this.updateAggregateFromLines(controller);
          controller.input.disabled = false;
          this.applyControllerAppearance(controller);
        });
        restored = true;
      });

      if (restored) {
        this.updateProgress();
      }
      return restored;
    },

    handleFileToggleClick(event) {
      const control =
        event.target instanceof this.window.Element
          ? event.target.closest("button")
          : null;
      if (!control) {
        return;
      }

      const labelledBy = (
        control.getAttribute("aria-labelledby") ?? ""
      )
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => this.document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const label = (
        control.getAttribute("aria-label") ??
        control.getAttribute("title") ??
        labelledBy
      ).trim();
      if (label !== "Collapse file" && label !== "Expand file") {
        return;
      }

      const fileElement =
        control.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
        control.closest("article, details, section, [role=region]");
      if (!fileElement) {
        return;
      }

      const filePath = this.resolveFilePath(fileElement, 0);
      const progressKey = this.fileProgressStateKey(filePath);
      if (label === "Collapse file") {
        this.fileExpandRestorePending.delete(progressKey);
        this.expectFileDiffVisibility(fileElement, false);
        this.removeFileProgress(fileElement);
        return;
      }
      if (label !== "Expand file") {
        return;
      }

      this.fileExpandRestorePending.add(progressKey);
      this.expectFileDiffVisibility(fileElement, true);
      this.window.setTimeout(
        () => this.fileExpandRestorePending.delete(progressKey),
        3000,
      );
    },

    settleOfficialViewedRestoreGuard(key) {
      const guard = this.officialViewedRestoreGuards.get(key);
      if (!guard) {
        return;
      }
      guard.officialStateSettled = true;
      this.scheduleRefresh();
    },

    clearSettledOfficialViewedRestoreGuards() {
      this.officialViewedRestoreGuards.forEach((guard, key) => {
        if (guard.mutationObserved && guard.officialStateSettled) {
          this.officialViewedRestoreGuards.delete(key);
        }
      });
    },

    async handleOfficialViewedClick(event) {
      const control =
        event.target instanceof this.window.Element
          ? event.target.closest(this.constants.OFFICIAL_FILE_VIEWED_SELECTOR)
          : null;
      if (!control) {
        return;
      }

      if (this.officialViewedProgrammaticClicks.has(control)) {
        this.officialViewedProgrammaticClicks.delete(control);
        return;
      }

      const controller = Array.from(this.controllersByRow.values()).find(
        (candidate) =>
          candidate.hunkRow.isConnected &&
          candidate.fileElement.contains(control),
      );
      const fileElement =
        controller?.fileElement ??
        control.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
        control.closest("article, details, section, [role=region]");
      if (!fileElement) {
        return;
      }

      this.officialViewedSyncPending.delete(fileElement);
      const filePath =
        controller?.filePath ?? this.resolveFilePath(fileElement, 0);
      const viewedBeforeClick = control.matches('input[type="checkbox"]')
        ? !control.checked
        : this.officialControlIsViewed(control);
      const visibilityExpectation = this.expectFileDiffVisibility(
        fileElement,
        viewedBeforeClick,
      );
      if (!viewedBeforeClick) {
        this.removeFileProgress(fileElement);
      }

      const suppressionScope = this.officialViewedSuppressionScope();
      const knownKey =
        controller?.officialSuppressionKey ??
        this.Core.cachedOfficialSyncSuppressionKey(
          suppressionScope,
          filePath,
        );
      if (viewedBeforeClick && knownKey) {
        this.startOfficialViewedRestoreGuard(knownKey, filePath);
      }
      let intent;
      try {
        intent = await this.recordManualOfficialViewedIntent({
          filePath,
          knownKey,
          suppressionScope,
          suppressed: viewedBeforeClick,
        });
      } catch (error) {
        this.cancelExpectedFileDiffVisibility(
          fileElement,
          visibilityExpectation,
        );
        if (
          knownKey &&
          !this.officialViewedReconcileGenerationByKey.has(knownKey)
        ) {
          this.officialViewedRestoreGuards.delete(knownKey);
        }
        throw error;
      }
      const { generation: reconcileGeneration, key } = intent;
      if (viewedBeforeClick) {
        if (key !== knownKey) {
          this.startOfficialViewedRestoreGuard(key, filePath);
        }
      } else {
        this.officialViewedRestoreGuards.delete(key);
      }
      this.window.setTimeout(
        () =>
          this.reconcileOfficialViewedAfterClick(
            key,
            fileElement,
            viewedBeforeClick,
            reconcileGeneration,
            suppressionScope,
          ),
        0,
      );
    },

    syncOfficialViewedForControllers(controllers) {
      const controllersByFileElement = new Map(
        Array.from(controllers, (controller) => [
          controller.fileElement,
          [],
        ]),
      );
      this.controllersByRow.forEach((controller) => {
        if (!controller.hunkRow.isConnected) {
          return;
        }
        controllersByFileElement
          .get(controller.fileElement)
          ?.push(controller);
      });
      controllersByFileElement.forEach((fileControllers, fileElement) => {
        this.syncOfficialFileViewed(fileElement, fileControllers);
      });
    },

    syncOfficialFileViewed(fileElement, controllers) {
      if (controllers.length === 0) {
        return;
      }

      const suppressionKey = controllers[0].officialSuppressionKey;
      const control = this.officialViewedControlForFile(fileElement);
      if (!control) {
        return;
      }

      const officialViewed = this.officialControlIsViewed(control);
      if (
        this.dragState ||
        this.officialViewedReviewPendingByKey.has(suppressionKey) ||
        this.fileDiffHasUnresolvedContent(fileElement) ||
        !this.controllersCoverRenderedHunks(fileElement, controllers) ||
        this.officialViewedSyncSuppressed.has(suppressionKey) ||
        !controllers.every((controller) => controller.marked) ||
        control.disabled ||
        this.officialViewedSyncPending.has(fileElement) ||
        control.getAttribute("aria-disabled") === "true" ||
        control.getAttribute("data-loading") === "true" ||
        officialViewed
      ) {
        return;
      }

      this.officialViewedSyncPending.add(fileElement);
      this.officialViewedProgrammaticClicks.add(control);
      this.expectFileDiffVisibility(fileElement, false);
      this.removeFileProgress(fileElement);
      try {
        control.click();
      } finally {
        this.officialViewedProgrammaticClicks.delete(control);
      }
      this.window.setTimeout(
        () => this.officialViewedSyncPending.delete(fileElement),
        2000,
      );
    },

    resetOfficialViewedState() {
      // Pending storage intents and manual-click reconciliations retain their
      // captured scope so a GitHub SPA route change cannot discard the user's
      // last intent.
      this.officialViewedRestoreGuards.clear();
      this.officialViewedSyncSuppressed.clear();
      this.officialViewedIntentGenerationByKey.clear();
    },

    applyOfficialSuppressionChanges(changes) {
      this.suppressionKeysForControllers(this.controllersByRow.values()).forEach(
        (key) => {
          if (!changes[key]) {
            return;
          }
          // A storage event from an older lock holder can arrive after a newer
          // local click has applied its guard but before that click acquires the
          // lock. Keep the optimistic local intent until its own transaction
          // commits or rolls back. Host reconciliation has a separate lifetime.
          if (
            this.officialViewedStorageIntentGenerationByKey.has(key)
          ) {
            return;
          }
          const generation = this.createOfficialViewedIntentGeneration();
          this.registerOfficialViewedIntent([key], generation);
          this.applyOfficialViewedIntent(
            [key],
            Boolean(changes[key].newValue),
            generation,
          );
        },
      );
    },
  });
})(globalThis);
