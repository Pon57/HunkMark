(function attachHunkMarkControllers(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    createController(hunk) {
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
      hunk.hunkCell.classList.add("hunkmark-hunk-cell");
      hunk.hunkCell.append(actions);

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
        lines: [],
        marked: false,
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
      this.connectSplitLinePeers(controller);

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

    createLineController(controller, line) {
      const label = this.document.createElement("label");
      label.className = "hunkmark-line-control";
      label.title = "Mark this code line as viewed";
      label.setAttribute("data-hunkmark-ui", "true");

      const input = this.document.createElement("input");
      input.type = "checkbox";
      input.disabled = true;
      input.setAttribute("aria-label", "Mark this code line as viewed");

      const text = this.document.createElement("span");
      text.textContent = "Viewed";
      label.append(input, text);

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
      line.element.style.setProperty(
        "--hunkmark-host-line-action-inset",
        `${safeHostRightInset}px`,
      );
      line.element.style.setProperty(
        "--hunkmark-first-line-center",
        `${firstLineCenter}px`,
      );
      line.element.classList.add("hunkmark-line-cell");
      line.element.append(label);

      const lineController = {
        ...line,
        controller,
        input,
        label,
        marked: false,
        peers: [],
        suppressPointerClick: false,
      };
      this.lineControllersByElement.set(line.element, lineController);
      label.addEventListener("click", (event) => {
        event.stopPropagation();
        if (lineController.suppressPointerClick) {
          event.preventDefault();
        }
      });
      label.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        if (
          event.button !== 0 ||
          lineController.input.disabled ||
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
      });
      input.addEventListener("change", () => {
        void this.setLineViewed(lineController, input.checked);
      });
      return lineController;
    },

    updateControllerRows(controller, nextRows) {
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
      lineController.input.checked = lineController.marked;
      lineController.label.classList.toggle(
        "is-viewed",
        lineController.marked,
      );
      lineController.element.classList.toggle(
        "hunkmark-line-viewed",
        lineController.marked && !dragPreviewActive,
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
      const previous = controller.collapsed;
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
          await this.chrome.storage.local.remove(controller.collapsedKey);
        }
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          controller.collapsed = previous;
          this.applyControllerAppearance(controller);
          console.warn("HunkMark could not save collapsed state.", error);
        }
      } finally {
        if (!this.stopped) {
          controller.collapsePending = false;
          this.applyControllerAppearance(controller);
        }
      }
    },

    async setHunkViewed(controller, viewed) {
      const previous = {
        collapsed: controller.collapsed,
        indeterminate: controller.indeterminate,
        lineMarks: controller.lines.map((line) => line.marked),
        marked: controller.marked,
      };
      controller.marked = viewed;
      controller.indeterminate = false;
      controller.lines.forEach((line) => {
        line.marked = viewed;
      });
      const collapseTransition = this.applyViewedCollapseTransition(
        controller,
        previous.marked,
      );
      controller.collapsePending = Boolean(collapseTransition);
      this.applyControllerAppearance(controller);
      this.updateProgress();

      controller.input.disabled = true;
      try {
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
          await this.setReviewStorage(values, this.currentReviewScope, viewedAt);
        } else {
          await this.chrome.storage.local.remove([
            controller.key,
            controller.collapsedKey,
            ...controller.lines.map((line) => line.key),
          ]);
        }
        this.releaseOfficialViewedSuppression([controller]);
        this.syncOfficialViewedForControllers([controller]);
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          controller.collapsed = previous.collapsed;
          controller.marked = previous.marked;
          controller.indeterminate = previous.indeterminate;
          controller.lines.forEach((line, index) => {
            line.marked = previous.lineMarks[index];
          });
          this.applyControllerAppearance(controller);
          this.updateProgress();
          console.warn("HunkMark could not save a mark.", error);
        }
      } finally {
        if (!this.stopped) {
          controller.input.disabled = false;
          controller.collapsePending = false;
          this.applyControllerAppearance(controller);
        }
      }
    },

    async setLineViewed(lineController, viewed) {
      const affectedLines = this.interactionLines(lineController);
      const affectedControllers = new Set(
        affectedLines.map((line) => line.controller),
      );
      const previousLines = new Map(
        affectedLines.map((line) => [line, line.marked]),
      );
      const previousControllers = new Map(
        Array.from(affectedControllers, (affectedController) => [
          affectedController,
          {
            collapsed: affectedController.collapsed,
            indeterminate: affectedController.indeterminate,
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
        line.input.disabled = true;
      });
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
            values[line.key] = this.lineReviewStorageValue(line, viewedAt);
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
        Object.keys(values).forEach((key) => removals.delete(key));
        if (Object.keys(values).length > 0) {
          await this.setReviewStorage(
            values,
            this.currentReviewScope,
            viewedAt,
          );
        }
        if (removals.size > 0) {
          await this.chrome.storage.local.remove(Array.from(removals));
        }
        this.releaseOfficialViewedSuppression(affectedControllers);
        this.syncOfficialViewedForControllers(affectedControllers);
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          previousLines.forEach((marked, line) => {
            line.marked = marked;
          });
          previousControllers.forEach((state, affectedController) => {
            affectedController.collapsed = state.collapsed;
            affectedController.marked = state.marked;
            affectedController.indeterminate = state.indeterminate;
            this.applyControllerAppearance(affectedController);
          });
          this.updateProgress();
          console.warn("HunkMark could not save a line mark.", error);
        }
      } finally {
        if (!this.stopped) {
          affectedControllers.forEach((affectedController) => {
            affectedController.collapsePending = false;
            this.applyControllerAppearance(affectedController);
          });
          affectedLines.forEach((line) => {
            line.input.disabled = false;
          });
        }
      }
    },

    destroyLineController(lineController) {
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
      lineController.label?.remove();
    },

    destroyController(controller) {
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
      this.fileExpandRestorePending.clear();
      this.fileProgressStateByKey.clear();
      this.removePanel();
      this.document
        .getElementById(this.constants.RECONNECT_NOTICE_ID)
        ?.remove();
    },
  });
})(globalThis);
