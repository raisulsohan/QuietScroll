(() => {
  "use strict";

  const STEP_KEY     = "wvc:step";
  const MINVOL_KEY   = "wvc:minvol";
  const MODKEY_KEY   = "wvc:modkey";
  const REVERSE_KEY  = "wvc:reverse";
  const DISABLED_KEY = "wvc:disabled";
  const HOST         = location.hostname.replace(/^www\./, "");
  const VOL_KEY      = "wvc:" + HOST;
  const SITE_ALT_KEY = "wvc:alt:" + HOST;

  const DEFAULT_STEP   = 0.005;
  const DEFAULT_MINVOL = 0.0025;
  const EPS = 0.0005;
  const UNMUTE_COOLDOWN = 2500;   // ms: slow rate once an element's burst is spent
  const UNMUTE_BURST    = 3;      // unmute attempts allowed per playback session
  const UNMUTE_RETRY    = 300;    // ms between attempts inside a burst

  let step = DEFAULT_STEP;
  let minVol = DEFAULT_MINVOL;
  let modKeyRequired = false;
  let reverseWheel = false;
  let siteAltOverride = null;
  let siteEnabled = true;

  let ladder = [];
  let savedVolume = null;
  let overlayEl = null;
  let hideTimer = null;
  let mo = null;   // MutationObserver, assigned at the bottom

  // ---- context-invalidation guard --------------------------------------
  // When the extension is reloaded/updated, this old content script keeps
  // running in the tab but its chrome.* connection is dead. Calling
  // chrome.storage then throws "Extension context invalidated". Once we
  // detect that, shutdown() stops the script completely so it doesn't
  // linger as a zombie (observer/listeners still firing).
  let dead = false;
  function shutdown() {
    if (dead) return;
    dead = true;
    try { if (mo) mo.disconnect(); } catch (e) {}
  }
  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }
  function safeSet(obj) {
    if (dead || !extAlive()) { shutdown(); return; }
    try { chrome.storage.local.set(obj); }
    catch (e) { shutdown(); }
  }

  // ---- user-activation tracking ----
  let userActivated = false;
  function markActivated() { userActivated = true; }
  ["pointerdown", "mousedown", "keydown", "touchstart", "wheel"].forEach((evt) => {
    window.addEventListener(evt, markActivated, { capture: true, passive: true });
  });

  function canUnmute() {
    if (userActivated) return true;
    try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); }
    catch (e) { return false; }
  }

  // ---- consume Alt-up after Alt+wheel, so Chrome doesn't focus the menu bar
  // FIX: Chrome auto-repeats keydown while Alt is held. The old code cleared
  // altWasUsed on every keydown, so a repeat firing after the wheel wiped the
  // flag and keyup stopped suppressing the menu-bar focus. Only a fresh press
  // (e.repeat === false) starts a new Alt gesture.
  let altWasUsed = false;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Alt") return;
    if (e.repeat) {
      // mid-gesture repeat: keep the flag, and keep Chrome from arming the menu
      if (altWasUsed) e.preventDefault();
      return;
    }
    altWasUsed = false;
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && altWasUsed) {
      e.preventDefault();
      e.stopPropagation();
      altWasUsed = false;
    }
  }, true);

  function buildLadder() {
    const set = new Set([0, 1]);
    if (minVol > EPS && minVol < 1) {
      set.add(Math.round(minVol * 1000000) / 1000000);          // 0.25%
      set.add(Math.round(minVol * 0.75 * 1000000) / 1000000);   // 0.1875%
      set.add(Math.round(minVol * 0.5 * 1000000) / 1000000);    // 0.125%
    }
    for (let i = 1; ; i++) {
      const x = Math.round(i * step * 1000000) / 1000000;
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

  // Per-element unmute budget. The site (e.g. YouTube on a Mix/ad transition)
  // re-asserts mute; unconditionally unmuting back caused an infinite
  // volumechange <-> mute fight that froze the tab.
  //
  // A flat cooldown stopped the freeze but lost the first round every time: on
  // a Facebook feed reel we unmute at ~150ms, Facebook re-mutes at ~200ms, and
  // the cooldown then blocked every retry — so the first hover played silent
  // and only a second hover (past the cooldown) got sound.
  //
  // So the budget is a bounded burst instead: UNMUTE_BURST attempts spaced
  // UNMUTE_RETRY apart, which wins that exchange on the second attempt, then a
  // fallback to one attempt per UNMUTE_COOLDOWN. A site that insists on mute
  // costs us a few attempts, never an unbounded fight. Each play/playing hands
  // the element a fresh burst (see the reset below).
  function ensureUnmuted(m) {
    if (!canUnmute() || savedVolume === null || savedVolume === 0) return;
    if (!m.muted) return;

    const now = Date.now();
    const since = now - (m._qsLastUnmute || 0);
    const tries = m._qsUnmuteTries || 0;

    if (tries >= UNMUTE_BURST) {
      // burst spent: back to the slow, freeze-proof rate. No retry is armed
      // here, so the chain ends and only a fresh event can wake it up.
      if (since < UNMUTE_COOLDOWN) return;
    } else if (since < UNMUTE_RETRY) {
      scheduleUnmuteRetry(m);
      return;
    }

    m._qsLastUnmute = now;
    m._qsUnmuteTries = tries + 1;
    try { m.muted = false; } catch (e) {}
    // verify it stuck — the site may re-assert mute a moment later
    scheduleUnmuteRetry(m);
  }

  function scheduleUnmuteRetry(m) {
    if (m._qsRetryTimer) return;
    m._qsRetryTimer = setTimeout(() => {
      m._qsRetryTimer = null;
      if (dead || !siteEnabled) return;
      if (m.muted) ensureUnmuted(m);
    }, UNMUTE_RETRY);
  }

  function applyToAll() {
    if (dead) return;
    if (!siteEnabled || savedVolume == null) {
      syncToMainWorld(null);
      return;
    }
    syncToMainWorld(savedVolume);
    document.querySelectorAll("video, audio").forEach(ensureUnmuted);
  }

  // single document-wide pass: re-broadcast the locked volume + unmute (throttled)
  function scanAndApply() {
    if (dead || !siteEnabled || savedVolume == null) return;
    syncToMainWorld(savedVolume);
    document.querySelectorAll("video, audio").forEach(ensureUnmuted);
  }

  // ---- volume responds instantly every notch; only the storage write is debounced ----
  let saveTimer = null;
  function persistVol(v) {
    savedVolume = v;
    syncToMainWorld(v);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      safeSet({ [VOL_KEY]: savedVolume });
    }, 200);
  }
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (savedVolume != null) safeSet({ [VOL_KEY]: savedVolume });
    }
  }
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  try {
    chrome.storage.local.get(
      [STEP_KEY, MINVOL_KEY, MODKEY_KEY, REVERSE_KEY, DISABLED_KEY, VOL_KEY, SITE_ALT_KEY],
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (typeof res[STEP_KEY] === "number") step = res[STEP_KEY];
        if (typeof res[MINVOL_KEY] === "number") minVol = res[MINVOL_KEY];
        modKeyRequired = res[MODKEY_KEY] === true;
        reverseWheel = res[REVERSE_KEY] === true;
        if (res[SITE_ALT_KEY] !== undefined) siteAltOverride = res[SITE_ALT_KEY];
        siteEnabled = !siteOff(res[DISABLED_KEY]);
        buildLadder();

        if (typeof res[VOL_KEY] === "number") {
          savedVolume = res[VOL_KEY];
        }
        applyToAll();
      }
    );
  } catch (e) { shutdown(); }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (dead || area !== "local") return;
    let rebuild = false;

    if (changes[STEP_KEY] && typeof changes[STEP_KEY].newValue === "number") {
      step = changes[STEP_KEY].newValue; rebuild = true;
    }
    if (changes[MINVOL_KEY] && typeof changes[MINVOL_KEY].newValue === "number") {
      minVol = changes[MINVOL_KEY].newValue; rebuild = true;
    }
    if (changes[MODKEY_KEY]) { modKeyRequired = changes[MODKEY_KEY].newValue === true; }
    if (changes[REVERSE_KEY]) { reverseWheel = changes[REVERSE_KEY].newValue === true; }
    if (changes[SITE_ALT_KEY]) {
      siteAltOverride = changes[SITE_ALT_KEY].newValue ?? null;
    }

    if (changes[DISABLED_KEY]) {
      siteEnabled = !siteOff(changes[DISABLED_KEY].newValue);
      applyToAll();
    }
    if (rebuild) buildLadder();
  });

  // ---- SMART MEDIA FINDER ----
  function mediaAtPoint(x, y) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      if (el.tagName === "VIDEO" || el.tagName === "AUDIO") return el;
    }
    return null;
  }

  // fallback for audio-only sites (YouTube Music, Suno, etc) where the
  // media element exists in DOM but isn't where the cursor is. returns
  // the first playing media, or any media with a loaded source.
  function findActiveMedia() {
    const all = document.querySelectorAll("video, audio");
    for (const m of all) {
      if (!m.paused && !m.ended && m.readyState > 0) return m;
    }
    for (const m of all) {
      if (m.readyState > 0 || m.src || m.currentSrc) return m;
    }
    return null;
  }

  function fmtPct(v) {
    // Kill float dust first (e.g. 0.29*100 = 28.999999999999996)
    // by rounding to 4 decimal places — the most we ever display.
    const p = Math.round(v * 1000000) / 10000;
    if (Math.round(p) === p) return String(p);
    if (Math.round(p * 10) === p * 10) return p.toFixed(1);
    if (Math.round(p * 100) === p * 100) return p.toFixed(2);
    if (Math.round(p * 1000) === p * 1000) return p.toFixed(3);
    return p.toFixed(4);
  }

  function showOverlay(v, x, y) {
    const host = document.fullscreenElement || document.body;
    if (!host) return;
    if (!overlayEl || overlayEl.parentNode !== host) {
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = document.createElement("div");
      overlayEl.style.cssText = [
        "position:fixed", "z-index:2147483647",
        "padding:8px 18px",
        "background:rgba(0,0,0,.82)", "color:#fff",
        "font:600 15px/1 -apple-system,Segoe UI,Roboto,sans-serif",
        "border-radius:8px", "pointer-events:none",
        "transition:opacity .25s", "opacity:0"
      ].join(";");
      host.appendChild(overlayEl);
    }
    overlayEl.textContent = (v === 0 ? "\uD83D\uDD07 " : "\uD83D\uDD0A ") + fmtPct(v) + "%";

    // ---- mouse-relative positioning ----
    const margin = 12;
    const gap = 18;
    const w = overlayEl.offsetWidth || 90;
    const h = overlayEl.offsetHeight || 32;
    // default: above cursor, horizontally centered
    let left = x;
    let top = y - gap;
    let transform = "translate(-50%, -100%)";
    // flip below if too close to viewport top
    if (top - h < margin) {
      top = y + gap;
      transform = "translate(-50%, 0)";
    }
    // clamp horizontally so the box stays inside the viewport
    const halfW = w / 2;
    if (left - halfW < margin) left = halfW + margin;
    if (left + halfW > window.innerWidth - margin) left = window.innerWidth - halfW - margin;
    overlayEl.style.left = left + "px";
    overlayEl.style.top = top + "px";
    overlayEl.style.transform = transform;

    requestAnimationFrame(() => { if (overlayEl) overlayEl.style.opacity = "1"; });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overlayEl) overlayEl.style.opacity = "0"; }, 900);
  }

  // ---- blur-pause safety net --------------------------------------------
  // Some sites (Facebook) pause playback as soon as the page loses focus. If
  // the Alt suppression above ever fails to hold — other extensions, a browser
  // build that arms the menu on keydown — the video would stop mid-scroll and
  // need a manual click. So after an Alt+wheel change on media that was
  // playing, a pause arriving within RESUME_WINDOW is treated as not the
  // user's doing and undone. A real click/keypress after the scroll cancels
  // the guard, so pausing by hand still works.
  const RESUME_WINDOW = 1500;
  let resumeTarget = null;
  let resumeUntil = 0;
  let resumeArmedAt = 0;
  let lastUserInputAt = 0;

  ["pointerdown", "mousedown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, () => { lastUserInputAt = Date.now(); },
      { capture: true, passive: true });
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Alt") lastUserInputAt = Date.now();
  }, { capture: true, passive: true });

  document.addEventListener("pause", (e) => {
    if (dead || !siteEnabled) return;
    const t = e.target;
    if (t !== resumeTarget || t.ended) return;
    if (Date.now() > resumeUntil || lastUserInputAt > resumeArmedAt) {
      resumeTarget = null;
      return;
    }
    resumeTarget = null;
    try {
      const p = t.play();
      if (p && p.catch) p.catch(() => {});
    } catch (err) {}
  }, true);

  function onWheel(e) {
    if (dead || !siteEnabled) return;

    const requiresAlt = siteAltOverride !== null ? siteAltOverride : modKeyRequired;
    if (requiresAlt && !e.altKey) return;

    let media = mediaAtPoint(e.clientX, e.clientY);
    // Alt held + no media at cursor → fall back to any active media on the page
    // (audio-only sites where the media element is hidden)
    if (!media && e.altKey) media = findActiveMedia();
    if (!media) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      altWasUsed = true;
      if (!media.paused && !media.ended) {
        resumeTarget = media;
        resumeArmedAt = Date.now();
        resumeUntil = resumeArmedAt + RESUME_WINDOW;
      }
    }

    const cur = savedVolume !== null ? savedVolume : (media.volume || 0);
    let idx = 0, best = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - cur);
      if (d < best) { best = d; idx = i; }
    }
    let dir = e.deltaY < 0 ? 1 : -1;
    if (reverseWheel) dir = -dir;
    idx = Math.min(ladder.length - 1, Math.max(0, idx + dir));
    const v = ladder[idx];

    persistVol(v);
    ensureUnmuted(media);
    showOverlay(v, e.clientX, e.clientY);
  }
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });

  // ---- SPA navigation (YouTube page change) ----
  document.addEventListener('yt-navigate-finish', () => {
    if (dead || !siteEnabled || savedVolume == null) return;
    setTimeout(scanAndApply, 500);
  });

  document.addEventListener("volumechange", (e) => {
    if (dead || !siteEnabled || savedVolume == null) return;
    const t = e.target;
    if (t.tagName !== "VIDEO" && t.tagName !== "AUDIO") return;
    if (Math.abs(t.volume - savedVolume) > EPS) {
      syncToMainWorld(savedVolume);
    }
    ensureUnmuted(t);
  }, true);

  // ---- FIX: playback events are debounced into ONE coalesced pass.
  // Previously each of 5 events fired syncToMainWorld separately -> a burst of
  // querySelectorAll work during load. Now a load burst triggers one pass. ----
  let playbackTimer = null;
  function onPlaybackEvent() {
    if (dead || !siteEnabled || savedVolume == null) return;
    clearTimeout(playbackTimer);
    playbackTimer = setTimeout(scanAndApply, 150);
  }
  ["loadstart", "canplay", "play", "playing", "loadedmetadata"].forEach((evt) => {
    document.addEventListener(evt, onPlaybackEvent, true);
  });

  // Each new playback session gets a fresh unmute burst, so a feed preview that
  // is hovered again — or a reel the site swapped in — starts from a clean
  // budget instead of inheriting the slow rate from the previous one.
  ["play", "playing"].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      const t = e.target;
      if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) t._qsUnmuteTries = 0;
    }, true);
  });

  // ---- MutationObserver: O(1) callback, single debounced full scan ----
  let moTimer = null;
  mo = new MutationObserver(() => {
    if (dead || !siteEnabled || savedVolume == null) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(scanAndApply, 500);
  });
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
