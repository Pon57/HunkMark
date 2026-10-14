"use strict";

// The worker serves packaged styles and reconnects on install/update or a
// toolbar click. It does not poll tabs or observe navigation.
const reconnectingTabs = new Map();
let stylesheet;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "hunkmark:stylesheet" || sender.id !== chrome.runtime.id) {
    return false;
  }
  stylesheet ??= fetch(chrome.runtime.getURL("content.css")).then((response) => {
    if (!response.ok) throw new Error("Could not load the packaged stylesheet");
    return response.text();
  }).catch((error) => {
    stylesheet = null;
    throw error;
  });
  stylesheet.then(
    (css) => respond({ css, version: chrome.runtime.getManifest().version }),
    () => respond({ error: "Stylesheet unavailable" }),
  );
  return true;
});

async function prepareReconnect(version) {
  if (location.protocol !== "https:" || location.hostname !== "github.com") {
    return false;
  }
  // A missing ownership marker also occurs in tabs opened before installation.
  // Only block migration when a legacy HunkMark rule is actually still applied.
  if (document.documentElement.getAttribute("data-hunkmark-managed-styles") !== "1") {
    const probe = document.createElement("div");
    probe.className = "hunkmark-collapsed";
    probe.setAttribute("data-hunkmark-ui", "");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
    let legacyStyles;
    try {
      document.documentElement.append(probe);
      legacyStyles = getComputedStyle(probe).display === "none";
    } finally {
      probe.remove();
    }
    if (legacyStyles) return false;
  }
  const current = globalThis.HunkMarkContent?.activeApp;
  if (current?.runtimeVersion === version && current.navigationStarted &&
      !current.isExtensionContextInvalidated()) {
    if (!current.stopped && !current.reviewStylesElement?.isConnected) {
      current.scheduleRefresh({ immediate: true });
    }
    return false;
  }
  document.dispatchEvent(new Event("hunkmark:replace-runtime"));
  current?.stop();

  // Older releases did not listen for replacement. Give their invalidated DOM
  // observers a turn to stop and release their UI before mounting the new one.
  const marker = document.createComment("HunkMark reconnect");
  document.documentElement.append(marker);
  marker.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
}

async function injectRuntime(tabId) {
  const manifest = chrome.runtime.getManifest();
  const script = manifest.content_scripts[0];
  const [prepared] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: prepareReconnect,
    args: [manifest.version],
  });
  if (!prepared?.result || !prepared.documentId) {
    return;
  }
  // A full navigation during preparation must not redirect injection into a
  // different document. The API rejects if this document has already gone.
  const target = { tabId, documentIds: [prepared.documentId] };
  await chrome.scripting.executeScript({ target, world: "ISOLATED", files: script.js });
}

function reconnectTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return Promise.resolve();
  }
  if (!reconnectingTabs.has(tabId)) {
    const pending = injectRuntime(tabId).catch(() => {
      // Closed/navigated tabs and withheld site access are expected. Leave the
      // existing reload fallback available; never request additional access.
    }).finally(() => reconnectingTabs.delete(tabId));
    reconnectingTabs.set(tabId, pending);
  }
  return reconnectingTabs.get(tabId);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install" && reason !== "update") {
    return;
  }
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().host_permissions });
  await Promise.allSettled(tabs.map((tab) => reconnectTab(tab.id)));
});

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.url !== "string") {
    return;
  }
  const url = new URL(tab.url);
  if (url.protocol === "https:" && url.hostname === "github.com") {
    void reconnectTab(tab.id);
  }
});
