"use strict";

/* Second Thought: settings (also the toolbar popup). Every change saves itself. */

const DEFAULTS = {
  sites: [],
  seconds: 10,
  message: "Is this really needed?",
  mode: "every",
  awayMinutes: 15,
  turnedBack: 0,
};
const PRESETS = [5, 10, 30, 60];

const $ = (id) => document.getElementById(id);
const els = {
  form: $("add-form"),
  siteInput: $("site-input"),
  siteError: $("site-error"),
  list: $("site-list"),
  empty: $("sites-empty"),
  presets: [...document.querySelectorAll("[data-seconds]")],
  custom: $("custom-seconds"),
  message: $("message"),
  modes: [...document.querySelectorAll('input[name="mode"]')],
  awayMinutes: $("away-minutes"),
  counter: $("counter"),
  toast: $("toast"),
};

let state = { ...DEFAULTS };
let granted = new Set(); // sites whose host permission is granted

/* ---------- helpers ---------- */

function patternFor(site) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(site) ? `*://${site}/*` : `*://*.${site}/*`;
}

// "https://www.reddit.com/r/foo" -> "reddit.com". Returns null if unusable.
function normalizeSite(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*\./, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
  let host;
  try {
    const url = new URL(s);
    if (!/^https?:$/.test(url.protocol)) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\d*\./, "");
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // also rejects IPv6
  if (!host.includes(".") && host !== "localhost") return null;
  if (host.split(".").some((part) => !part)) return null;
  return host;
}

const save = (values) => browser.storage.local.set(values).then(() => toast("Saved"));

function debounce(fn, ms) {
  let t;
  const run = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  run.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return run;
}

let toastTimer;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function clampInt(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/* ---------- sites ---------- */

function showSiteError(text) {
  els.siteError.textContent = text;
  els.siteError.hidden = !text;
  els.siteInput.setAttribute("aria-invalid", text ? "true" : "false");
}

function onAdd(e) {
  e.preventDefault();
  const site = normalizeSite(els.siteInput.value);
  if (!site) {
    showSiteError(els.siteInput.value.trim() ? "That doesn't look like a site. Try something like reddit.com." : "");
    els.siteInput.focus();
    return;
  }
  if (state.sites.includes(site)) {
    showSiteError(`${site} is already on your list.`);
    return;
  }
  const parent = state.sites.find((s) => site.endsWith("." + s));
  if (parent) {
    showSiteError(`Already covered by ${parent}.`);
    return;
  }

  // Adding reddit.com makes an existing old.reddit.com redundant.
  const covered = state.sites.filter((s) => s.endsWith("." + site));
  const next = state.sites.filter((s) => !covered.includes(s)).concat(site);

  // Both calls start synchronously, inside the click/Enter. permissions.request
  // needs the user gesture, and on desktop the popup may close while
  // Firefox shows the prompt. The site is already saved, and the background
  // script registers it as soon as the permission is granted.
  const saved = browser.storage.local.set({ sites: next });
  const asked = browser.permissions.request({ origins: [patternFor(site)] });

  state.sites = next;
  els.siteInput.value = "";
  showSiteError("");
  renderSites();
  for (const s of covered) dropSiteData(s);

  Promise.all([saved, asked]).then(
    ([, ok]) => {
      if (ok) granted.add(site);
      renderSites();
      toast(ok ? `Added ${site}` : `${site} needs permission`);
    },
    () => refreshPermissions().then(() => toast(`${site} needs permission`))
  );
}

function grant(site) {
  browser.permissions.request({ origins: [patternFor(site)] }).then((ok) => {
    if (ok) {
      granted.add(site);
      renderSites();
      toast(`${site} is ready`);
    }
  });
}

function removeSite(site) {
  state.sites = state.sites.filter((s) => s !== site);
  browser.storage.local.set({ sites: state.sites });
  dropSiteData(site);
  renderSites();
  toast(`Removed ${site}`);
  els.siteInput.focus();
}

function dropSiteData(site) {
  browser.storage.local.remove(`active:${site}`);
  browser.permissions.remove({ origins: [patternFor(site)] }).catch(() => {});
  granted.delete(site);
}

async function refreshPermissions() {
  const results = await Promise.all(
    state.sites.map((s) => browser.permissions.contains({ origins: [patternFor(s)] }))
  );
  granted = new Set(state.sites.filter((_, i) => results[i]));
  renderSites();
}

function renderSites() {
  const items = state.sites.map((site) => {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "site-main";
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site;
    main.append(name);

    if (!granted.has(site)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "grant";
      btn.textContent = "Needs permission · tap to grant";
      btn.addEventListener("click", () => grant(site));
      main.append(btn);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove ${site}`);
    remove.addEventListener("click", () => removeSite(site));

    li.append(main, remove);
    return li;
  });
  els.list.replaceChildren(...items);
  els.empty.hidden = state.sites.length > 0;
}

/* ---------- wait time ---------- */

function renderSeconds() {
  const isPreset = PRESETS.includes(state.seconds);
  for (const b of els.presets) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.seconds) === state.seconds));
  }
  if (document.activeElement !== els.custom) {
    els.custom.value = isPreset ? "" : String(state.seconds);
    els.custom.removeAttribute("aria-invalid");
  }
  els.custom.classList.toggle("active", !isPreset);
}

for (const b of els.presets) {
  b.addEventListener("click", () => {
    state.seconds = Number(b.dataset.seconds);
    els.custom.value = "";
    renderSeconds();
    save({ seconds: state.seconds });
  });
}

const saveCustomSeconds = debounce(() => {
  if (els.custom.value === "") return;
  const n = clampInt(els.custom.value, 1, 3600);
  els.custom.setAttribute("aria-invalid", n ? "false" : "true");
  if (!n || n === state.seconds) return;
  state.seconds = n;
  renderSeconds();
  save({ seconds: n });
}, 600);

els.custom.addEventListener("input", saveCustomSeconds);
els.custom.addEventListener("blur", () => {
  saveCustomSeconds.flush();
  renderSeconds();
});

/* ---------- message ---------- */

const saveMessage = debounce(() => {
  const value = els.message.value.trim();
  if (value === state.message) return;
  state.message = value;
  save({ message: value });
}, 600);

els.message.addEventListener("input", saveMessage);
els.message.addEventListener("blur", () => {
  if (!els.message.value.trim()) els.message.value = DEFAULTS.message;
  saveMessage.flush();
});

/* ---------- when to ask ---------- */

function renderMode() {
  for (const r of els.modes) r.checked = r.value === state.mode;
  els.awayMinutes.disabled = state.mode !== "away";
  if (document.activeElement !== els.awayMinutes) {
    els.awayMinutes.value = String(state.awayMinutes);
    els.awayMinutes.removeAttribute("aria-invalid");
  }
}

for (const r of els.modes) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.mode = r.value;
    renderMode();
    save({ mode: state.mode });
    if (state.mode === "away") {
      els.awayMinutes.focus();
      els.awayMinutes.select();
    }
  });
}

const saveMinutes = debounce(() => {
  const n = clampInt(els.awayMinutes.value, 1, 1440);
  els.awayMinutes.setAttribute("aria-invalid", n ? "false" : "true");
  if (!n || n === state.awayMinutes) return;
  state.awayMinutes = n;
  save({ awayMinutes: n });
}, 600);

els.awayMinutes.addEventListener("input", saveMinutes);
els.awayMinutes.addEventListener("blur", () => {
  saveMinutes.flush();
  renderMode();
});

/* ---------- counter ---------- */

function renderCounter() {
  const n = state.turnedBack;
  els.counter.textContent = `You've turned back ${n} ${n === 1 ? "time" : "times"}.`;
}

/* ---------- wiring ---------- */

function renderAll() {
  renderSites();
  renderSeconds();
  if (document.activeElement !== els.message) els.message.value = state.message;
  renderMode();
  renderCounter();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let sitesChanged = false;
  for (const key of Object.keys(DEFAULTS)) {
    if (key in changes) {
      state[key] = changes[key].newValue ?? DEFAULTS[key];
      if (key === "sites") sitesChanged = true;
    }
  }
  renderAll();
  if (sitesChanged) refreshPermissions();
});

browser.permissions.onAdded.addListener(refreshPermissions);
browser.permissions.onRemoved.addListener(refreshPermissions);

els.form.addEventListener("submit", onAdd);
els.siteInput.addEventListener("input", () => showSiteError(""));

(async function init() {
  state = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  if (!Array.isArray(state.sites)) state.sites = [];
  renderAll();
  await refreshPermissions();
  if (!state.sites.length) els.siteInput.focus();
})();
