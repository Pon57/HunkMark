"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

  globalThis.HunkMarkContent.extendApp({
    async loadPreferences() {
      if (this.preferencesLoaded) {
        return;
      }

      const stored = await this.getLocalStorage([
        this.autoCollapsePreferenceKey,
        this.linkSplitPreferenceKey,
        this.officialViewedSyncPreferenceKey,
      ]);
      this.autoCollapseViewed =
        stored[this.autoCollapsePreferenceKey] !== false;
      this.linkSplitSides = stored[this.linkSplitPreferenceKey] !== false;
      this.syncOfficialViewedEnabled =
        stored[this.officialViewedSyncPreferenceKey] !== false;
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

    syncOfficialViewedPreferenceInput() {
      const input = this.document.querySelector(
        `#${this.constants.PANEL_ID} input[aria-label="Sync GitHub file Viewed"]`,
      );
      if (input) {
        input.checked = this.syncOfficialViewedEnabled;
      }
    },

    applyOfficialViewedSyncPreference() {
      try {
        this.syncOfficialViewedForControllers(
          this.controllersByRow.values(),
        );
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          console.warn(
            "HunkMark could not apply GitHub Viewed synchronization.",
            error,
          );
        }
      }
    },

    async setOfficialViewedSync(enabled) {
      const previous = this.syncOfficialViewedEnabled;
      const input = this.document.querySelector(
        `#${this.constants.PANEL_ID} input[aria-label="Sync GitHub file Viewed"]`,
      );
      if (input) {
        input.disabled = true;
      }
      this.syncOfficialViewedEnabled = enabled;
      this.syncOfficialViewedPreferenceInput();
      let stored = false;
      try {
        await this.setLocalStorage({
          [this.officialViewedSyncPreferenceKey]: enabled,
        });
        stored = true;
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          this.syncOfficialViewedEnabled = previous;
          this.syncOfficialViewedPreferenceInput();
          console.warn(
            "HunkMark could not save GitHub Viewed synchronization.",
            error,
          );
        }
      } finally {
        if (!this.stopped && input) {
          input.disabled = false;
        }
      }
      if (
        stored &&
        !previous &&
        enabled &&
        this.syncOfficialViewedEnabled &&
        !this.stopped
      ) {
        this.applyOfficialViewedSyncPreference();
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
      this.panelEventController?.abort();
      this.panelEventController = null;
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

      const settingsButton = this.document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "hunkmark-settings-button";
      settingsButton.title = "Settings";
      settingsButton.setAttribute("aria-label", "HunkMark settings");
      settingsButton.setAttribute("aria-expanded", "false");
      settingsButton.setAttribute(
        "aria-controls",
        this.constants.PANEL_SETTINGS_ID,
      );
      const settingsIcon = this.document.createElementNS(
        SVG_NAMESPACE,
        "svg",
      );
      settingsIcon.setAttribute("class", "hunkmark-settings-icon");
      settingsIcon.setAttribute("aria-hidden", "true");
      settingsIcon.setAttribute("focusable", "false");
      settingsIcon.setAttribute("viewBox", "0 0 16 16");
      const settingsIconPath = this.document.createElementNS(
        SVG_NAMESPACE,
        "path",
      );
      // Primer Octicons gear-16 (MIT).
      settingsIconPath.setAttribute(
        "d",
        "M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z",
      );
      settingsIcon.append(settingsIconPath);
      settingsButton.append(settingsIcon);

      const settings = this.document.createElement("div");
      settings.id = this.constants.PANEL_SETTINGS_ID;
      settings.className = "hunkmark-settings-menu";
      settings.hidden = true;
      settings.setAttribute("role", "dialog");
      settings.setAttribute("aria-label", "HunkMark settings");

      const settingsHeading = this.document.createElement("strong");
      settingsHeading.className = "hunkmark-settings-heading";
      settingsHeading.textContent = "Settings";

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

      const officialViewedSyncLabel = this.document.createElement("label");
      officialViewedSyncLabel.className = "hunkmark-panel-toggle";
      officialViewedSyncLabel.title =
        "Mark GitHub's file-level Viewed when all HunkMark hunks are viewed";
      const officialViewedSyncInput = this.document.createElement("input");
      officialViewedSyncInput.type = "checkbox";
      officialViewedSyncInput.checked = this.syncOfficialViewedEnabled;
      officialViewedSyncInput.setAttribute(
        "aria-label",
        "Sync GitHub file Viewed",
      );
      const officialViewedSyncText = this.document.createElement("span");
      officialViewedSyncText.textContent = "Sync GitHub file Viewed";
      officialViewedSyncLabel.append(
        officialViewedSyncInput,
        officialViewedSyncText,
      );

      const resetButton = this.document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "hunkmark-reset-button";
      resetButton.textContent = "Reset page";
      resetButton.title =
        "Clear hunk, line, and collapse state for this diff view";

      const setSettingsOpen = (open, { restoreFocus = false } = {}) => {
        settings.hidden = !open;
        settingsButton.setAttribute("aria-expanded", String(open));
        if (!open && restoreFocus && settingsButton.isConnected) {
          settingsButton.focus();
        }
      };

      settingsButton.addEventListener("click", () => {
        setSettingsOpen(settings.hidden);
      });

      this.panelEventController?.abort();
      this.panelEventController = new this.window.AbortController();
      const { signal } = this.panelEventController;
      this.document.addEventListener(
        "click",
        (event) => {
          if (!settings.hidden && !panel.contains(event.target)) {
            setSettingsOpen(false);
          }
        },
        { signal },
      );
      this.document.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape" || settings.hidden) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          setSettingsOpen(false, { restoreFocus: true });
        },
        { signal },
      );

      autoCollapseInput.addEventListener("change", () => {
        void this.setAutoCollapse(autoCollapseInput.checked);
      });

      officialViewedSyncInput.addEventListener("change", () => {
        void this.setOfficialViewedSync(officialViewedSyncInput.checked);
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

      settings.append(
        settingsHeading,
        autoCollapseLabel,
        officialViewedSyncLabel,
        linkLabel,
        resetButton,
      );
      panel.append(summary, settingsButton, settings);
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
        this.fileReviewSnapshotsByKey.set(
          progressKey,
          this.captureFileReviewSnapshot(
            controllers,
            controllers[0].filePath,
          ),
        );
        const state = {
          collapsed: file.collapsed,
          complete: file.viewed === controllers.length,
          hunks: controllers.length,
          lines: file.lines,
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
}
