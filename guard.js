"use strict";

(() => {
  const origVol = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  let lockedVol = null;

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    get() { return origVol.get.call(this); },
    set(v) {
      // ওয়েবসাইট ভলিউম পরিবর্তন করতে চাইলে আমরা আমাদের সেভ করা ভলিউমটাই জোর করে বসিয়ে দেব
      if (lockedVol !== null) {
        // ...তবে সাইট কোন ভলিউম চেয়েছিল সেটা মনে রাখি, লক ছাড়ার সময় ফেরত দিতে হবে
        this._qsSiteVol = v;
        origVol.set.call(this, lockedVol);
      } else {
        origVol.set.call(this, v);
      }
    }
  });

  window.addEventListener('qs-set-vol', (e) => {
    const next = e.detail;
    const was = lockedVol;
    lockedVol = next;

    if (next !== null) {
      document.querySelectorAll('video, audio').forEach(m => {
        try {
          // লক শুরুর মুহূর্তে সাইটের নিজের ভলিউমটা স্ন্যাপশট করে রাখি
          if (was === null && m._qsSiteVol === undefined) m._qsSiteVol = origVol.get.call(m);
          origVol.set.call(m, next);
        } catch(err){}
      });
    } else if (was !== null) {
      // লক ছাড়া হলো (যেমন Night mode বন্ধ) — সাইট যে ভলিউম চেয়েছিল সেটাই ফিরিয়ে দিই।
      // কিছু মনে না থাকলে ব্রাউজারের ডিফল্ট ১০০%, কারণ ওখান থেকেই শুরু হয়েছিল।
      document.querySelectorAll('video, audio').forEach(m => {
        try {
          const back = m._qsSiteVol;
          delete m._qsSiteVol;
          origVol.set.call(m, back === undefined ? 1 : back);
        } catch(err){}
      });
    }
  });
})();
