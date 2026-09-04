"use strict";

const STEP_KEY     = "wvc:step";
const MINVOL_KEY   = "wvc:minvol";
const REVERSE_KEY  = "wvc:reverse";
const DISABLED_KEY = "wvc:disabled";
const NIGHT_KEY    = "wvc:night";
const NIGHTVOL_KEY = "wvc:nightvol";

const DEFAULT_STEP     = 0.005;
const DEFAULT_MINVOL   = 0.0025;
const DEFAULT_NIGHTVOL = 0.01;

const stepEl    = document.getElementById("step");
const stepVal   = document.getElementById("stepVal");
const minEl     = document.getElementById("minvol");
const minVal    = document.getElementById("minVal");
const reverseEl = document.getElementById("reverse");
const siteEl    = document.getElementById("siteon");
const hostEl    = document.getElementById("host");
const nightEl   = document.getElementById("night");

const quickBlock = document.getElementById("quickBlock");
const quickTitle = document.getElementById("quickTitle");
const quickScope = document.getElementById("quickScope");
const quickHint  = document.getElementById("quickHint");
const quickVal   = document.getElementById("quickVal");
const presetsEl  = document.getElementById("presets");
const presetBtns = [...presetsEl.querySelectorAll("button")];

function fmt(pct) {
  let s;
  if (Math.round(pct) === pct) s = String(pct);
  else if (Math.round(pct * 10) === pct * 10) s = pct.toFixed(1);
  else s = pct.toFixed(2);
  return s + "%";
}

// the Min preset can sit at 0.125%, so this one carries a third decimal
function fmtVol(frac) {
  const p = Math.round(frac * 1000000) / 10000;
  if (Math.round(p) === p) return p + "%";
  if (Math.round(p * 10) === p * 10) return p.toFixed(1) + "%";
  if (Math.round(p * 100) === p * 100) return p.toFixed(2) + "%";
  return p.toFixed(3) + "%";
}

// ---- Night mode + quick presets ----
const state = {
  host: "", volKey: "", siteVol: null,
  nightOn: false, nightVol: DEFAULT_NIGHTVOL
};

// The buttons carry bare numbers to fit the popup width, so the full value
// lives in the tooltip.
presetBtns.forEach((b) => { b.title = fmtVol(parseFloat(b.dataset.p)); });

// Presets act on whatever is actually in effect: the global night level while
// night mode is on, this site's own volume otherwise.
function renderQuick() {
  const v = state.nightOn ? state.nightVol : state.siteVol;
  const noTarget = !state.nightOn && !state.host;

  quickBlock.classList.toggle("night-on", state.nightOn);
  quickTitle.textContent = state.nightOn ? "NIGHT LEVEL" : "VOLUME";
  quickScope.textContent = state.nightOn ? "all sites" : (state.host || "not available here");
  quickHint.textContent = state.nightOn ? "Applies everywhere until you switch it off"
                                        : "Or scroll on any player";
  quickVal.textContent = noTarget ? "—" : (v == null ? "site default" : fmtVol(v));

  presetBtns.forEach((b) => {
    const target = parseFloat(b.dataset.p);
    b.disabled = noTarget;
    b.classList.toggle("on", !noTarget && v != null && Math.abs(target - v) < 1e-6);
  });
}

presetsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  const v = parseFloat(btn.dataset.p);
  if (state.nightOn) {
    state.nightVol = v;
    chrome.storage.local.set({ [NIGHTVOL_KEY]: v });
  } else {
    state.siteVol = v;
    chrome.storage.local.set({ [state.volKey]: v });
  }
  renderQuick();
});

nightEl.addEventListener("change", () => {
  state.nightOn = nightEl.checked;
  chrome.storage.local.set({ [NIGHT_KEY]: state.nightOn });
  renderQuick();
});

// ---- Global Settings ----
chrome.storage.local.get(
  [STEP_KEY, MINVOL_KEY, REVERSE_KEY, NIGHT_KEY, NIGHTVOL_KEY],
  (res) => {
    const sFrac = typeof res[STEP_KEY] === "number" ? res[STEP_KEY] : DEFAULT_STEP;
    const mFrac = typeof res[MINVOL_KEY] === "number" ? res[MINVOL_KEY] : DEFAULT_MINVOL;
    const sPct = Math.round(sFrac * 1000) / 10;
    const mPct = Math.round(mFrac * 10000) / 100;

    stepEl.value = String(sPct);
    stepVal.textContent = fmt(sPct);
    minEl.value = String(mPct);
    minVal.textContent = fmt(mPct);

    reverseEl.checked = res[REVERSE_KEY] === true;

    state.nightOn = res[NIGHT_KEY] === true;
    if (typeof res[NIGHTVOL_KEY] === "number") state.nightVol = res[NIGHTVOL_KEY];
    nightEl.checked = state.nightOn;
    renderQuick();
  }
);

stepEl.addEventListener("input", () => {
  const pct = parseFloat(stepEl.value);
  stepVal.textContent = fmt(pct);
  chrome.storage.local.set({ [STEP_KEY]: pct / 100 });
});

minEl.addEventListener("input", () => {
  const pct = parseFloat(minEl.value);
  minVal.textContent = fmt(pct);
  chrome.storage.local.set({ [MINVOL_KEY]: pct / 100 });
});

reverseEl.addEventListener("change", () => {
  chrome.storage.local.set({ [REVERSE_KEY]: reverseEl.checked });
});


// ---- Per-site Settings ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  let host = "";
  try { host = new URL(tabs[0].url).hostname.replace(/^www\./, ""); } catch (e) {}

  if (!host) {
    hostEl.textContent = "not available here";
    siteEl.checked = true;
    siteEl.disabled = true;
    return;
  }

  hostEl.textContent = host;
  const VOL_KEY = "wvc:" + host;
  state.host = host;
  state.volKey = VOL_KEY;
  renderQuick();

  chrome.storage.local.get([DISABLED_KEY, VOL_KEY], (res) => {
    // Enable/Disable
    const list = Array.isArray(res[DISABLED_KEY]) ? res[DISABLED_KEY] : [];
    siteEl.checked = list.indexOf(host) === -1;

    if (typeof res[VOL_KEY] === "number") state.siteVol = res[VOL_KEY];
    renderQuick();
  });

  siteEl.addEventListener("change", () => {
    chrome.storage.local.get(DISABLED_KEY, (res) => {
      const list = Array.isArray(res[DISABLED_KEY]) ? res[DISABLED_KEY] : [];
      const i = list.indexOf(host);
      if (siteEl.checked) {
        if (i !== -1) list.splice(i, 1);
      } else {
        if (i === -1) list.push(host);
      }
      chrome.storage.local.set({ [DISABLED_KEY]: list });
    });
  });
});