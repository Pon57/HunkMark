"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    hostContextExpansionItemsInDocumentOrder(items, filePath) {
      return items
        .filter((item) => item.filePath === filePath)
        .sort((left, right) => {
          if (
            left.hunkRow === right.hunkRow ||
            !left.hunkRow?.isConnected ||
            !right.hunkRow?.isConnected
          ) {
            return 0;
          }
          const position = left.hunkRow.compareDocumentPosition(right.hunkRow);
          if (position & this.window.Node.DOCUMENT_POSITION_FOLLOWING) {
            return -1;
          }
          if (position & this.window.Node.DOCUMENT_POSITION_PRECEDING) {
            return 1;
          }
          return 0;
        });
    },

    sameHostContextExpansionSequence(left, right) {
      return (
        left === right ||
        (Array.isArray(left) &&
          Array.isArray(right) &&
          left.length === right.length &&
          left.every((value, index) => value === right[index]))
      );
    },

    hostContextExpansionPreservesContextAnchors(captured, current) {
      if (captured === null) {
        return true;
      }
      if (!Array.isArray(captured) || !Array.isArray(current)) {
        return false;
      }
      let capturedIndex = 0;
      current.forEach((anchor) => {
        if (anchor === captured[capturedIndex]) {
          capturedIndex += 1;
        }
      });
      return capturedIndex === captured.length;
    },

    hostContextExpansionSourceControlStillPresent(
      intent,
      fileElements = [],
    ) {
      if (!intent?.source?.control) {
        return false;
      }

      const identity = intent.source.identity;
      if (
        intent.source.control.isConnected &&
        (!identity ||
          this.describeHostContextExpansionControl(intent.source.control)
            .identity ===
            identity)
      ) {
        return true;
      }
      if (!identity) {
        return false;
      }

      const matchingControlIn = (root) => {
        if (!root?.isConnected) {
          return false;
        }
        const controls = [];
        if (root.matches?.(this.constants.HUNK_EXPANSION_CONTROL_SELECTOR)) {
          controls.push(root);
        }
        controls.push(
          ...root.querySelectorAll(
            this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
          ),
        );
        return controls.some(
          (control) =>
            this.describeHostContextExpansionControl(control).identity ===
            identity,
        );
      };
      const roots = new Set([
        ...(intent.fileElements ?? []),
        ...fileElements,
      ]);
      if (Array.from(roots).some(matchingControlIn)) {
        return true;
      }

      return Boolean(
        intent.source.expandsWholeFile &&
          Array.from(
            this.document.querySelectorAll(
              this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
            ),
          ).some(
            (control) => {
              const description =
                this.describeHostContextExpansionControl(control);
              return (
                description.identity === identity &&
                description.filePath === intent.filePath
              );
            },
          ),
      );
    },

    hostContextExpansionControllersForControl(description) {
      const { control, expandsWholeFile, fileElement, filePath } = description;
      const hunkRow = this.semanticRow(control);
      const directController =
        this.controllersByRow.get(hunkRow) ??
        Array.from(this.controllersByRow.values()).find((candidate) =>
          candidate.hunkRow.contains(control),
        );
      if (this.reviewControllerIsCurrent(directController)) {
        const controllers = [directController];
        // GitHub places a gap control in the following hunk row, while a
        // directional expansion grows the preceding hunk until they merge.
        let precedingRow = directController.hunkRow.previousElementSibling;
        while (precedingRow) {
          const precedingController = this.controllersByRow.get(precedingRow);
          if (
            this.reviewControllerIsCurrent(precedingController) &&
            precedingController.filePath === directController.filePath
          ) {
            controllers.push(precedingController);
            break;
          }
          precedingRow = precedingRow.previousElementSibling;
        }
        return controllers;
      }

      // Current React diffs render the final "Expand file down" control in
      // its own diff-line-row after the last hunk. That row has no @@ header,
      // so discovery intentionally does not create a controller for it. Map
      // standalone boundary rows to the nearest controllers in the same file;
      // this also keeps a standalone between-hunk row scoped to both sides.
      const adjacentController = (property) => {
        let row = hunkRow?.[property] ?? null;
        while (row) {
          const candidate = this.controllersByRow.get(row);
          const sameFile = Boolean(
            fileElement &&
              (candidate?.fileElement === fileElement ||
                candidate?.fileElement?.contains(control) ||
                fileElement.contains(candidate?.hunkRow)),
          );
          if (sameFile && this.reviewControllerIsCurrent(candidate)) {
            return candidate;
          }
          row = row[property];
        }
        return null;
      };
      const adjacentControllers = [
        adjacentController("nextElementSibling"),
        adjacentController("previousElementSibling"),
      ].filter(
        (candidate, index, candidates) =>
          candidate && candidates.indexOf(candidate) === index,
      );
      if (adjacentControllers.length > 0) {
        return adjacentControllers;
      }
      if (!expandsWholeFile) {
        return [];
      }

      return Array.from(this.controllersByRow.values()).filter(
        (candidate) =>
          this.reviewControllerIsCurrent(candidate) &&
          ((filePath && candidate.filePath === filePath) ||
            candidate.fileElement?.contains(control)),
      );
    },

    hostContextExpansionControllersMatchDisplayedFile(filePath) {
      const currentControllers = Array.from(
        this.controllersByRow.values(),
      ).filter(
        (controller) =>
          controller.filePath === filePath &&
          this.reviewControllerIsCurrent(controller),
      );
      if (currentControllers.length === 0) {
        return false;
      }

      const controllersByFileElement = new Map();
      currentControllers.forEach((controller) => {
        const controllers =
          controllersByFileElement.get(controller.fileElement) ?? [];
        controllers.push(controller);
        controllersByFileElement.set(controller.fileElement, controllers);
      });

      return Array.from(controllersByFileElement).every(
        ([fileElement, controllers]) => {
          if (!fileElement?.isConnected) {
            return false;
          }
          const displayedHunks = this.discoverCachedHunks(fileElement);
          if (!displayedHunks) {
            return false;
          }
          const displayedByRow = new Map(
            displayedHunks
              .filter((hunk) => hunk.filePath === filePath)
              .map((hunk) => [hunk.hunkRow, hunk]),
          );
          return (
            displayedByRow.size === controllers.length &&
            controllers.every((controller) => {
              const displayed = displayedByRow.get(controller.hunkRow);
              if (
                !displayed ||
                !this.controllerMatchesHunk(controller, displayed) ||
                displayed.groupRows.length !== controller.groupRows.length ||
                !displayed.groupRows.every(
                  (row, index) => row === controller.groupRows[index],
                )
              ) {
                return false;
              }
              return this.sameHostContextExpansionSequence(
                controller.hostContextExpansionContextAnchors,
                this.hostContextExpansionContextAnchorsForRows(
                  fileElement,
                  displayed.groupRows,
                  displayed.lines,
                ),
              );
            })
          );
        },
      );
    },

    hostContextExpansionMutationFilePaths(
      mutations,
      expectedFileElements = new Set(),
    ) {
      const legacyFileElements = Array.from(
        this.document.querySelectorAll(this.constants.FILE_CONTAINER_SELECTOR),
      );
      const filePathsByElement = new Map();
      const filePathForElement = (fileElement) => {
        const knownPath =
          filePathsByElement.get(fileElement) ??
          this.knownFilePath(fileElement);
        if (knownPath || !fileElement.isConnected) {
          return knownPath ?? null;
        }
        const fallbackIndex = legacyFileElements.indexOf(fileElement);
        return fallbackIndex >= 0
          ? this.resolveFilePath(fileElement, fallbackIndex)
          : null;
      };
      const rememberKnownFile = (fileElement, filePath = null) => {
        if (!(fileElement instanceof this.window.Element)) {
          return;
        }
        const resolvedPath = filePath ?? filePathForElement(fileElement);
        if (resolvedPath) {
          filePathsByElement.set(fileElement, resolvedPath);
        }
      };
      this.controllersByRow.forEach((controller) =>
        rememberKnownFile(controller.fileElement, controller.filePath),
      );
      this.hostContextExpansionIntents.forEach((intent) =>
        intent.fileElements?.forEach((fileElement) =>
          rememberKnownFile(fileElement, intent.filePath),
        ),
      );
      expectedFileElements.forEach((fileElement) =>
        rememberKnownFile(fileElement),
      );

      const filePaths = new Set();
      expectedFileElements.forEach((fileElement) => {
        const filePath = filePathForElement(fileElement);
        if (filePath) {
          filePaths.add(filePath);
        }
      });
      const rememberFilePaths = (node) => {
        const element =
          node?.nodeType === this.window.Node.ELEMENT_NODE
            ? node
            : node?.parentElement;
        if (!(element instanceof this.window.Element)) {
          return false;
        }

        let found = false;
        filePathsByElement.forEach((filePath, fileElement) => {
          if (
            element === fileElement ||
            fileElement.contains(element) ||
            element.contains(fileElement)
          ) {
            filePaths.add(filePath);
            found = true;
          }
        });

        const closestFile = element.matches(
          this.constants.FILE_CONTAINER_SELECTOR,
        )
          ? element
          : element.closest(this.constants.FILE_CONTAINER_SELECTOR);
        if (closestFile) {
          const filePath = filePathForElement(closestFile);
          if (filePath) {
            filePaths.add(filePath);
            found = true;
          }
        }
        const nestedFiles = element.querySelectorAll(
          this.constants.FILE_CONTAINER_SELECTOR,
        );
        nestedFiles.forEach((fileElement) => {
          const filePath = filePathForElement(fileElement);
          if (filePath) {
            filePaths.add(filePath);
            found = true;
          }
        });
        return found;
      };

      let unresolvedMutation = false;
      mutations.forEach((mutation) => {
        let resolved = rememberFilePaths(mutation.target);
        [...mutation.addedNodes, ...mutation.removedNodes].forEach((node) => {
          resolved = rememberFilePaths(node) || resolved;
        });
        unresolvedMutation ||= !resolved;
      });
      return unresolvedMutation ? null : filePaths;
    },
  });
}
