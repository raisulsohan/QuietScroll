(() => {
  "use strict";

  const STEP_KEY     = "wvc:step";
  const MINVOL_KEY   = "wvc:minvol";
  const REVERSE_KEY  = "wvc:reverse";
  const DISABLED_KEY = "wvc:disabled";
  const NIGHT_KEY    = "wvc:night";      // global on/off
  const NIGHTVOL_KEY = "wvc:nightvol";   // the level night mode holds
  const HOST         = location.hostname.replace(/^www\./, "");
  const VOL_KEY      = "wvc:" + HOST;

  const DEFAULT_STEP     = 0.005;
  const DEFAULT_MINVOL   = 0.0025;
  const DEFAULT_NIGHTVOL = 0.01;
  const EPS = 0.0005;
  const UNMUTE_COOLDOWN = 2500;   // ms: slow rate once an element's burst is spent
  const UNMUTE_BURST    = 3;      // unmute attempts allowed per playback session
  const UNMUTE_RETRY    = 300;    // ms between attempts inside a burst

  let step = DEFAULT_STEP;
  let minVol = DEFAULT_MINVOL;
  let reverseWheel = false;
  let siteEnabled = true;
  let nightOn = false;
  let nightVol = DEFAULT_NIGHTVOL;

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
  // FIX: "wheel" used to be in this list, but scrolling does NOT grant user
  // activation in Chrome -- the activation-triggering events are keydown,
  // mousedown, pointerdown, pointerup, touchend and click. On a
  // scroll-only visit (x.com timeline) the flag said "activated", we unmuted
  // an autoplaying video, and Chrome refused and PAUSED it instead:
  // "Unmuting failed and the element was paused instead...". So the list only
  // holds real activation events now, and navigator.userActivation -- the
  // authority Chrome itself uses -- is consulted first.
  let userActivated = false;
  let activationEpoch = 0;
  function markActivated() { userActivated = true; activationEpoch++; }
  ["pointerdown", "mousedown", "keydown", "touchend", "click"].forEach((evt) => {
    window.addEventListener(evt, markActivated, { capture: true, passive: true });
  });

  function canUnmute() {
    try {
      if (navigator.userActivation) return !!navigator.userActivation.hasBeenActive;
    } catch (e) {}
    return userActivated;
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
      set.add(Math.round(minVol * 1.5 * 1000000) / 1000000);   // 0.375%
      set.add(Math.round(minVol * 0.75 * 1000000) / 1000000);  // 0.1875%
      set.add(Math.round(minVol * 0.5 * 1000000) / 1000000);   // 0.125%
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

  // ---- night mode -------------------------------------------------------
  // While it is on, one global level overrides every site's own volume. The
  // per-site values are never rewritten, so switching night mode off restores
  // each site exactly where it was — no backup bookkeeping, nothing to lose.
  // Night mode also applies on sites that have no saved volume yet, which is
  // the point: at night everything is quiet, not just the sites you've tuned.
  function effVol() {
    if (nightOn) return nightVol;
    return savedVolume;
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
    const target = effVol();
    if (!canUnmute() || target === null || target === 0) return;
    if (!m.muted) return;
    // Chrome already refused this element since the last real interaction;
    // asking again only repeats the error and re-pauses the video.
    if (m._qsBlockedAt === activationEpoch) return;

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
    const wasPlaying = !m.paused;
    try { m.muted = false; } catch (e) {}
    // verify it stuck — the site may re-assert mute a moment later
    scheduleUnmuteRetry(m);
    if (wasPlaying) verifyUnmute(m);
  }

  // Even with the activation check above, Chrome can still refuse an unmute
  // (an iframe with no activation of its own, a site with low media
  // engagement). Its refusal pauses the element, which is worse than leaving it
  // muted — so if playback stopped on the very next task, undo our change and
  // put the element back the way we found it: playing, muted.
  function verifyUnmute(m) {
    setTimeout(() => {
      if (dead || !m.paused || m.ended) return;
      m._qsBlockedAt = activationEpoch;
      try { m.muted = true; } catch (e) {}
      try {
        const p = m.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    }, 0);
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
    const v = effVol();
    if (!siteEnabled || v == null) {
      syncToMainWorld(null);
      return;
    }
    syncToMainWorld(v);
    document.querySelectorAll("video, audio").forEach(ensureUnmuted);
  }

  // single document-wide pass: re-broadcast the locked volume + unmute (throttled)
  function scanAndApply() {
    const v = effVol();
    if (dead || !siteEnabled || v == null) return;
    syncToMainWorld(v);
    document.querySelectorAll("video, audio").forEach(ensureUnmuted);
  }

  // ---- volume responds instantly every notch; only the storage write is debounced ----
  // The wheel writes whatever is currently in effect: the night level while
  // night mode is on, this site's own volume otherwise. So scrolling during
  // night mode tunes the night level instead of silently editing a site value
  // that isn't even being applied.
  let saveTimer = null;
  function writeVol() {
    if (nightOn) {
      if (nightVol != null) safeSet({ [NIGHTVOL_KEY]: nightVol });
    } else if (savedVolume != null) {
      safeSet({ [VOL_KEY]: savedVolume });
    }
  }
  function persistVol(v) {
    if (nightOn) nightVol = v;
    else savedVolume = v;
    syncToMainWorld(v);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeVol();
    }, 200);
  }
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      writeVol();
    }
  }
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  try {
    chrome.storage.local.get(
      [STEP_KEY, MINVOL_KEY, REVERSE_KEY, DISABLED_KEY, VOL_KEY,
       NIGHT_KEY, NIGHTVOL_KEY],
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (typeof res[STEP_KEY] === "number") step = res[STEP_KEY];
        if (typeof res[MINVOL_KEY] === "number") minVol = res[MINVOL_KEY];
        reverseWheel = res[REVERSE_KEY] === true;
        siteEnabled = !siteOff(res[DISABLED_KEY]);
        nightOn = res[NIGHT_KEY] === true;
        if (typeof res[NIGHTVOL_KEY] === "number") nightVol = res[NIGHTVOL_KEY];
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
    if (changes[REVERSE_KEY]) { reverseWheel = changes[REVERSE_KEY].newValue === true; }

    let reapply = false;
    if (changes[DISABLED_KEY]) {
      siteEnabled = !siteOff(changes[DISABLED_KEY].newValue);
      reapply = true;
    }
    // night mode + the popup's quick presets reach us through storage, so both
    // take effect in open tabs without a reload
    if (changes[NIGHT_KEY]) {
      nightOn = changes[NIGHT_KEY].newValue === true;
      reapply = true;
    }
    if (changes[NIGHTVOL_KEY] && typeof changes[NIGHTVOL_KEY].newValue === "number") {
      nightVol = changes[NIGHTVOL_KEY].newValue;
      if (nightOn) reapply = true;
    }
    if (changes[VOL_KEY] && typeof changes[VOL_KEY].newValue === "number") {
      savedVolume = changes[VOL_KEY].newValue;
      if (!nightOn) reapply = true;
    }

    if (reapply) applyToAll();
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
    // \uD83C\uDF19 while night mode holds the level, so it is obvious that the wheel is
    // tuning the global night level and not just this site
    const icon = v === 0 ? "\uD83D\uDD07" : (nightOn ? "\uD83C\uDF19" : "\uD83D\uDD0A");
    overlayEl.textContent = icon + " " + fmtPct(v) + "%";

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

    if (!e.altKey) return;

    let media = mediaAtPoint(e.clientX, e.clientY);
    // Alt is always held — fall back to any active media on the page
    // (audio-only sites where the media element is hidden)
    if (!media) media = findActiveMedia();
    if (!media) return;

    e.preventDefault();
    e.stopPropagation();
    altWasUsed = true;
    if (!media.paused && !media.ended) {
      resumeTarget = media;
      resumeArmedAt = Date.now();
      resumeUntil = resumeArmedAt + RESUME_WINDOW;
    }

    const held = effVol();
    const cur = held !== null ? held : (media.volume || 0);
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
    if (dead || !siteEnabled || effVol() == null) return;
    setTimeout(scanAndApply, 500);
  });

  document.addEventListener("volumechange", (e) => {
    const target = effVol();
    if (dead || !siteEnabled || target == null) return;
    const t = e.target;
    if (t.tagName !== "VIDEO" && t.tagName !== "AUDIO") return;
    if (Math.abs(t.volume - target) > EPS) {
      syncToMainWorld(target);
    }
    ensureUnmuted(t);
  }, true);

  // ---- FIX: playback events are debounced into ONE coalesced pass.
  // Previously each of 5 events fired syncToMainWorld separately -> a burst of
  // querySelectorAll work during load. Now a load burst triggers one pass. ----
  let playbackTimer = null;
  function onPlaybackEvent() {
    if (dead || !siteEnabled || effVol() == null) return;
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
    if (dead || !siteEnabled || effVol() == null) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(scanAndApply, 500);
  });
  if (document.documentElement) {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
