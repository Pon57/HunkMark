"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    describeHostContextExpansionControl(control) {
      const label = control?.getAttribute("aria-label") ?? "";
      const expandsWholeFile = Boolean(
        control?.matches(".js-expand-all-difflines-button") ||
          /^Expand all lines:\s*\S/i.test(label),
      );
      const filePath = ["data-file-path", "data-path"]
        .map((attribute) =>
          this.trustedFilePath(control?.getAttribute(attribute)),
        )
        .find(Boolean) ??
        this.trustedFilePath(/^Expand all lines: (.+)$/i.exec(label)?.[1]);
      const normalizedLabel = label.trim().replace(/\s+/g, " ");
      return Object.freeze({
        control,
        expandsWholeFile,
        fileElement:
          control?.closest(
            this.constants.CURRENT_FILE_DIFF_REGION_SELECTOR,
          ) ??
          control?.closest(this.constants.FILE_CONTAINER_SELECTOR) ??
          control?.closest("article, details, section, [role=region]") ??
          null,
        filePath,
        identity: normalizedLabel
          ? `aria-label:${normalizedLabel}`
          : null,
      });
    },
  });
}
