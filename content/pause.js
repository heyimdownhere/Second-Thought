/*
 * Second Thought: pause screen.
 *
 * Runs at document_start on sites from the list. It hides the page right
 * away, asks the background script whether this visit needs a pause, and
 * then either shows the pause screen or reveals the page again.
 */
(() => {
  "use strict";

  if (window.__secondThought) return;
  window.__secondThought = true;

  const DEFAULT_MESSAGE = "Is this really needed?";
  const RING_RADIUS = 54;
  const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

  let holding = false; // page hidden + media held
  let overlay = null; // { host, root, els, timer, ... }
  let heartbeatSite = null;
  let askOnReturn = false; // "Ask again when I switch back to the tab"
  let savedRootStyle = null;
  let mediaSweep = null;
  const heldMedia = new Map(); // element -> { muted, resume }

  const send = (msg) => browser.runtime.sendMessage(msg);

  /* ---------- hiding the page ---------- */

  function whenRoot(fn) {
    if (document.documentElement) return fn();
    const mo = new MutationObserver(() => {
      if (document.documentElement) {
        mo.disconnect();
        fn();
      }
    });
    mo.observe(document, { childList: true });
  }

  // Inline !important styles on <html>, set through CSSOM, so a strict page
  // CSP can't block them and site stylesheets can't override them.
  function hidePage() {
    const st = document.documentElement.style;
    if (!savedRootStyle) {
      savedRootStyle = ["visibility", "overflow"].map((p) => [
        p,
        st.getPropertyValue(p),
        st.getPropertyPriority(p),
      ]);
    }
    st.setProperty("visibility", "hidden", "important");
    st.setProperty("overflow", "hidden", "important");
  }

  function showPage() {
    if (!savedRootStyle || !document.documentElement) return;
    const st = document.documentElement.style;
    for (const [prop, value, priority] of savedRootStyle) {
      if (value) st.setProperty(prop, value, priority);
      else st.removeProperty(prop);
    }
    savedRootStyle = null;
  }

  /* ---------- holding media ---------- */

  function holdMedia(el) {
    let rec = heldMedia.get(el);
    if (!rec) {
      rec = { muted: el.muted, resume: !el.paused || el.autoplay };
      heldMedia.set(el, rec);
    } else if (!el.paused) {
      rec.resume = true;
    }
    if (!el.muted) el.muted = true;
    if (!el.paused) el.pause();
  }

  // Finds media in the document and inside shadow roots, including closed
  // ones (openOrClosedShadowRoot is available to Firefox content scripts).
  function sweepMedia(root) {
    for (const el of root.querySelectorAll("video, audio")) holdMedia(el);
    for (const el of root.querySelectorAll("*")) {
      const sr = el.openOrClosedShadowRoot || el.shadowRoot;
      if (sr && (!overlay || el !== overlay.host)) sweepMedia(sr);
    }
  }

  function onMediaEvent(e) {
    if (!holding) return;
    const el = e.target;
    if (el instanceof HTMLMediaElement) holdMedia(el);
  }

  function startMediaHold() {
    window.addEventListener("play", onMediaEvent, true);
    window.addEventListener("playing", onMediaEvent, true);
    window.addEventListener("volumechange", onMediaEvent, true);
    const sweep = () => {
      try {
        sweepMedia(document);
      } catch {
        // Ignore odd documents.
      }
    };
    sweep();
    mediaSweep = setInterval(sweep, 250);
  }

  function releaseMedia() {
    clearInterval(mediaSweep);
    mediaSweep = null;
    window.removeEventListener("play", onMediaEvent, true);
    window.removeEventListener("playing", onMediaEvent, true);
    window.removeEventListener("volumechange", onMediaEvent, true);
    for (const [el, rec] of heldMedia) {
      el.muted = rec.muted;
      if (rec.resume) {
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
    heldMedia.clear();
  }

  /* ---------- hold / release ---------- */

  function hold() {
    if (holding) return;
    holding = true;
    hidePage();
    startMediaHold();
  }

  function release() {
    if (!holding) return;
    holding = false;
    removeOverlay();
    showPage();
    releaseMedia();
  }

  /* ---------- the pause screen ---------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .screen {
      --bg: #f5f3ee; --fg: #1c1b1f; --muted: #6b6870; --track: #e2ded5;
      --accent: #4b49c8; --accent-fg: #ffffff; --ghost: rgba(28,27,31,.06);
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 32px 24px calc(32px + env(safe-area-inset-bottom));
      overflow: auto; overscroll-behavior: contain;
      background: var(--bg); color: var(--fg);
      font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased; text-align: center;
    }
    .screen.dark {
      --bg: #141317; --fg: #ecebf0; --muted: #9a97a3; --track: #2b2a31;
      --accent: #a6a4ff; --accent-fg: #15142a; --ghost: rgba(236,235,240,.08);
    }
    .card {
      width: 100%; max-width: 380px;
      display: flex; flex-direction: column; align-items: center;
      animation: in .35s ease-out both;
    }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    .site {
      font-size: 14px; letter-spacing: .02em; color: var(--muted);
      margin: 0 0 12px; word-break: break-all;
    }
    h1 {
      font-size: 28px; line-height: 1.25; font-weight: 650;
      margin: 0 0 36px; letter-spacing: -.01em; overflow-wrap: anywhere;
    }
    .ring { position: relative; width: 148px; height: 148px; margin-bottom: 40px; }
    .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 6; }
    .track { stroke: var(--track); }
    .bar {
      stroke: var(--accent); stroke-linecap: round;
      stroke-dasharray: ${RING_LENGTH.toFixed(2)};
      transition: stroke-dashoffset .12s linear;
    }
    .count {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 52px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .done .count { color: var(--accent); }
    button {
      all: unset; box-sizing: border-box; cursor: pointer;
      width: 100%; min-height: 54px; padding: 14px 20px; border-radius: 14px;
      font: inherit; font-size: 17px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
      transition: transform .1s ease, opacity .4s ease, background-color .2s ease;
    }
    button:active { transform: scale(.98); }
    button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    .nope { background: var(--accent); color: var(--accent-fg); }
    .continue {
      margin-top: 12px; color: var(--muted); font-weight: 500;
      visibility: hidden; opacity: 0;
    }
    .continue:hover { background: var(--ghost); }
    .continue.shown { visibility: visible; opacity: 1; }
    .hint { margin: 16px 0 0; font-size: 13px; color: var(--muted); min-height: 1.45em; }
    @media (max-height: 520px) {
      h1 { margin-bottom: 20px; }
      .ring { width: 110px; height: 110px; margin-bottom: 24px; }
      .count { font-size: 40px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      button, .bar { transition: none; }
    }
  `;

  // Tiny DOM builder (no innerHTML, so nothing from the page or settings is
  // ever parsed as markup).
  function h(tag, attrs, ...children) {
    const svg = tag === "svg" || tag === "circle";
    const el = svg
      ? document.createElementNS("http://www.w3.org/2000/svg", tag)
      : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of children) el.append(c);
    return el;
  }

  function buildScreen() {
    const circle = (cls) => h("circle", { class: cls, cx: "60", cy: "60", r: String(RING_RADIUS) });
    return h(
      "div",
      { class: "screen", role: "dialog", "aria-modal": "true", "aria-labelledby": "msg" },
      h(
        "div",
        { class: "card" },
        h("p", { class: "site" }),
        h("h1", { id: "msg" }),
        h(
          "div",
          { class: "ring", role: "timer", "aria-live": "off" },
          h("svg", { viewBox: "0 0 120 120", "aria-hidden": "true" }, circle("track"), circle("bar")),
          h("span", { class: "count" })
        ),
        h("button", { class: "nope", type: "button" }, "Nope, take me back"),
        h("button", { class: "continue", type: "button", tabindex: "-1" }, "Continue"),
        h("p", { class: "hint" })
      )
    );
  }

  function showOverlay(info) {
    if (overlay) return;

    const host = document.createElement("second-thought");
    const hs = host.style;
    for (const [prop, value] of [
      ["all", "initial"],
      ["display", "block"],
      ["position", "fixed"],
      ["inset", "0"],
      ["z-index", "2147483647"],
      ["visibility", "visible"],
      ["opacity", "1"],
      ["pointer-events", "auto"],
    ]) {
      hs.setProperty(prop, value, "important");
    }
    // Theme setting: "dark", "light", or "auto" (follow the system).
    const dark =
      info.theme === "dark" ||
      (info.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    hs.setProperty("background", dark ? "#141317" : "#f5f3ee", "important");

    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    root.appendChild(buildScreen());
    if (dark) root.querySelector(".screen").classList.add("dark");

    const $ = (sel) => root.querySelector(sel);
    const els = {
      card: $(".card"),
      site: $(".site"),
      msg: $("h1"),
      bar: $(".bar"),
      count: $(".count"),
      nope: $(".nope"),
      cont: $(".continue"),
      hint: $(".hint"),
    };
    els.site.textContent = info.site || location.hostname;
    els.msg.textContent = info.message || DEFAULT_MESSAGE;

    // Keep keystrokes from reaching the page's own shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    els.nope.addEventListener("click", onNope);
    els.cont.addEventListener("click", onContinue);

    overlay = { host, root, els, info, timer: null, shownAt: 0 };

    document.documentElement.appendChild(host);
    keepOnTop();
    startCountdown(Math.max(1, Number(info.seconds) || 10));
  }

  // Keep the host as the last child of <html> (so later page elements can't
  // stack above it) and put it back if a page script removes it.
  let keeper = null;
  function keepOnTop() {
    keeper = new MutationObserver(() => {
      if (!overlay) return;
      const html = document.documentElement;
      if (html && html.lastElementChild !== overlay.host) {
        html.appendChild(overlay.host);
      }
    });
    keeper.observe(document, { childList: true, subtree: false });
    keeper.observe(document.documentElement, { childList: true });
  }

  function removeOverlay() {
    if (!overlay) return;
    if (keeper) keeper.disconnect();
    keeper = null;
    stopCountdown();
    overlay.host.remove();
    overlay = null;
  }

  /* ---------- countdown (runs only while the tab is visible) ---------- */

  function startCountdown(seconds) {
    const o = overlay;
    stopCountdown();
    o.total = seconds * 1000;
    o.remaining = o.total;
    o.lastTick = performance.now();
    o.wasVisible = document.visibilityState === "visible";
    o.els.card.classList.remove("done");
    o.els.cont.classList.remove("shown");
    o.els.cont.tabIndex = -1;
    o.els.hint.textContent = "Continue appears when the timer ends.";
    renderCountdown();
    o.timer = setInterval(tick, 100);
    document.addEventListener("visibilitychange", tick);
  }

  function stopCountdown() {
    if (!overlay) return;
    clearInterval(overlay.timer);
    overlay.timer = null;
    document.removeEventListener("visibilitychange", tick);
  }

  function tick() {
    const o = overlay;
    if (!o || o.timer == null) return;
    const now = performance.now();
    const visible = document.visibilityState === "visible";
    // Count time only if the tab was visible for the whole interval. The cap
    // guards against throttled timers or a sleeping device.
    if (visible && o.wasVisible) {
      o.remaining -= Math.min(now - o.lastTick, 500);
    }
    o.lastTick = now;
    o.wasVisible = visible;
    renderCountdown();
    if (o.remaining <= 0) finishCountdown();
  }

  function renderCountdown() {
    const o = overlay;
    const left = Math.max(0, o.remaining);
    o.els.count.textContent = String(Math.ceil(left / 1000));
    o.els.bar.style.strokeDashoffset = String(RING_LENGTH * (1 - left / o.total));
  }

  function finishCountdown() {
    const o = overlay;
    stopCountdown();
    o.remaining = 0;
    renderCountdown();
    o.els.count.textContent = "✓";
    o.els.card.classList.add("done");
    o.els.cont.classList.add("shown");
    o.els.cont.tabIndex = 0;
    o.els.hint.textContent = "";
    o.shownAt = performance.now();
  }

  /* ---------- buttons ---------- */

  function onContinue() {
    const o = overlay;
    if (!o || !o.els.cont.classList.contains("shown")) return;
    // Ignore a tap that lands while the button is still fading in.
    if (performance.now() - o.shownAt < 300) return;
    const site = o.info.site;
    send({ type: "continue", site }).catch(() => {});
    release();
    startHeartbeat(site);
  }

  async function onNope() {
    const o = overlay;
    if (!o || o.leaving) return;
    o.leaving = true;
    o.els.nope.style.opacity = "0.6";

    // Pausing on a tab you switched back to: "back" would usually just be
    // another page of the same site, so leave by closing the tab instead.
    const canGoBack = !o.info.returning && history.length > 1;
    try {
      await send({ type: "nope", close: !canGoBack });
    } catch {
      // Background unreachable; still try to leave.
    }
    if (!canGoBack) return; // the background script closes the tab

    // history.back() can stay inside this document (when the site pushed
    // its own entries) or do nothing. In those cases, close the tab instead.
    let unloading = false;
    const markUnloading = () => (unloading = true);
    window.addEventListener("beforeunload", markUnloading, { once: true });
    window.addEventListener("pagehide", markUnloading, { once: true });
    const closeInstead = () => {
      if (!unloading) send({ type: "close" }).catch(() => {});
    };
    window.addEventListener("popstate", closeInstead, { once: true });
    setTimeout(closeInstead, 4000);
    history.back();
  }

  /* ---------- after the page is let through ---------- */

  // Keeps "away" mode's last-active time fresh, and handles switching back
  // to this tab.
  function startHeartbeat(site) {
    if (!site || heartbeatSite) return;
    heartbeatSite = site;
    const beat = () => {
      if (!holding) send({ type: "active", site }).catch(() => {});
    };
    const beatIfVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    beatIfVisible();
    setInterval(beatIfVisible, 30_000);
    window.addEventListener("pagehide", beat);

    document.addEventListener("visibilitychange", () => {
      if (holding) return;
      if (document.visibilityState === "hidden") {
        beat();
        // Hide now, so the page can't flash before the check on return.
        if (askOnReturn) hidePage();
      } else {
        checkOnReturn(beat);
      }
    });
  }

  async function checkOnReturn(beat) {
    let res = null;
    try {
      res = await send({ type: "check", host: location.hostname, reason: "return" });
    } catch {
      // Extension unreachable: just show the page.
    }
    if (res && typeof res.askOnReturn === "boolean") askOnReturn = res.askOnReturn;
    if (holding || document.visibilityState !== "visible") return;
    if (res && res.prompt) {
      hold();
      showOverlay({ ...res, returning: true });
    } else {
      showPage();
      beat();
    }
  }

  // Follow the setting live, so turning it on takes effect in open tabs.
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.askOnReturn) askOnReturn = !!changes.askOnReturn.newValue;
    });
  } catch {
    // storage API unavailable; the value from each check is used instead.
  }

  /* ---------- deciding ---------- */

  async function check() {
    hold();
    let res;
    try {
      res = await send({ type: "check", host: location.hostname });
    } catch {
      // Can't reach the extension (e.g. it was just updated). Err on the
      // side of pausing; Continue still works without the background.
      res = { prompt: true, site: location.hostname, seconds: 10, message: DEFAULT_MESSAGE };
    }
    if (res && typeof res.askOnReturn === "boolean") askOnReturn = res.askOnReturn;
    if (res && res.prompt) {
      showOverlay(res);
    } else {
      release();
      if (res && res.site) startHeartbeat(res.site);
    }
  }

  // Coming back to this page with the Back/Forward buttons counts as a new
  // visit. If the pause screen was still up, start its countdown over.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    if (overlay) {
      overlay.leaving = false;
      overlay.els.nope.style.opacity = "";
      startCountdown(Math.max(1, Number(overlay.info.seconds) || 10));
    } else {
      check();
    }
  });

  whenRoot(check);
})();
