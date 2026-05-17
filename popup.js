"use strict";

const STEP_KEY     = "wvc:step";
const MINVOL_KEY   = "wvc:minvol";
const MODKEY_KEY   = "wvc:modkey";
const DISABLED_KEY = "wvc:disabled";

const stepEl  = document.getElementById("step");
const stepVal = document.getElementById("stepVal");
const minEl   = document.getElementById("minvol");
const minVal  = document.getElementById("minVal");
const modEl   = document.getElementById("modkey");
const siteEl  = document.getElementById("siteon");
const hostEl  = document.getElementById("host");

function fmt(pct) {
  let s;
  if (Math.round(pct) === pct) s = String(pct);
  else if (Math.round(pct * 10) === pct * 10) s = pct.toFixed(1);
  else s = pct.toFixed(2);
  return s + "%";
}

// ---- sliders + Alt modifier ----
chrome.storage.local.get([STEP_KEY, MINVOL_KEY, MODKEY_KEY], (res) => {
  const sFrac = typeof res[STEP_KEY] === "number" ? res[STEP_KEY] : 0.005;
  const mFrac = typeof res[MINVOL_KEY] === "number" ? res[MINVOL_KEY] : 0.0025;
  const sPct = Math.round(sFrac * 1000) / 10;     // 0.005 -> 0.5
  const mPct = Math.round(mFrac * 10000) / 100;   // 0.0025 -> 0.25
  stepEl.value = String(sPct);
  stepVal.textContent = fmt(sPct);
  minEl.value = String(mPct);
  minVal.textContent = fmt(mPct);
  modEl.checked = res[MODKEY_KEY] === true;
});

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

modEl.addEventListener("change", () => {
  chrome.storage.local.set({ [MODKEY_KEY]: modEl.checked });
});

// ---- per-site enable / disable ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  let host = "";
  try { host = new URL(tabs[0].url).hostname.replace(/^www\./, ""); } catch (e) {}

  if (!host) {                                   // chrome://, extension pages, etc.
    hostEl.textContent = "not available here";
    siteEl.checked = true;
    siteEl.disabled = true;
    return;
  }

  hostEl.textContent = host;

  chrome.storage.local.get(DISABLED_KEY, (res) => {
    const list = Array.isArray(res[DISABLED_KEY]) ? res[DISABLED_KEY] : [];
    siteEl.checked = list.indexOf(host) === -1;  // checked = enabled
  });

  siteEl.addEventListener("change", () => {
    chrome.storage.local.get(DISABLED_KEY, (res) => {
      const list = Array.isArray(res[DISABLED_KEY]) ? res[DISABLED_KEY] : [];
      const i = list.indexOf(host);
      if (siteEl.checked) {
        if (i !== -1) list.splice(i, 1);         // enable -> remove from disabled list
      } else {
        if (i === -1) list.push(host);           // disable -> add to disabled list
      }
      chrome.storage.local.set({ [DISABLED_KEY]: list });
    });
  });
});
