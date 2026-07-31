(function attachHunkMarkPanel(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    async loadPreferences() {
      if (this.preferencesLoaded) {
        return;
      }

      const stored = await this.getLocalStorage([
        this.autoCollapsePreferenceKey,
        this.linkSplitPreferenceKey,
      ]);
      this.autoCollapseViewed =
        stored[this.autoCollapsePreferenceKey] !== false;
      this.linkSplitSides = stored[this.linkSplitPreferenceKey] !== false;
      this.preferencesLoaded = true;
    },

    syncAutoCollapseInput() {
      const autoCollapseInput = this.document.querySelector(
        `#${this.constants.PANEL_ID} input[aria-label="Automatically collapse viewed hunks"]`,
      );
      if (autoCollapseInput) {
        autoCollapseInput.checked = this.autoCollapseViewed;
      }
    },

    async setAutoCollapse(enabled) {
      const previous = this.autoCollapseViewed;
      const input = this.document.querySelector(
        `#${this.constants.PANEL_ID} input[aria-label="Automatically collapse viewed hunks"]`,
      );
      if (input) {
        input.disabled = true;
      }
      this.autoCollapseViewed = enabled;
      this.syncAutoCollapseInput();
      try {
        await this.setLocalStorage({
          [this.autoCollapsePreferenceKey]: enabled,
        });
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          this.autoCollapseViewed = previous;
          this.syncAutoCollapseInput();
          console.warn("HunkMark could not save auto-collapse.", error);
        }
      } finally {
        if (!this.stopped && input) {
          input.disabled = false;
        }
      }
    },

    panelClearanceFileForElement(element) {
      if (!element?.isConnected) {
        return null;
      }
      if (!element.matches("button, input, [role=button]")) {
        return element;
      }
      return element.closest("article, details, section, [role=region]");
    },

    lastPanelClearanceFile() {
      let lastFileElement = null;
      const addCandidate = (element, normalize = false) => {
        const fileElement = normalize
          ? this.panelClearanceFileForElement(element)
          : element;
        if (
          !fileElement?.isConnected ||
          fileElement === lastFileElement ||
          lastFileElement?.contains(fileElement)
        ) {
          return;
        }
        if (
          !lastFileElement ||
          fileElement.contains(lastFileElement) ||
          (lastFileElement.compareDocumentPosition(fileElement) &
            this.window.Node.DOCUMENT_POSITION_FOLLOWING)
        ) {
          lastFileElement = fileElement;
        }
      };

      this.controllersByRow.forEach((controller) => {
        if (controller.hunkRow.isConnected) {
          addCandidate(controller.fileElement);
        }
      });
      this.fileRevealPrepaintRestores.forEach((_, fileElement) =>
        addCandidate(fileElement),
      );
      this.fileDiffVisibilityPending.forEach((_, fileElement) =>
        addCandidate(fileElement),
      );

      this.document
        .querySelectorAll(
          [
            this.constants.FILE_CONTAINER_SELECTOR,
            this.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
          ].join(", "),
        )
        .forEach((element) => addCandidate(element, true));
      return lastFileElement;
    },

    panelClearanceContentBottom(fileElement) {
      if (!fileElement?.isConnected) {
        return 0;
      }
      let bottom =
        fileElement.getBoundingClientRect().bottom + this.window.scrollY;
      let trailingController = null;
      this.controllersByRow.forEach((controller) => {
        if (
          !controller.hunkRow.isConnected ||
          (controller.fileElement !== fileElement &&
            !fileElement.contains(controller.fileElement) &&
            !controller.fileElement.contains(fileElement))
        ) {
          return;
        }
        if (
          !trailingController ||
          (trailingController.hunkRow.compareDocumentPosition(
            controller.hunkRow,
          ) &
            this.window.Node.DOCUMENT_POSITION_FOLLOWING)
        ) {
          trailingController = controller;
        }
      });
      const trailingRow = trailingController?.collapsed
        ? trailingController.hunkRow
        : trailingController?.groupRows.at(-1);
      if (trailingRow?.isConnected) {
        bottom = Math.max(
          bottom,
          trailingRow.getBoundingClientRect().bottom + this.window.scrollY,
        );
      }
      return bottom;
    },

    updatePanelClearance(
      panel,
      spacer,
      fileElement = this.lastPanelClearanceFile(),
    ) {
      if (!panel.isConnected || !spacer.isConnected) {
        return;
      }
      const bottom =
        Number.parseFloat(this.window.getComputedStyle(panel).bottom) || 0;
      const requiredClearance =
        panel.getBoundingClientRect().height + bottom + 16;
      const spacerTop =
        spacer.getBoundingClientRect().top + this.window.scrollY;
      const existingClearance =
        spacerTop - this.panelClearanceContentBottom(fileElement);
      const height = Math.ceil(
        Math.max(0, requiredClearance - existingClearance),
      );
      spacer.style.height = `${height}px`;
    },

    ensurePanelClearance(panel) {
      let spacer = this.document.getElementById(
        this.constants.PANEL_SPACER_ID,
      );
      if (!spacer) {
        spacer = this.document.createElement("div");
        spacer.id = this.constants.PANEL_SPACER_ID;
        spacer.setAttribute("aria-hidden", "true");
        this.document.body.append(spacer);
      }

      const fileTarget = this.lastPanelClearanceFile();
      const targetChanged =
        this.panelClearanceTarget !== panel ||
        this.panelClearanceFileTarget !== fileTarget;
      if (targetChanged) {
        this.panelClearanceObserver?.disconnect();
        this.panelClearanceTarget = panel;
        this.panelClearanceFileTarget = fileTarget;
        if (typeof this.window.ResizeObserver === "function") {
          this.panelClearanceObserver = new this.window.ResizeObserver(() => {
            this.updatePanelClearance(panel, spacer, fileTarget);
          });
          this.panelClearanceObserver.observe(panel);
          if (fileTarget && fileTarget !== panel) {
            this.panelClearanceObserver.observe(fileTarget);
          }
        }
      }
      if (targetChanged || !this.panelClearanceObserver) {
        this.updatePanelClearance(panel, spacer, fileTarget);
      }
    },

    removePanel() {
      this.panelClearanceObserver?.disconnect();
      this.panelClearanceObserver = null;
      this.panelClearanceFileTarget = null;
      this.panelClearanceTarget = null;
      this.document.getElementById(this.constants.PANEL_ID)?.remove();
      this.document.getElementById(this.constants.PANEL_SPACER_ID)?.remove();
    },

    ensurePanel() {
      let panel = this.document.getElementById(this.constants.PANEL_ID);
      if (panel) {
        this.ensurePanelClearance(panel);
        return panel;
      }

      panel = this.document.createElement("aside");
      panel.id = this.constants.PANEL_ID;
      panel.setAttribute("aria-label", "Diff hunk review progress");

      const summary = this.document.createElement("strong");
      summary.className = "hunkmark-panel-summary";

      const autoCollapseLabel = this.document.createElement("label");
      autoCollapseLabel.className = "hunkmark-panel-toggle";
      const autoCollapseInput = this.document.createElement("input");
      autoCollapseInput.type = "checkbox";
      autoCollapseInput.checked = this.autoCollapseViewed;
      autoCollapseInput.setAttribute(
        "aria-label",
        "Automatically collapse viewed hunks",
      );
      const autoCollapseText = this.document.createElement("span");
      autoCollapseText.textContent = "Auto-collapse hunks";
      autoCollapseLabel.append(autoCollapseInput, autoCollapseText);

      const linkLabel = this.document.createElement("label");
      linkLabel.className = "hunkmark-panel-toggle";
      const linkInput = this.document.createElement("input");
      linkInput.type = "checkbox";
      linkInput.checked = this.linkSplitSides;
      linkInput.setAttribute("aria-label", "Link split diff sides");
      const linkText = this.document.createElement("span");
      linkText.textContent = "Link split sides";
      linkLabel.append(linkInput, linkText);

      const resetButton = this.document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "hunkmark-reset-button";
      resetButton.textContent = "Reset page";
      resetButton.title =
        "Clear hunk, line, and collapse state for this diff view";

      autoCollapseInput.addEventListener("change", () => {
        void this.setAutoCollapse(autoCollapseInput.checked);
      });

      linkInput.addEventListener("change", () => {
        const previous = this.linkSplitSides;
        this.linkSplitSides = linkInput.checked;
        linkInput.disabled = true;
        void this.setLocalStorage({
          [this.linkSplitPreferenceKey]: this.linkSplitSides,
        })
          .catch((error) => {
            if (!this.stopForInvalidatedContext(error)) {
              this.linkSplitSides = previous;
              linkInput.checked = previous;
              console.warn(
                "HunkMark could not save split-side linking.",
                error,
              );
            }
          })
          .finally(() => {
            if (!this.stopped) {
              linkInput.disabled = false;
            }
          });
      });

      resetButton.addEventListener("click", () => {
        void this.resetCurrentPage(resetButton);
      });

      panel.append(
        summary,
        autoCollapseLabel,
        linkLabel,
        resetButton,
      );
      this.document.body.append(panel);
      this.ensurePanelClearance(panel);
      return panel;
    },

    async resetCurrentPage(resetButton) {
      const reviewScope = this.currentReviewScope;
      const contextScope = this.currentScope;
      const controllers = Array.from(this.controllersByRow.values()).filter(
        (controller) => controller.hunkRow.isConnected,
      );
      const suppressionKeys =
        this.currentReviewVariant === this.Core.ALL_COMMITS_REVIEW_VARIANT
          ? this.suppressionKeysForControllers(controllers)
          : [];
      const suppressionGeneration =
        this.createOfficialViewedIntentGeneration();
      this.registerOfficialViewedIntent(
        suppressionKeys,
        suppressionGeneration,
      );

      resetButton.disabled = true;
      try {
        const [scopePrefixes, contextPrefixes, metadataKey] =
          await Promise.all([
            this.Core.reviewStoragePrefixes(reviewScope),
            this.Core.reviewStoragePrefixesForContext(contextScope),
            this.Core.reviewContextMetadataKey(contextScope),
          ]);
        await this.withReviewStorageLock(async () => {
          const stored = await this.getLocalStorage(null);
          const keys = new Set([
            ...Object.keys(stored).filter((key) =>
              scopePrefixes.some((prefix) => key.startsWith(prefix)),
            ),
            ...suppressionKeys,
          ]);
          const otherRangesExist = Object.keys(stored).some(
            (key) =>
              !keys.has(key) &&
              contextPrefixes.some((prefix) => key.startsWith(prefix)),
          );
          if (!otherRangesExist) {
            keys.add(metadataKey);
          }
          if (keys.size > 0) {
            await this.removeReviewStorageUnlocked(Array.from(keys));
          }
          this.applyOfficialViewedIntent(
            suppressionKeys,
            false,
            suppressionGeneration,
          );
          if (!otherRangesExist) {
            await this.forgetReviewContextAccess(contextScope);
          }
          controllers.forEach((controller) => {
            controller.marked = false;
            controller.indeterminate = false;
            controller.collapsed = false;
            controller.lines.forEach((line) => {
              line.marked = false;
            });
            this.applyControllerAppearance(controller);
          });
          this.updateProgress();
        });
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          console.warn("HunkMark could not reset this page.", error);
        }
      } finally {
        if (!this.stopped) {
          resetButton.disabled = false;
        }
      }
    },

    fileProgressStateKey(filePath) {
      return `${this.currentReviewScope ?? ""}\u0000${filePath}`;
    },

    renderFileProgress(fileElement, state) {
      if (!fileElement || !state) {
        return null;
      }

      const fileNameLink = fileElement.querySelector('a[href^="#diff-"]');
      const fileInfo = [
        fileElement.querySelector(".file-header .file-info"),
        fileElement.querySelector(
          '[data-testid*="file-header"] [data-testid*="file-name"]',
        ),
        fileElement.querySelector('[data-testid*="file-name"]'),
        fileElement.querySelector("[data-diff-header-wrapper] h3"),
        fileNameLink?.closest("h1, h2, h3, h4, h5, h6, [role=heading]"),
        fileElement.querySelector(
          '[class*="DiffFileHeader-module__file-name"]',
        ),
        fileElement.querySelector(".file-header"),
        fileElement.querySelector('[data-testid*="file-header"]'),
        fileElement.querySelector("header"),
      ].find(Boolean);
      if (!fileInfo) {
        return null;
      }

      const pathSection = fileInfo.closest(
        [
          '[class*="DiffFileHeader-module__file-path-section"]',
          '[class*="file-path-section"]',
        ].join(", "),
      );
      const insertAfter =
        pathSection?.parentElement &&
        fileElement.contains(pathSection.parentElement)
          ? pathSection
          : null;

      let badge = fileElement.querySelector(".hunkmark-file-progress");
      if (!badge) {
        badge = this.document.createElement("span");
        badge.className = "hunkmark-file-progress";
        badge.title = "Viewed diff hunks in this file";
      }
      if (insertAfter) {
        if (
          badge.parentElement !== insertAfter.parentElement ||
          badge.previousElementSibling !== insertAfter
        ) {
          insertAfter.after(badge);
        }
      } else if (badge.parentElement !== fileInfo) {
        fileInfo.append(badge);
      }

      if (badge.textContent !== state.text) {
        badge.textContent = state.text;
      }
      badge.classList.toggle("is-complete", state.complete);
      return badge;
    },

    removeFileProgress(fileElement) {
      fileElement?.querySelector(".hunkmark-file-progress")?.remove();
    },

    restoreFileProgress(fileElement, filePath) {
      return this.renderFileProgress(
        fileElement,
        this.fileProgressStateByKey.get(
          this.fileProgressStateKey(filePath),
        ),
      );
    },

    removeProgressForFilesWithoutRenderedHunks() {
      const controllers = Array.from(this.controllersByRow.values());
      let removed = false;
      this.document
        .querySelectorAll(".hunkmark-file-progress")
        .forEach((badge) => {
          const fileElement =
            controllers.find((controller) =>
              controller.fileElement?.contains(badge),
            )?.fileElement ??
            badge.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
            badge.closest("article, details, section, [role=region]");
          if (
            fileElement &&
            this.findHunkMarkers(fileElement).length === 0
          ) {
            badge.remove();
            removed = true;
          }
        });
      return removed;
    },

    countViewedLines(controller) {
      if (controller.marked) {
        return controller.lines.length;
      }
      if (!controller.indeterminate) {
        return 0;
      }
      return controller.lines.reduce(
        (count, line) => count + Number(line.marked),
        0,
      );
    },

    updateProgress() {
      const byFile = new Map();
      let hunkCount = 0;
      let lineCount = 0;
      let viewedHunkCount = 0;
      let viewedLineCount = 0;

      this.controllersByRow.forEach((controller) => {
        if (!controller.hunkRow.isConnected) {
          return;
        }

        hunkCount += 1;
        viewedHunkCount += Number(controller.marked);
        lineCount += controller.lines.length;
        const controllerViewedLines = this.countViewedLines(controller);
        viewedLineCount += controllerViewedLines;

        let file = byFile.get(controller.fileElement);
        if (!file) {
          file = {
            collapsed: 0,
            controllers: [],
            lines: 0,
            viewed: 0,
            viewedLines: 0,
          };
          byFile.set(controller.fileElement, file);
        }
        file.controllers.push(controller);
        file.collapsed += Number(controller.collapsed);
        file.lines += controller.lines.length;
        file.viewed += Number(controller.marked);
        file.viewedLines += controllerViewedLines;
      });

      const fileElements = Array.from(byFile.keys());
      this.document
        .querySelectorAll(".hunkmark-file-progress")
        .forEach((badge) => {
          const owner = fileElements.find((file) =>
            file.contains(badge),
          );
          if (!owner) {
            badge.remove();
          }
        });

      byFile.forEach((file, fileElement) => {
        const { controllers } = file;
        const lineText =
          file.lines > 0
            ? ` · Lines ${file.viewedLines}/${file.lines}`
            : "";
        const nextText =
          `Hunks ${file.viewed}/${controllers.length}${lineText}`;
        const progressKey = this.fileProgressStateKey(
          controllers[0].filePath,
        );
        const previousReviewKeyGroups =
          this.fileProgressStateByKey.get(progressKey)?.reviewKeyGroups;
        const reviewKeyGroupsMatch =
          previousReviewKeyGroups?.length === controllers.length &&
          controllers.every(
            (controller, index) =>
              previousReviewKeyGroups[index] === controller.reviewKeys,
          );
        const reviewKeyGroups = reviewKeyGroupsMatch
          ? previousReviewKeyGroups
          : Object.freeze(
              controllers.map((controller) => controller.reviewKeys),
            );
        const state = {
          collapsed: file.collapsed,
          complete: file.viewed === controllers.length,
          hunks: controllers.length,
          lines: file.lines,
          reviewKeyGroups,
          text: nextText,
          viewed: file.viewed,
          viewedLines: file.viewedLines,
        };
        this.fileProgressStateByKey.set(progressKey, state);
        this.renderFileProgress(fileElement, state);
      });

      if (hunkCount === 0) {
        this.removePanel();
        return;
      }

      const panel = this.ensurePanel();
      const summary = panel.querySelector(".hunkmark-panel-summary");
      const lineText =
        lineCount > 0
          ? ` · Lines ${viewedLineCount} / ${lineCount}`
          : "";
      const nextText =
        `Hunks ${viewedHunkCount} / ${hunkCount}${lineText}`;
      if (summary.textContent !== nextText) {
        summary.textContent = nextText;
      }
    },
  });
})(globalThis);
