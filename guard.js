"use strict";

(() => {
  const origVol = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  let lockedVol = null;

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    get() { return origVol.get.call(this); },
    set(v) {
      // ওয়েবসাইট ভলিউম পরিবর্তন করতে চাইলে আমরা আমাদের সেভ করা ভলিউমটাই জোর করে বসিয়ে দেব
      origVol.set.call(this, lockedVol !== null ? lockedVol : v);
    }
  });

  window.addEventListener('qs-set-vol', (e) => {
    lockedVol = e.detail;
    if (lockedVol !== null) {
      document.querySelectorAll('video, audio').forEach(m => {
        try { origVol.set.call(m, lockedVol); } catch(err){}
      });
    }
  });
})();