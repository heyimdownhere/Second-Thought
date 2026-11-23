"use strict";

/*
 * Second Thought: background (event page).
 *
 * Everything is read from storage when it's needed. Nothing important lives
 * in globals, because Firefox may unload this page at any time.
 *
 * storage.local:   sites, seconds, message, mode, awayMinutes, turnedBack,
 *                  "active:<site>" (last time a visible tab was on <site>)
 * storage.session: "allow:<tabId>" (the site this tab already got past)
 */

const DEFAULTS = {
  sites: [],
  seconds: 10,
  message: "Is this really needed?",
  mode: "every", // "every" | "away"
  awayMinutes: 15,
  turnedBack: 0,
};

const SCRIPT_PREFIX = "site:";

/* ---------- helpers ---------- */

function patternFor(site) {
  // "*.reddit.com" matches reddit.com itself and every subdomain.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(site) ? `*://${site}/*` : `*://*.${site}/*`;
}

function siteForHost(host, sites) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  let best = null;
  for (const site of sites) {
    if ((host === site || host.endsWith("." + site)) && (!best || site.length > best.length)) {
      best = site;
    }
  }
  return best;
}

function siteForUrl(url, sites) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? siteForHost(u.hostname, sites) : null;
  } catch {
    return null;
  }
}

const allowKey = (tabId) => `allow:${tabId}`;
const activeKey = (site) => `active:${site}`;

async function getSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  if (!Array.isArray(s.sites)) s.sites = [];
  return s;
}

/* ---------- content script registration ---------- */

// Serialize syncs so overlapping events (e.g. storage + permission changes)
// don't race each other. This is just a queue; losing it is harmless.
let syncQueue = Promise.resolve();
function syncRegistrations() {
  syncQueue = syncQueue.then(doSync).catch((e) => console.error("Second Thought: sync failed", e));
  return syncQueue;
}

async function doSync() {
  const { sites } = await getSettings();

  const wanted = new Map(); // id -> match pattern
  for (const site of sites) {
    const pattern = patternFor(site);
    if (await browser.permissions.contains({ origins: [pattern] })) {
      wanted.set(SCRIPT_PREFIX + site, pattern);
    }
  }

  const existing = (await browser.scripting.getRegisteredContentScripts())
    .filter((s) => s.id.startsWith(SCRIPT_PREFIX));

  const stale = existing
    .filter((s) => wanted.get(s.id) !== (s.matches || [])[0])
    .map((s) => s.id);
  if (stale.length) {
    await browser.scripting.unregisterContentScripts({ ids: stale });
  }

  const kept = new Set(existing.map((s) => s.id).filter((id) => !stale.includes(id)));
  const toAdd = [...wanted]
    .filter(([id]) => !kept.has(id))
    .map(([id, pattern]) => ({
      id,
      matches: [pattern],
      js: ["content/pause.js"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    }));
  if (toAdd.length) {
    await browser.scripting.registerContentScripts(toAdd);
  }
}

/* ---------- visit logic ---------- */

async function handleCheck(host, tabId) {
  const s = await getSettings();
  const site = siteForHost(host, s.sites);
  if (!site) return { prompt: false };

  let prompt = true;
  if (s.mode === "away") {
    const key = activeKey(site);
    const { [key]: last = 0 } = await browser.storage.local.get(key);
    prompt = Date.now() - last > s.awayMinutes * 60_000;
  } else if (tabId != null) {
    const key = allowKey(tabId);
    const { [key]: allowed } = await browser.storage.session.get(key);
    prompt = allowed !== site;
  }

  return {
    prompt,
    site,
    seconds: s.seconds,
    message: String(s.message || "").trim() || DEFAULTS.message,
  };
}

async function handleContinue(site, tabId) {
  const { sites } = await getSettings();
  if (!sites.includes(site)) return;
  const writes = [browser.storage.local.set({ [activeKey(site)]: Date.now() })];
  if (tabId != null) writes.push(browser.storage.session.set({ [allowKey(tabId)]: site }));
  await Promise.all(writes);
}

async function markActive(site) {
  const { sites } = await getSettings();
  if (sites.includes(site)) {
    await browser.storage.local.set({ [activeKey(site)]: Date.now() });
  }
}

async function handleNope(tabId, closeTab) {
  const { turnedBack } = await browser.storage.local.get({ turnedBack: 0 });
  await browser.storage.local.set({ turnedBack: (Number(turnedBack) || 0) + 1 });
  if (closeTab) await closeTabSafely(tabId);
}

async function closeTabSafely(tabId) {
  if (tabId == null) return;
  try {
    await browser.tabs.remove(tabId);
  } catch {
    // Tab already gone.
  }
}

/* ---------- top-level event handlers ---------- */

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab ? sender.tab.id : undefined;
  switch (msg && msg.type) {
    case "check":
      return handleCheck(msg.host, tabId);
    case "continue":
      return handleContinue(msg.site, tabId);
    case "active":
      return markActive(msg.site);
    case "nope":
      return handleNope(tabId, !!msg.close);
    case "close":
      return closeTabSafely(tabId);
  }
  return undefined;
});

// A tab that leaves the site loses its "already continued" pass.
browser.tabs.onUpdated.addListener(
  async (tabId, changeInfo) => {
    if (!changeInfo.url) return;
    const key = allowKey(tabId);
    const { [key]: allowed } = await browser.storage.session.get(key);
    if (!allowed) return;
    const { sites } = await getSettings();
    if (siteForUrl(changeInfo.url, sites) !== allowed) {
      await browser.storage.session.remove(key);
    }
  },
  { properties: ["url"] }
);

browser.tabs.onRemoved.addListener((tabId) => {
  browser.storage.session.remove(allowKey(tabId));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sites) syncRegistrations();
});

browser.permissions.onAdded.addListener(() => syncRegistrations());
browser.permissions.onRemoved.addListener(() => syncRegistrations());

browser.runtime.onStartup.addListener(() => syncRegistrations());

browser.runtime.onInstalled.addListener((details) => {
  syncRegistrations();
  if (details.reason === "install") {
    browser.runtime.openOptionsPage();
  }
});
