"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    cleanElementText(element) {
      if (!element) {
        return "";
      }

      const extensionUiSelector =
        '[data-hunkmark-ui], .hunkmark-file-progress';
      if (!element.querySelector(extensionUiSelector)) {
        return element.textContent ?? "";
      }

      const clone = element.cloneNode(true);
      clone
        .querySelectorAll(extensionUiSelector)
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

    knownLineControllerForMutationTarget(node) {
      const element =
        node?.nodeType === this.window.Node.ELEMENT_NODE
          ? node
          : node?.parentElement;
      if (!(element instanceof this.window.Element)) {
        return null;
      }

      const row = this.semanticRow(element);
      let current = element;
      while (current) {
        const lineController = this.lineControllersByElement.get(current);
        if (lineController) {
          return lineController;
        }
        if (current === row) {
          break;
        }
        current = current.parentElement;
      }
      return null;
    },

    mutationPreservesKnownLineIdentity(mutation) {
      const targetLine = this.knownLineControllerForMutationTarget(
        mutation.target,
      );
      const row = targetLine?.row;
      if (
        !targetLine ||
        targetLine.controller.destroyed ||
        !targetLine.element.isConnected ||
        !row?.isConnected
      ) {
        return false;
      }

      const expectedLines = targetLine.controller.lines.filter(
        (line) => line.row === row && line.element.isConnected,
      );
      if (
        expectedLines.some(
          (line) =>
            line.control &&
            (!line.control.isConnected ||
              !line.element.contains(line.control)),
        )
      ) {
        return false;
      }
      const currentLines = this.changedLineDescriptorsForRows([row]);
      if (
        expectedLines.length === 0 ||
        currentLines.length !== expectedLines.length
      ) {
        return false;
      }

      const expectedLineSet = new Set(expectedLines);
      return currentLines.every((line) => {
        const previous = this.lineControllersByElement.get(line.element);
        return (
          expectedLineSet.has(previous) &&
          previous.kind === line.kind &&
          previous.side === line.side &&
          previous.text === line.text
        );
      });
    },

    mutationPreservesUntrackedDiffCellIdentity(mutation) {
      const target =
        mutation.target?.nodeType === this.window.Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
      if (!(target instanceof this.window.Element)) {
        return false;
      }

      const cell = target.matches(".diff-text-cell")
        ? target
        : target.closest(".diff-text-cell");
      if (
        !cell?.isConnected ||
        !cell.closest(this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR) ||
        this.knownLineControllerForMutationTarget(target)
      ) {
        return false;
      }

      const identityContentSelector = "[data-code-text], code, pre";
      const identityContent = Array.from(
        cell.querySelectorAll(identityContentSelector),
      );
      if (
        identityContent.length === 0 ||
        target.matches(identityContentSelector) ||
        target.closest(identityContentSelector)
      ) {
        return false;
      }

      const structuralSelector = [
        identityContentSelector,
        this.constants.FILE_CONTAINER_SELECTOR,
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
        this.constants.HUNK_ELEMENT_SELECTOR,
        this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
        this.constants.ACTIVE_DIFF_LOADING_SELECTOR,
        this.constants.UNRESOLVED_DIFF_SELECTOR,
      ].join(", ");
      const changedNodes = [
        ...mutation.addedNodes,
        ...mutation.removedNodes,
      ];
      return (
        changedNodes.length > 0 &&
        changedNodes.every((node) => {
          if (node.nodeType !== this.window.Node.ELEMENT_NODE) {
            return true;
          }
          return (
            !node.matches(structuralSelector) &&
            !node.querySelector(structuralSelector)
          );
        })
      );
    },

    mutationPreservesFileAuxiliaryIdentity(mutation) {
      const target =
        mutation.target?.nodeType === this.window.Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
      if (!(target instanceof this.window.Element)) {
        return false;
      }

      const fileRegion = target.matches(
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
      )
        ? target
        : target.closest(
            this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
          );
      if (!fileRegion?.isConnected || target === fileRegion) {
        return false;
      }
      const diffGrid = this.currentFileDiffGrid(fileRegion);
      const fileHeader = this.fileHeaderElement(fileRegion);
      const knownFilePath = this.knownFilePath(fileRegion);
      if (
        !diffGrid ||
        !fileHeader ||
        !knownFilePath ||
        this.currentFilePathEvidence(fileRegion) !== knownFilePath
      ) {
        return false;
      }

      const identityTargetSelector = [
        ".diff-text-cell",
        this.constants.HUNK_ELEMENT_SELECTOR,
        this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
      ].join(", ");
      if (
        target === fileHeader ||
        fileHeader.contains(target) ||
        target === diffGrid ||
        diffGrid.contains(target) ||
        target.matches(identityTargetSelector) ||
        target.closest(identityTargetSelector)
      ) {
        return false;
      }

      const structuralSelector = [
        "[data-hunkmark-ui]",
        ".hunkmark-file-progress",
        this.constants.FILE_CONTAINER_SELECTOR,
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
        this.constants.HUNK_ELEMENT_SELECTOR,
        this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
      ].join(", ");
      const changedNodes = [
        ...mutation.addedNodes,
        ...mutation.removedNodes,
      ];
      return (
        changedNodes.length > 0 &&
        changedNodes.every((node) => {
          if (node.nodeType !== this.window.Node.ELEMENT_NODE) {
            return true;
          }
          return (
            node !== fileHeader &&
            !node.contains(fileHeader) &&
            node !== diffGrid &&
            !node.contains(diffGrid) &&
            !node.matches(structuralSelector) &&
            !node.querySelector(structuralSelector)
          );
        })
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
      if (target && this.mutationPreservesKnownLineIdentity(mutation)) {
        // Host code cells can acquire auxiliary descendants that change row
        // geometry without changing HunkMark's line identity or hunk topology.
        // Sticky origins are invalidated before diff mutations are filtered.
        return false;
      }
      if (
        target &&
        this.mutationPreservesUntrackedDiffCellIdentity(mutation)
      ) {
        // Unreviewable diff cells can acquire auxiliary descendants too. Keep
        // those geometry changes visible to sticky layout handling, but do not
        // rediscover while identity content and diff structure remain untouched.
        return false;
      }
      if (
        target &&
        this.mutationPreservesFileAuxiliaryIdentity(mutation)
      ) {
        // Current GitHub file comments and other auxiliary file UI are mounted
        // beside the diff table. Their parent still contains every diff row, so
        // file-region ancestry alone must not trigger whole-page rediscovery.
        return false;
      }
      if (
        target &&
        (target.matches(this.constants.FILE_CONTAINER_SELECTOR) ||
          target.matches(
            this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
          ) ||
          target.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
          target.matches(this.constants.ROW_CANDIDATE_SELECTOR) ||
          target.closest(this.constants.FILE_CONTAINER_SELECTOR) ||
          target.closest(
            this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
          ))
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
            element.matches(
              this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
            ) ||
            element.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
            element.matches(this.constants.ROW_CANDIDATE_SELECTOR) ||
            element.closest(this.constants.FILE_CONTAINER_SELECTOR) ||
            element.closest(
              this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
            ) ||
            element.querySelector(this.constants.FILE_CONTAINER_SELECTOR) ||
            element.querySelector(
              this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
            ) ||
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

    trustedFilePath(value) {
      // Repository paths may be extensionless or contain significant
      // whitespace. Path-specific GitHub metadata is authoritative and must
      // remain byte-for-byte distinct from presentation labels.
      return typeof value === "string" && value.length > 0 ? value : null;
    },

    knownFilePath(fileElement) {
      return this.fileIdentityByElement.get(fileElement)?.path ?? null;
    },

    currentFileDiffGrid(fileElement) {
      const selector = '[role="grid"][aria-label^="Diff for: "]';
      return fileElement.matches(selector)
        ? fileElement
        : fileElement.querySelector(selector);
    },

    currentFilePathEvidence(fileElement) {
      const grid = this.currentFileDiffGrid(fileElement);
      const gridPath = this.trustedFilePath(
        grid?.getAttribute("aria-label")?.slice("Diff for: ".length),
      );
      if (gridPath) {
        return gridPath;
      }

      const currentRegionSelector =
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR;
      const currentRegion = fileElement.matches(currentRegionSelector)
        ? fileElement
        : fileElement.closest(currentRegionSelector) ??
          fileElement.querySelector(currentRegionSelector);
      const loadingLabel = currentRegion?.getAttribute("aria-label");
      return loadingLabel?.startsWith("Loading ")
        ? this.trustedFilePath(loadingLabel.slice("Loading ".length))
        : null;
    },

    fileHeaderElement(fileElement) {
      if (fileElement.matches(this.constants.FILE_HEADER_SELECTOR)) {
        return fileElement;
      }
      return Array.from(fileElement.children).find((child) =>
        child.matches(this.constants.FILE_HEADER_SELECTOR),
      ) ?? null;
    },

    filePathLink(fileElement) {
      const header = this.fileHeaderElement(fileElement);
      if (!header) {
        return null;
      }
      const selector = 'a[href^="#diff-"]';
      return header.matches(selector) ? header : header.querySelector(selector);
    },

    rememberFileIdentity(fileElement, path, presentedPath) {
      const previous = this.fileIdentityByElement.get(fileElement);
      this.fileIdentityByElement.set(fileElement, {
        path,
        presentedPath:
          presentedPath === undefined && previous?.path === path
            ? previous.presentedPath
            : (presentedPath ?? null),
      });
      return path;
    },

    resolveFilePath(fileElement, fallbackIndex) {
      const cachedIdentity = this.fileIdentityByElement.get(fileElement);
      const cachedPath = cachedIdentity?.path ?? null;
      const pathElements = Array.from(
        fileElement.querySelectorAll(
          this.constants.FILE_PATH_METADATA_SELECTOR,
        ),
      );
      const filePathLink = this.filePathLink(fileElement);
      if (filePathLink) {
        pathElements.push(filePathLink);
      }
      const cleanPresentedPath = (element) => {
        const codeElement = element.matches("code")
          ? element
          : element.querySelector("code");
        let presentedPath = this.cleanElementText(codeElement ?? element);
        if (
          presentedPath.startsWith("\u200e") &&
          presentedPath.endsWith("\u200e")
        ) {
          // GitHub inserts exactly one outer LRM pair. Removing only that pair
          // preserves an LRM that is genuinely part of the repository path.
          presentedPath = presentedPath.slice(1, -1);
        }
        return presentedPath;
      };
      const presentedPaths = [
        ...new Set(
          pathElements
            .filter((element) => element.matches('a[href^="#diff-"]'))
            .map(cleanPresentedPath)
            .map((value) => this.trustedFilePath(value))
            .filter(Boolean),
        ),
      ];
      const currentPresentedPath =
        presentedPaths.length === 1 ? presentedPaths[0] : null;
      const rememberPath = (value, { trusted = false } = {}) => {
        const path = trusted
          ? this.trustedFilePath(value)
          : String(value ?? "").trim();
        if (!path || (!trusted && !this.Core.looksLikeFilePath(path))) {
          return null;
        }
        return this.rememberFileIdentity(fileElement, path);
      };
      const rememberAuthoritativePath = (value) => {
        const path = rememberPath(value, { trusted: true });
        if (path) {
          this.rememberFileIdentity(
            fileElement,
            path,
            currentPresentedPath,
          );
        }
        return path;
      };
      const directAttributes = [
        "data-tagsearch-path",
        "data-file-path",
        "data-path",
      ];
      for (const attribute of directAttributes) {
        const path = rememberAuthoritativePath(
          fileElement.getAttribute(attribute),
        );
        if (path) {
          return path;
        }
      }

      // The grid labels the rendered rows, so it outranks a staged or stale
      // expansion button elsewhere in the same React file region.
      const gridPaths = [
        ...new Set(
          pathElements
            .filter((element) =>
              element.matches('[role="grid"][aria-label^="Diff for: "]'),
            )
            .map((element) =>
              this.trustedFilePath(
                element
                  .getAttribute("aria-label")
                  ?.slice("Diff for: ".length),
              ),
            )
            .filter(Boolean),
        ),
      ];
      if (gridPaths.length === 1) {
        return rememberAuthoritativePath(gridPaths[0]);
      }

      if (
        cachedPath &&
        cachedIdentity?.presentedPath &&
        currentPresentedPath &&
        currentPresentedPath !== cachedIdentity.presentedPath
      ) {
        return rememberAuthoritativePath(currentPresentedPath);
      }
      if (
        cachedPath &&
        currentPresentedPath &&
        !cachedIdentity?.presentedPath
      ) {
        this.rememberFileIdentity(
          fileElement,
          cachedPath,
          currentPresentedPath,
        );
      }

      // Prefer remaining machine-readable values before unchanged visible
      // header text.
      for (const element of pathElements) {
        if (element.matches('[role="grid"][aria-label^="Diff for: "]')) {
          continue;
        }
        const authoritativeValues = [
          element.getAttribute("data-file-path"),
          element.getAttribute("data-path"),
          element.getAttribute("value"),
        ];
        for (const value of authoritativeValues) {
          const path = rememberAuthoritativePath(value);
          if (path) {
            return path;
          }
        }
      }

      if (cachedPath && !cachedPath.startsWith("unknown-file:")) {
        return cachedPath;
      }

      for (const element of pathElements) {
        const titlePath = rememberPath(element.getAttribute("title"));
        if (titlePath) {
          return titlePath;
        }
        const presentedPath = cleanPresentedPath(element);
        const semanticPath = element.matches(
          '[data-testid*="file-name"], a[href^="#diff-"]',
        );
        const path = semanticPath
          ? rememberAuthoritativePath(presentedPath)
          : rememberPath(presentedPath);
        if (path) {
          return path;
        }
      }

      // A Load Diff replacement can introduce a nested file container before
      // GitHub gives that container its own path metadata. Keep the identity
      // captured at click time so review keys remain stable across discovery.
      const pendingRevealPath = Array.from(
        this.fileRevealPrepaintRestores,
      ).find(
        ([revealRoot]) =>
          revealRoot.isConnected &&
          (revealRoot === fileElement || revealRoot.contains(fileElement)),
      )?.[1]?.filePath;
      if (pendingRevealPath) {
        return this.rememberFileIdentity(
          fileElement,
          pendingRevealPath,
          currentPresentedPath,
        );
      }

      if (cachedPath) {
        return cachedPath;
      }

      const stableId = fileElement.id || fileElement.getAttribute("data-testid");
      return this.rememberFileIdentity(
        fileElement,
        stableId
          ? `unknown-file:${stableId}`
          : `unknown-file:${fallbackIndex}`,
      );
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

    runHunkDiscoveryWork(iterator) {
      let step = iterator.next();
      while (!step.done) {
        step = iterator.next();
      }
      return step.value;
    },

    async runHunkDiscoveryWorkChunked(iterator, snapshot) {
      let step = iterator.next();
      while (!step.done) {
        await this.yieldForHunkDiscoveryInteraction(snapshot);
        if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
          iterator.return();
          return null;
        }
        step = iterator.next();
      }
      return step.value;
    },

    changedLineDescriptorsForRows(groupRows) {
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

    *changedLineDescriptorsWork(groupRows, chunkSize) {
      const changedLines = [];
      for (
        let chunkStart = 0;
        chunkStart < groupRows.length;
        chunkStart += chunkSize
      ) {
        changedLines.push(
          ...this.changedLineDescriptorsForRows(
            groupRows.slice(chunkStart, chunkStart + chunkSize),
          ),
        );
        if (chunkStart + chunkSize < groupRows.length) {
          yield;
        }
      }
      return changedLines;
    },

    contextLineDescriptors(row, { includeEmpty = false } = {}) {
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
            (includeEmpty || text.length > 0) &&
            !this.Core.isHunkHeaderText(text),
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

    layoutReviewAnchorForContextRow(row) {
      const texts = [
        ...new Set(
          this.contextLineDescriptors(row)
            .map(({ text }) => this.Core.normalizeLineBreaks(text))
            .filter((text) => text.length > 0),
        ),
      ];
      if (texts.length === 0) {
        return "";
      }
      return texts.length === 1 ? `context:${texts[0]}` : null;
    },

    *lineReviewContextOptionsWork(
      groupRows,
      lineDescriptors,
      headerText,
      checkpointEvery,
    ) {
      let workSinceYield = 0;
      const checkpointNeeded = () => {
        workSinceYield += 1;
        if (workSinceYield < checkpointEvery) {
          return false;
        }
        workSinceYield = 0;
        return true;
      };
      const changedByRow = new Map();
      for (const descriptor of lineDescriptors) {
        const descriptors = changedByRow.get(descriptor.row) ?? [];
        descriptors.push(descriptor);
        changedByRow.set(descriptor.row, descriptors);
        if (checkpointNeeded()) {
          yield;
        }
      }
      const contextAnchor = function* (start, step, layout = false) {
        for (
          let index = start;
          index >= 0 && index < groupRows.length;
          index += step
        ) {
          const anchor = layout
            ? this.layoutReviewAnchorForContextRow(groupRows[index])
            : this.reviewAnchorForContextRow(groupRows[index]);
          if (
            (layout && (anchor === null || anchor.length > 0)) ||
            (!layout && anchor)
          ) {
            return anchor;
          }
          if (checkpointNeeded()) {
            yield;
          }
        }
        return "";
      }.bind(this);
      const contextOptionsByLine = new Map();

      for (let blockStart = 0; blockStart < groupRows.length; blockStart += 1) {
        if (!changedByRow.has(groupRows[blockStart])) {
          if (checkpointNeeded()) {
            yield;
          }
          continue;
        }
        let blockEnd = blockStart;
        while (
          blockEnd + 1 < groupRows.length &&
          changedByRow.has(groupRows[blockEnd + 1])
        ) {
          blockEnd += 1;
          if (checkpointNeeded()) {
            yield;
          }
        }

        const blockLines = [];
        for (let index = blockStart; index <= blockEnd; index += 1) {
          blockLines.push(...(changedByRow.get(groupRows[index]) ?? []));
          if (checkpointNeeded()) {
            yield;
          }
        }
        const kindOrder = { deletion: 0, addition: 1 };
        const layoutBlockLines = blockLines.slice().sort(
          (left, right) =>
            (kindOrder[left.kind] ?? 2) -
            (kindOrder[right.kind] ?? 2),
        );
        const blockSignatureParts = [];
        for (const descriptor of blockLines) {
          blockSignatureParts.push(
            `${descriptor.kind}:${descriptor.side}:${this.Core.normalizeLineBreaks(descriptor.text)}`,
          );
          if (checkpointNeeded()) {
            yield;
          }
        }
        const layoutBlockSignatureParts = [];
        for (const descriptor of layoutBlockLines) {
          layoutBlockSignatureParts.push(
            `${descriptor.kind}:${this.Core.normalizeLineBreaks(descriptor.text)}`,
          );
          if (checkpointNeeded()) {
            yield;
          }
        }
        const layoutBeforeAnchor =
          yield* contextAnchor(blockStart - 1, -1, true);
        const layoutAfterAnchor =
          yield* contextAnchor(blockEnd + 1, 1, true);
        const beforeAnchor = yield* contextAnchor(blockStart - 1, -1);
        const afterAnchor = yield* contextAnchor(blockEnd + 1, 1);
        const layoutBlock = {
          headerText,
          beforeAnchor: layoutBeforeAnchor,
          afterAnchor: layoutAfterAnchor,
          blockSignature: layoutBlockSignatureParts.join("\n"),
        };
        const block = {
          headerText,
          beforeAnchor,
          afterAnchor,
          blockSignature: blockSignatureParts.join("\n"),
        };
        for (
          let blockLineIndex = 0;
          blockLineIndex < blockLines.length;
          blockLineIndex += 1
        ) {
          contextOptionsByLine.set(blockLines[blockLineIndex], {
            block,
            blockLineIndex,
            layoutBlock,
          });
          if (checkpointNeeded()) {
            yield;
          }
        }
        blockStart = blockEnd;
      }

      const contextOptions = [];
      for (const line of lineDescriptors) {
        contextOptions.push(contextOptionsByLine.get(line));
        if (checkpointNeeded()) {
          yield;
        }
      }
      return contextOptions;
    },

    reviewLayoutForLines(lineDescriptors) {
      return lineDescriptors.some((line) => {
        const row = line.row;
        const cells = Array.from(row.children).filter((child) =>
          child.matches('td, [role="gridcell"]'),
        );
        return cells.length >= 4;
      })
        ? "split"
        : "unified";
    },

    *reviewLayoutForHunkWork(lineDescriptors, chunkSize) {
      for (
        let chunkStart = 0;
        chunkStart < lineDescriptors.length;
        chunkStart += chunkSize
      ) {
        if (
          this.reviewLayoutForLines(
            lineDescriptors.slice(chunkStart, chunkStart + chunkSize),
          ) === "split"
        ) {
          return "split";
        }
        if (chunkStart + chunkSize < lineDescriptors.length) {
          yield;
        }
      }
      return "unified";
    },

    hunkDiscoveryRootSelection(searchRoot = this.document) {
      const fileRootSelector = [
        this.constants.FILE_CONTAINER_SELECTOR,
        this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
      ].join(", ");
      return {
        candidates: Array.from(
          searchRoot.querySelectorAll(fileRootSelector),
        ),
        fileRootSelector,
      };
    },

    hunkDiscoveryRootContainsHunk(candidate) {
      return (
        candidate.matches(this.constants.HUNK_ELEMENT_SELECTOR) ||
        candidate.querySelector(this.constants.HUNK_ELEMENT_SELECTOR) ||
        this.Core.isHunkHeaderText(this.cleanElementText(candidate))
      );
    },

    hunkDiscoveryRootNeedsRowChunking(candidate) {
      return (
        (candidate.textContent?.length ?? 0) >=
        this.constants.HUNK_DISCOVERY_LARGE_ROOT_TEXT_THRESHOLD
      );
    },

    outermostHunkDiscoveryRoots(fileRoots, fileRootSelector) {
      const fileRootSet = new Set(fileRoots);
      return fileRoots.filter((candidate) => {
        const ancestor = candidate.parentElement?.closest(fileRootSelector);
        return !ancestor || !fileRootSet.has(ancestor);
      });
    },

    hunkDiscoverySearchRoots(searchRoot = this.document) {
      const { candidates, fileRootSelector } =
        this.hunkDiscoveryRootSelection(searchRoot);
      const fileRoots = candidates.filter((candidate) =>
        this.hunkDiscoveryRootContainsHunk(candidate),
      );
      const searchRoots = this.outermostHunkDiscoveryRoots(
        fileRoots,
        fileRootSelector,
      );
      return searchRoots.length > 0 ? searchRoots : [searchRoot];
    },

    collectDiscoveredHunkFileGroup(
      groupedByFile,
      markers,
      rootNode,
    ) {
      this.findHunkMarkers(rootNode).forEach((marker) => {
        if (markers.has(marker)) {
          return;
        }
        markers.add(marker);
        const hunkRow = this.semanticRow(marker);
        const fileElement = this.findFileElement(marker, hunkRow);
        if (!fileElement) {
          return;
        }

        const entries = groupedByFile.get(fileElement) ?? [];
        entries.push({ marker, hunkRow });
        groupedByFile.set(fileElement, entries);
      });
    },

    collectDiscoveredHunkFileGroups(searchRoot = this.document) {
      const groupedByFile = new Map();
      const markers = new Set();
      this.hunkDiscoverySearchRoots(searchRoot).forEach((rootNode) =>
        this.collectDiscoveredHunkFileGroup(
          groupedByFile,
          markers,
          rootNode,
        ),
      );
      return Array.from(groupedByFile.entries());
    },

    *prepareDiscoveredHunkFileInputsWork(
      fileElement,
      entries,
      fileIndex,
      fileRows,
    ) {
      const chunkSize = Math.max(
        1,
        this.constants.HUNK_DISCOVERY_ROW_CHUNK_SIZE,
      );
      const filePath = this.resolveFilePath(fileElement, fileIndex);
      const rowIndexes = new Map();
      for (
        let chunkStart = 0;
        chunkStart < fileRows.length;
        chunkStart += chunkSize
      ) {
        const chunkEnd = Math.min(chunkStart + chunkSize, fileRows.length);
        for (let index = chunkStart; index < chunkEnd; index += 1) {
          rowIndexes.set(fileRows[index], index);
        }
        if (chunkEnd < fileRows.length) {
          yield;
        }
      }

      const preparedEntries = [];
      for (
        let entryIndex = 0;
        entryIndex < entries.length;
        entryIndex += 1
      ) {
        const entry = entries[entryIndex];
        const nextEntry = entries[entryIndex + 1];
        const groupRows = this.rowsForHunk(
          fileRows,
          entry.hunkRow,
          nextEntry?.hunkRow,
          rowIndexes,
        );
        const headerText = this.stableHunkHeaderText(entry.marker);
        const lineDescriptors =
          yield* this.changedLineDescriptorsWork(groupRows, chunkSize);
        const reviewLayout =
          yield* this.reviewLayoutForHunkWork(lineDescriptors, chunkSize);
        const lineIdentityTokens = [];
        for (
          let chunkStart = 0;
          chunkStart < lineDescriptors.length;
          chunkStart += chunkSize
        ) {
          lineDescriptors
            .slice(chunkStart, chunkStart + chunkSize)
            .forEach((line) => {
              lineIdentityTokens.push(
                `${line.kind}\u0000${this.Core.normalizeLineBreaks(line.text)}`,
              );
            });
          if (chunkStart + chunkSize < lineDescriptors.length) {
            yield;
          }
        }
        const lineContextOptions =
          yield* this.lineReviewContextOptionsWork(
            groupRows,
            lineDescriptors,
            headerText,
            chunkSize,
          );
        const layoutBlocks = new Set();
        for (
          let chunkStart = 0;
          chunkStart < lineContextOptions.length;
          chunkStart += chunkSize
        ) {
          lineContextOptions
            .slice(chunkStart, chunkStart + chunkSize)
            .forEach((options) => layoutBlocks.add(options?.layoutBlock));
          if (chunkStart + chunkSize < lineContextOptions.length) {
            yield;
          }
        }
        const {
          completionSignature: layoutSignature,
          occurrenceSignature: layoutOccurrenceSignature,
        } = this.Core.buildLayoutHunkIdentity({
          blocks: [...layoutBlocks],
          headerText,
        });
        preparedEntries.push({
          ...entry,
          groupRows,
          headerText,
          lineDescriptors,
          lineIdentityTokens,
          lineContextOptions,
          layoutOccurrenceSignature,
          layoutSignature,
          reviewLayout,
        });
        if (
          (entryIndex + 1) % chunkSize === 0 &&
          entryIndex + 1 < entries.length
        ) {
          yield;
        }
      }

      const identicalLineCounts = new Map();
      let countedLines = 0;
      const totalLines = preparedEntries.reduce(
        (total, entry) => total + entry.lineIdentityTokens.length,
        0,
      );
      for (const entry of preparedEntries) {
        for (const lineIdentityToken of entry.lineIdentityTokens) {
          identicalLineCounts.set(
            lineIdentityToken,
            (identicalLineCounts.get(lineIdentityToken) ?? 0) + 1,
          );
          countedLines += 1;
          if (countedLines % chunkSize === 0 && countedLines < totalLines) {
            yield;
          }
        }
      }

      const hunkOccurrenceCounts = new Map();
      const layoutHunkOccurrenceCounts = new Map();
      const lineOccurrenceCounts = new Map();
      const hunkInputs = [];
      let preparedLines = 0;
      for (const entry of preparedEntries) {
        const {
          groupRows,
          headerText,
          lineDescriptors,
          lineIdentityTokens,
          lineContextOptions,
          layoutOccurrenceSignature,
          layoutSignature,
          reviewLayout,
        } = entry;
        const signature = this.Core.buildHunkSignature({
          headerText,
          changedLines: lineDescriptors,
        });
        const hunkOccurrenceToken = `${filePath}\u0000${signature}`;
        const occurrence = hunkOccurrenceCounts.get(hunkOccurrenceToken) ?? 0;
        hunkOccurrenceCounts.set(hunkOccurrenceToken, occurrence + 1);
        const layoutHunkOccurrenceToken = layoutOccurrenceSignature
          ? `${filePath}\u0000${layoutOccurrenceSignature}`
          : null;
        const layoutOccurrence = layoutHunkOccurrenceToken
          ? layoutHunkOccurrenceCounts.get(layoutHunkOccurrenceToken) ?? 0
          : 0;
        if (layoutHunkOccurrenceToken) {
          layoutHunkOccurrenceCounts.set(
            layoutHunkOccurrenceToken,
            layoutOccurrence + 1,
          );
        }
        const lineInputs = [];
        for (let index = 0; index < lineDescriptors.length; index += 1) {
          const lineIdentityToken = lineIdentityTokens[index];
          const lineOccurrence =
            lineOccurrenceCounts.get(lineIdentityToken) ?? 0;
          lineOccurrenceCounts.set(lineIdentityToken, lineOccurrence + 1);
          lineInputs.push({
            contextOptions: lineContextOptions[index],
            identicalCount: identicalLineCounts.get(lineIdentityToken),
            layout: reviewLayout,
            line: lineDescriptors[index],
            lineOccurrence,
          });
          preparedLines += 1;
          if (preparedLines % chunkSize === 0 && preparedLines < totalLines) {
            yield;
          }
        }
        hunkInputs.push({
          fileElement,
          filePath,
          groupRows,
          headerText,
          hunkCell: entry.marker,
          hunkRow: entry.hunkRow,
          lineInputs,
          occurrence,
          layoutOccurrence,
          layoutSignature,
          signature,
        });
      }
      return { filePath, hunkInputs };
    },

    prepareDiscoveredHunkFileInputs(
      fileElement,
      entries,
      fileIndex,
    ) {
      const fileRows = this.collectRows(fileElement);
      return this.runHunkDiscoveryWork(
        this.prepareDiscoveredHunkFileInputsWork(
          fileElement,
          entries,
          fileIndex,
          fileRows,
        ),
      );
    },

    async prepareDiscoveredHunkFileInputsChunked(
      fileElement,
      entries,
      fileIndex,
      snapshot,
    ) {
      const fileRows = this.collectRows(fileElement);
      const iterator = this.prepareDiscoveredHunkFileInputsWork(
        fileElement,
        entries,
        fileIndex,
        fileRows,
      );
      const chunkSize = Math.max(
        1,
        this.constants.HUNK_DISCOVERY_ROW_CHUNK_SIZE,
      );
      return fileRows.length <= chunkSize && entries.length <= chunkSize
        ? this.runHunkDiscoveryWork(iterator)
        : this.runHunkDiscoveryWorkChunked(iterator, snapshot);
    },

    collectDiscoveredHunkInputs(searchRoot = this.document) {
      return this.collectDiscoveredHunkFileGroups(searchRoot).map(
        ([fileElement, entries], fileIndex) =>
          this.prepareDiscoveredHunkFileInputs(
            fileElement,
            entries,
            fileIndex,
          ),
      );
    },

    hunkDiscoverySnapshot(
      searchRoot,
      { isCurrent = () => true } = {},
    ) {
      const fileScoped =
        searchRoot !== this.document &&
        searchRoot instanceof this.window.Element;
      return {
        diffMutationGeneration: this.diffMutationGeneration,
        fileMutationGeneration: fileScoped
          ? this.diffMutationGenerationByFileElement.get(searchRoot) ?? 0
          : null,
        fileScoped,
        isCurrent,
        yieldedToQueuedTasks: false,
        reviewScope: this.currentReviewScope,
        searchRoot,
        searchRootWasConnected:
          searchRoot === this.document || Boolean(searchRoot?.isConnected),
        unscopedDiffMutationGeneration: this.unscopedDiffMutationGeneration,
      };
    },

    hunkDiscoverySnapshotIsCurrent(snapshot) {
      if (
        this.stopped ||
        !snapshot.isCurrent() ||
        (snapshot.fileScoped
          ? (this.diffMutationGenerationByFileElement.get(
            snapshot.searchRoot,
          ) ?? 0) !== snapshot.fileMutationGeneration
          : this.diffMutationGeneration !== snapshot.diffMutationGeneration) ||
        (snapshot.fileScoped &&
          this.unscopedDiffMutationGeneration !==
            snapshot.unscopedDiffMutationGeneration) ||
        this.currentReviewScope !== snapshot.reviewScope ||
        (snapshot.searchRootWasConnected &&
          snapshot.searchRoot !== this.document &&
          !snapshot.searchRoot?.isConnected)
      ) {
        return false;
      }
      return (
        this.Core.reviewStateScope(
          this.Core.parseReviewScope(this.window.location),
          this.Core.parseReviewVariant(this.window.location),
        ) === snapshot.reviewScope
      );
    },

    async yieldForHunkDiscoveryInteraction(snapshot) {
      // scheduler.yield() resumes its continuation ahead of ordinary queued
      // tasks. Use one fresh task boundary first so work already waiting on
      // the page can run, then retain scheduler priority for later chunks.
      if (snapshot?.yieldedToQueuedTasks) {
        if (typeof this.window.scheduler?.yield === "function") {
          await this.window.scheduler.yield();
          return;
        }
      } else if (snapshot) {
        snapshot.yieldedToQueuedTasks = true;
      }
      await new Promise((resolve) => this.window.setTimeout(resolve, 0));
    },

    async collectDiscoveredHunkInputsChunked(searchRoot, snapshot) {
      const groupedByFile = new Map();
      const markers = new Set();
      const chunkSize = Math.max(
        1,
        this.constants.HUNK_DISCOVERY_FILE_CHUNK_SIZE,
      );
      const { candidates, fileRootSelector } =
        this.hunkDiscoveryRootSelection(searchRoot);
      const largeCandidates = new Set(
        candidates.filter((candidate) =>
          this.hunkDiscoveryRootNeedsRowChunking(candidate),
        ),
      );
      if (largeCandidates.size > 0) {
        await this.yieldForHunkDiscoveryInteraction(snapshot);
        if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
          return null;
        }
      }
      const fileRoots = [];
      for (let index = 0; index < candidates.length; index += 1) {
        if (this.hunkDiscoveryRootContainsHunk(candidates[index])) {
          fileRoots.push(candidates[index]);
        }
        if (
          largeCandidates.has(candidates[index]) ||
          ((index + 1) % chunkSize === 0 &&
            index + 1 < candidates.length)
        ) {
          await this.yieldForHunkDiscoveryInteraction(snapshot);
          if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
            return null;
          }
        }
      }
      const outermostRoots = this.outermostHunkDiscoveryRoots(
        fileRoots,
        fileRootSelector,
      );
      const searchRoots = outermostRoots.length > 0
        ? outermostRoots
        : [searchRoot];
      const largeSearchRoots = new Set(
        searchRoots.filter(
          (rootNode) =>
            largeCandidates.has(rootNode) ||
            this.hunkDiscoveryRootNeedsRowChunking(rootNode),
        ),
      );
      for (let index = 0; index < searchRoots.length; index += 1) {
        this.collectDiscoveredHunkFileGroup(
          groupedByFile,
          markers,
          searchRoots[index],
        );
        if (
          largeSearchRoots.has(searchRoots[index]) ||
          ((index + 1) % chunkSize === 0 &&
            index + 1 < searchRoots.length)
        ) {
          await this.yieldForHunkDiscoveryInteraction(snapshot);
          if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
            return null;
          }
        }
      }

      const fileGroups = Array.from(groupedByFile.entries());
      const discoveredFiles = [];
      for (let index = 0; index < fileGroups.length; index += 1) {
        const [fileElement, entries] = fileGroups[index];
        const discoveredFile =
          await this.prepareDiscoveredHunkFileInputsChunked(
            fileElement,
            entries,
            index,
            snapshot,
          );
        if (!discoveredFile) {
          return null;
        }
        discoveredFiles.push(discoveredFile);
        if (
          (index + 1) % chunkSize === 0 &&
          index + 1 < fileGroups.length
        ) {
          await this.yieldForHunkDiscoveryInteraction(snapshot);
          if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
            return null;
          }
        }
      }
      return discoveredFiles;
    },

    async discoverHunks(
      searchRoot = this.document,
      { isCurrent = () => true, snapshot = null } = {},
    ) {
      snapshot ??= this.hunkDiscoverySnapshot(searchRoot, { isCurrent });
      const discoveredFiles =
        await this.collectDiscoveredHunkInputsChunked(searchRoot, snapshot);
      if (!discoveredFiles) {
        return null;
      }
      const blockFingerprintPromises = new Map();
      const blockFingerprintFor = (contextOptions) => {
        const { block } = contextOptions;
        let fingerprintPromise = blockFingerprintPromises.get(block);
        if (!fingerprintPromise) {
          fingerprintPromise = this.Core.lineReviewBlockFingerprint(block);
          blockFingerprintPromises.set(block, fingerprintPromise);
        }
        return fingerprintPromise;
      };
      const hydrateLine = async (input, filePath) => {
        const blockFingerprint = await blockFingerprintFor(
          input.contextOptions,
        );
        const { layout } = input;
        const [contextFingerprint, key, legacyKey] = await Promise.all([
          this.Core.lineReviewContextFingerprint({
            blockFingerprint,
            blockLineIndex: input.contextOptions.blockLineIndex,
          }),
          this.Core.layoutLineStorageKey(
            this.currentReviewScope,
            filePath,
            layout,
            input.line.kind,
            input.line.text,
            input.lineOccurrence,
            input.identicalCount,
          ),
          this.Core.lineStorageKey(
            this.currentReviewScope,
            filePath,
            input.line.kind,
            input.line.text,
            input.lineOccurrence,
            input.identicalCount,
          ),
        ]);
        return {
          ...input.line,
          contextFingerprint,
          key,
          layout,
          legacyKey,
        };
      };
      const rowChunkSize = Math.max(
        1,
        this.constants.HUNK_DISCOVERY_ROW_CHUNK_SIZE,
      );
      const hydrateHunk = async (hunk, filePath, officialSuppressionKey) => {
        const keyPromise = this.Core.hunkStorageKey(
          this.currentReviewScope,
          filePath,
          hunk.signature,
          hunk.occurrence,
        );
        const sharedCompletionKeyPromise = hunk.layoutSignature
          ? this.Core.layoutHunkStorageKey(
            this.currentReviewScope,
            filePath,
            hunk.layoutSignature,
            hunk.layoutOccurrence,
          )
          : Promise.resolve(null);
        const lines = [];
        for (
          let chunkStart = 0;
          chunkStart < hunk.lineInputs.length;
          chunkStart += rowChunkSize
        ) {
          lines.push(
            ...(await Promise.all(
              hunk.lineInputs
                .slice(chunkStart, chunkStart + rowChunkSize)
                .map((input) => hydrateLine(input, filePath)),
            )),
          );
          if (chunkStart + rowChunkSize < hunk.lineInputs.length) {
            await this.yieldForHunkDiscoveryInteraction(snapshot);
            if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
              return null;
            }
          }
        }
        const [key, sharedCompletionKey] = await Promise.all([
          keyPromise,
          sharedCompletionKeyPromise,
        ]);
        return {
          fileElement: hunk.fileElement,
          filePath,
          groupRows: hunk.groupRows,
          headerText: hunk.headerText,
          hunkCell: hunk.hunkCell,
          hunkRow: hunk.hunkRow,
          key,
          sharedCompletionKey,
          lines,
          officialSuppressionKey,
        };
      };
      const hydrateFile = async ({ filePath, hunkInputs }) => {
        const officialSuppressionKey =
          await this.officialViewedSuppressionKey(filePath);
        const hunks = [];
        for (
          let chunkStart = 0;
          chunkStart < hunkInputs.length;
          chunkStart += rowChunkSize
        ) {
          const hydratedHunks = await Promise.all(
            hunkInputs
              .slice(chunkStart, chunkStart + rowChunkSize)
              .map((hunk) =>
                hydrateHunk(hunk, filePath, officialSuppressionKey),
              ),
          );
          if (hydratedHunks.some((hunk) => hunk === null)) {
            return null;
          }
          hunks.push(...hydratedHunks);
          if (chunkStart + rowChunkSize < hunkInputs.length) {
            await this.yieldForHunkDiscoveryInteraction(snapshot);
            if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
              return null;
            }
          }
        }
        return hunks;
      };
      const chunkSize = Math.max(
        1,
        this.constants.HUNK_DISCOVERY_FILE_CHUNK_SIZE,
      );
      const hunksByFile = [];
      for (
        let chunkStart = 0;
        chunkStart < discoveredFiles.length;
        chunkStart += chunkSize
      ) {
        const hydratedFiles = await Promise.all(
          discoveredFiles
            .slice(chunkStart, chunkStart + chunkSize)
            .map(hydrateFile),
        );
        if (hydratedFiles.some((file) => file === null)) {
          return null;
        }
        hunksByFile.push(...hydratedFiles);
        if (chunkStart + chunkSize < discoveredFiles.length) {
          await this.yieldForHunkDiscoveryInteraction(snapshot);
          if (!this.hunkDiscoverySnapshotIsCurrent(snapshot)) {
            return null;
          }
        }
      }

      return this.hunkDiscoverySnapshotIsCurrent(snapshot)
        ? hunksByFile.flat()
        : null;
    },

    discoverCachedHunks(searchRoot = this.document) {
      const discoveredFiles = this.collectDiscoveredHunkInputs(searchRoot);
      const blockFingerprints = new Map();
      const blockFingerprintFor = (contextOptions) => {
        const { block } = contextOptions;
        if (!blockFingerprints.has(block)) {
          blockFingerprints.set(
            block,
            this.Core.cachedLineReviewBlockFingerprint(block),
          );
        }
        return blockFingerprints.get(block);
      };
      const hunks = [];
      for (const { filePath, hunkInputs } of discoveredFiles) {
        const officialSuppressionKey =
          this.Core.cachedOfficialSyncSuppressionKey(
            this.officialViewedSuppressionScope(),
            filePath,
          );
        if (!officialSuppressionKey) {
          return null;
        }
        for (const hunk of hunkInputs) {
          const key = this.Core.cachedHunkStorageKey(
            this.currentReviewScope,
            filePath,
            hunk.signature,
            hunk.occurrence,
          );
          if (!key) {
            return null;
          }
          const lines = [];
          for (const input of hunk.lineInputs) {
            const blockFingerprint = blockFingerprintFor(
              input.contextOptions,
            );
            const contextFingerprint =
              blockFingerprint &&
              this.Core.cachedLineReviewContextFingerprint({
                blockFingerprint,
                blockLineIndex: input.contextOptions.blockLineIndex,
              });
            const lineKey = this.Core.cachedLineStorageKey(
              this.currentReviewScope,
              filePath,
              input.line.kind,
              input.line.text,
              input.lineOccurrence,
              input.identicalCount,
            );
            const { layout } = input;
            const layoutLineKey = this.Core.cachedLayoutLineStorageKey(
              this.currentReviewScope,
              filePath,
              layout,
              input.line.kind,
              input.line.text,
              input.lineOccurrence,
              input.identicalCount,
            );
            if (!contextFingerprint || !lineKey || !layoutLineKey) {
              return null;
            }
            lines.push({
              ...input.line,
              contextFingerprint,
              key: layoutLineKey,
              layout,
              legacyKey: lineKey,
            });
          }
          hunks.push({
            fileElement: hunk.fileElement,
            filePath,
            groupRows: hunk.groupRows,
            headerText: hunk.headerText,
            hunkCell: hunk.hunkCell,
            hunkRow: hunk.hunkRow,
            key,
            sharedCompletionKey: hunk.layoutSignature
              ? this.Core.cachedLayoutHunkStorageKey(
                  this.currentReviewScope,
                  filePath,
                  hunk.layoutSignature,
                  hunk.layoutOccurrence,
                )
              : null,
            lines,
            officialSuppressionKey,
          });
        }
      }
      return hunks;
    },
  });
}
