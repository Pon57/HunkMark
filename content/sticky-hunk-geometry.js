(function attachHunkMarkStickyHunkGeometry(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  const Sticky = namespace?.stickyHunk;
  if (!App || !Sticky) {
    return;
  }
  const {
    AUXILIARY_SELECTOR,
    firstPositiveNumber,
    setPixelStyle,
  } = Sticky;

  const cacheStickyHunkOrigin = (
    controller,
    documentTop,
    originLayoutGeneration,
  ) => {
    controller.stickyHunkOriginDocumentTop = documentTop;
    if (Number.isInteger(originLayoutGeneration)) {
      controller.stickyHunkOriginLayoutGeneration =
        originLayoutGeneration;
    }
    return documentTop;
  };

  Object.assign(App.prototype, {
    orderedStickyHunkControllers(state) {
      if (!state.orderDirty) {
        return state.orderedControllers;
      }
      const orderedControllers = Array.from(state.controllers)
        .filter(
          (controller) =>
            !controller.destroyed && controller.hunkRow.isConnected,
        )
        .sort((left, right) => {
          if (left.hunkRow === right.hunkRow) {
            return 0;
          }
          return left.hunkRow.compareDocumentPosition(right.hunkRow) &
            this.window.Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1;
        });
      state.orderChanged ||=
        orderedControllers.length !== state.orderedControllers.length ||
        orderedControllers.some(
          (controller, index) =>
            controller !== state.orderedControllers[index],
        );
      state.orderedControllers = orderedControllers;
      state.orderDirty = false;
      return orderedControllers;
    },

    syncStickyHunkControllerOrder(state, orderedControllers) {
      const currentControllers = orderedControllers.filter(
        (controller) =>
          state.controllers.has(controller) &&
          !controller.destroyed &&
          controller.hunkRow.isConnected,
      );
      const orderChanged =
        currentControllers.length !== state.orderedControllers.length ||
        currentControllers.some(
          (controller, index) =>
            controller !== state.orderedControllers[index],
        );
      state.orderedControllers = currentControllers;
      state.orderDirty = false;
      state.orderChanged ||= orderChanged;
      if (orderChanged) {
        this.markStickyHunkOriginsDirty(state);
      }
    },

    stickyHunkRenderedHeaderRect(textElement) {
      if (!textElement || typeof this.document.createRange !== "function") {
        return null;
      }
      const walker = this.document.createTreeWalker(
        textElement,
        this.window.NodeFilter.SHOW_TEXT,
      );
      let headerTextNode = walker.nextNode();
      while (
        headerTextNode &&
        !this.Core.isHunkHeaderText(headerTextNode.nodeValue)
      ) {
        headerTextNode = walker.nextNode();
      }
      const range = this.document.createRange();
      try {
        range.selectNodeContents(headerTextNode ?? textElement);
        const rect = range.getBoundingClientRect?.();
        const height = Number(rect?.height);
        const top = Number(rect?.top);
        return Number.isFinite(top) && Number.isFinite(height) && height > 0
          ? { height, top }
          : null;
      } catch {
        return null;
      } finally {
        range.detach?.();
      }
    },

    measureStickyHunkContentInset(controller) {
      // Measure from the complete row: GitHub can place the hunk cell partway
      // down a taller expansion row. The row is what we clip and pin.
      const rect = controller.hunkRow.getBoundingClientRect();
      const height = firstPositiveNumber(
        controller.hunkRow.offsetHeight,
        rect.height,
      );
      const textElement =
        controller.hunkRow.querySelector(
          ".diff-text-inner, .blob-code-inner",
        ) ?? controller.hunkCell;
      const textRect =
        this.stickyHunkRenderedHeaderRect(textElement) ??
        textElement?.getBoundingClientRect?.();
      const textTop = Number(textRect?.top);
      const textHeight = Number(textRect?.height);
      const baseHeight = this.constants.STICKY_HUNK_HEIGHT_PX;
      const contentLines =
        Number.isFinite(textHeight) && textHeight > 0
          ? Math.max(1, Math.ceil(textHeight / baseHeight))
          : 1;
      const compactHeight = Math.min(
        Math.round(height * 100) / 100 || baseHeight,
        contentLines * baseHeight,
      );
      const measuredCenter =
        Number.isFinite(textTop) &&
        Number.isFinite(textHeight) &&
        textHeight > 0
          ? textTop - Number(rect.top) + textHeight / 2
          : Number.NaN;
      const maximumInset = Math.max(0, height - compactHeight);
      const rawInset = Math.min(
        maximumInset,
        Math.max(
          0,
          Number.isFinite(measuredCenter)
            ? measuredCenter - compactHeight / 2
            : maximumInset / 2,
        ),
      );
      const inset = Math.round(rawInset * 100) / 100;
      const bottomInset =
        Math.round(Math.max(0, height - compactHeight - inset) * 100) / 100;
      return { bottomInset, compactHeight, inset };
    },

    syncStickyHunkAuxiliaryElements(controller) {
      const elements = Array.from(
        controller.hunkRow.querySelectorAll(AUXILIARY_SELECTOR),
      );
      const previousElements = controller.stickyHunkAuxiliaryElements ?? [];
      const elementsChanged =
        elements.length !== previousElements.length ||
        elements.some(
          (element, index) => element !== previousElements[index],
        );
      const currentElements = new Set(elements);
      previousElements.forEach((element) => {
        if (!currentElements.has(element)) {
          element.classList.remove("hunkmark-sticky-hunk-auxiliary");
        }
      });
      elements.forEach((element) => {
        element.classList.add("hunkmark-sticky-hunk-auxiliary");
      });
      controller.stickyHunkAuxiliaryElements = elements;
      controller.stickyHunkHasAuxiliaryElements = elements.length > 0;
      return elementsChanged;
    },

    applyStickyHunkContentInset(
      controller,
      { bottomInset, compactHeight, inset },
    ) {
      controller.stickyHunkCompactHeight = compactHeight;
      this.syncStickyHunkAuxiliaryElements(controller);
      if (
        (controller.stickyHunkContentInset ?? 0) === inset &&
        (controller.stickyHunkBottomInset ?? 0) === bottomInset
      ) {
        return;
      }
      controller.stickyHunkContentInset = inset;
      controller.stickyHunkBottomInset = bottomInset;
      setPixelStyle(
        controller.hunkRow,
        "--hunkmark-sticky-hunk-content-inset",
        inset,
        true,
      );
      setPixelStyle(
        controller.hunkRow,
        "--hunkmark-sticky-hunk-bottom-inset",
        bottomInset,
        true,
      );
    },

    stickyHunkContentMetrics(state, controller, measurements) {
      if (
        (controller.stickyHunkContentLayoutGeneration !==
          state.contentLayoutGeneration ||
          state.contentLayoutDirtyControllers.has(controller)) &&
        !measurements.has(controller)
      ) {
        measurements.set(
          controller,
          this.measureStickyHunkContentInset(controller),
        );
      }
      return measurements.get(controller) ?? {
        bottomInset: controller.stickyHunkBottomInset ?? 0,
        compactHeight:
          controller.stickyHunkCompactHeight ??
          this.constants.STICKY_HUNK_HEIGHT_PX,
        inset: controller.stickyHunkContentInset ?? 0,
      };
    },

    applyStickyHunkStateMeasurements(state, measurements) {
      measurements.forEach((content, controller) => {
        this.applyStickyHunkContentInset(controller, content);
        controller.stickyHunkContentLayoutGeneration =
          state.contentLayoutGeneration;
        state.contentLayoutDirtyControllers.delete(controller);
      });
    },

    stickyHunkTableDocumentTop(
      controller,
      { refreshLayout = false } = {},
    ) {
      const row = controller.hunkRow;
      if (row?.tagName !== "TR") {
        return null;
      }
      const table = row.closest("table");
      const wasSticky = row.classList.contains(
        "hunkmark-sticky-hunk-active",
      );
      if (refreshLayout && wasSticky) {
        row.classList.remove("hunkmark-sticky-hunk-active");
      }
      let renderedOffsetTop;
      let tableTop;
      try {
        renderedOffsetTop = Number(row.offsetTop);
        tableTop = Number(table?.getBoundingClientRect().top);
      } finally {
        if (refreshLayout && wasSticky) {
          row.classList.add("hunkmark-sticky-hunk-active");
        }
      }
      if (
        !table ||
        !Number.isFinite(renderedOffsetTop) ||
        !Number.isFinite(tableTop)
      ) {
        return null;
      }
      const cachedOffsetTop = Number(controller.stickyHunkTableOffsetTop);
      const offsetTop =
        !refreshLayout && wasSticky && Number.isFinite(cachedOffsetTop)
          ? cachedOffsetTop
          : renderedOffsetTop;
      if (refreshLayout || !wasSticky) {
        controller.stickyHunkTableOffsetTop = renderedOffsetTop;
      }
      return tableTop + (Number(this.window.scrollY) || 0) + offsetTop;
    },

    stickyHunkNaturalDocumentTop(
      controller,
      { originLayoutGeneration = null, refreshLayout = false } = {},
    ) {
      const cachedTop = Number(controller.stickyHunkOriginDocumentTop);
      if (
        !refreshLayout &&
        Number.isInteger(originLayoutGeneration) &&
        controller.stickyHunkOriginLayoutGeneration ===
          originLayoutGeneration &&
        Number.isFinite(cachedTop)
      ) {
        return cachedTop;
      }

      // Sticky table rows need the last pre-sticky offset unless a real layout
      // invalidation explicitly requests another measurement.
      const tableTop = this.stickyHunkTableDocumentTop(controller, {
        refreshLayout,
      });
      if (tableTop !== null) {
        return cacheStickyHunkOrigin(
          controller,
          tableTop,
          originLayoutGeneration,
        );
      }

      const row = controller.hunkRow;
      const wasSticky = row.classList.contains(
        "hunkmark-sticky-hunk-active",
      );
      if (refreshLayout && wasSticky) {
        row.classList.remove("hunkmark-sticky-hunk-active");
      }
      let rowRect;
      try {
        rowRect = row.getBoundingClientRect();
      } finally {
        if (refreshLayout && wasSticky) {
          row.classList.add("hunkmark-sticky-hunk-active");
        }
      }
      const rowTop = Number(rowRect.top);
      if ((refreshLayout || !wasSticky) && Number.isFinite(rowTop)) {
        const naturalTop = rowTop + (Number(this.window.scrollY) || 0);
        return cacheStickyHunkOrigin(
          controller,
          naturalTop,
          originLayoutGeneration,
        );
      }

      const rowHeight = firstPositiveNumber(row.offsetHeight, rowRect.height);
      const rowIndex = controller.groupRows.indexOf(row);
      const followingRow =
        rowIndex >= 0 ? controller.groupRows[rowIndex + 1] : null;
      if (followingRow?.isConnected && rowHeight > 0) {
        const followingRect = followingRow.getBoundingClientRect();
        const followingHeight = firstPositiveNumber(
          followingRow.offsetHeight,
          followingRect.height,
        );
        const followingTop = Number(followingRect.top);
        if (followingHeight > 0 && Number.isFinite(followingTop)) {
          const naturalTop =
            followingTop + (Number(this.window.scrollY) || 0) - rowHeight;
          if (Number.isFinite(naturalTop)) {
            return cacheStickyHunkOrigin(
              controller,
              naturalTop,
              originLayoutGeneration,
            );
          }
        }
      }

      if (Number.isFinite(cachedTop)) {
        return cachedTop;
      }
      return Number.isFinite(rowTop)
        ? rowTop + (Number(this.window.scrollY) || 0)
        : 0;
    },

    stickyHunkNaturalViewportTop(controller, options) {
      const documentTop = this.stickyHunkNaturalDocumentTop(
        controller,
        options,
      );
      const scrollY = Number(this.window.scrollY) || 0;
      return Number.isFinite(documentTop)
        ? documentTop - scrollY
        : Number.POSITIVE_INFINITY;
    },
  });
})(globalThis);
