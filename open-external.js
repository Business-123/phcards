/* Snapchat in-app browser: show an "Open in your browser" prompt immediately.
 * No automatic redirects (those can blank the page inside Snapchat's webview).
 * The handoff is only attempted when the user taps the button, and the page
 * stays intact underneath if the handoff fails. */
(function () {
  'use strict';
  try {
    var ua = navigator.userAgent || '';
    if (!/Snapchat/i.test(ua)) return;

    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var pageUrl = location.href;

    function androidIntent(withChrome) {
      var u = new URL(pageUrl);
      var scheme = u.protocol.replace(':', '');
      return 'intent://' + u.host + u.pathname + u.search + u.hash +
        '#Intent;scheme=' + scheme + ';action=android.intent.action.VIEW;' +
        (withChrome ? 'package=com.android.chrome;' : '') +
        'S.browser_fallback_url=' + encodeURIComponent(pageUrl) + ';end';
    }

    function go(href) {
      // Use an anchor click so a failed/unsupported scheme doesn't replace the page.
      var a = document.createElement('a');
      a.href = href;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 500);
    }

    function copyLink(btn) {
      function done() { btn.textContent = 'Link copied \u2713 \u2014 paste it in your browser'; }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = pageUrl; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Press and hold the link to copy'; }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pageUrl).then(done, fallback);
      } else { fallback(); }
    }

    function show() {
      if (document.getElementById('ph-ext-overlay')) return;
      var steps = isIOS
        ? 'Tap the <b>&#8943;</b> menu (top right), then choose <b>Open in Safari</b>.'
        : 'Tap the <b>&#8942;</b> menu (top right), then choose <b>Open in Browser</b>.';
      var o = document.createElement('div');
      o.id = 'ph-ext-overlay';
      o.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#1E1B18;' +
        'color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;' +
        'font-family:Inter,system-ui,-apple-system,sans-serif;overflow:auto;';
      o.innerHTML =
        '<div style="max-width:380px;width:100%;text-align:center">' +
          '<div style="font-size:22px;font-weight:800;margin-bottom:10px">Open in your browser</div>' +
          '<p style="font-size:15px;line-height:1.5;opacity:.85;margin:0 0 14px">For a smooth and secure checkout, open Phantom Cards in your phone\u2019s browser instead of Snapchat.</p>' +
          '<p style="font-size:15px;line-height:1.5;margin:0 0 20px">' + steps + '</p>' +
          '<a id="ph-ext-open" href="#" style="display:block;box-sizing:border-box;width:100%;padding:14px;border-radius:12px;background:#fff;color:#1E1B18;font-size:16px;font-weight:700;margin-bottom:10px;text-decoration:none">Open in browser</a>' +
          '<button id="ph-ext-copy" style="width:100%;padding:14px;border:1px solid rgba(255,255,255,.35);border-radius:12px;background:transparent;color:#fff;font-size:16px;font-weight:600;margin-bottom:14px">Copy link</button>' +
          '<div id="ph-ext-hint" style="font-size:13px;opacity:.8;margin-bottom:12px;display:none">Didn\u2019t open? Use the menu steps above or copy the link.</div>' +
          '<button id="ph-ext-skip" style="background:none;border:0;color:#fff;opacity:.6;font-size:13px;text-decoration:underline">Continue here anyway</button>' +
        '</div>';
      (document.body || document.documentElement).appendChild(o);

      var openLink = document.getElementById('ph-ext-open');
      var u = new URL(pageUrl);
      // The real link behind the button (followed natively when tapped).
      openLink.href = isAndroid
        ? androidIntent(true)
        : isIOS
          ? pageUrl.replace(/^https:/, 'x-safari-https:').replace(/^http:/, 'x-safari-http:')
          : pageUrl;
      openLink.addEventListener('click', function () {
        // Do NOT preventDefault: let the link navigate. Fallbacks only if we're still here.
        setTimeout(function () {
          if (document.hidden) return;
          if (isAndroid) location.href = androidIntent(false);
          else if (isIOS) location.href = 'googlechrome://' + u.host + u.pathname + u.search + u.hash;
        }, 1000);
        setTimeout(function () {
          var h = document.getElementById('ph-ext-hint'); if (h) h.style.display = 'block';
        }, 2400);
      });
      document.getElementById('ph-ext-copy').addEventListener('click', function () { copyLink(this); });
      document.getElementById('ph-ext-skip').addEventListener('click', function () { o.parentNode && o.parentNode.removeChild(o); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
  } catch (e) { /* never break the site */ }
})();
