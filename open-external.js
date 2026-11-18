/* Open in the real browser when the page is loaded inside Snapchat's in-app browser.
 *
 * Android: fires a Chrome intent:// link (falls back to the default browser, then to an
 *          on-screen prompt if the handoff is blocked).
 * iOS:     iOS gives web pages no reliable way out of an in-app browser, so we try the
 *          x-safari-https:// scheme once and, if the page is still visible, show a
 *          full-screen prompt with the exact steps plus a Copy link button.
 */
(function () {
  'use strict';

  var ua = navigator.userAgent || '';
  if (!/Snapchat/i.test(ua)) return; // normal browsers: do nothing

  var isAndroid = /Android/i.test(ua);
  var isIOS = /iPhone|iPad|iPod/i.test(ua);

  var url = new URL(location.href);
  var cleanUrl = new URL(url.href);
  cleanUrl.searchParams.delete('_ext');

  // If we already tried and landed back here, don't loop: just show the prompt.
  var alreadyTried = url.searchParams.get('_ext') === '1';
  try { if (sessionStorage.getItem('ph_ext_tried') === '1') alreadyTried = true; } catch (e) {}

  function androidChromeIntent() {
    var path = cleanUrl.host + cleanUrl.pathname + cleanUrl.search + cleanUrl.hash;
    var fallback = new URL(cleanUrl.href);
    fallback.searchParams.set('_ext', '1');
    return 'intent://' + path + '#Intent;scheme=' + cleanUrl.protocol.replace(':', '') +
      ';package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(fallback.href) + ';end';
  }

  function androidDefaultIntent() {
    var path = cleanUrl.host + cleanUrl.pathname + cleanUrl.search + cleanUrl.hash;
    return 'intent://' + path + '#Intent;scheme=' + cleanUrl.protocol.replace(':', '') +
      ';action=android.intent.action.VIEW;end';
  }

  function iosSafariUrl() {
    return cleanUrl.href.replace(/^https:/, 'x-safari-https:').replace(/^http:/, 'x-safari-http:');
  }

  function tryOpen(viaUserTap) {
    try { sessionStorage.setItem('ph_ext_tried', '1'); } catch (e) {}
    if (isAndroid) {
      location.href = viaUserTap ? androidDefaultIntent() : androidChromeIntent();
    } else if (isIOS) {
      location.href = iosSafariUrl();
    }
  }

  function copyLink(btn) {
    var text = cleanUrl.href;
    function done() { btn.textContent = 'Link copied ✓'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallbackCopy);
    } else { fallbackCopy(); }
    function fallbackCopy() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Copy failed'; }
      document.body.removeChild(ta);
    }
  }

  function showPrompt() {
    if (document.getElementById('ph-ext-overlay')) return;
    var steps = isIOS
      ? 'Tap the <b>⋯</b> menu (top right), then choose <b>Open in Safari</b>.'
      : 'Tap the <b>⋮</b> menu (top right), then choose <b>Open in Browser</b>.';

    var o = document.createElement('div');
    o.id = 'ph-ext-overlay';
    o.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483647;background:#1E1B18;color:#fff;display:flex;' +
      'align-items:center;justify-content:center;padding:24px;font-family:Inter,system-ui,sans-serif;');
    o.innerHTML =
      '<div style="max-width:380px;width:100%;text-align:center">' +
        '<div style="font-size:22px;font-weight:800;margin-bottom:10px">Open in your browser</div>' +
        '<p style="font-size:15px;line-height:1.5;opacity:.85;margin:0 0 18px">' +
          'For a smooth and secure checkout, open Phantom Cards in your phone\u2019s browser instead of Snapchat.' +
        '</p>' +
        '<p style="font-size:15px;line-height:1.5;margin:0 0 20px">' + steps + '</p>' +
        '<button id="ph-ext-open" style="width:100%;padding:14px;border:0;border-radius:12px;' +
          'background:#fff;color:#1E1B18;font-size:16px;font-weight:700;margin-bottom:10px">Open in browser</button>' +
        '<button id="ph-ext-copy" style="width:100%;padding:14px;border:1px solid rgba(255,255,255,.35);' +
          'border-radius:12px;background:transparent;color:#fff;font-size:16px;font-weight:600;margin-bottom:14px">Copy link</button>' +
        '<button id="ph-ext-skip" style="background:none;border:0;color:#fff;opacity:.6;font-size:13px;' +
          'text-decoration:underline">Continue here anyway</button>' +
      '</div>';
    document.body.appendChild(o);

    document.getElementById('ph-ext-open').addEventListener('click', function () { tryOpen(true); });
    document.getElementById('ph-ext-copy').addEventListener('click', function () { copyLink(this); });
    document.getElementById('ph-ext-skip').addEventListener('click', function () { o.remove(); });
  }

  function whenBodyReady(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn);
  }

  if (!alreadyTried) {
    tryOpen(false);
    // If the handoff didn't take us away, show the manual prompt.
    setTimeout(function () { whenBodyReady(showPrompt); }, 1500);
  } else {
    whenBodyReady(showPrompt);
  }
})();
