# QuietScroll

Smart per-site volume control for peaceful browsing.

QuietScroll is a lightweight Chrome/Edge extension that lets you control the
volume of any video or audio player with your mouse wheel — and remembers your
preferred volume separately for every website.

document that pure Web-Audio-API players (Spotify,
  SoundCloud) are not supported — they route audio outside
  <video>/<audio> entirely; users fall back to the site's own
  volume control there.

## Features

* **Mouse-wheel volume control** — hover over any player and scroll to adjust the volume
* **Per-site volume memory** — your volume is saved separately for each website
* **Ultra-low volume** — go as quiet as 0.25%, ideal for late-night listening
* **Night mode** — one switch drops every site to a single quiet level, and switches back
* **Quick presets** — jump straight to 0.125% / 0.1875% / 0.25% / 0.5% / 1% from the popup
* **Adjustable step** — choose how much each scroll changes the volume (0.5%–10%)
* **Reverse direction** — optionally flip scroll-up / scroll-down
* **Optional Alt modifier** — require Alt to be held for volume changes (off by default), set globally or per site
* **Per-site on/off** — disable the extension on any site you choose
* **Volume Guard** — holds your volume steady on autoplay-heavy sites that keep re-asserting their own
* **Fullscreen-safe** — never breaks a site's fullscreen
* **Lightweight & private** — all settings stay on your device; nothing is sent anywhere

## How It Works

Hover the mouse over a video or audio player and scroll the **mouse wheel** up
or down to change the volume. That's it — no keys needed by default.

QuietScroll remembers the volume you set for each website, so the next time you
visit, it starts where you left off.

### Optional: Alt modifier

If you'd rather the wheel scroll the page normally and only change volume while
a key is held, enable **Require Alt key** in the popup. You can set this
globally, or override it for individual sites. When enabled, use:

`Alt + Mouse Wheel`

## Night Mode

Flip **Night mode** in the popup and every site drops to one quiet level — no
need to visit each site and scroll it down. Flip it back and each site returns
to its own remembered volume.

* Your per-site volumes are never overwritten while night mode is on, so
  switching it off restores them exactly
* Scrolling the wheel during night mode tunes the **night level** itself, and
  the overlay shows a 🌙 so you can tell which one you are changing
* The quick presets set the night level while night mode is on, and the current
  site's volume otherwise
* Sites you turned off under **Extension active** stay untouched

## Quick Presets

The popup has five one-click levels, all in the ultra-low range where scrolling
notch by notch is slowest: **0.125%**, **0.1875%**, **0.25%**, **0.5%** and
**1%**. The buttons show bare numbers to fit the popup width; hover one to see
its full value.

## Settings

Open the popup (toolbar icon) to adjust:

* **Step per scroll** — volume change per wheel notch (0.5%–10%)
* **Minimum volume** — the lowest non-zero level on the volume ladder (down to 0.25%)
* **Reverse wheel direction** — scroll down to increase volume
* **Global: Require Alt key** — applies to all sites
* **Night mode** — hold every site at one quiet level
* **Quick presets** — 0.125% / 0.1875% / 0.25% / 0.5% / 1%
* **This site: Extension active** — turn QuietScroll on/off for the current site
* **This site: Require Alt key** — Use Global / Always / Never

## A Note on Volume Guard

While QuietScroll is active on a site, it keeps the volume locked to your
chosen level — so the site's own volume slider may not take effect. If you want
to use a site's native volume controls instead, turn off **Extension active**
for that site in the popup.

## Supported Browsers

* Google Chrome
* Microsoft Edge
* Brave

Requires a Chromium-based browser, version 111 or newer (QuietScroll relies on
`MAIN`-world content scripts for the Volume Guard).

## Installation

1. Download or clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the QuietScroll folder

## Author

Made by Raisul Sohan
