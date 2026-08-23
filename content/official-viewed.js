"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
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

    fileVisibilityControlLabel(control) {
      const labelledBy = (
        control.getAttribute("aria-labelledby") ?? ""
      )
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => this.document.getElementById(id)?.textContent ?? "")
        .join(" ");
      return (
        [
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
          labelledBy,
          control.textContent,
        ]
          .map((value) => value?.trim() ?? "")
          .find(Boolean) ?? ""
      );
    },

    fileDiffRevealControl(fileElement) {
      return (
        Array.from(
          fileElement.querySelectorAll(
            "button:not(.hunkmark-line-control), " +
              "[role=button]:not(.hunkmark-line-control)",
          ),
        ).find(
          (element) =>
            !element.matches(
              this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
            ) &&
            /\b(?:load|show)\b.*\bdiff\b/i.test(
              this.fileVisibilityControlLabel(element),
            ),
        ) ?? null
      );
    },

    fileElementHasHostMatch(fileElement, selector) {
      if (
        fileElement.matches(selector) &&
        !this.extensionOwnsNode(fileElement)
      ) {
        return true;
      }
      for (const element of fileElement.querySelectorAll(selector)) {
        if (!this.extensionOwnsNode(element)) {
          return true;
        }
      }
      return false;
    },

    fileDiffHasActiveLoadingContent(fileElement) {
      return this.fileElementHasHostMatch(
        fileElement,
        this.constants.ACTIVE_DIFF_LOADING_SELECTOR,
      );
    },

    fileDiffHasUnresolvedContent(fileElement) {
      if (this.fileElementHasHostMatch(
        fileElement,
        this.constants.UNRESOLVED_DIFF_SELECTOR,
      )) {
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

    fileRevealHasReadyNonHunkContent(fileElement, restore) {
      const hostHiddenSelector =
        '[data-hunkmark-ui], [hidden], [aria-hidden="true"], .d-none, ' +
        "details:not([open])";
      const mediaSelector = "img, svg, canvas, video, audio";
      return Array.from(fileElement.children).some((child) => {
        if (
          child === restore.headerElement ||
          restore.controlPathElements.includes(child) ||
          child.matches(hostHiddenSelector) ||
          child.closest("details:not([open])") ||
          child.style.display === "none" ||
          child.style.visibility === "hidden"
        ) {
          return false;
        }

        const visibleContent = child.cloneNode(true);
        visibleContent
          .querySelectorAll(hostHiddenSelector)
          .forEach((element) => element.remove());
        visibleContent.querySelectorAll("[style]").forEach((element) => {
          if (
            element.style.display === "none" ||
            element.style.visibility === "hidden"
          ) {
            element.remove();
          }
        });
        return (
          this.cleanElementText(visibleContent).trim().length > 0 ||
          visibleContent.matches(mediaSelector) ||
          visibleContent.querySelector(mediaSelector) !== null
        );
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

    startOfficialViewedRestoreGuard(key, filePath, fileElement = null) {
      // GitHub can replace diff rows when its Viewed state is removed. Keep the
      // existing collapsed hunk identities and stored line contexts so the
      // replacement state is restored before the debounced full refresh runs.
      const collapsedKeys = new Set(
        Array.from(this.controllersByRow.values())
          .filter(
            (controller) =>
              controller.hunkRow.isConnected &&
              (fileElement
                ? controller.fileElement === fileElement
                : controller.filePath === filePath) &&
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

    clearFileRevealPrepaintClasses(fileElement, restore) {
      restore.loadingPresentationElement?.remove();
      restore.loadingPresentationElement = null;
      fileElement.classList.remove("hunkmark-file-reveal-restoring");
      restore.headerElement?.classList.remove(
        "hunkmark-file-reveal-restore-header",
      );
      restore.controlPathElements.forEach((element) =>
        element.classList.remove(
          "hunkmark-file-reveal-restore-control-path",
        ),
      );
      restore.controlContainer = null;
      restore.controlPathElements = [];
    },

    observeFileRevealLoadingState(fileElement, restore) {
      restore.loadingStateAttributeObserver?.disconnect();
      restore.loadingStateAttributeObserver = null;
      if (!restore.waitForResolvedContent) {
        return;
      }

      // GitHub's current React diff root uses aria-label="Loading <path>"
      // without a spinner while its content is unresolved. The main observer
      // intentionally watches child-list changes only, so observe this root
      // attribute for the lifetime of the Load Diff restore.
      const observer = new this.window.MutationObserver(() => {
        if (this.fileRevealPrepaintRestores.get(fileElement) !== restore) {
          return;
        }
        this.finishReadyFileRevealPrepaintRestores();
      });
      observer.observe(fileElement, {
        attributeFilter: ["aria-label"],
        attributes: true,
      });
      restore.loadingStateAttributeObserver = observer;
    },

    maintainFileRevealPrepaintRestores() {
      // GitHub replaces the complete file region when Load Diff resolves.
      // Move the pre-paint guard to that replacement before the browser paints.
      for (const [fileElement, restore] of Array.from(
        this.fileRevealPrepaintRestores,
      )) {
        if (fileElement.isConnected) {
          continue;
        }
        const replacement = fileElement.id
          ? this.document.getElementById(fileElement.id)
          : Array.from(
              this.document.querySelectorAll(
                this.constants.FILE_CONTAINER_SELECTOR,
              ),
            ).find(
              (candidate, index) =>
                candidate !== fileElement &&
                this.resolveFilePath(candidate, index) === restore.filePath,
            );
        if (!replacement || replacement === fileElement) {
          continue;
        }

        const loadingPresentation =
          restore.controlContainer?.querySelector(
            this.constants.FILE_REVEAL_LOADING_INDICATOR_SELECTOR,
          )
            ? restore.controlContainer.cloneNode(true)
            : null;

        this.fileRevealPrepaintRestores.delete(fileElement);
        restore.loadingStateAttributeObserver?.disconnect();
        restore.loadingStateAttributeObserver = null;
        this.clearFileRevealPrepaintClasses(fileElement, restore);
        if (restore.timeoutId !== null) {
          this.window.clearTimeout(restore.timeoutId);
        }

        restore.headerElement = replacement.firstElementChild;
        restore.loadingPresentationElement = loadingPresentation;
        if (loadingPresentation) {
          [
            loadingPresentation,
            ...loadingPresentation.querySelectorAll(
              "[id], [data-diff-anchor]",
            ),
          ].forEach((element) => {
            element.removeAttribute("id");
            element.removeAttribute("data-diff-anchor");
          });
          loadingPresentation.setAttribute(
            "data-hunkmark-ui",
            "file-reveal-loading",
          );
          loadingPresentation.setAttribute("aria-hidden", "true");
          restore.controlContainer = loadingPresentation;
          restore.controlPathElements = [
            loadingPresentation,
            ...loadingPresentation.querySelectorAll("*"),
          ];
          replacement.insertBefore(
            loadingPresentation,
            replacement.children[1] ?? null,
          );
        }

        this.fileRevealPrepaintRestores.set(replacement, restore);
        replacement.classList.add("hunkmark-file-reveal-restoring");
        restore.headerElement?.classList.add(
          "hunkmark-file-reveal-restore-header",
        );
        restore.controlPathElements.forEach((element) =>
          element.classList.add(
            "hunkmark-file-reveal-restore-control-path",
          ),
        );
        this.observeFileRevealLoadingState(replacement, restore);
        restore.timeoutId = this.window.setTimeout(
          () => this.finishFileRevealPrepaintRestore(replacement, restore),
          Math.max(0, restore.expiresAt - Date.now()),
        );
      }
    },

    beginFileRevealPrepaintRestore(
      fileElement,
      filePath,
      control,
      {
        cachedReveal = false,
        timeoutMs = 3000,
        waitForResolvedContent = false,
      } = {},
    ) {
      // Hide a host-revealed diff until cached or authoritative review state
      // has been applied, so raw rows cannot paint between those operations.
      const previous = this.fileRevealPrepaintRestores.get(fileElement);
      if (previous) {
        this.finishFileRevealPrepaintRestore(fileElement, previous);
      }

      const controlContainer = Array.from(fileElement.children).find(
        (child) => child === control || child.contains(control),
      );
      if (!controlContainer) {
        return null;
      }
      const headerElement = fileElement.firstElementChild;
      // Preserve the small host placeholder exactly as it existed at click
      // time. Newly inserted diff nodes remain hidden, while GitHub may swap
      // its button contents for a loading indicator.
      const controlPathElements =
        controlContainer === headerElement
          ? []
          : [
              controlContainer,
              ...controlContainer.querySelectorAll("*"),
            ];
      const restore = {
        cachedProgress: cachedReveal
          ? this.fileProgressStateByKey.get(
              this.fileProgressStateKey(filePath),
            ) ?? null
          : null,
        cachedReviewSnapshot: cachedReveal
          ? this.fileReviewSnapshotsByKey.get(
              this.fileProgressStateKey(filePath),
            ) ?? null
          : null,
        controlPathElements,
        controlContainer,
        expiresAt: Date.now() + timeoutMs,
        filePath,
        headerElement,
        loadingPresentationElement: null,
        loadingStateAttributeObserver: null,
        readinessFrameId: null,
        timeoutId: null,
        waitForResolvedContent,
      };
      this.fileRevealPrepaintRestores.set(fileElement, restore);
      fileElement.classList.add("hunkmark-file-reveal-restoring");
      headerElement?.classList.add("hunkmark-file-reveal-restore-header");
      controlPathElements.forEach((element) =>
        element.classList.add(
          "hunkmark-file-reveal-restore-control-path",
        ),
      );
      this.observeFileRevealLoadingState(fileElement, restore);
      restore.timeoutId = this.window.setTimeout(
        () => this.finishFileRevealPrepaintRestore(fileElement, restore),
        timeoutMs,
      );
      // GitHub's header controls can reveal an already-mounted Load Diff
      // region by changing attributes only. The main observer watches
      // child-list changes, so check once after the host click has completed
      // and before the browser paints instead of broadening that observer.
      if (controlContainer === headerElement) {
        restore.readinessFrameId = this.window.requestAnimationFrame(() => {
          restore.readinessFrameId = null;
          this.finishReadyFileRevealPrepaintRestores();
        });
      }
      return restore;
    },

    finishCleanCachedFileReveal(searchRoot = this.document) {
      const candidates = Array.from(
        this.fileRevealPrepaintRestores.entries(),
      ).filter(
        ([fileElement]) =>
          fileElement.isConnected &&
          (searchRoot === this.document || searchRoot === fileElement),
      );
      if (candidates.length !== 1) {
        return false;
      }
      const [fileElement, restore] = candidates[0];
      const progress = restore.cachedProgress;
      const reviewSnapshot = restore.cachedReviewSnapshot;
      if (
        !progress ||
        !reviewSnapshot ||
        progress.lines <
          this.constants.LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD ||
        progress.viewed !== 0 ||
        progress.viewedLines !== 0 ||
        (progress.collapsed ?? 0) !== 0
      ) {
        return false;
      }
      for (const hunk of reviewSnapshot.hunks) {
        for (const key of [
          hunk.key,
          `${hunk.key}:collapsed`,
          ...hunk.lines.map((line) => line.key),
        ]) {
          if (this.reviewStorageKeys.has(key)) {
            return false;
          }
        }
      }
      let renderedHunkReady = false;
      for (const marker of fileElement.querySelectorAll(
        this.constants.HUNK_ELEMENT_SELECTOR,
      )) {
        if (this.Core.isHunkHeaderText(this.cleanElementText(marker))) {
          renderedHunkReady = true;
          break;
        }
      }
      if (!renderedHunkReady) {
        return false;
      }

      // With no visual review state to restore, keeping a large host diff
      // hidden until full identity discovery only delays first paint.
      this.finishFileRevealPrepaintRestore(fileElement, restore);
      return true;
    },

    finishFileRevealPrepaintRestore(fileElement, restore) {
      if (this.fileRevealPrepaintRestores.get(fileElement) !== restore) {
        return;
      }
      this.fileRevealPrepaintRestores.delete(fileElement);
      this.fileRevealRestorePending.delete(
        this.fileProgressStateKey(restore.filePath),
      );
      if (restore.timeoutId !== null) {
        this.window.clearTimeout(restore.timeoutId);
        restore.timeoutId = null;
      }
      if (restore.readinessFrameId !== null) {
        this.window.cancelAnimationFrame(restore.readinessFrameId);
        restore.readinessFrameId = null;
      }
      restore.loadingStateAttributeObserver?.disconnect();
      restore.loadingStateAttributeObserver = null;
      this.clearFileRevealPrepaintClasses(fileElement, restore);
    },

    finishReadyFileRevealPrepaintRestores() {
      this.fileRevealPrepaintRestores.forEach((restore, fileElement) => {
        if (!fileElement.isConnected) {
          return;
        }

        const renderedHunkRows = new Set(
          this.findHunkMarkers(fileElement).map((marker) =>
            this.semanticRow(marker),
          ),
        );
        // Match controllers by the rendered rows in the current replacement.
        // GitHub may resolve the same file through a different nested container,
        // which can legitimately change its fallback file path.
        const renderedControllers = Array.from(
          renderedHunkRows,
          (row) => this.controllersByRow.get(row),
        ).filter(
          (controller) =>
            controller?.hunkRow.isConnected &&
            fileElement.contains(controller.hunkRow),
        );
        // Cached counts detect a partial render even after GitHub has mounted
        // some hunk rows. Active host loading indicators are handled below.
        const cachedFileIncomplete = Boolean(
          restore.cachedProgress &&
          (restore.cachedProgress.hunks > renderedControllers.length ||
            restore.cachedProgress.lines >
              renderedControllers.reduce(
                (total, controller) => total + controller.lines.length,
                0,
              )),
        );
        const activeLoadingContent =
          restore.waitForResolvedContent &&
          this.fileDiffHasActiveLoadingContent(fileElement);
        // Expanding a large file may reveal only GitHub's stable Load Diff
        // placeholder. It has no hunks to restore and is safe to show now;
        // the subsequent Load Diff click starts its own guarded restore.
        const unresolvedDiff =
          (renderedHunkRows.size === 0 ||
            (restore.waitForResolvedContent &&
              (cachedFileIncomplete || activeLoadingContent))) &&
          this.fileDiffHasUnresolvedContent(fileElement);
        const unresolvedPlaceholderReady =
          !restore.waitForResolvedContent &&
          renderedHunkRows.size === 0 &&
          this.fileDiffRevealControl(fileElement) !== null;
        // Binary, image, empty-file, and metadata-only diffs can resolve to
        // stable host content without ever rendering a hunk or Load Diff
        // control. Release those once the host content itself is present.
        const nonHunkContentReady =
          renderedHunkRows.size === 0 &&
          !unresolvedDiff &&
          this.fileRevealHasReadyNonHunkContent(fileElement, restore);
        const controllersReady =
          renderedControllers.length > 0 &&
          renderedControllers.length === renderedHunkRows.size;
        if (
          (!unresolvedPlaceholderReady &&
            !nonHunkContentReady &&
            !controllersReady) ||
          (restore.waitForResolvedContent &&
            (cachedFileIncomplete || activeLoadingContent) &&
            unresolvedDiff) ||
          renderedControllers.some(
            (controller) => {
              // Diff-load suspension is a deliberate fail-closed state,
              // not an unfinished storage restore. The loaded content may
              // paint while its review controls stay inert until refresh.
              return (
                !this.reviewControllerSuspensionAllowsFileReveal(
                  controller,
                ) &&
                (controller.input.disabled ||
                  controller.lines.some(
                    (line) => line.control?.disabled === true,
                  ))
              );
            },
          )
        ) {
          return;
        }
        this.finishFileRevealPrepaintRestore(fileElement, restore);
      });
    },

    finishAllFileRevealPrepaintRestores() {
      this.fileRevealPrepaintRestores.forEach((restore, fileElement) =>
        this.finishFileRevealPrepaintRestore(fileElement, restore),
      );
    },

    fileRevealRestoreRootForMutations(mutations) {
      const roots = Array.from(this.fileRevealPrepaintRestores.keys()).filter(
        (fileElement) =>
          fileElement.isConnected &&
          mutations.some(
            (mutation) =>
              mutation.target === fileElement ||
              fileElement.contains(mutation.target),
          ),
      );
      if (roots.length !== 1) {
        return this.document;
      }
      const [root] = roots;
      return mutations.every(
        (mutation) =>
          mutation.target === root || root.contains(mutation.target),
      )
        ? root
        : this.document;
    },

    preserveOfficialViewedRestoredState(searchRoot = this.document) {
      if (this.officialViewedRestoreGuards.size === 0) {
        return false;
      }

      let restored = false;
      const restoredFiles = new Set();
      const discovered = this.discoverCachedHunks(searchRoot);
      if (!discovered) {
        return false;
      }
      this.attachCachedHostContextExpansionBaselines(discovered);
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
        const sharedCompletion = hunk.sharedCompletionKey
          ? this.sharedHunkCompletionByKey.get(hunk.sharedCompletionKey)
          : null;
        hunk.lines.forEach((line) => {
          const lineKey = this.cachedLineReviewKey(line);
          if (
            sharedCompletion?.viewed !== true &&
            !this.reviewStorageKeys.has(lineKey)
          ) {
            return;
          }
          const state = this.cachedLineReviewState(
            line,
            sharedCompletion,
            lineKey,
          );
          if (state.invalidated) {
            invalidatedLineReview = true;
          } else if (sharedCompletion?.viewed === true || state.marked) {
            line.element.classList.add("hunkmark-line-viewed");
          }
        });
        if (invalidatedLineReview) {
          return;
        }
        const collapsedKey = `${hunk.key}:collapsed`;
        const persistedCollapsed = this.cachedCollapseSurvivesSharedClear(
          collapsedKey,
          sharedCompletion,
        );
        const sharedCollapsed = Boolean(
          sharedCompletion?.viewed === true && sharedCompletion.collapsed,
        );
        const guardedCollapsed = Boolean(
          this.sharedHunkCompletionClearTimestamp(sharedCompletion) === 0 &&
            guard.collapsedKeys.has(hunk.key),
        );
        if (!sharedCollapsed && !persistedCollapsed && !guardedCollapsed) {
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

    cachedFileControllerRestoreNeeded(searchRoot = this.document) {
      // A cold Load Diff has no complete file snapshot to restore and would be
      // parsed again by the authoritative refresh. Keep it hidden and avoid
      // doing the same large discovery twice.
      const cachedRevealPending = Array.from(
        this.fileRevealPrepaintRestores.entries(),
      ).some(
        ([fileElement, restore]) =>
          restore.cachedProgress &&
          (searchRoot === this.document ||
            searchRoot === fileElement ||
            searchRoot.contains(fileElement)),
      );
      if (cachedRevealPending) {
        return true;
      }

      const controls = Array.from(
        searchRoot.querySelectorAll(
          this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
        ),
      );
      if (
        searchRoot instanceof this.window.Element &&
        searchRoot.matches(this.constants.OFFICIAL_FILE_VIEWED_SELECTOR)
      ) {
        controls.unshift(searchRoot);
      }
      return controls.some((control) =>
        this.officialControlIsViewed(control),
      );
    },

    restoreCachedFileControllers(searchRoot = this.document) {
      if (
        !this.currentReviewScope ||
        !this.cachedFileControllerRestoreNeeded(searchRoot)
      ) {
        return false;
      }

      const candidatesByFile = new Map();
      const discovered = this.discoverCachedHunks(searchRoot);
      if (!discovered) {
        return false;
      }
      this.attachCachedHostContextExpansionBaselines(discovered);
      discovered.forEach((hunk) => {
        if (this.controllersByRow.has(hunk.hunkRow)) {
          return;
        }

        const officialControl = this.officialViewedControlForFile(
          hunk.fileElement,
        );
        const progressKey = this.fileProgressStateKey(hunk.filePath);
        const explicitReveal =
          this.fileRevealRestorePending.has(progressKey);
        if (!explicitReveal && (
          !officialControl ||
          !this.officialControlIsViewed(officialControl) ||
          this.fileDiffHasUnresolvedContent(hunk.fileElement)
        )) {
          return;
        }

        const candidates = candidatesByFile.get(hunk.fileElement) ?? [];
        const sharedCompletion = hunk.sharedCompletionKey
          ? this.sharedHunkCompletionByKey.get(hunk.sharedCompletionKey)
          : null;
        candidates.push({
          hunk,
          progressKey,
          lineStates: hunk.lines.map((line) => {
            const lineKey = this.cachedLineReviewKey(line);
            const state = this.cachedLineReviewState(
              line,
              sharedCompletion,
              lineKey,
            );
            return {
              invalidated: state.invalidated,
              marked: sharedCompletion?.viewed === true || state.marked,
            };
          }),
          sharedCompletion,
        });
        candidatesByFile.set(hunk.fileElement, candidates);
      });

      const restorationPlans = [];
      candidatesByFile.forEach((candidates) => {
        const progressKey = candidates[0].progressKey;
        const explicitReveal =
          this.fileRevealRestorePending.has(progressKey);
        const cachedProgress =
          this.fileProgressStateByKey.get(progressKey);
        const matchesCachedFile =
          explicitReveal &&
          cachedProgress?.hunks === candidates.length &&
          cachedProgress?.lines === candidates.reduce(
            (total, { hunk }) => total + hunk.lines.length,
            0,
          );
        const canRestoreEntireFile = candidates.every(
          ({ hunk, lineStates, sharedCompletion }) =>
            (matchesCachedFile ||
              sharedCompletion?.viewed === true ||
              this.reviewStorageKeys.has(hunk.key) ||
              this.reviewStorageKeys.has(`${hunk.key}:collapsed`) ||
              hunk.lines.some((line) =>
                this.reviewStorageKeys.has(this.cachedLineReviewKey(line)),
              )) &&
            lineStates.every((line) => !line.invalidated),
        );
        if (!canRestoreEntireFile) {
          return;
        }

        this.fileRevealRestorePending.delete(progressKey);
        const lazyLineControls =
          candidates.reduce(
            (total, { hunk }) => total + hunk.lines.length,
            0,
          ) >= this.constants.LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD;
        candidates.forEach(({ hunk, lineStates, sharedCompletion }) => {
          const collapsedKey = `${hunk.key}:collapsed`;
          const collapsed = sharedCompletion?.viewed === true
            ? Boolean(sharedCompletion.collapsed)
            : this.cachedCollapseSurvivesSharedClear(
                collapsedKey,
                sharedCompletion,
              );
          restorationPlans.push({
            collapsed,
            deferLineControls: collapsed || lazyLineControls,
            hunk,
            lazyLineControls,
            lineStates,
            sharedCompletion: sharedCompletion?.viewed === true,
          });
        });
      });

      const hostLayouts = restorationPlans.map((plan) =>
        this.measureControllerHostLayout(plan.hunk, plan),
      );
      restorationPlans.forEach((plan, planIndex) => {
        const controller = this.createController(plan.hunk, {
          deferLineControls: plan.deferLineControls,
          hostLayout: hostLayouts[planIndex],
          lazyLineControls: plan.lazyLineControls,
        });
        controller.lines.forEach((line, lineIndex) => {
          line.marked = plan.lineStates[lineIndex].marked;
          if (line.control) {
            line.control.disabled = false;
          }
        });
        controller.marked =
          controller.lines.length === 0 &&
          this.reviewStorageKeys.has(controller.key);
        controller.sharedCompletion = plan.sharedCompletion;
        controller.collapsed = plan.collapsed;
        this.updateAggregateFromLines(controller);
        controller.input.disabled = false;
        this.applyControllerAppearance(controller);
      });

      const restored = restorationPlans.length > 0;
      if (restored) {
        this.updateProgress();
      }
      return restored;
    },

    handleFileVisibilityClick(event) {
      const control =
        event.target instanceof this.window.Element
          ? event.target.closest("button, [role=button]")
          : null;
      if (!control) {
        return;
      }

      const label = this.fileVisibilityControlLabel(control);
      const loadsDiff = /\b(?:load|show)\b.*\bdiff\b/i.test(label);
      if (
        label !== "Collapse file" &&
        label !== "Expand file" &&
        !loadsDiff
      ) {
        return;
      }

      const fileElement =
        control.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
        control.closest("article, details, section, [role=region]");
      if (!fileElement) {
        return;
      }
      if (loadsDiff && this.findHunkMarkers(fileElement).length > 0) {
        return;
      }

      const filePath = this.resolveFilePath(fileElement, 0);
      const progressKey = this.fileProgressStateKey(filePath);
      if (label === "Collapse file") {
        const pendingRestore =
          this.fileRevealPrepaintRestores.get(fileElement);
        if (pendingRestore) {
          this.finishFileRevealPrepaintRestore(
            fileElement,
            pendingRestore,
          );
        }
        this.fileRevealRestorePending.delete(progressKey);
        this.expectFileDiffVisibility(fileElement, false);
        this.removeFileProgress(fileElement);
        return;
      }
      if (label !== "Expand file" && !loadsDiff) {
        return;
      }

      const timeoutMs = loadsDiff
        ? this.constants.FILE_DIFF_VISIBILITY_EXPECTATION_TIMEOUT_MS
        : 3000;
      const prepaintRestore = this.beginFileRevealPrepaintRestore(
        fileElement,
        filePath,
        control,
        {
          cachedReveal: true,
          timeoutMs,
          waitForResolvedContent: loadsDiff,
        },
      );
      this.fileRevealRestorePending.add(progressKey);
      this.expectFileDiffVisibility(fileElement, true);
      if (!prepaintRestore) {
        this.window.setTimeout(
          () => this.fileRevealRestorePending.delete(progressKey),
          timeoutMs,
        );
      }
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

      const fileElement =
        control.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
        control.closest("article, details, section, [role=region]");
      if (!fileElement) {
        return;
      }
      const controller = Array.from(this.controllersByRow.values()).find(
        (candidate) =>
          candidate.hunkRow.isConnected &&
          candidate.fileElement === fileElement,
      );

      this.officialViewedSyncPending.delete(fileElement);
      const filePath =
        controller?.filePath ?? this.resolveFilePath(fileElement, 0);
      const viewedBeforeClick = control.matches('input[type="checkbox"]')
        ? !control.checked
        : this.officialControlIsViewed(control);
      const cachedReveal = this.fileProgressStateByKey.has(
        this.fileProgressStateKey(filePath),
      );
      const willRevealDiff =
        viewedBeforeClick &&
        !controller &&
        (cachedReveal ||
          !fileElement.querySelector(
            this.constants.HUNK_ELEMENT_SELECTOR,
          ));
      const prepaintRestore = willRevealDiff
        ? this.beginFileRevealPrepaintRestore(
            fileElement,
            filePath,
            control,
            { cachedReveal },
          )
        : null;
      if (!prepaintRestore) {
        const pendingRestore =
          this.fileRevealPrepaintRestores.get(fileElement);
        if (pendingRestore) {
          this.finishFileRevealPrepaintRestore(
            fileElement,
            pendingRestore,
          );
        }
      }
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
        this.startOfficialViewedRestoreGuard(
          knownKey,
          filePath,
          fileElement,
        );
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
        if (prepaintRestore) {
          this.finishFileRevealPrepaintRestore(
            fileElement,
            prepaintRestore,
          );
        }
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
          this.startOfficialViewedRestoreGuard(key, filePath, fileElement);
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
      if (!this.syncOfficialViewedEnabled || controllers.length === 0) {
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
      this.finishAllFileRevealPrepaintRestores();
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
}
