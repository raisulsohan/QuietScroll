(() => {
  "use strict";

  // ---- keys & defaults ----
  const STEP_KEY     = "wvc:step";                                  // global step (fraction)
  const MINVOL_KEY   = "wvc:minvol";                                // global min volume (fraction)
  const MODKEY_KEY   = "wvc:modkey";                                // global: require Alt (boolean)
  const DISABLED_KEY = "wvc:disabled";                              // array of disabled hostnames
  const HOST    = location.hostname.replace(/^www\./, "");
  const VOL_KEY = "wvc:" + HOST;                                    // per-domain volume
  const DEFAULT_STEP   = 0.005;                                     // 0.5% per notch
  const DEFAULT_MINVOL = 0.0025;                                    // 0.25% lowest non-zero stop
  const EPS = 0.0005;                                               // float-compare tolerance

  let step = DEFAULT_STEP;
  let minVol = DEFAULT_MINVOL;
  let modKeyRequired = false;      // when true, wheel changes volume only while Alt is held
  let siteEnabled = true;          // false -> extension does nothing on this domain
  let ladder = [];                 // sorted list of reachable volume values
  let savedVolume = null;          // 0..1, remembered per domain
  let overlayEl = null;
  let hideTimer = null;

  // ---- user-activation tracking ----
  // Browsers block programmatic unmute of an autoplaying element before the user
  // has interacted with the document. We only unmute once a real gesture happened.
  let userActivated = false;
  function markActivated() { userActivated = true; }
  ["pointerdown", "mousedown", "keydown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, markActivated, { capture: true, passive: true });
  });
  function canUnmute() {
    if (userActivated) return true;
    try {
      return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
    } catch (e) {
      return false;
    }
  }

  // ---- the volume "ladder": 0 -> minVol -> step -> 2*step -> ... -> 1 ----
  function buildLadder() {
    const set = new Set([0, 1]);
    if (minVol > EPS && minVol < 1) set.add(Math.round(minVol * 10000) / 10000);
    for (let i = 1; ; i++) {
      const x = Math.round(i * step * 10000) / 10000;
      if (x >= 1) break;
      set.add(x);
    }
    ladder = [...set].sort((a, b) => a - b);
  }
  buildLadder();

  function siteOff(list) {
    return Array.isArray(list) && list.indexOf(HOST) !== -1;
  }

  // ---- load settings ----
  chrome.storage.local.get(
    [STEP_KEY, MINVOL_KEY, MODKEY_KEY, DISABLED_KEY, VOL_KEY],
    (res) => {
      if (typeof res[STEP_KEY] === "number") step = res[STEP_KEY];
      if (typeof res[MINVOL_KEY] === "number") minVol = res[MINVOL_KEY];
      modKeyRequired = res[MODKEY_KEY] === true;
      siteEnabled = !siteOff(res[DISABLED_KEY]);
      buildLadder();
      if (typeof res[VOL_KEY] === "number") {
        savedVolume = res[VOL_KEY];
        enforceAll();
      }
    }
  );

  // live-update when popup settings change
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let rebuild = false;
    if (changes[STEP_KEY] && typeof changes[STEP_KEY].newValue === "number") {
      step = changes[STEP_KEY].newValue; rebuild = true;
    }
    if (changes[MINVOL_KEY] && typeof changes[MINVOL_KEY].newValue === "number") {
      minVol = changes[MINVOL_KEY].newValue; rebuild = true;
    }
    if (changes[MODKEY_KEY]) {
      modKeyRequired = changes[MODKEY_KEY].newValue === true;
    }
    if (changes[DISABLED_KEY]) {
      siteEnabled = !siteOff(changes[DISABLED_KEY].newValue);
    }
    if (rebuild) buildLadder();
  });

  // ---- helpers ----
  function persistVol(v) {
    savedVolume = v;
    chrome.storage.local.set({ [VOL_KEY]: v });
  }

  // Write the volume only when it actually differs -> makes the guard below
  // self-stabilising. Unmute only when the autoplay policy allows it.
  function applyVol(media, v) {
    try {
      if (Math.abs(media.volume - v) > EPS) media.volume = v;
      if (media.muted && v > 0 && canUnmute()) media.muted = false;
    } catch (e) { /* some custom players block direct access */ }
  }

  function enforceAll() {
    if (!siteEnabled || savedVolume == null) return;
    document.querySelectorAll("video, audio").forEach((m) => applyVol(m, savedVolume));
  }

  // find the media element under the cursor (rect-based: survives player overlays)
  function mediaAtPoint(x, y) {
    const medias = document.querySelectorAll("video, audio");
    for (const m of medias) {
      const r = m.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;            // <audio> has no box
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m;
    }
    const audios = [...medias].filter((m) => m.tagName === "AUDIO");
    return audios.length === 1 ? audios[0] : null;              // audio-only page fallback
  }

  function fmtPct(v) {
    const p = v * 100;
    if (Math.round(p) === p) return String(p);
    if (Math.round(p * 10) === p * 10) return p.toFixed(1);
    return p.toFixed(2);
  }

  // ---- on-screen indicator (re-parents into the fullscreen element when needed) ----
  function showOverlay(v) {
    const host = document.fullscreenElement || document.body;
    if (!host) return;
    if (!overlayEl || overlayEl.parentNode !== host) {
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = document.createElement("div");
      overlayEl.style.cssText = [
        "position:fixed", "z-index:2147483647", "top:24px", "left:50%",
        "transform:translateX(-50%)", "padding:8px 18px",
        "background:rgba(0,0,0,.82)", "color:#fff",
        "font:600 15px/1 -apple-system,Segoe UI,Roboto,sans-serif",
        "border-radius:8px", "pointer-events:none",
        "transition:opacity .25s", "opacity:0"
      ].join(";");
      host.appendChild(overlayEl);
    }
    overlayEl.textContent = (v === 0 ? "\uD83D\uDD07 " : "\uD83D\uDD0A ") + fmtPct(v) + "%";
    requestAnimationFrame(() => { if (overlayEl) overlayEl.style.opacity = "1"; });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overlayEl) overlayEl.style.opacity = "0"; }, 900);
  }

  // ---- wheel handler: step along the ladder ----
  function onWheel(e) {
    if (!siteEnabled) return;                    // extension off for this domain
    const media = mediaAtPoint(e.clientX, e.clientY);
    if (!media) return;                          // not over a player -> page scrolls normally
    if (modKeyRequired && !e.altKey) return;     // Alt required but not held -> let page scroll

    e.preventDefault();
    e.stopPropagation();

    const cur = media.volume || 0;
    // locate the ladder rung nearest to the current volume
    let idx = 0, best = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - cur);
      if (d < best) { best = d; idx = i; }
    }
    const dir = e.deltaY < 0 ? 1 : -1;           // wheel up = louder
    idx = Math.min(ladder.length - 1, Math.max(0, idx + dir));
    const v = ladder[idx];

    persistVol(v);                               // update memory first...
    applyVol(media, v);                          // ...then set it
    showOverlay(v);
  }
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });

  // ---- THE GUARD ----
  // Sites like Facebook Reels / TikTok re-assert their own volume on loop, scroll
  // and reload. Every such change fires 'volumechange'; we catch it and snap back.
  document.addEventListener("volumechange", (e) => {
    if (!siteEnabled || savedVolume == null) return;
    const t = e.target;
    if (t.tagName !== "VIDEO" && t.tagName !== "AUDIO") return;
    if (Math.abs(t.volume - savedVolume) > EPS || (t.muted && savedVolume > 0)) {
      applyVol(t, savedVolume);
    }
  }, true);

  // re-apply on playback start / metadata load -> covers reel loop & replay
  ["play", "playing", "loadedmetadata", "loadeddata"].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (!siteEnabled || savedVolume == null) return;
      const t = e.target;
      if (t.tagName === "VIDEO" || t.tagName === "AUDIO") applyVol(t, savedVolume);
    }, true);
  });

  // catch players inserted later (feed scrolling, SPA navigation)
  const mo = new MutationObserver((muts) => {
    if (!siteEnabled || savedVolume == null) return;
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches("video, audio")) {
          applyVol(node, savedVolume);
        } else if (node.querySelectorAll) {
          node.querySelectorAll("video, audio").forEach((m) => applyVol(m, savedVolume));
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
