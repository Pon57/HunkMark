(function attachHunkMarkStickyHunkNatural(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  const Sticky = namespace?.stickyHunk;
  if (!App || !Sticky) {
    return;
  }
  const { AUXILIARY_SELECTOR } = Sticky;
  const AUXILIARY_RANGES = [
    "--hunkmark-sticky-hunk-auxiliary-start",
    "--hunkmark-sticky-hunk-auxiliary-end",
  ];
  const setSurfacePosition = (element, property, value) => {
    const next = `${Math.round(value * 100) / 100}px`;
    if (element.style.getPropertyValue(property) !== next ||
        element.style.getPropertyPriority(property) !== "important") {
      element.style.setProperty(property, next, "important");
    }
  };

  Object.assign(App.prototype, {
    stickyHunkNaturalSurfaceGeometry(controller, rect) {
      const width = Number(rect.width) > 0 ? Number(rect.width) : Number(controller.hunkRow.offsetWidth) || 0;
      const height = Number(rect.height) > 0 ? Number(rect.height) : Number(controller.hunkRow.offsetHeight) || 0;
      if (!(width > 0 && height > 0)) {
        return { width, height };
      }
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (!state) {
        return { width, height };
      }
      if (state.naturalParentGeneration !== state.originLayoutGeneration) {
        state.naturalParentGeneration = state.originLayoutGeneration;
        state.naturalParentLayouts = new Map();
        state.naturalContainingParents = new Map();
      }
      const sourceParent = controller.hunkRow.parentElement;
      let parent = state.naturalContainingParents.get(sourceParent);
      if (!parent) {
        parent = controller.fileElement;
        for (let ancestor = sourceParent; ancestor && ancestor !== controller.fileElement;
          ancestor = ancestor.parentElement) {
          if (/^(auto|scroll)$/.test(this.window.getComputedStyle(ancestor).overflowX)) {
            parent = ancestor;
            break;
          }
        }
        state.naturalContainingParents.set(sourceParent, parent);
      }
      let layout = state.naturalParentLayouts.get(parent);
      if (!layout) {
        const box = parent === state.fileElement ? null : parent.getBoundingClientRect();
        layout = {
          top: box ? box.top + (Number(this.window.scrollY) || 0) : Number(state.fileOriginDocumentTop) || 0,
          left: box ? box.left + (Number(this.window.scrollX) || 0) : Number(state.fileOriginDocumentLeft) || 0,
          fileTop: Number(state.fileOriginDocumentTop) || 0,
          fileLeft: Number(state.fileOriginDocumentLeft) || 0,
          borderTop: Number(parent.clientTop) || 0,
          borderLeft: Number(parent.clientLeft) || 0,
        };
        state.naturalParentLayouts.set(parent, layout);
      }
      return {
        width,
        height,
        parent,
        top: rect.top + (Number(this.window.scrollY) || 0) -
          layout.top - ((Number(state.fileOriginDocumentTop) || 0) - layout.fileTop) - layout.borderTop + parent.scrollTop,
        left: rect.left + (Number(this.window.scrollX) || 0) -
          layout.left - ((Number(state.fileOriginDocumentLeft) || 0) - layout.fileLeft) - layout.borderLeft + parent.scrollLeft,
      };
    },

    removeStickyHunkNaturalSurface(controller) {
      const record = controller.stickyHunkNaturalLayer;
      controller.stickyHunkNaturalSurface?.remove();
      controller.stickyHunkNaturalSurface = null;
      controller.stickyHunkNaturalRow = null;
      controller.stickyHunkNaturalState = null;
      controller.stickyHunkNaturalLayer = null;
      controller.stickyHunkNaturalAuxiliaries = [];
      if (record && !record.layer.children.length) {
        record.layer.remove();
        if (this.hunkStickyNaturalLayersByParent.get(record.parent) === record) {
          if (record.positionClassAdded) {
            record.parent.classList.remove("hunkmark-sticky-hunk-container");
          }
          this.hunkStickyNaturalLayersByParent.delete(record.parent);
        }
      }
    },

    rebuildStickyHunkNaturalSurface(controller, surface) {
      const sourceRow = controller.hunkRow;
      const row = sourceRow.cloneNode(true);
      row.classList.remove(
        "hunkmark-sticky-hunk-prepared",
        "hunkmark-sticky-hunk-active",
        "hunkmark-sticky-hunk-tail-constrained",
        "hunkmark-sticky-hunk-compact-return",
      );
      row.classList.add("hunkmark-sticky-hunk-natural-row");
      row.removeAttribute("id");
      row.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      row.querySelectorAll("[data-hunkmark-ui]").forEach((element) => element.remove());
      row.querySelectorAll("a, button, input, select, textarea, [tabindex]")
        .forEach((element) => { element.tabIndex = -1; });
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.reviewControllerIsCurrent(controller)) {
          controller.hunkCell.dispatchEvent(new this.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: event.button,
            clientX: event.clientX,
            clientY: event.clientY,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          }));
        }
      });

      const sources = Array.from(sourceRow.querySelectorAll(AUXILIARY_SELECTOR))
        .filter((element) => !element.closest("[data-hunkmark-ui]"));
      const targets = Array.from(row.querySelectorAll(AUXILIARY_SELECTOR));
      controller.stickyHunkNaturalAuxiliaries = targets.map((target, index) => {
        const source = sources[index];
        const sourceControl = source?.closest("button, a, [tabindex]") ?? source;
        const targetControl = target.closest("button, a, [tabindex]") ?? target;
        target.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.button !== 0 || !this.reviewControllerIsCurrent(controller) ||
              !source?.isConnected || sourceControl.disabled) {
            return;
          }
          this.focusStickyHunkWithoutReveal(controller, sourceControl);
          source.dispatchEvent(new this.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: event.button,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            detail: event.detail,
            view: this.window,
          }));
        });
        return { source: sourceControl, target: targetControl };
      });
      if (sourceRow.tagName === "TR") {
        const body = this.document.createElement("tbody");
        body.append(row);
        surface.replaceChildren(body);
      } else {
        surface.replaceChildren(row);
      }
      controller.stickyHunkNaturalRow = row;
      controller.stickyHunkNaturalContentDirty = false;
    },

    syncStickyHunkNaturalSurface(controller) {
      const geometry = controller.stickyHunkNaturalGeometry;
      if (!(geometry?.width > 0 && geometry.height > 0) ||
          !(controller.stickyHunkContentInset || controller.stickyHunkBottomInset)) {
        this.removeStickyHunkNaturalSurface(controller);
        return;
      }
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (!state) {
        return;
      }
      let surface = controller.stickyHunkNaturalSurface;
      if (surface && (controller.stickyHunkNaturalState !== state ||
          controller.stickyHunkNaturalLayer?.parent !== geometry.parent ||
          surface.parentElement !== controller.stickyHunkNaturalLayer?.layer ||
          this.hunkStickyNaturalLayersByParent.get(geometry.parent) !== controller.stickyHunkNaturalLayer ||
          !surface.isConnected)) {
        this.removeStickyHunkNaturalSurface(controller);
        surface = null;
      }
      let record = this.hunkStickyNaturalLayersByParent.get(geometry.parent);
      if (!record?.layer.isConnected) {
        record?.layer.remove();
        const positionClassAdded = record?.positionClassAdded ||
          this.window.getComputedStyle(geometry.parent).position === "static";
        if (positionClassAdded) {
          geometry.parent.classList.add("hunkmark-sticky-hunk-container");
        }
        const layer = this.document.createElement("div");
        layer.className = "hunkmark-sticky-hunk-natural-layer";
        layer.setAttribute("data-hunkmark-ui", "true");
        layer.setAttribute("aria-hidden", "true");
        geometry.parent.append(layer);
        record = { layer, parent: geometry.parent, positionClassAdded };
        this.hunkStickyNaturalLayersByParent.set(geometry.parent, record);
      }
      if (!surface) {
        const source = controller.hunkRow.tagName === "TR"
          ? controller.hunkRow.closest("table") : controller.hunkRow.parentElement;
        surface = source?.cloneNode(false) ?? this.document.createElement("div");
        surface.removeAttribute("id");
        surface.removeAttribute("aria-label");
        surface.setAttribute("role", "presentation");
        surface.classList.add("hunkmark-sticky-hunk-natural-surface");
        record.layer.append(surface);
        controller.stickyHunkNaturalSurface = surface;
        controller.stickyHunkNaturalState = state;
        controller.stickyHunkNaturalLayer = record;
        controller.stickyHunkNaturalContentDirty = true;
      }
      if (controller.stickyHunkNaturalContentDirty) {
        this.rebuildStickyHunkNaturalSurface(controller, surface);
      }
      setSurfacePosition(surface, "width", geometry.width);
      setSurfacePosition(controller.stickyHunkNaturalRow, "height", geometry.height);
      setSurfacePosition(surface, "left", geometry.left);
      setSurfacePosition(surface, "top", geometry.top);
      const fileStart = state.fileElement.style.getPropertyValue("--hunkmark-sticky-hunk-file-start");
      if (surface.style.getPropertyValue("--hunkmark-sticky-hunk-file-start") !== fileStart) {
        surface.style.setProperty("--hunkmark-sticky-hunk-file-start", fileStart);
      }
      AUXILIARY_RANGES.forEach((property) => {
        const value = controller.hunkRow.style.getPropertyValue(property);
        if (controller.stickyHunkNaturalRow.style.getPropertyValue(property) !== value) {
          controller.stickyHunkNaturalRow.style.setProperty(property, value);
        }
      });
      (controller.stickyHunkNaturalAuxiliaries ?? []).forEach(({ source, target }) => {
        if (source && "disabled" in target && target.disabled !== source.disabled) {
          target.disabled = source.disabled;
        }
      });
    },
  });
})(globalThis);
