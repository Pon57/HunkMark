"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    hostContextExpansionContextGroupIsIndependentlyAnchored(
      contextAnchors,
    ) {
      if (!Array.isArray(contextAnchors)) {
        return false;
      }
      const firstChangedIndex = contextAnchors.findIndex((anchor) =>
        anchor.startsWith("changed:"),
      );
      const lastChangedIndex = contextAnchors.findLastIndex((anchor) =>
        anchor.startsWith("changed:"),
      );
      return Boolean(
        firstChangedIndex > 0 &&
          lastChangedIndex < contextAnchors.length - 1 &&
          contextAnchors
            .slice(0, firstChangedIndex)
            .some((anchor) => anchor.startsWith("context:")) &&
          contextAnchors
            .slice(lastChangedIndex + 1)
            .some((anchor) => anchor.startsWith("context:")),
      );
    },

    captureFileReviewSnapshot(controllers, filePath) {
      const hunks = this.hostContextExpansionItemsInDocumentOrder(
        controllers,
        filePath,
      ).map((controller) =>
        Object.freeze({
          contextAnchors:
            controller.hostContextExpansionContextAnchors ??
            this.hostContextExpansionContextAnchorsForRows(
              controller.fileElement,
              controller.groupRows,
              controller.lines,
            ),
          headerText: controller.headerText,
          key: controller.key,
          lines: Object.freeze(
            controller.lines.map((line) =>
              Object.freeze({
                baselineContextFingerprint:
                  this.hostContextExpansionBaselineContext(line),
                contextFingerprint: line.contextFingerprint,
                key: line.key,
              }),
            ),
          ),
        }),
      );
      const contextAnchors = hunks.some(
        (hunk) => hunk.contextAnchors === null,
      )
        ? null
        : Object.freeze(hunks.flatMap((hunk) => hunk.contextAnchors));
      return Object.freeze({
        contextAnchors,
        hunks: Object.freeze(hunks),
        lineKeys: Object.freeze(
          hunks.flatMap((hunk) => hunk.lines.map((line) => line.key)),
        ),
      });
    },

    adoptStoredLineReviewBaselineInFileSnapshot(key, value) {
      const storedBaseline = this.storedLineReviewBaselineContext(value);
      if (
        !this.Core.isLineReviewStorageKey(key) ||
        !this.Core.isReviewIdentifier(value?.contextFingerprint) ||
        !storedBaseline ||
        storedBaseline === value.contextFingerprint
      ) {
        return false;
      }

      let adopted = false;
      this.fileReviewSnapshotsByKey.forEach((snapshot, snapshotKey) => {
        let changed = false;
        const hunks = snapshot.hunks.map((hunk) => {
          let hunkChanged = false;
          const lines = hunk.lines.map((line) => {
            if (
              line.key !== key ||
              line.contextFingerprint !== value.contextFingerprint ||
              line.baselineContextFingerprint === storedBaseline
            ) {
              return line;
            }
            changed = true;
            hunkChanged = true;
            return Object.freeze({
              ...line,
              baselineContextFingerprint: storedBaseline,
            });
          });
          return hunkChanged
            ? Object.freeze({ ...hunk, lines: Object.freeze(lines) })
            : hunk;
        });
        if (!changed) {
          return;
        }
        this.fileReviewSnapshotsByKey.set(
          snapshotKey,
          Object.freeze({ ...snapshot, hunks: Object.freeze(hunks) }),
        );
        adopted = true;
      });
      return adopted;
    },

    hostContextExpansionCachedFileSnapshot(filePath) {
      const snapshot = this.fileReviewSnapshotsByKey.get(
        this.fileProgressStateKey(filePath),
      );
      if (!snapshot?.hunks?.length) {
        return null;
      }
      const groups = snapshot.hunks.map((hunk) => ({
        contextAnchors: hunk.contextAnchors,
        headerText: hunk.headerText,
        independentlyAnchored:
          this.hostContextExpansionContextGroupIsIndependentlyAnchored(
            hunk.contextAnchors,
          ),
        lines: hunk.lines,
      }));
      if (
        groups.some(
          (group) =>
            !Array.isArray(group.contextAnchors) || group.lines.length === 0,
        ) ||
        !groups.some((group) => group.independentlyAnchored)
      ) {
        return null;
      }
      const lines = groups.flatMap((group) => group.lines);
      const lineReviewSnapshot = new Map();
      groups
        .filter((group) => group.independentlyAnchored)
        .flatMap((group) => group.lines)
        .forEach((line) => lineReviewSnapshot.set(line.key, line));
      return {
        cachedHunkGroups: groups.map(
          ({ contextAnchors, headerText, independentlyAnchored }) => ({
            contextAnchors,
            headerText,
            independentlyAnchored,
          }),
        ),
        fileContextAnchors: groups.flatMap((group) => group.contextAnchors),
        fileLineKeys: lines.map((line) => line.key),
        lineReviewSnapshot,
      };
    },

    hostContextExpansionCachedHunkGroupsVerdict(
      cachedHunkGroups,
      hunks,
      filePath,
    ) {
      if (!Array.isArray(cachedHunkGroups)) {
        return "rejected";
      }
      const fileHunks = hunks
        .filter((hunk) => hunk.filePath === filePath)
        .map((hunk, hunkIndex) => ({
          contextAnchors: this.hostContextExpansionContextAnchorsForRows(
            hunk.fileElement,
            hunk.groupRows,
            hunk.lines,
          ),
          hunk,
          hunkIndex,
        }));
      const hunkByChangedAnchor = new Map();
      const duplicateChangedAnchors = new Set();
      fileHunks.forEach((hunkEvidence) => {
        hunkEvidence.contextAnchors
          .filter((anchor) => anchor.startsWith("changed:"))
          .forEach((anchor) => {
            if (hunkByChangedAnchor.has(anchor)) {
              duplicateChangedAnchors.add(anchor);
            } else {
              hunkByChangedAnchor.set(anchor, hunkEvidence);
            }
          });
      });
      const mappings = cachedHunkGroups.map((cachedGroup) => {
        if (
          !Array.isArray(cachedGroup?.contextAnchors) ||
          typeof cachedGroup.headerText !== "string" ||
          typeof cachedGroup.independentlyAnchored !== "boolean"
        ) {
          return null;
        }
        const firstChangedAnchor = cachedGroup.contextAnchors.find((anchor) =>
          anchor.startsWith("changed:"),
        );
        const match = hunkByChangedAnchor.get(firstChangedAnchor);
        return match &&
          !duplicateChangedAnchors.has(firstChangedAnchor) &&
          this.hostContextExpansionPreservesContextAnchors(
            cachedGroup.contextAnchors,
            match.contextAnchors,
          )
          ? { cachedGroup, ...match }
          : null;
      });
      if (
        mappings.some((mapping) => mapping === null) ||
        mappings.some(
          (mapping, index) =>
            index > 0 &&
            mapping.hunkIndex < mappings[index - 1].hunkIndex,
        )
      ) {
        return "rejected";
      }

      const mappingsByHunk = new Map();
      mappings.forEach((mapping) => {
        const hunkMappings = mappingsByHunk.get(mapping.hunk) ?? [];
        hunkMappings.push(mapping);
        mappingsByHunk.set(mapping.hunk, hunkMappings);
      });
      let pending = false;
      const headersMatch = Array.from(mappingsByHunk).every(
        ([hunk, hunkMappings]) => {
          const firstCachedGroup = hunkMappings[0].cachedGroup;
          const cachedHeader = this.Core.findHunkHeader(
            firstCachedGroup.headerText,
          );
          const currentHeader = this.Core.findHunkHeader(hunk.headerText);
          if (!cachedHeader || !currentHeader) {
            return false;
          }
          const cachedSuffix =
            this.Core.hunkHeaderSemanticSuffix(cachedHeader);
          const currentSuffix =
            this.Core.hunkHeaderSemanticSuffix(currentHeader);
          if (cachedSuffix && !currentSuffix) {
            pending = true;
            return true;
          }
          return firstCachedGroup.independentlyAnchored
            ? this.Core.hunkHeadersSemanticallyCompatible(
                cachedHeader,
                currentHeader,
              )
            : cachedHeader === currentHeader;
        },
      );
      return headersMatch ? (pending ? "pending" : "matched") : "rejected";
    },

    attachCachedHostContextExpansionBaselines(hunks) {
      const hunksByFilePath = new Map();
      hunks.forEach((hunk) => {
        const fileHunks = hunksByFilePath.get(hunk.filePath) ?? [];
        fileHunks.push(hunk);
        hunksByFilePath.set(hunk.filePath, fileHunks);
      });

      let attached = false;
      hunksByFilePath.forEach((fileHunks, filePath) => {
        const snapshot = this.fileReviewSnapshotsByKey.get(
          this.fileProgressStateKey(filePath),
        );
        if (!snapshot || snapshot.hunks.length !== fileHunks.length) {
          return;
        }
        const exactCachedFile = fileHunks.every((hunk, hunkIndex) => {
          const cached = snapshot.hunks[hunkIndex];
          const currentAnchors =
            this.hostContextExpansionContextAnchorsForRows(
              hunk.fileElement,
              hunk.groupRows,
              hunk.lines,
            );
          const anchorsMatch =
            cached.contextAnchors === null
              ? currentAnchors === null
              : this.sameHostContextExpansionSequence(
                  cached.contextAnchors,
                  currentAnchors,
                );
          return (
            cached.key === hunk.key &&
            anchorsMatch &&
            cached.lines.length === hunk.lines.length &&
            hunk.lines.every((line, lineIndex) => {
              const cachedLine = cached.lines[lineIndex];
              const baseline = cachedLine.baselineContextFingerprint;
              return (
                cachedLine.key === line.key &&
                cachedLine.contextFingerprint === line.contextFingerprint &&
                (baseline === null ||
                  (this.Core.isReviewIdentifier(baseline) &&
                    baseline !== line.contextFingerprint))
              );
            })
          );
        });
        if (
          !exactCachedFile ||
          !snapshot.hunks.some((hunk) =>
            hunk.lines.some(
              (line) => line.baselineContextFingerprint !== null,
            ),
          )
        ) {
          return;
        }

        fileHunks.forEach((hunk, hunkIndex) => {
          hunk.lines.forEach((line, lineIndex) => {
            const baseline =
              snapshot.hunks[hunkIndex].lines[lineIndex]
                .baselineContextFingerprint;
            if (baseline !== null) {
              line.hostContextExpansionBaselineContextFingerprint = baseline;
              attached = true;
            }
          });
        });
      });
      return attached;
    },
  });
}
