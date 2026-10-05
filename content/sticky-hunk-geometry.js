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
    fileDocumentTop,
  ) => {
    controller.stickyHunkOriginDocumentTop = documentTop;
    controller.stickyHunkOriginFileDocumentTop = fileDocumentTop;
    if (Number.isInteger(originLayoutGeneration)) {
      controller.stickyHunkOriginLayoutGeneration =
        originLayoutGeneration;
    }
    return documentTop;
  };

  const readStickyHunkNaturalLayout = (controller, readLayout) => {
    const fileElement = controller.fileElement;
    const measureFile =
      fileElement &&
      controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared") &&
      !fileElement.classList.contains("hunkmark-sticky-file-measuring");
    if (measureFile) {
      fileElement.classList.add("hunkmark-sticky-file-measuring");
    }
    try {
      return readLayout();
    } finally {
      if (measureFile) {
        fileElement.classList.remove("hunkmark-sticky-file-measuring");
      }
    }
  };

  Object.assign(App.prototype, {
    cachedStickyHunkNaturalDocumentTop(controller) {
      const cachedTop = controller.stickyHunkOriginDocumentTop;
      if (!Number.isFinite(cachedTop)) {
        return null;
      }
      const fileTop = this.hunkStickyStateByFile.get(controller.fileElement)
        ?.fileOriginDocumentTop;
      const measuredFileTop = controller.stickyHunkOriginFileDocumentTop;
      return cachedTop + (
        Number.isFinite(fileTop) && Number.isFinite(measuredFileTop)
          ? fileTop - measuredFileTop : 0
      );
    },

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
      state.orderedControllers = orderedControllers;
      orderedControllers.forEach((controller, index) => {
        controller.stickyHunkOrderIndex = index;
      });
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
      if (orderChanged) {
        currentControllers.forEach((controller, index) => {
          controller.stickyHunkOrderIndex = index;
        });
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
      controller.stickyHunkNaturalContentDirty = true;
      controller.stickyHunkTailRoomLayoutGeneration = null;
      controller.stickyHunkCompactHeight = compactHeight;
      this.syncStickyHunkAuxiliaryElements(controller);
      controller.stickyHunkContentInset = inset;
      controller.stickyHunkBottomInset = bottomInset;
      this.syncStickyHunkContentStyles(controller);
    },

    syncStickyHunkContentStyles(controller) {
      setPixelStyle(
        controller.hunkRow,
        "--hunkmark-sticky-hunk-compact-height",
        controller.stickyHunkCompactHeight ?? this.constants.STICKY_HUNK_HEIGHT_PX,
      );
      setPixelStyle(
        controller.hunkRow,
        "--hunkmark-sticky-hunk-content-inset",
        Math.max(0, controller.stickyHunkContentInset ?? 0),
        true,
      );
      setPixelStyle(
        controller.hunkRow,
        "--hunkmark-sticky-hunk-bottom-inset",
        Math.max(0, controller.stickyHunkBottomInset ?? 0),
        true,
      );
    },

    syncStickyHunkTailRoom(controller, naturalTop, hasFollowingHunk) {
      const row = controller.hunkRow;
      const constrained = controller.collapsed && !hasFollowingHunk &&
        (controller.stickyHunkBottomInset ?? 0) > 0;
      if (
        row.classList.contains("hunkmark-sticky-hunk-tail-constrained") !==
        constrained
      ) {
        row.classList.toggle("hunkmark-sticky-hunk-tail-constrained", constrained);
      }
      if (!constrained) {
        controller.stickyHunkTailRoom = null;
        controller.stickyHunkTailRoomLayoutGeneration = null;
        return;
      }
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (
        controller.stickyHunkTailRoomLayoutGeneration !==
        state?.originLayoutGeneration
      ) {
        const container = row.tagName === "TR"
          ? row.closest("table") : row.parentElement;
        const bottom = Number(container?.getBoundingClientRect().bottom) +
          (Number(this.window.scrollY) || 0);
        const height =
          (controller.stickyHunkCompactHeight ?? this.constants.STICKY_HUNK_HEIGHT_PX) +
          (controller.stickyHunkContentInset ?? 0) + (controller.stickyHunkBottomInset ?? 0);
        controller.stickyHunkTailRoom = Number.isFinite(bottom)
          ? Math.max(0, bottom - naturalTop - height) : 0;
        controller.stickyHunkTailRoomLayoutGeneration = state?.originLayoutGeneration;
      }
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

    stickyHunkNaturalDocumentTop(
      controller,
      { originLayoutGeneration = null, refreshLayout = false } = {},
    ) {
      const row = controller.hunkRow;
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (state?.fileOriginDirty) {
        // Explicit navigation measurements may precede the scheduled layout.
        // Cache them against the current file origin, not its previous offset.
        this.updateStickyHunkFileOrigin(state);
      }
      const cachedTop = this.cachedStickyHunkNaturalDocumentTop(controller);
      const currentGeneration = state?.originLayoutGeneration ?? originLayoutGeneration;
      if (
        !refreshLayout &&
        Number.isFinite(cachedTop) &&
        Number.isInteger(currentGeneration) &&
        controller.stickyHunkOriginLayoutGeneration === currentGeneration
      ) {
        return cachedTop;
      }

      // CSS can pin any prepared row. Navigation keeps its natural origin;
      // explicit remeasurement temporarily restores the whole file's flow.
      const rowRect = readStickyHunkNaturalLayout(
        controller,
        () => row.getBoundingClientRect(),
      );
      controller.stickyHunkNaturalGeometry = this.stickyHunkNaturalSurfaceGeometry(controller, rowRect);
      const rowTop = Number(rowRect.top);
      if (Number.isFinite(rowTop)) {
        const naturalTop = rowTop + (Number(this.window.scrollY) || 0);
        return cacheStickyHunkOrigin(
          controller,
          naturalTop,
          currentGeneration,
          this.hunkStickyStateByFile.get(controller.fileElement)?.fileOriginDocumentTop,
        );
      }

      return Number.isFinite(cachedTop) ? cachedTop : 0;
    },

  });
})(globalThis);
