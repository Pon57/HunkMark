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
      if (!controller) {
        return;
      }

      this.officialViewedSyncPending.delete(controller.fileElement);
      const key = this.officialViewedSuppressionKey(controller.filePath);
      const viewedBeforeClick = this.officialControlIsViewed(control);
      this.officialViewedSyncSuppressed.add(key);
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
