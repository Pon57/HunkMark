(function attachHunkMarkLifecycle(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    githubViewerIdentity() {
      const candidates = [
        ["id", 'meta[name="octolytics-dimension-user_id"]'],
        ["login", 'meta[name="user-login"]'],
        ["login", 'meta[name="octolytics-dimension-user_login"]'],
      ];
      for (const [kind, selector] of candidates) {
        const value = this.document
          .querySelector(selector)
          ?.getAttribute("content");
        if (typeof value === "string" && value.trim()) {
          return `${kind}:${value.trim()}`;
        }
      }

      const signedOutControl = this.document.querySelector(
        [
          'header a[href^="/login"]',
          'a.HeaderMenu-link[href^="/login"]',
        ].join(", "),
      );
      if (signedOutControl) {
        return "anonymous";
      }
      return null;
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
      const locationScope = this.Core.parseReviewScope(this.window.location);
      const nextScope = this.Core.reviewViewerScope(
        locationScope,
        this.githubViewerIdentity(),
      );
      const nextReviewVariant = this.Core.parseReviewVariant(
        this.window.location,
      );
      const nextReviewScope = this.Core.reviewStateScope(
        nextScope,
        nextReviewVariant,
      );
      if (nextReviewScope !== this.currentReviewScope) {
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
      const storagePruneDue =
        !this.storagePruned ||
        now - this.storagePrunedAt >=
          this.constants.REVIEW_STORAGE_PRUNE_INTERVAL_MS;
      if (storagePruneDue) {
        try {
          await this.ensureStoredReviewStatePruned();
          this.storagePruned = true;
          this.storagePrunedAt = now;
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
      const discovered = this.discoverHunks();
      const previousByHunk = new Map(
        discovered.map((hunk) => [
          hunk,
          this.previousControllersForHunk(previousControllers, hunk),
        ]),
      );
      const seenRows = new Set(discovered.map((hunk) => hunk.hunkRow));
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
          const newController = this.createController(hunk);
          newControllers.push(newController);
          previousByController.set(
            newController,
            previousByHunk.get(hunk) ?? [],
          );
        }
      });

      if (newControllers.length > 0) {
        const keys = [
          ...new Set(
            newControllers.flatMap((controller) => [
              controller.key,
              controller.collapsedKey,
              this.officialViewedSuppressionKey(controller.filePath),
              ...controller.lines.map((line) => line.key),
            ]),
          ),
        ];
        const stored = await this.chrome.storage.local.get(keys);
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
            controller.lines.length === 0 && Boolean(stored[controller.key]);
          const expandedByHost =
            previous.length > 1 ||
            (previous.length === 1 &&
              controller.groupRows.length > previous[0].groupRows.length);
          const suppressionKey = this.officialViewedSuppressionKey(
            controller.filePath,
          );
          if (stored[suppressionKey]) {
            this.officialViewedSyncSuppressed.add(suppressionKey);
          }
          controller.collapsed =
            !expandedByHost && Boolean(stored[controller.collapsedKey]);
          controller.marked = hunkStored;
          let invalidatedLineReview = false;
          controller.lines.forEach((line) => {
            const storedMatches = this.storedLineReviewMatches(
              line,
              stored[line.key],
            );
            const previousLine = previousLineMarks.get(line.key);
            const previousMatches =
              previousLine?.marked === true &&
              (previousLine.contextFingerprint === line.contextFingerprint ||
                (expandedByHost && previousLine.element === line.element));
            line.marked = storedMatches || previousMatches;
            line.input.disabled = false;
            if (stored[line.key] && !storedMatches) {
              invalidatedLineReview = true;
              migrationRemovals.add(line.key);
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
            migrationRemovals.add(controller.collapsedKey);
          }
          if (expandedByHost) {
            migrationRemovals.add(controller.collapsedKey);
            previous.forEach((candidate) =>
              migrationRemovals.add(candidate.collapsedKey),
            );
          }
          controller.input.disabled = false;
          this.applyControllerAppearance(controller);
        });

        if (Object.keys(migrations).length > 0) {
          Object.keys(migrations).forEach((key) =>
            migrationRemovals.delete(key),
          );
          await this.setReviewStorage(migrations);
        }
        if (migrationRemovals.size > 0) {
          await this.chrome.storage.local.remove(
            Array.from(migrationRemovals),
          );
        }
      }

      this.updateProgress();
      this.clearSettledOfficialViewedRestoreGuards();
    },

    isExtensionContextInvalidated(error) {
      return /extension context invalidated/i.test(
        String(error?.message ?? error ?? ""),
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

      this.controllersByRow.forEach((controller) => {
        if (changes[controller.collapsedKey]) {
          controller.collapsed = Boolean(
            changes[controller.collapsedKey].newValue,
          );
        }

        let lineChanged = false;
        controller.lines.forEach((line) => {
          if (changes[line.key]) {
            line.marked = this.storedLineReviewMatches(
              line,
              changes[line.key].newValue,
            );
            lineChanged = true;
          }
        });

        const hunkChange = changes[controller.key];
        if (hunkChange?.newValue) {
          controller.marked = true;
          controller.indeterminate = false;
          controller.lines.forEach((line) => {
            line.marked = true;
          });
        } else if (
          controller.lines.length > 0 &&
          (lineChanged || hunkChange)
        ) {
          this.updateAggregateFromLines(controller);
        } else if (hunkChange) {
          controller.marked = false;
          controller.indeterminate = false;
        }

        if (
          lineChanged ||
          hunkChange ||
          changes[controller.collapsedKey]
        ) {
          this.applyControllerAppearance(controller);
        }
      });
      this.updateProgress();
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

      const hostDiffChanged = mutations.some(
        (mutation) =>
          !this.mutationIsExtensionOnly(mutation) &&
          this.mutationAffectsDiff(mutation),
      );
      if (hostDiffChanged) {
        const progressRemoved =
          this.removeProgressForFilesWithoutRenderedHunks();
        const restored =
          this.preserveOfficialViewedRestoredState() ||
          this.restoreCachedOfficialViewedControllers();
        this.scheduleRefresh({ immediate: restored || progressRemoved });
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
      this.boundOfficialViewedClick = (event) =>
        this.handleOfficialViewedClick(event);
      this.boundFileToggleClick = (event) =>
        this.handleFileToggleClick(event);
      this.boundScheduleRefresh = () => this.scheduleRefresh();
      this.boundNavigationChange = () => this.checkForNavigation();
      this.boundWindowBlur = () => {
        if (this.dragState) {
          void this.finishLineDrag(true);
        }
      };

      this.chrome.storage.onChanged.addListener(this.boundStorageChanged);
      this.observer = new this.window.MutationObserver((mutations) =>
        this.handleMutations(mutations),
      );
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
        "click",
        this.boundOfficialViewedClick,
        true,
      );
      this.document.addEventListener(
        "click",
        this.boundFileToggleClick,
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
        "click",
        this.boundOfficialViewedClick,
        true,
      );
      this.document.removeEventListener(
        "click",
        this.boundFileToggleClick,
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
    },
  });
})(globalThis);
