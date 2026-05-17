(() => {
  "use strict";

  const STEP_KEY     = "wvc:step";
  const MINVOL_KEY   = "wvc:minvol";
  const MODKEY_KEY   = "wvc:modkey";
  const DISABLED_KEY = "wvc:disabled";
  const HOST    = location.hostname.replace(/^www\./, "");
  const VOL_KEY = "wvc:" + HOST;
  const DEFAULT_STEP   = 0.005;
  const DEFAULT_MINVOL = 0.0025;
  const EPS = 0.0005;

  let step = DEFAULT_STEP;
  let minVol = DEFAULT_MINVOL;
  let modKeyRequired = false;
  let siteEnabled = true;
  let ladder = [];
  let savedVolume = null;
  let overlayEl = null;
  let hideTimer = null;

  // ---- user-activation tracking ----
  let userActivated = false;
  function markActivated() { userActivated = true; }
  // রিলস স্ক্রল করার সময় মাউস হুইলকেও একটিভিটি হিসেবে ধরা হলো
  ["pointerdown", "mousedown", "keydown", "touchstart", "wheel"].forEach((evt) => {
    window.addEventListener(evt, markActivated, { capture: true, passive: true });
  });
  function canUnmute() {
    if (userActivated) return true;
    try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); }
    catch (e) { return false; }
  }

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

  function syncToMainWorld(v) {
    window.dispatchEvent(new CustomEvent('qs-set-vol', { detail: v }));
  }

  // জোর করে মিউট খোলার ফাংশন
  function ensureUnmuted(m) {
    if (!canUnmute() || savedVolume === null || savedVolume === 0) return;
    if (m.muted) {
      try { m.muted = false; } catch (e) {}
    }
  }

  function applyToAll() {
    if (!siteEnabled || savedVolume == null) {
      syncToMainWorld(null);
      return;
    }
    syncToMainWorld(savedVolume);
    document.querySelectorAll("video, audio").forEach(ensureUnmuted);
  }

  function persistVol(v) {
    savedVolume = v;
    chrome.storage.local.set({ [VOL_KEY]: v });
    syncToMainWorld(v);
  }

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
      }
      applyToAll();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let rebuild = false;
    if (changes[STEP_KEY]) { step = changes[STEP_KEY].newValue; rebuild = true; }
    if (changes[MINVOL_KEY]) { minVol = changes[MINVOL_KEY].newValue; rebuild = true; }
    if (changes[MODKEY_KEY]) { modKeyRequired = changes[MODKEY_KEY].newValue === true; }
    if (changes[DISABLED_KEY]) {
      siteEnabled = !siteOff(changes[DISABLED_KEY].newValue);
      applyToAll();
    }
    if (rebuild) buildLadder();
  });

  function mediaAtPoint(x, y) {
    const medias = document.querySelectorAll("video, audio");
    for (const m of medias) {
      const r = m.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m;
    }
    const audios = [...medias].filter((m) => m.tagName === "AUDIO");
    return audios.length === 1 ? audios[0] : null;
  }

  function fmtPct(v) {
    const p = v * 100;
    if (Math.round(p) === p) return String(p);
    if (Math.round(p * 10) === p * 10) return p.toFixed(1);
    return p.toFixed(2);
  }

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

  function onWheel(e) {
    if (!siteEnabled) return;
    const media = mediaAtPoint(e.clientX, e.clientY);
    if (!media) return;
    if (modKeyRequired && !e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const cur = savedVolume !== null ? savedVolume : (media.volume || 0);
    let idx = 0, best = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - cur);
      if (d < best) { best = d; idx = i; }
    }
    const dir = e.deltaY < 0 ? 1 : -1;
    idx = Math.min(ladder.length - 1, Math.max(0, idx + dir));
    const v = ladder[idx];

    persistVol(v);
    ensureUnmuted(media);
    showOverlay(v);
  }
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });

  document.addEventListener("volumechange", (e) => {
    if (!siteEnabled || savedVolume == null) return;
    const t = e.target;
    if (t.tagName !== "VIDEO" && t.tagName !== "AUDIO") return;
    
    if (Math.abs(t.volume - savedVolume) > EPS) {
       syncToMainWorld(savedVolume);
    }
    // ওয়েবসাইট মিউট করলেও জোর করে খুলে দেওয়া হবে
    ensureUnmuted(t);
  }, true);

  ["loadstart", "canplay", "play", "playing", "loadedmetadata"].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (!siteEnabled || savedVolume == null) return;
      const t = e.target;
      if (t.tagName === "VIDEO" || t.tagName === "AUDIO") {
         syncToMainWorld(savedVolume);
         ensureUnmuted(t);
      }
    }, true);
  });

  const mo = new MutationObserver((muts) => {
    if (!siteEnabled || savedVolume == null) return;
    let foundNewMedia = false;
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches("video, audio")) {
          foundNewMedia = true;
        } else if (node.querySelectorAll && node.querySelector("video, audio")) {
          foundNewMedia = true;
        }
      }
    }
    if (foundNewMedia) {
      syncToMainWorld(savedVolume);
      document.querySelectorAll("video, audio").forEach(ensureUnmuted);
    }
  });
  
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();