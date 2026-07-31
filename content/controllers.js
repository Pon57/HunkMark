(function attachHunkMarkControllers(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    createController(
      hunk,
      {
        deferLineControls = false,
        lazyLineControls = false,
      } = {},
    ) {
      const actions = this.document.createElement("span");
      actions.className = "hunkmark-hunk-actions";
      actions.setAttribute("data-hunkmark-ui", "true");

      const collapseButton = this.document.createElement("button");
      collapseButton.type = "button";
      collapseButton.className = "hunkmark-collapse-button";
      collapseButton.disabled = true;
      collapseButton.title = "Collapse this diff hunk";

      const label = this.document.createElement("label");
      label.className = this.constants.CONTROL_CLASS;
      label.title = "Mark this diff hunk as viewed";

      const input = this.document.createElement("input");
      input.type = "checkbox";
      input.disabled = true;
      input.setAttribute("aria-label", "Mark this diff hunk as viewed");

      const text = this.document.createElement("span");
      text.textContent = "Viewed";

      label.append(input, text);
      actions.append(collapseButton, label);

      const controller = {
        ...hunk,
        actions,
        collapseButton,
        collapsed: false,
        collapsedKey: `${hunk.key}:collapsed`,
        collapsePending: false,
        indeterminate: false,
        input,
        label,
        lazyLineControls,
        lines: [],
        marked: false,
        materializedLazyLines: lazyLineControls ? new Set() : null,
        observedLazyLines: new Set(),
        destroyed: false,
      };

      actions.addEventListener("click", (event) => event.stopPropagation());
      actions.addEventListener("pointerdown", (event) =>
        event.stopPropagation(),
      );
      input.addEventListener("change", () => {
        void this.setHunkViewed(controller, input.checked);
      });
      collapseButton.addEventListener("click", () => {
        void this.setCollapsed(controller, !controller.collapsed);
      });

      controller.lines = hunk.lines.map((line) =>
        this.createLineController(controller, line),
      );
      controller.reviewKeys = Object.freeze([
        controller.key,
        controller.collapsedKey,
        ...controller.lines.map((line) => line.key),
      ]);
      this.connectSplitLinePeers(controller);

      // Read all host metrics before adding any HunkMark DOM. Interleaving a
      // computed-style read with each line-control insertion forces repeated
      // style and layout work on large hunks. Persisted collapsed hunks can
      // defer this entire pass until the user expands them.
      const lineLayouts = deferLineControls
        ? null
        : controller.lines.map((line) => this.measureLineHostLayout(line));

      hunk.hunkCell.classList.add("hunkmark-hunk-cell");
      hunk.hunkCell.append(actions);
      if (lineLayouts) {
        this.materializeControllerLineControls(controller, lineLayouts, {
          disabled: true,
        });
      }

      this.controllersByRow.set(hunk.hunkRow, controller);
      return controller;
    },

    connectSplitLinePeers(controller) {
      const linesByRow = new Map();
      controller.lines.forEach((line) => {
        line.peers = [];
        const lines = linesByRow.get(line.row) ?? [];
        lines.push(line);
        linesByRow.set(line.row, lines);
      });

      controller.split = false;
      linesByRow.forEach((lines) => {
        const left = lines.filter((line) => line.side === "left");
        const right = lines.filter((line) => line.side === "right");
        if (left.length === 0 || right.length === 0) {
          return;
        }
        controller.split = true;
        left.forEach((line) => {
          line.peers = right;
        });
        right.forEach((line) => {
          line.peers = left;
        });
      });
    },

    interactionLines(lineController) {
      if (!this.linkSplitSides || !lineController.controller.split) {
        return [lineController];
      }
      return [lineController, ...lineController.peers];
    },

    measureLineHostLayout(line) {
      const hostStyle = this.window.getComputedStyle(line.element);

      // GitHub reserves the modern cell's right padding for its native line menu.
      const hostRightInset = line.element.matches(
        ".diff-text-cell, [data-line-anchor]",
      )
        ? Number.parseFloat(hostStyle.paddingRight)
        : 0;
      const safeHostRightInset = Number.isFinite(hostRightInset)
        ? Math.min(Math.max(hostRightInset, 0), 48)
        : 0;
      const hostLineHeight = Number.parseFloat(hostStyle.lineHeight);
      const hostPaddingTop = Number.parseFloat(hostStyle.paddingTop);
      const firstLineCenter =
        (Number.isFinite(hostPaddingTop) ? Math.max(hostPaddingTop, 0) : 0) +
        (Number.isFinite(hostLineHeight) && hostLineHeight > 0
          ? hostLineHeight / 2
          : 12);
      return { firstLineCenter, safeHostRightInset };
    },

    createLineController(controller, line) {
      const lineController = {
        ...line,
        control: null,
        controller,
        lineControlObserved: false,
        lazyControlChunk: null,
        marked: false,
        peers: [],
        suppressPointerClick: false,
      };
      this.lineControllersByElement.set(line.element, lineController);
      return lineController;
    },

    materializeLineControl(lineController, layout, { disabled = false } = {}) {
      if (lineController.control?.isConnected) {
        return lineController.control;
      }
      lineController.control?.remove();
      lineController.control = null;

      const control = this.document.createElement("button");
      control.type = "button";
      control.className = "hunkmark-line-control";
      control.disabled = disabled;
      control.textContent = "Viewed";
      control.title = "Mark this code line as viewed";
      control.setAttribute("aria-label", "Mark this code line as viewed");
      control.setAttribute("aria-pressed", "false");
      control.setAttribute("data-hunkmark-ui", "true");

      const { firstLineCenter, safeHostRightInset } = layout;
      lineController.element.style.setProperty(
        "--hunkmark-host-line-action-inset",
        `${safeHostRightInset}px`,
      );
      lineController.element.style.setProperty(
        "--hunkmark-first-line-center",
        `${firstLineCenter}px`,
      );
      lineController.element.classList.add("hunkmark-line-cell");
      lineController.element.append(control);
      lineController.control = control;
      lineController.controller.materializedLazyLines?.add(lineController);
      this.applyLineAppearance(lineController);
      return control;
    },

    materializeControllerLineControls(
      controller,
      lineLayouts = null,
      options = {},
    ) {
      const missingLines = controller.lines.filter(
        (line) => !line.control?.isConnected,
      );
      if (missingLines.length === 0) {
        return;
      }
      const disabledStates = missingLines.map(
        (line) => line.control?.disabled ?? options.disabled ?? false,
      );
      missingLines.forEach((line) => {
        line.control?.remove();
        line.control = null;
      });

      // Batch every style read ahead of the DOM writes below.
      const layouts =
        lineLayouts ??
        missingLines.map((line) => this.measureLineHostLayout(line));
      missingLines.forEach((line, index) =>
        this.materializeLineControl(line, layouts[index], {
          disabled: disabledStates[index],
        }),
      );
    },

    lineControlVisibilityObserverInstance() {
      if (this.lineControlVisibilityObserver) {
        return this.lineControlVisibilityObserver;
      }
      if (typeof this.window.IntersectionObserver !== "function") {
        return null;
      }

      this.lineControlVisibilityObserver =
        new this.window.IntersectionObserver(
          (entries) => {
            const visibleLines = new Set();
            entries.forEach((entry) => {
              if (!entry.isIntersecting) {
                return;
              }
              const line = this.lineControllersByElement.get(entry.target);
              if (!line || line.controller.destroyed) {
                this.lineControlVisibilityObserver?.unobserve(entry.target);
                if (line) {
                  line.lineControlObserved = false;
                  line.controller.observedLazyLines.delete(line);
                }
                return;
              }
              this.lineControlVisibilityObserver?.unobserve(line.element);
              line.lineControlObserved = false;
              line.controller.observedLazyLines.delete(line);
              if (
                line.controller.collapsed ||
                !line.controller.lazyLineControls
              ) {
                return;
              }
              (line.lazyControlChunk ?? [line]).forEach((chunkLine) => {
                if (
                  chunkLine.element.isConnected &&
                  !chunkLine.control?.isConnected
                ) {
                  visibleLines.add(chunkLine);
                }
              });
            });

            // Preserve the read-before-write batching used for eager controls,
            // but only for lines that are close enough to be interacted with.
            const lines = Array.from(visibleLines);
            const layouts = lines.map((line) =>
              this.measureLineHostLayout(line),
            );
            lines.forEach((line, index) =>
              this.materializeLineControl(line, layouts[index], {
                disabled: line.controller.input.disabled,
              }),
            );
          },
          { rootMargin: "800px 0px" },
        );
      return this.lineControlVisibilityObserver;
    },

    observeLazyControllerLineControls(controller) {
      const observer = this.lineControlVisibilityObserverInstance();
      if (!observer) {
        controller.lazyLineControls = false;
        controller.materializedLazyLines = null;
        this.materializeControllerLineControls(controller, null, {
          disabled: controller.input.disabled,
        });
        return;
      }
      const chunkSize = this.constants.LAZY_LINE_CONTROL_CHUNK_SIZE;
      // Observe one midpoint per small line chunk instead of every changed
      // line. Entering that region materializes the whole chunk, preserving
      // nearby controls while keeping file reveal/hide work sublinear.
      for (
        let start = 0;
        start < controller.lines.length;
        start += chunkSize
      ) {
        const chunk = controller.lines.slice(start, start + chunkSize);
        if (chunk.every((line) => line.control?.isConnected)) {
          continue;
        }
        const line = chunk[Math.floor(chunk.length / 2)];
        line.lazyControlChunk = chunk;
        if (line.lineControlObserved) {
          continue;
        }
        line.lineControlObserved = true;
        controller.observedLazyLines.add(line);
        observer.observe(line.element);
      }
    },

    unobserveLazyControllerLineControls(controller) {
      controller.observedLazyLines.forEach((line) => {
        this.lineControlVisibilityObserver?.unobserve(line.element);
        line.lineControlObserved = false;
      });
      controller.observedLazyLines.clear();
    },

    lineControllerForControlEvent(event) {
      const control =
        event.target instanceof this.window.Element
          ? event.target.closest(".hunkmark-line-control")
          : null;
      const lineController = control
        ? this.lineControllersByElement.get(control.parentElement)
        : null;
      return lineController?.control === control ? lineController : null;
    },

    handleLineControlClick(event) {
      const lineController = this.lineControllerForControlEvent(event);
      if (!lineController) {
        return;
      }
      event.stopPropagation();
      if (
        lineController.control.disabled ||
        lineController.suppressPointerClick
      ) {
        event.preventDefault();
        return;
      }
      void this.setLineViewed(lineController, !lineController.marked);
    },

    handleLineControlPointerDown(event) {
      const lineController = this.lineControllerForControlEvent(event);
      if (!lineController) {
        return;
      }
      event.stopPropagation();
      if (
        event.button !== 0 ||
        lineController.control.disabled ||
        (event.pointerType !== "mouse" && event.pointerType !== "pen")
      ) {
        return;
      }
      event.preventDefault();
      lineController.suppressPointerClick = true;
      this.startLineDrag(
        lineController,
        !lineController.marked,
        event.pointerId,
      );
    },

    controllerAppearanceMatchesRows(controller) {
      if (!controller.collapsed) {
        const controlledLines = controller.lazyLineControls
          ? controller.materializedLazyLines
          : controller.lines;
        for (const line of controlledLines) {
          if (!line.control?.isConnected) {
            return false;
          }
        }
      }
      if (
        controller.groupRows.some((row) => {
          const shouldCollapse =
            controller.collapsed && row !== controller.hunkRow;
          return (
            row.classList.contains("hunkmark-collapsed") !== shouldCollapse
          );
        })
      ) {
        return false;
      }
      return controller.lines.every((line) => {
        const dragPreviewActive = Boolean(this.dragState?.touched.has(line));
        return (
          line.element.classList.contains("hunkmark-line-viewed") ===
          (line.marked && !dragPreviewActive)
        );
      });
    },

    updateControllerRows(controller, nextRows) {
      if (
        controller.groupRows.length === nextRows.length &&
        controller.groupRows.every((row, index) => row === nextRows[index]) &&
        this.controllerAppearanceMatchesRows(controller)
      ) {
        return;
      }

      const previousRows = new Set(controller.groupRows);
      const nextRowSet = new Set(nextRows);
      const hostRevealedRows =
        controller.collapsed &&
        nextRows.some((row) => !previousRows.has(row));

      controller.groupRows.forEach((row) => {
        if (!nextRowSet.has(row)) {
          row.classList.remove("hunkmark-collapsed");
        }
      });

      controller.groupRows = nextRows;
      if (hostRevealedRows) {
        void this.setCollapsed(controller, false);
      } else {
        this.applyControllerAppearance(controller);
      }
    },

    applyControllerAppearance(controller) {
      if (controller.destroyed) {
        return;
      }
      if (!controller.collapsed && controller.lazyLineControls) {
        this.observeLazyControllerLineControls(controller);
      } else if (!controller.collapsed) {
        this.materializeControllerLineControls(controller, null, {
          disabled: controller.input.disabled,
        });
      } else if (controller.lazyLineControls) {
        this.unobserveLazyControllerLineControls(controller);
      }
      controller.input.checked = controller.marked;
      controller.input.indeterminate = controller.indeterminate;
      controller.label.classList.toggle("is-viewed", controller.marked);
      controller.label.classList.toggle("is-partial", controller.indeterminate);
      const collapseText = controller.collapsed ? "Expand" : "Collapse";
      const collapseTitle = controller.collapsed
        ? "Expand this diff hunk"
        : "Collapse this diff hunk";
      if (controller.collapseButton.textContent !== collapseText) {
        controller.collapseButton.textContent = collapseText;
      }
      if (controller.collapseButton.title !== collapseTitle) {
        controller.collapseButton.title = collapseTitle;
      }
      controller.collapseButton.disabled = controller.collapsePending;

      controller.groupRows.forEach((row) => {
        const isHeader = row === controller.hunkRow;
        row.classList.toggle(
          "hunkmark-collapsed",
          controller.collapsed && !isHeader,
        );
      });
      controller.lines.forEach((line) => this.applyLineAppearance(line));
    },

    applyLineAppearance(lineController) {
      const dragPreviewActive = Boolean(
        this.dragState?.touched.has(lineController),
      );
      lineController.element.classList.toggle(
        "hunkmark-line-viewed",
        lineController.marked && !dragPreviewActive,
      );
      if (!lineController.control) {
        return;
      }
      lineController.control.setAttribute(
        "aria-pressed",
        String(lineController.marked),
      );
      lineController.control.classList.toggle(
        "is-viewed",
        lineController.marked,
      );
    },

    updateAggregateFromLines(controller) {
      const state = this.Core.aggregateLineState(
        controller.lines.map((line) => line.marked),
        controller.marked,
      );
      controller.marked = state.marked;
      controller.indeterminate = state.indeterminate;
    },

    reviewControllerIsCurrent(controller) {
      return (
        !this.stopped &&
        controller?.hunkRow?.isConnected &&
        this.controllersByRow.get(controller.hunkRow) === controller
      );
    },

    applyStoredReviewState(controller, stored) {
      controller.collapsed = Boolean(stored[controller.collapsedKey]);
      controller.marked =
        controller.lines.length === 0 && Boolean(stored[controller.key]);
      controller.indeterminate = false;
      let invalidatedLineReview = false;
      controller.lines.forEach((line) => {
        const storedLineReview = stored[line.key];
        line.marked = this.storedLineReviewMatches(
          line,
          storedLineReview,
        );
        invalidatedLineReview ||= (
          storedLineReview !== undefined && !line.marked
        );
      });
      this.updateAggregateFromLines(controller);
      if (invalidatedLineReview) {
        controller.collapsed = false;
      }
      this.applyControllerAppearance(controller);
    },

    async reconcileReviewControllersFromStorage(controllers) {
      const requestedControllers = [...new Set(controllers)];
      return this.withReviewStorageLock(async () => {
        const currentControllers = requestedControllers.filter((controller) =>
          this.reviewControllerIsCurrent(controller),
        );
        if (currentControllers.length === 0) {
          return false;
        }

        const keys = [
          ...new Set(
            currentControllers.flatMap(
              (controller) => controller.reviewKeys,
            ),
          ),
        ];
        const stored = await this.getLocalStorage(keys);
        this.applyReviewStorageKeyChanges(
          Object.fromEntries(
            keys.map((key) => [
              key,
              { newValue: stored[key] },
            ]),
          ),
        );

        const reconciledControllers = currentControllers.filter((controller) =>
          this.reviewControllerIsCurrent(controller),
        );
        reconciledControllers.forEach((controller) =>
          this.applyStoredReviewState(controller, stored),
        );
        if (reconciledControllers.length > 0) {
          this.updateProgress();
          return true;
        }
        return false;
      });
    },

    async reconcileReviewControllersAfterFailure(
      controllers,
      error,
      warning,
    ) {
      if (this.stopForInvalidatedContext(error)) {
        return false;
      }

      let reconciliationError = null;
      let reconciled = false;
      try {
        reconciled =
          await this.reconcileReviewControllersFromStorage(controllers);
      } catch (nextError) {
        if (this.stopForInvalidatedContext(nextError)) {
          return false;
        }
        reconciliationError = nextError;
      }

      const details = {};
      if (error?.reviewStorageRollbackError) {
        details.rollbackError = error.reviewStorageRollbackError;
      }
      if (reconciliationError) {
        details.reconciliationError = reconciliationError;
      }
      if (Object.keys(details).length > 0) {
        console.warn(warning, error, details);
      } else {
        console.warn(warning, error);
      }
      return reconciled;
    },

    applyViewedCollapseTransition(controller, wasViewed) {
      if (!wasViewed && controller.marked && this.autoCollapseViewed) {
        controller.collapsed = true;
        return "collapse";
      }
      if (wasViewed && !controller.marked) {
        controller.collapsed = false;
        return "expand";
      }
      return null;
    },

    async setCollapsed(controller, collapsed) {
      controller.collapsed = collapsed;
      controller.collapsePending = true;
      this.applyControllerAppearance(controller);

      try {
        if (collapsed) {
          await this.setReviewStorage({
            [controller.collapsedKey]: {
              collapsed: true,
              updatedAt: Date.now(),
            },
          });
        } else {
          await this.removeReviewStorage(controller.collapsedKey);
        }
      } catch (error) {
        await this.reconcileReviewControllersAfterFailure(
          [controller],
          error,
          "HunkMark could not save collapsed state.",
        );
      } finally {
        if (!this.stopped) {
          controller.collapsePending = false;
          this.applyControllerAppearance(controller);
        }
      }
    },

    async setHunkViewed(controller, viewed) {
      const wasViewed = controller.marked;
      controller.marked = viewed;
      controller.indeterminate = false;
      controller.lines.forEach((line) => {
        line.marked = viewed;
      });
      const collapseTransition = this.applyViewedCollapseTransition(
        controller,
        wasViewed,
      );
      controller.collapsePending = Boolean(collapseTransition);
      this.applyControllerAppearance(controller);
      this.updateProgress();

      controller.input.disabled = true;
      const officialViewedPendingKeys =
        this.beginOfficialViewedReviewPersistence([controller]);
      let reviewStateKnown = true;
      try {
        let reviewMutation;
        if (viewed) {
          const viewedAt = Date.now();
          const values = {};
          if (controller.lines.length === 0) {
            values[controller.key] = { viewedAt };
          }
          controller.lines.forEach((line) => {
            values[line.key] = this.lineReviewStorageValue(line, viewedAt);
          });
          if (collapseTransition === "collapse") {
            values[controller.collapsedKey] = {
              autoCollapsed: true,
              collapsed: true,
              updatedAt: viewedAt,
            };
          }
          reviewMutation = {
            values,
            scope: this.currentReviewScope,
            now: viewedAt,
          };
        } else {
          reviewMutation = {
            removals: controller.reviewKeys,
          };
        }
        await this.mutateReviewStorageAndReleaseOfficialViewed(
          [controller],
          reviewMutation,
        );
      } catch (error) {
        reviewStateKnown =
          await this.reconcileReviewControllersAfterFailure(
            [controller],
            error,
            "HunkMark could not save a mark.",
          );
      } finally {
        this.endOfficialViewedReviewPersistence(
          officialViewedPendingKeys,
        );
        if (!this.stopped) {
          controller.input.disabled = false;
          controller.collapsePending = false;
          this.applyControllerAppearance(controller);
          if (reviewStateKnown) {
            this.syncOfficialViewedForControllers([controller]);
          }
        }
      }
    },

    async setLineViewed(lineController, viewed) {
      const affectedLines = this.interactionLines(lineController);
      const affectedControllers = new Set(
        affectedLines.map((line) => line.controller),
      );
      const previousControllers = new Map(
        Array.from(affectedControllers, (affectedController) => [
          affectedController,
          {
            marked: affectedController.marked,
          },
        ]),
      );
      affectedLines.forEach((line) => {
        line.marked = viewed;
      });
      affectedControllers.forEach((affectedController) => {
        this.updateAggregateFromLines(affectedController);
        const previous = previousControllers.get(affectedController);
        previous.collapseTransition = this.applyViewedCollapseTransition(
          affectedController,
          previous.marked,
        );
        affectedController.collapsePending = Boolean(
          previous.collapseTransition,
        );
        this.applyControllerAppearance(affectedController);
      });
      this.updateProgress();

      affectedLines.forEach((line) => {
        if (line.control) {
          line.control.disabled = true;
        }
      });
      const officialViewedPendingKeys =
        this.beginOfficialViewedReviewPersistence(affectedControllers);
      let reviewStateKnown = true;
      try {
        const viewedAt = Date.now();
        const values = {};
        const removals = new Set();
        if (!viewed) {
          affectedLines.forEach((line) => removals.add(line.key));
          affectedControllers.forEach((affectedController) => {
            removals.add(affectedController.key);
          });
        } else {
          affectedLines.forEach((line) => {
            values[line.key] =
              this.lineReviewStorageValue(line, viewedAt);
          });
          affectedControllers.forEach((affectedController) => {
            removals.add(affectedController.key);
          });
        }
        affectedControllers.forEach((affectedController) => {
          const previous = previousControllers.get(affectedController);
          if (previous.collapseTransition === "collapse") {
            values[affectedController.collapsedKey] = {
              autoCollapsed: true,
              collapsed: true,
              updatedAt: viewedAt,
            };
          } else if (previous.collapseTransition === "expand") {
            removals.add(affectedController.collapsedKey);
          }
        });
        await this.mutateReviewStorageAndReleaseOfficialViewed(
          affectedControllers,
          {
            values,
            removals: Array.from(removals),
            scope: this.currentReviewScope,
            now: viewedAt,
          },
        );
      } catch (error) {
        reviewStateKnown =
          await this.reconcileReviewControllersAfterFailure(
            affectedControllers,
            error,
            "HunkMark could not save a line mark.",
          );
      } finally {
        this.endOfficialViewedReviewPersistence(
          officialViewedPendingKeys,
        );
        if (!this.stopped) {
          affectedControllers.forEach((affectedController) => {
            affectedController.collapsePending = false;
            this.applyControllerAppearance(affectedController);
          });
          affectedLines.forEach((line) => {
            if (line.control) {
              line.control.disabled = false;
            }
          });
          if (reviewStateKnown) {
            this.syncOfficialViewedForControllers(affectedControllers);
          }
        }
      }
    },

    destroyLineController(lineController) {
      if (lineController.lineControlObserved) {
        this.lineControlVisibilityObserver?.unobserve(
          lineController.element,
        );
        lineController.lineControlObserved = false;
        lineController.controller.observedLazyLines.delete(lineController);
      }
      this.lineControllersByElement.delete(lineController.element);
      lineController.element?.classList.remove(
        "hunkmark-line-cell",
        "hunkmark-line-viewed",
      );
      lineController.element?.style.removeProperty(
        "--hunkmark-host-line-action-inset",
      );
      lineController.element?.style.removeProperty(
        "--hunkmark-first-line-center",
      );
      lineController.element?.classList.remove("hunkmark-line-drag-touched");
      lineController.control?.remove();
      lineController.controller.materializedLazyLines?.delete(
        lineController,
      );
    },

    destroyController(controller) {
      controller.destroyed = true;
      if (controller.groupRows.every((row) => !row.isConnected)) {
        this.unobserveLazyControllerLineControls(controller);
        this.controllersByRow.delete(controller.hunkRow);
        return;
      }
      controller.groupRows.forEach((row) => {
        row.classList.remove("hunkmark-collapsed");
      });
      controller.lines.forEach((line) => this.destroyLineController(line));
      controller.hunkCell?.classList.remove("hunkmark-hunk-cell");
      controller.actions?.remove();
      this.controllersByRow.delete(controller.hunkRow);
    },

    cleanupExtensionElements() {
      if (this.dragState) {
        void this.finishLineDrag(false);
      }
      Array.from(this.controllersByRow.values()).forEach((controller) =>
        this.destroyController(controller),
      );
      this.document
        .querySelectorAll(".hunkmark-file-progress")
        .forEach((element) => element.remove());
      this.finishAllFileRevealPrepaintRestores();
      this.fileDiffVisibilityPending.forEach((expectation, fileElement) =>
        this.cancelExpectedFileDiffVisibility(fileElement, expectation),
      );
      this.fileRevealRestorePending.clear();
      this.fileProgressStateByKey.clear();
      this.filePathByElement = new WeakMap();
      this.lineControlVisibilityObserver?.disconnect();
      this.lineControlVisibilityObserver = null;
      this.removePanel();
      this.document
        .getElementById(this.constants.RECONNECT_NOTICE_ID)
        ?.remove();
    },
  });
})(globalThis);
