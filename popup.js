"use strict";

const STEP_KEY     = "wvc:step";
const MINVOL_KEY   = "wvc:minvol";
const MODKEY_KEY   = "wvc:modkey";
const REVERSE_KEY  = "wvc:reverse";
const DISABLED_KEY = "wvc:disabled";

const stepEl    = document.getElementById("step");
const stepVal   = document.getElementById("stepVal");
const minEl     = document.getElementById("minvol");
const minVal    = document.getElementById("minVal");
const reverseEl = document.getElementById("reverse");
const modEl     = document.getElementById("modkey");
const siteEl    = document.getElementById("siteon");
const siteAltEl = document.getElementById("sitealt");
const hostEl    = document.getElementById("host");

function fmt(pct) {
  let s;
  if (Math.round(pct) === pct) s = String(pct);
  else if (Math.round(pct * 10) === pct * 10) s = pct.toFixed(1);
  else s = pct.toFixed(2);
  return s + "%";
}

// ---- Global Settings ----
chrome.storage.local.get([STEP_KEY, MINVOL_KEY, MODKEY_KEY, REVERSE_KEY], (res) => {
  const sFrac = typeof res[STEP_KEY] === "number" ? res[STEP_KEY] : 0.005;
  const mFrac = typeof res[MINVOL_KEY] === "number" ? res[MINVOL_KEY] : 0.0025;
  const sPct = Math.round(sFrac * 1000) / 10;
  const mPct = Math.round(mFrac * 10000) / 100;
  
  stepEl.value = String(sPct);
  stepVal.textContent = fmt(sPct);
  minEl.value = String(mPct);
  minVal.textContent = fmt(mPct);
  
  reverseEl.checked = res[REVERSE_KEY] === true;
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

reverseEl.addEventListener("change", () => {
  chrome.storage.local.set({ [REVERSE_KEY]: reverseEl.checked });
});

modEl.addEventListener("change", () => {
  chrome.storage.local.set({ [MODKEY_KEY]: modEl.checked });
});

// ---- Per-site Settings ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  let host = "";
  try { host = new URL(tabs[0].url).hostname.replace(/^www\./, ""); } catch (e) {}

  if (!host) {
    hostEl.textContent = "not available here";
    siteEl.checked = true;
    siteEl.disabled = true;
    siteAltEl.disabled = true;
    return;
  }

  hostEl.textContent = host;
  const SITE_ALT_KEY = "wvc:alt:" + host;

  chrome.storage.local.get([DISABLED_KEY, SITE_ALT_KEY], (res) => {
    // Enable/Disable
    const list = Array.isArray(res[DISABLED_KEY]) ? res[DISABLED_KEY] : [];
    siteEl.checked = list.indexOf(host) === -1;

    // Per-site Alt Override
    const altOverride = res[SITE_ALT_KEY];
    if (altOverride === true) siteAltEl.value = "true";
    else if (altOverride === false) siteAltEl.value = "false";
    else siteAltEl.value = "default";
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

  siteAltEl.addEventListener("change", () => {
    let val = siteAltEl.value;
    if (val === "default") {
      chrome.storage.local.remove(SITE_ALT_KEY);
    } else {
      chrome.storage.local.set({ [SITE_ALT_KEY]: val === "true" });
    }
  });
});