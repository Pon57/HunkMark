(function attachHunkMarkOfficialViewed(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    officialViewedControlForFile(fileElement) {
      return fileElement?.querySelector(
        this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
      ) ?? null;
    },

    officialViewedSuppressionScope() {
      return this.Core.reviewStateScope(
        this.currentScope,
        this.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
    },

    officialViewedSuppressionKey(filePath) {
      return this.Core.officialSyncSuppressionKey(
        this.officialViewedSuppressionScope(),
        filePath,
      );
    },

    suppressionKeysForControllers(controllers) {
      return [
        ...new Set(
          Array.from(controllers, (controller) =>
            this.officialViewedSuppressionKey(controller.filePath),
          ),
        ),
      ];
    },

    clearOfficialViewedSuppressionKeys(keys) {
      const clearedKeys = keys.filter((key) =>
        this.officialViewedSyncSuppressed.delete(key),
      );
      if (clearedKeys.length === 0) {
        return;
      }

      void this.chrome.storage.local.remove(clearedKeys).catch((error) => {
        if (!this.stopForInvalidatedContext(error)) {
          clearedKeys.forEach((key) =>
            this.officialViewedSyncSuppressed.add(key),
          );
          console.warn(
            "HunkMark could not clear the official Viewed override.",
            error,
          );
        }
      });
    },

    releaseOfficialViewedSuppression(controllers) {
      this.clearOfficialViewedSuppressionKeys(
        this.suppressionKeysForControllers(
          Array.from(controllers).filter((controller) =>
            this.officialViewedControlForFile(controller.fileElement),
          ),
        ),
      );
    },

    persistOfficialViewedSuppression(key) {
      this.officialViewedSyncSuppressed.add(key);
      const updatedAt = Date.now();
      void this.setReviewStorage(
        { [key]: { suppressed: true, updatedAt } },
        this.officialViewedSuppressionScope(),
        updatedAt,
      )
        .catch((error) => {
          if (!this.stopForInvalidatedContext(error)) {
            console.warn(
              "HunkMark could not remember the official Viewed override.",
              error,
            );
          }
        });
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
        fileElement.querySelectorAll("button, [role=button]"),
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

    reconcileOfficialViewedAfterClick(key, viewedBeforeClick, attempt = 0) {
      const controller = Array.from(this.controllersByRow.values()).find(
        (candidate) =>
          candidate.hunkRow.isConnected &&
          this.officialViewedSuppressionKey(candidate.filePath) === key,
      );
      const control = controller?.fileElement.querySelector(
        this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
      );
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
              viewedBeforeClick,
              attempt + 1,
            ),
          100,
        );
        return;
      }

      if (control && this.officialControlIsViewed(control)) {
        this.officialViewedStateByKey.set(key, true);
        this.clearOfficialViewedSuppressionKeys([key]);
      } else {
        if (control) {
          this.officialViewedStateByKey.set(key, false);
        }
        this.persistOfficialViewedSuppression(key);
      }
      this.settleOfficialViewedRestoreGuard(key);
    },

    observeOfficialViewedState(key, control) {
      const viewed = this.officialControlIsViewed(control);
      const previous = this.officialViewedStateByKey.get(key);
      this.officialViewedStateByKey.set(key, viewed);

      if (
        previous === false &&
        viewed &&
        this.officialViewedSyncSuppressed.has(key)
      ) {
        this.clearOfficialViewedSuppressionKeys([key]);
      }

      return viewed;
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
      this.discoverHunks().forEach((hunk) => {
        const key = this.officialViewedSuppressionKey(hunk.filePath);
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
        hunk.lines.forEach((line) => {
          if (
            this.lineReviewContextByKey.get(line.key) ===
            line.contextFingerprint
          ) {
            line.element.classList.add("hunkmark-line-viewed");
          }
        });
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
      this.discoverHunks().forEach((hunk) => {
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
            line.input.disabled = false;
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
        this.removeFileProgress(fileElement);
        return;
      }
      if (label !== "Expand file") {
        return;
      }

      this.fileExpandRestorePending.add(progressKey);
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

    handleOfficialViewedClick(event) {
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
      const key = this.officialViewedSuppressionKey(filePath);
      const viewedBeforeClick = control.matches('input[type="checkbox"]')
        ? !control.checked
        : this.officialControlIsViewed(control);
      this.officialViewedSyncSuppressed.add(key);
      if (viewedBeforeClick) {
        this.startOfficialViewedRestoreGuard(key, filePath);
      } else {
        this.removeFileProgress(fileElement);
      }
      this.window.setTimeout(
        () => this.reconcileOfficialViewedAfterClick(key, viewedBeforeClick),
        0,
      );
    },

    syncOfficialViewedForControllers(controllers) {
      const fileElements = new Set(
        Array.from(controllers, (controller) => controller.fileElement),
      );
      const connectedControllers = Array.from(
        this.controllersByRow.values(),
      ).filter((controller) => controller.hunkRow.isConnected);

      fileElements.forEach((fileElement) => {
        this.syncOfficialFileViewed(
          fileElement,
          connectedControllers.filter(
            (controller) => controller.fileElement === fileElement,
          ),
        );
      });
    },

    syncOfficialFileViewed(fileElement, controllers) {
      if (controllers.length === 0) {
        return;
      }

      const suppressionKey = this.officialViewedSuppressionKey(
        controllers[0].filePath,
      );
      const control = this.officialViewedControlForFile(fileElement);
      if (!control) {
        return;
      }

      const officialViewed = this.observeOfficialViewedState(
        suppressionKey,
        control,
      );
      if (
        this.dragState ||
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
      this.officialViewedRestoreGuards.clear();
      this.officialViewedStateByKey.clear();
      this.officialViewedSyncSuppressed.clear();
    },

    applyOfficialSuppressionChanges(changes) {
      this.suppressionKeysForControllers(this.controllersByRow.values()).forEach(
        (key) => {
          if (!changes[key]) {
            return;
          }
          if (changes[key].newValue) {
            this.officialViewedSyncSuppressed.add(key);
          } else {
            this.officialViewedSyncSuppressed.delete(key);
          }
        },
      );
    },
  });
})(globalThis);
