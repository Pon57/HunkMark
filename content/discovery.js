(function attachHunkMarkDiscovery(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    cleanElementText(element) {
      if (!element) {
        return "";
      }

      const clone = element.cloneNode(true);
      clone
        .querySelectorAll('[data-hunkmark-ui], .hunkmark-file-progress')
        .forEach((control) => control.remove());
      return clone.textContent ?? "";
    },

    extensionOwnsNode(node) {
      const { Element, Node } = this.window;
      const element =
        node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!(element instanceof Element)) {
        return false;
      }

      const selector = [
        "[data-hunkmark-ui]",
        ".hunkmark-file-progress",
        `#${this.constants.PANEL_ID}`,
        `#${this.constants.PANEL_SPACER_ID}`,
      ].join(", ");
      return element.matches(selector) || Boolean(element.closest(selector));
    },

    mutationIsExtensionOnly(mutation) {
      if (this.extensionOwnsNode(mutation.target)) {
        return true;
      }

      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
      return (
        changedNodes.length > 0 &&
        changedNodes.every((node) => this.extensionOwnsNode(node))
      );
    },

    mutationAffectsDiff(mutation) {
      const elementForNode = (node) => {
        const element =
          node?.nodeType === this.window.Node.ELEMENT_NODE
            ? node
            : node?.parentElement;
        return element instanceof this.window.Element ? element : null;
      };
      const target = elementForNode(mutation.target);
      if (
        target &&
        (target.matches(this.constants.FILE_CONTAINER_SELECTOR) ||
          target.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
          target.matches(this.constants.ROW_CANDIDATE_SELECTOR) ||
          target.closest(this.constants.FILE_CONTAINER_SELECTOR))
      ) {
        return true;
      }

      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
        const element = elementForNode(node);
        if (!element) {
          return false;
        }
        return Boolean(
          element.matches(this.constants.FILE_CONTAINER_SELECTOR) ||
            element.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
            element.matches(this.constants.ROW_CANDIDATE_SELECTOR) ||
            element.closest(this.constants.FILE_CONTAINER_SELECTOR) ||
            element.querySelector(this.constants.FILE_CONTAINER_SELECTOR) ||
            element.querySelector(this.constants.HUNK_ELEMENT_SELECTOR),
        );
      });
    },

    semanticRow(element) {
      return (
        element.closest("tr") ||
        element.closest('[role="row"]') ||
        element.closest('[data-testid="diff-line"]') ||
        element.closest('[data-testid^="diff-line-"]') ||
        element.closest("[data-line-type]") ||
        element.parentElement ||
        element
      );
    },

    findHunkMarkers(searchRoot) {
      const { Element, NodeFilter, Node } = this.window;
      const candidates = new Set();

      const addCandidate = (element) => {
        if (
          !(element instanceof Element) ||
          !this.Core.isHunkHeaderText(this.cleanElementText(element))
        ) {
          return;
        }

        const cell = element.closest('td, [role="gridcell"]');
        const semantic =
          cell && searchRoot.contains(cell)
            ? cell
            : element.closest(this.constants.HUNK_ELEMENT_SELECTOR) || element;

        if (searchRoot.contains(semantic)) {
          candidates.add(semantic);
        }
      };

      searchRoot
        .querySelectorAll(this.constants.HUNK_ELEMENT_SELECTOR)
        .forEach(addCandidate);

      if (candidates.size === 0) {
        const walker = this.document.createTreeWalker(
          searchRoot,
          NodeFilter.SHOW_TEXT,
        );
        let textNode = walker.nextNode();
        while (textNode) {
          const ignoredContainer = textNode.parentElement?.closest(
            "script, style, noscript, template",
          );
          if (
            !ignoredContainer &&
            this.Core.isHunkHeaderText(textNode.nodeValue)
          ) {
            addCandidate(textNode.parentElement);
          }
          textNode = walker.nextNode();
        }
      }

      return Array.from(candidates)
        .filter(
          (candidate, index, all) =>
            !all.some(
              (other, otherIndex) =>
                index !== otherIndex && candidate.contains(other),
            ),
        )
        .sort((left, right) => {
          if (left === right) {
            return 0;
          }
          return left.compareDocumentPosition(right) &
            Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1;
        });
    },

    stableHunkHeaderText(marker) {
      const headerContainers = marker.matches("code, pre")
        ? [marker]
        : Array.from(marker.querySelectorAll("code, pre"));
      for (const container of headerContainers) {
        const header = this.Core.findHunkHeader(this.cleanElementText(container));
        if (header) {
          return header;
        }
      }

      const walker = this.document.createTreeWalker(
        marker,
        this.window.NodeFilter.SHOW_TEXT,
      );
      let textNode = walker.nextNode();
      while (textNode) {
        const header = this.Core.findHunkHeader(textNode.nodeValue);
        if (header) {
          return header;
        }
        textNode = walker.nextNode();
      }
      return this.cleanElementText(marker);
    },

    findFileElement(marker, hunkRow) {
      return (
        hunkRow.closest(this.constants.FILE_CONTAINER_SELECTOR) ||
        marker.closest(this.constants.FILE_CONTAINER_SELECTOR) ||
        hunkRow.closest("article, details, section, [role=region]") ||
        hunkRow.closest("table") ||
        hunkRow.parentElement
      );
    },

    resolveFilePath(fileElement, fallbackIndex) {
      const directAttributes = [
        "data-tagsearch-path",
        "data-file-path",
        "data-path",
      ];
      for (const attribute of directAttributes) {
        const value = fileElement.getAttribute(attribute);
        if (this.Core.looksLikeFilePath(value)) {
          return value.trim();
        }
      }

      const pathElements = fileElement.querySelectorAll(
        [
          "[data-file-path]",
          ".file-header[data-path]",
          '[data-testid*="file-header"][data-path]',
          '[data-testid*="file-name"]',
          "clipboard-copy[value]",
          'a[href^="#diff-"]',
        ].join(", "),
      );

      for (const element of pathElements) {
        const values = [
          element.getAttribute("data-file-path"),
          element.getAttribute("data-path"),
          element.getAttribute("value"),
          element.getAttribute("title"),
          this.cleanElementText(element),
        ];
        const path = values.find((value) => this.Core.looksLikeFilePath(value));
        if (path) {
          return path.trim();
        }
      }

      const stableId = fileElement.id || fileElement.getAttribute("data-testid");
      return stableId
        ? `unknown-file:${stableId}`
        : `unknown-file:${fallbackIndex}`;
    },

    collectRows(fileElement) {
      const rows = new Set();
      fileElement
        .querySelectorAll(this.constants.ROW_CANDIDATE_SELECTOR)
        .forEach((element) => {
          const row = this.semanticRow(element);
          if (fileElement.contains(row)) {
            rows.add(row);
          }
        });
      return Array.from(rows).sort((left, right) => {
        if (left === right) {
          return 0;
        }
        return left.compareDocumentPosition(right) &
          this.window.Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1;
      });
    },

    rowsForHunk(fileRows, hunkRow, nextHunkRow, rowIndexes = null) {
      const startIndex = rowIndexes?.get(hunkRow) ?? fileRows.indexOf(hunkRow);
      if (startIndex >= 0) {
        const nextIndex = nextHunkRow
          ? (rowIndexes?.get(nextHunkRow) ?? fileRows.indexOf(nextHunkRow))
          : -1;
        return fileRows.slice(
          startIndex,
          nextIndex > startIndex ? nextIndex : undefined,
        );
      }

      if (
        hunkRow.parentElement &&
        hunkRow.parentElement === nextHunkRow?.parentElement
      ) {
        const siblings = Array.from(hunkRow.parentElement.children);
        return siblings.slice(
          siblings.indexOf(hunkRow),
          siblings.indexOf(nextHunkRow),
        );
      }

      return [hunkRow];
    },

    lineKind(element) {
      const subject = element.matches("[data-line-type]")
        ? element
        : element.querySelector(
            '[data-line-type], code.addition, code.deletion',
          );
      const tokens = [
        subject?.getAttribute("data-line-type"),
        subject?.className,
        element.className,
      ]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();

      if (/addition|added|insert/.test(tokens)) {
        return "addition";
      }
      if (/deletion|deleted|remove/.test(tokens)) {
        return "deletion";
      }
      return null;
    },

    lineSide(element) {
      const subject = element.matches("[data-diff-side]")
        ? element
        : element.querySelector("[data-diff-side]");
      const explicitSide = subject
        ?.getAttribute("data-diff-side")
        ?.toLowerCase();
      if (explicitSide === "left" || explicitSide === "right") {
        return explicitSide;
      }

      const tokens = [subject?.className, element.className]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
      if (/left-side|diff-side-left|\bleft\b/.test(tokens)) {
        return "left";
      }
      if (/right-side|diff-side-right|\bright\b/.test(tokens)) {
        return "right";
      }

      const cell = element.closest("td");
      const row = cell?.parentElement;
      const cells = row
        ? Array.from(row.children).filter((child) => child.matches("td"))
        : [];
      if (cell && cells.length >= 4) {
        return cells.indexOf(cell) < cells.length / 2 ? "left" : "right";
      }
      return "unified";
    },

    changedLineDescriptors(groupRows) {
      const changedLines = [];
      const seenElements = new Set();

      const addLine = (element, kind, textElement = element) => {
        if (!element || !kind || seenElements.has(element)) {
          return;
        }
        seenElements.add(element);
        changedLines.push({
          element,
          kind,
          row: this.semanticRow(element),
          side: this.lineSide(element),
          text: this.cleanElementText(textElement),
        });
      };

      groupRows.forEach((row) => {
        const legacyCells = row.querySelectorAll(
          "td.blob-code-addition, td.blob-code-deletion",
        );
        if (legacyCells.length > 0) {
          legacyCells.forEach((cell) => {
            addLine(cell, this.lineKind(cell));
          });
          return;
        }

        const modernCodeLines = row.querySelectorAll(
          "code.addition, code.deletion",
        );
        if (modernCodeLines.length > 0) {
          modernCodeLines.forEach((code) => {
            const cell = code.closest('td, [role="gridcell"]') || code;
            addLine(
              cell,
              this.lineKind(code) || this.lineKind(cell) || this.lineKind(row),
              code,
            );
          });
          return;
        }

        const kind = this.lineKind(row);
        if (kind) {
          const codeElement = row.querySelector(
            '[data-testid*="code"], [data-code-text], code, pre',
          );
          addLine(
            codeElement?.closest('td, [role="gridcell"]') ||
              codeElement ||
              row,
            kind,
            codeElement || row,
          );
        }
      });

      return changedLines;
    },

    contextLineDescriptors(row) {
      const legacyCells = row.querySelectorAll("td.blob-code-context");
      const dataCodeTextElements = row.querySelectorAll("[data-code-text]");
      const candidates =
        legacyCells.length > 0
          ? Array.from(legacyCells)
          : this.lineKind(row)
            ? []
            : dataCodeTextElements.length > 0
              ? Array.from(dataCodeTextElements)
              : Array.from(
                  row.querySelectorAll(
                    "code:not(.addition):not(.deletion), pre",
                  ),
                );

      return candidates
        .map((element) => ({
          side: this.lineSide(element),
          text:
            element.getAttribute("data-code-text") ??
            this.cleanElementText(element),
        }))
        .filter(
          ({ text }) =>
            text.length > 0 && !this.Core.isHunkHeaderText(text),
        );
    },

    reviewAnchorForContextRow(row) {
      return this.contextLineDescriptors(row)
        .map(
          ({ side, text }) =>
            `context:${side}:${this.Core.normalizeLineBreaks(text)}`,
        )
        .join("\n");
    },

    lineReviewContextFingerprints(groupRows, lineDescriptors, headerText) {
      const changedByRow = new Map();
      lineDescriptors.forEach((descriptor) => {
        const descriptors = changedByRow.get(descriptor.row) ?? [];
        descriptors.push(descriptor);
        changedByRow.set(descriptor.row, descriptors);
      });
      const contextAnchor = (start, step) => {
        for (
          let index = start;
          index >= 0 && index < groupRows.length;
          index += step
        ) {
          const anchor = this.reviewAnchorForContextRow(groupRows[index]);
          if (anchor) {
            return anchor;
          }
        }
        return "";
      };
      const fingerprints = new Map();

      for (let blockStart = 0; blockStart < groupRows.length; blockStart += 1) {
        if (!changedByRow.has(groupRows[blockStart])) {
          continue;
        }
        let blockEnd = blockStart;
        while (
          blockEnd + 1 < groupRows.length &&
          changedByRow.has(groupRows[blockEnd + 1])
        ) {
          blockEnd += 1;
        }

        const blockLines = groupRows
          .slice(blockStart, blockEnd + 1)
          .flatMap((row) => changedByRow.get(row) ?? []);
        const blockSignature = blockLines
          .map(
            (descriptor) =>
              `${descriptor.kind}:${descriptor.side}:${this.Core.normalizeLineBreaks(descriptor.text)}`,
          )
          .join("\n");
        const beforeAnchor = contextAnchor(blockStart - 1, -1);
        const afterAnchor = contextAnchor(blockEnd + 1, 1);
        blockLines.forEach((line, blockLineIndex) => {
          fingerprints.set(
            line,
            this.Core.lineReviewContextFingerprint({
              headerText,
              beforeAnchor,
              afterAnchor,
              blockSignature,
              blockLineIndex,
            }),
          );
        });
        blockStart = blockEnd;
      }

      return lineDescriptors.map((line) => fingerprints.get(line));
    },

    discoverHunks(searchRoot = this.document) {
      const groupedByFile = new Map();
      const fileRoots = Array.from(
        searchRoot.querySelectorAll(this.constants.FILE_CONTAINER_SELECTOR),
      ).filter(
        (candidate) =>
          candidate.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
          candidate.querySelector(this.constants.HUNK_ELEMENT_SELECTOR) ||
          this.Core.isHunkHeaderText(this.cleanElementText(candidate)),
      );
      const fileRootSet = new Set(fileRoots);
      const searchRoots = fileRoots.filter((candidate) => {
        const ancestor = candidate.parentElement?.closest(
          this.constants.FILE_CONTAINER_SELECTOR,
        );
        return !ancestor || !fileRootSet.has(ancestor);
      });
      const markers = new Set();
      (searchRoots.length > 0 ? searchRoots : [searchRoot]).forEach((rootNode) => {
        this.findHunkMarkers(rootNode).forEach((marker) => markers.add(marker));
      });

      Array.from(markers).forEach((marker) => {
        const hunkRow = this.semanticRow(marker);
        const fileElement = this.findFileElement(marker, hunkRow);
        if (!fileElement) {
          return;
        }

        const entries = groupedByFile.get(fileElement) ?? [];
        entries.push({ marker, hunkRow });
        groupedByFile.set(fileElement, entries);
      });

      const hunks = [];
      let fileIndex = 0;

      groupedByFile.forEach((entries, fileElement) => {
        const filePath = this.resolveFilePath(fileElement, fileIndex);
        const fileRows = this.collectRows(fileElement);
        const rowIndexes = new Map(
          fileRows.map((row, index) => [row, index]),
        );
        const occurrences = new Map();
        const lineOccurrences = new Map();
        fileIndex += 1;

        const preparedEntries = entries.map((entry, index) => {
          const nextEntry = entries[index + 1];
          const groupRows = this.rowsForHunk(
            fileRows,
            entry.hunkRow,
            nextEntry?.hunkRow,
            rowIndexes,
          );
          const headerText = this.stableHunkHeaderText(entry.marker);
          const lineDescriptors = this.changedLineDescriptors(groupRows);
          const lineFingerprints = lineDescriptors.map((line) =>
            this.Core.hashString(
              `${line.kind}\n${this.Core.normalizeLineBreaks(line.text)}`,
            ),
          );
          const lineContextFingerprints = this.lineReviewContextFingerprints(
            groupRows,
            lineDescriptors,
            headerText,
          );
          return {
            ...entry,
            groupRows,
            headerText,
            lineDescriptors,
            lineFingerprints,
            lineContextFingerprints,
          };
        });
        const lineTotals = new Map();
        preparedEntries.forEach((entry) => {
          entry.lineFingerprints.forEach((fingerprint) => {
            lineTotals.set(fingerprint, (lineTotals.get(fingerprint) ?? 0) + 1);
          });
        });

        preparedEntries.forEach((entry) => {
          const {
            groupRows,
            headerText,
            lineDescriptors,
            lineFingerprints,
            lineContextFingerprints,
          } = entry;
          const signature = this.Core.buildHunkSignature({
            headerText,
            changedLines: lineDescriptors,
          });
          const fingerprint = this.Core.hashString(`${filePath}\n${signature}`);
          const occurrence = occurrences.get(fingerprint) ?? 0;
          occurrences.set(fingerprint, occurrence + 1);
          const key = this.Core.storageKey(
            this.currentReviewScope,
            filePath,
            signature,
            occurrence,
          );
          const lines = lineDescriptors.map((line, index) => {
            const lineFingerprint = lineFingerprints[index];
            const lineOccurrence = lineOccurrences.get(lineFingerprint) ?? 0;
            lineOccurrences.set(lineFingerprint, lineOccurrence + 1);
            return {
              ...line,
              contextFingerprint: lineContextFingerprints[index],
              key: this.Core.lineStorageKey(
                this.currentReviewScope,
                filePath,
                line.kind,
                line.text,
                lineOccurrence,
                lineTotals.get(lineFingerprint),
              ),
            };
          });

          hunks.push({
            fileElement,
            filePath,
            groupRows,
            hunkCell: entry.marker,
            hunkRow: entry.hunkRow,
            key,
            lines,
          });
        });
      });

      return hunks;
    },
  });
})(globalThis);
