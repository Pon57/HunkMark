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

      const stored = await this.chrome.storage.local.get([
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
        await this.chrome.storage.local.set({
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

    updatePanelClearance(panel, spacer) {
      if (!panel.isConnected || !spacer.isConnected) {
        return;
      }
      const bottom =
        Number.parseFloat(this.window.getComputedStyle(panel).bottom) || 0;
      const boundary = this.lastVisibleDiffBoundary();
      const contentGap = boundary.collapsedFile ? 16 : 8;
      const requiredClearance =
        panel.getBoundingClientRect().height + bottom + contentGap;
      const previousSpacerHeight =
        Number.parseFloat(spacer.style.height) || 0;
      const pageBottomWithoutSpacer = Math.max(
        0,
        this.document.documentElement.scrollHeight - previousSpacerHeight,
      );
      const existingClearance = Math.max(
        0,
        pageBottomWithoutSpacer - boundary.bottom,
      );
      const height = Math.ceil(
        Math.max(0, requiredClearance - existingClearance),
      );
      spacer.style.height = `${height}px`;
    },

    lastVisibleDiffBoundary() {
      const boundary = { bottom: 0, collapsedFile: false };
      const fileContainers = this.document.querySelectorAll(
        this.constants.FILE_CONTAINER_SELECTOR,
      );
      fileContainers.forEach((fileElement) => {
        if (
          !fileElement.isConnected ||
          fileElement.getClientRects().length === 0
        ) {
          return;
        }
        const bottom =
          fileElement.getBoundingClientRect().bottom + this.window.scrollY;
        if (bottom <= boundary.bottom) {
          return;
        }
        const hasVisibleHunk = Array.from(
          fileElement.querySelectorAll(
            this.constants.HUNK_ELEMENT_SELECTOR,
          ),
        ).some((element) => element.getClientRects().length > 0);
        boundary.bottom = bottom;
        boundary.collapsedFile = !hasVisibleHunk;
      });
      this.controllersByRow.forEach((controller) => {
        controller.groupRows.forEach((row) => {
          if (!row.isConnected || row.getClientRects().length === 0) {
            return;
          }
          const bottom =
            row.getBoundingClientRect().bottom + this.window.scrollY;
          if (bottom > boundary.bottom) {
            boundary.bottom = bottom;
            boundary.collapsedFile = false;
          }
        });
      });
      return boundary;
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

      if (this.panelClearanceTarget !== panel) {
        this.panelClearanceObserver?.disconnect();
        this.panelClearanceTarget = panel;
        if (typeof this.window.ResizeObserver === "function") {
          this.panelClearanceObserver = new this.window.ResizeObserver(() => {
            this.updatePanelClearance(panel, spacer);
          });
          this.panelClearanceObserver.observe(panel);
        }
      }
      if (this.panelClearanceObserver) {
        this.document
          .querySelectorAll(this.constants.FILE_CONTAINER_SELECTOR)
          .forEach((fileElement) =>
            this.panelClearanceObserver.observe(fileElement),
          );
      }
      this.updatePanelClearance(panel, spacer);
    },

    removePanel() {
      this.panelClearanceObserver?.disconnect();
      this.panelClearanceObserver = null;
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
        void this.chrome.storage.local
          .set({ [this.linkSplitPreferenceKey]: this.linkSplitSides })
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
      const controllers = Array.from(this.controllersByRow.values()).filter(
        (controller) => controller.hunkRow.isConnected,
      );
      const suppressionKeys =
        this.currentReviewVariant === this.Core.ALL_COMMITS_REVIEW_VARIANT
          ? this.suppressionKeysForControllers(controllers)
          : [];

      resetButton.disabled = true;
      try {
        const stored = await this.chrome.storage.local.get(null);
        const keys = new Set([
          ...Object.keys(stored).filter((key) =>
            this.Core.isReviewStorageKeyForScope(
              key,
              this.currentReviewScope,
            ),
          ),
          ...suppressionKeys,
        ]);
        const hasOtherRanges = Object.keys(stored).some(
          (key) =>
            !keys.has(key) &&
            this.Core.isReviewStorageKeyForContext(key, this.currentScope),
        );
        if (!hasOtherRanges) {
          keys.add(
            this.Core.reviewContextMetadataKey(this.currentScope),
          );
        }
        if (keys.size > 0) {
          await this.chrome.storage.local.remove(Array.from(keys));
        }
        suppressionKeys.forEach((key) =>
          this.officialViewedSyncSuppressed.delete(key),
        );
        if (!hasOtherRanges) {
          this.forgetReviewContextAccess(this.currentScope);
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

    updateProgress() {
      const connectedControllers = Array.from(
        this.controllersByRow.values(),
      ).filter((controller) => controller.hunkRow.isConnected);
      const byFile = new Map();

      connectedControllers.forEach((controller) => {
        const list = byFile.get(controller.fileElement) ?? [];
        list.push(controller);
        byFile.set(controller.fileElement, list);
      });

      this.document
        .querySelectorAll(".hunkmark-file-progress")
        .forEach((badge) => {
          const owner = Array.from(byFile.keys()).find((file) =>
            file.contains(badge),
          );
          if (!owner) {
            badge.remove();
          }
        });

      byFile.forEach((controllers, fileElement) => {
        const viewed = controllers.filter(
          (controller) => controller.marked,
        ).length;
        const lines = controllers.flatMap((controller) => controller.lines);
        const viewedLines = lines.filter((line) => line.marked).length;
        const lineText =
          lines.length > 0 ? ` · Lines ${viewedLines}/${lines.length}` : "";
        const nextText = `Hunks ${viewed}/${controllers.length}${lineText}`;
        const state = {
          complete: viewed === controllers.length,
          hunks: controllers.length,
          lines: lines.length,
          text: nextText,
          viewed,
          viewedLines,
        };
        this.fileProgressStateByKey.set(
          this.fileProgressStateKey(controllers[0].filePath),
          state,
        );
        this.renderFileProgress(fileElement, state);
      });

      if (connectedControllers.length === 0) {
        this.removePanel();
        return;
      }

      const panel = this.ensurePanel();
      const summary = panel.querySelector(".hunkmark-panel-summary");
      const viewed = connectedControllers.filter(
        (controller) => controller.marked,
      ).length;
      const lines = connectedControllers.flatMap(
        (controller) => controller.lines,
      );
      const viewedLines = lines.filter((line) => line.marked).length;
      const lineText =
        lines.length > 0 ? ` · Lines ${viewedLines} / ${lines.length}` : "";
      const nextText = `Hunks ${viewed} / ${connectedControllers.length}${lineText}`;
      if (summary.textContent !== nextText) {
        summary.textContent = nextText;
      }
    },
  });
})(globalThis);
