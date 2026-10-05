(function attachHunkMarkStickyHunkNatural(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  const Sticky = namespace?.stickyHunk;
  if (!App || !Sticky) {
    return;
  }
  const { AUXILIARY_SELECTOR } = Sticky;
  const NATIVE_CONTROL_SELECTOR = [
    "a", "button", "input", "select", "textarea", "label", "summary",
    '[role="button"]', "[tabindex]", '[contenteditable="true"]',
  ].join(", ");
  const AUXILIARY_RANGES = [
    "--hunkmark-sticky-hunk-auxiliary-start",
    "--hunkmark-sticky-hunk-auxiliary-end",
  ];
  const hostClasses = (value) => (value ?? "").split(/\s+/)
    .filter((name) => name && !name.startsWith("hunkmark-")).join(" ");
  const hostStyles = (style) => Array.from(style)
    .filter((property) => !property.startsWith("--hunkmark-"))
    .map((property) => `${property}:${style.getPropertyValue(property)}:${style.getPropertyPriority(property)}`)
    .join(";");
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
      controller.stickyHunkNaturalContentObserver?.disconnect();
      controller.stickyHunkNaturalContentObserver = null;
      controller.stickyHunkNaturalSurface?.remove();
      controller.stickyHunkNaturalSurface = null;
      controller.stickyHunkNaturalRow = null;
      controller.stickyHunkNaturalState = null;
      controller.stickyHunkNaturalLayer = null;
      controller.stickyHunkNaturalControls = [];
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

    observeStickyHunkNaturalContent(controller, surface) {
      controller.stickyHunkNaturalContentObserver = new this.window.MutationObserver((mutations) => {
        if (this.stopped || controller.stickyHunkNaturalSurface !== surface || !surface.isConnected) {
          return;
        }
        let previousStyle;
        const contentChanged = mutations.some((mutation) => {
          if (this.mutationIsExtensionOnly(mutation)) return false;
          if (mutation.type !== "attributes") return true;
          const current = mutation.target.getAttribute(mutation.attributeName);
          if (mutation.oldValue === current) return false;
          if (mutation.attributeName === "class") {
            return hostClasses(mutation.oldValue) !== hostClasses(current);
          }
          if (mutation.attributeName === "style") {
            previousStyle ??= this.document.createElement("span").style;
            previousStyle.cssText = mutation.oldValue ?? "";
            return hostStyles(previousStyle) !== hostStyles(mutation.target.style);
          }
          return true;
        });
        if (contentChanged) {
          controller.stickyHunkNaturalContentDirty = true;
          this.scheduleStickyHunkLayout();
        }
      });
      controller.stickyHunkNaturalContentObserver.observe(controller.hunkRow, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        subtree: true,
      });
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
      // Detach copies before insertion: they must neither join a native form
      // nor uncheck an original radio, including radios with no form owner.
      row.querySelectorAll("button, input, select, textarea, fieldset, object, output")
        .forEach((element) => {
          element.setAttribute("form", "");
          element.removeAttribute("name");
        });
      row.querySelectorAll(NATIVE_CONTROL_SELECTOR)
        .forEach((element) => { element.tabIndex = -1; });
      row.addEventListener("click", (event) => {
        const selection = this.window.getSelection();
        if (selection && !selection.isCollapsed) {
          return;
        }
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

      // Keep auxiliary targets first so expansion snapshots and icon clicks
      // still use the original native target. Shared button ancestors get one
      // listener, even when both an icon and the button match these selectors.
      const pairs = [AUXILIARY_SELECTOR, NATIVE_CONTROL_SELECTOR].flatMap((selector) => {
        const sources = Array.from(sourceRow.querySelectorAll(selector))
          .filter((element) => !element.closest("[data-hunkmark-ui]"));
        return Array.from(row.querySelectorAll(selector), (target, index) => ({
          source: sources[index], target,
        }));
      });
      const boundControls = new Set();
      controller.stickyHunkNaturalControls = pairs.flatMap(({ source, target }) => {
        const sourceControl = source?.closest(NATIVE_CONTROL_SELECTOR) ?? source;
        const targetControl = target.closest(NATIVE_CONTROL_SELECTOR) ?? target;
        if (!sourceControl || boundControls.has(targetControl)) return [];
        boundControls.add(targetControl);
        targetControl.addEventListener("mousedown", (event) => event.preventDefault());
        targetControl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.button !== 0 || !this.reviewControllerIsCurrent(controller) ||
              !source?.isConnected || sourceControl.matches(":disabled")) {
            return;
          }
          // The dispatched native event is synthetic, so capture the source
          // snapshot explicitly before GitHub can replace its diff rows.
          this.captureHostContextExpansionControl(source.closest(
            this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
          ));
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
          // Native inputs can change properties without attribute mutations.
          // Rebuild from the real control after its default activation settles.
          controller.stickyHunkNaturalContentDirty = true;
          this.scheduleStickyHunkLayout();
        });
        return [{ source: sourceControl, target: targetControl }];
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

    syncStickyHunkNaturalParentPosition(record, state, { refreshLayout = false } = {}) {
      const parent = record.parent;
      const parentClass = Array.from(parent.classList)
        .filter((value) => value !== "hunkmark-sticky-file-measuring" && value !== "hunkmark-sticky-hunk-container")
        .join(" ");
      const parentPosition = parent.style.position;
      let changed = false;
      if (refreshLayout || record.positionParentClass !== parentClass || record.positionParentPosition !== parentPosition) {
        if (record.positionClassAdded) {
          parent.classList.remove("hunkmark-sticky-hunk-container");
        }
        record.positionParentClass = parentClass;
        record.positionParentPosition = parentPosition;
        const nativePosition = this.window.getComputedStyle(parent).position;
        record.positionClassAdded = nativePosition === "static";
        const position = record.positionClassAdded ? "relative" : nativePosition;
        changed = record.positionValue !== undefined && record.positionValue !== position;
        record.positionValue = position;
        if (changed) this.markStickyHunkOriginsDirty(state);
      }
      if (record.positionClassAdded && !parent.classList.contains("hunkmark-sticky-hunk-container")) {
        parent.classList.add("hunkmark-sticky-hunk-container");
      }
      return changed;
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
        const positionClassAdded = record?.positionClassAdded ?? false;
        const layer = this.document.createElement("div");
        layer.className = "hunkmark-sticky-hunk-natural-layer";
        layer.setAttribute("data-hunkmark-ui", "true");
        layer.setAttribute("aria-hidden", "true");
        geometry.parent.append(layer);
        record = { layer, parent: geometry.parent, positionClassAdded };
        this.hunkStickyNaturalLayersByParent.set(geometry.parent, record);
      }
      if (this.syncStickyHunkNaturalParentPosition(record, state)) {
        this.scheduleStickyHunkLayout();
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
        this.observeStickyHunkNaturalContent(controller, surface);
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
      (controller.stickyHunkNaturalControls ?? []).forEach(({ source, target }) => {
        if (source && "disabled" in target && target.disabled !== source.disabled) {
          target.disabled = source.disabled;
        }
      });
    },
  });
})(globalThis);
