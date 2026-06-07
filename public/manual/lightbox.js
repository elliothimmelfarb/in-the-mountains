/*
 * In the Mountains — shared image lightbox for all user-facing docs.
 *
 * One mechanism, included on every served manual/archive/report page via
 *   <script src="/manual/lightbox.js" defer></script>
 *
 * Behaviour (the "expected UX"):
 *   - Click any content image (or a large diagram) -> opens full-screen on a dark backdrop.
 *   - Close with the X button, the Esc key, or a click on the backdrop outside the image.
 *   - With several images: Prev/Next buttons + Left/Right arrows + swipe move through them,
 *     with an "n / m" counter.
 *   - Raster images: click (or press Z) to toggle fit <-> actual pixels; drag (or arrow keys
 *     when zoomed) to pan.
 *   - Captions come from the figure/figcaption/.cap near the image, else the alt text.
 *
 * Rules that keep it correct, not just flashy:
 *   - Images wrapped in a link (<a>) are LEFT ALONE — the link must win (archive thumbnails
 *     that open their full report).
 *   - Annotated screenshots wrap the photo in `.shotwrap` with an absolutely-positioned
 *     overlay SVG (`.ov`) on top; a click anywhere in the shotwrap opens the PHOTO, and the
 *     overlay never becomes its own slide.
 *   - Tiny images (icons) and small inline SVGs (sprite-grid items) are not zoomable; only
 *     content-sized media is. Mark anything `class="no-zoom"` to opt out explicitly.
 *   - Accessible: focus trap, background made inert, Esc/arrow/Home/End/Tab/Z keys, keyboard-
 *     openable images AND diagrams, ARIA naming + a polite live caption, focus restored on close.
 *   - Zero dependencies, namespaced classes (itm-lb-*), very high z-index, robust iOS scroll-lock.
 */
(function () {
  'use strict';
  if (window.__itmLightbox) return; // guard against double-injection
  window.__itmLightbox = true;

  var MIN_IMG = 60;   // min displayed px (w or h) for an <img> to be zoomable
  var MIN_SVG_W = 240, MIN_SVG_H = 160; // inline <svg> must be a real diagram, not a sprite
  var DRAG_PX = 6;    // movement beyond this counts as a pan/swipe, not a click
  var PAN_KEY = 80;   // px panned per arrow press while zoomed
  var idSeq = 0;      // unique suffix source for cloned-SVG id namespacing

  // ---- one-time CSS injection ------------------------------------------------
  var css = [
    '.itm-lb-overlay{position:fixed;inset:0;z-index:2147483600;display:none;',
      'background:rgba(8,9,6,.93);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
      'flex-direction:column;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'overscroll-behavior:contain;touch-action:none}',
    '.itm-lb-overlay.itm-lb-open{display:flex}',
    '.itm-lb-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;',
      'overflow:auto;overscroll-behavior:contain;touch-action:none;padding:48px 56px 8px}',
    '.itm-lb-stage.itm-lb-zoom{display:block;text-align:center;cursor:grab}',
    '.itm-lb-stage.itm-lb-zoom.itm-lb-grabbing{cursor:grabbing}',
    // width/height/border pinned so a page-level `img{width:100%;border:...}` can't leak in
    '.itm-lb-media{max-width:100%;max-height:100%;width:auto;height:auto;border:0;box-sizing:border-box;',
      'display:block;margin:auto;border-radius:4px;box-shadow:0 14px 60px rgba(0,0,0,.6);',
      'background:#0c0d08;cursor:zoom-in;outline:none}',
    '.itm-lb-media:focus-visible{outline:2px solid #e0a72b;outline-offset:3px}',
    '.itm-lb-stage.itm-lb-zoom .itm-lb-media{max-width:none;max-height:none;width:auto;height:auto;cursor:inherit;margin:0 auto}',
    'svg.itm-lb-media{width:min(92vw,1200px);height:auto;cursor:default;background:transparent}',
    '.itm-lb-cap{flex:0 0 auto;color:#d8d6c4;font-size:13px;line-height:1.5;text-align:center;',
      'padding:10px 56px 16px;max-width:1000px;margin:0 auto;font-style:italic}',
    '.itm-lb-cap:empty{display:none}',
    '.itm-lb-count{position:absolute;top:16px;left:20px;color:#9a9a82;font-size:12px;',
      'letter-spacing:1px;font-variant-numeric:tabular-nums}',
    '.itm-lb-btn{position:absolute;background:rgba(20,22,15,.72);color:#e0a72b;border:1px solid #2c3022;',
      'border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'transition:background .15s,border-color .15s;-webkit-tap-highlight-color:transparent;padding:0}',
    '.itm-lb-btn:hover{background:rgba(40,44,30,.92);border-color:#e0a72b}',
    '.itm-lb-btn:focus-visible{outline:2px solid #e0a72b;outline-offset:2px}',
    '.itm-lb-close{top:12px;right:16px;width:40px;height:40px;font-size:24px;line-height:1}',
    '.itm-lb-nav{top:50%;transform:translateY(-50%);width:46px;height:64px;font-size:28px}',
    '.itm-lb-prev{left:10px}.itm-lb-next{right:10px}',
    '.itm-lb-nav[hidden],.itm-lb-count[hidden]{display:none}',
    '@media (max-width:640px){.itm-lb-stage{padding:40px 8px 4px}.itm-lb-cap{padding:8px 14px 12px}',
      '.itm-lb-nav{width:40px;height:54px}}',
    '@media (prefers-reduced-motion:reduce){.itm-lb-btn{transition:none}}'
  ].join('');
  var style = document.createElement('style');
  style.id = 'itm-lb-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // ---- overlay DOM (built once, lazily) -------------------------------------
  var overlay, stage, mediaEl, capEl, countEl, prevBtn, nextBtn, closeBtn;
  var items = [];      // current page's zoomable media, in document order
  var index = -1;      // index into items of the open item
  var lastFocus = null;
  var zoomed = false;
  var scrollLock = null; // saved scroll/style state for the body lock
  var inerted = [];      // background elements made inert, with prior state

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'itm-lb-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image viewer');

    countEl = el('div', 'itm-lb-count');
    closeBtn = btn('itm-lb-close', '×', 'Close (Esc)');
    prevBtn = btn('itm-lb-nav itm-lb-prev', '‹', 'Previous image (Left arrow)');
    nextBtn = btn('itm-lb-nav itm-lb-next', '›', 'Next image (Right arrow)');
    stage = el('div', 'itm-lb-stage');
    capEl = el('div', 'itm-lb-cap');
    capEl.id = 'itm-lb-cap';
    capEl.setAttribute('aria-live', 'polite');

    overlay.appendChild(countEl);
    overlay.appendChild(closeBtn);
    overlay.appendChild(prevBtn);
    overlay.appendChild(nextBtn);
    overlay.appendChild(stage);
    overlay.appendChild(capEl);
    document.body.appendChild(overlay);

    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); close(); });
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    // a click that lands on the backdrop (overlay/stage/caption, not the media) closes
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target === stage || e.target === capEl) close();
    });
    wireStageGestures();
  }

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function btn(cls, label, aria) {
    var b = el('button', 'itm-lb-btn ' + cls);
    b.type = 'button'; b.innerHTML = label; b.setAttribute('aria-label', aria);
    return b;
  }

  // ---- which media is zoomable ----------------------------------------------
  function isZoomable(node) {
    if (!node || node.classList.contains('no-zoom')) return false;
    if (node.closest('a')) return false;          // a link must win
    if (node.closest('nav')) return false;        // nav thumbnails/icons, if any
    if (node.closest('.ov')) return false;        // annotation overlay sits over a photo — not content
    if (node.closest('.itm-lb-overlay')) return false;
    var r = node.getBoundingClientRect();
    var tag = node.tagName.toLowerCase();
    if (tag === 'img') return Math.max(r.width, r.height) >= MIN_IMG;
    if (tag === 'svg') return r.width >= MIN_SVG_W && r.height >= MIN_SVG_H;
    return false;
  }

  function collect() {
    items = [];
    var all = document.querySelectorAll('img, svg');
    for (var i = 0; i < all.length; i++) if (isZoomable(all[i])) items.push(all[i]);
  }

  // resolve the media element from an arbitrary click target
  function mediaFromTarget(t) {
    if (t.closest('a')) return null;
    // annotated screenshot: a click on the overlay (or the wrap) opens the photo underneath
    var sw = t.closest('.shotwrap');
    if (sw) { var pic = sw.querySelector('img'); if (pic && isZoomable(pic)) return pic; }
    var m = t.closest('img, svg');
    if (m && isZoomable(m)) return m;
    var cont = t.closest('figure, .shot, .dia, .card');
    if (cont) { var inner = cont.querySelector('img, svg'); if (inner && isZoomable(inner)) return inner; }
    return null;
  }

  // ---- caption resolution (prefer the figure/.shot caption over the bare wrap) ----
  function captionFor(node) {
    var scopes = [node.closest('figure'), node.closest('.shot'), node.closest('.dia'),
                  node.closest('.card'), node.closest('.shotwrap')];
    for (var i = 0; i < scopes.length; i++) {
      var s = scopes[i]; if (!s) continue;
      var c = s.querySelector('figcaption, .cap, .figcaption');
      if (c && c.textContent.trim()) return c.textContent.trim();
    }
    if (node.getAttribute && node.getAttribute('alt')) return node.getAttribute('alt').trim();
    if (node.getAttribute && node.getAttribute('aria-label')) return node.getAttribute('aria-label').trim();
    return '';
  }

  // ---- open / render / navigate / close -------------------------------------
  function openFrom(node) {
    collect();
    var i = items.indexOf(node);
    if (i < 0) { if (!isZoomable(node)) return; items.push(node); i = items.length - 1; }
    if (!overlay) build();
    lastFocus = document.activeElement;
    index = i;
    render();
    lockScroll();
    makeBackgroundInert();
    overlay.classList.add('itm-lb-open');
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }

  // give the cloned SVG its own id namespace so url(#..)/href=#.. never collide with the page
  function namespaceIds(svg) {
    var ided = svg.querySelectorAll('[id]');
    if (!ided.length) return;
    var suffix = '-lb' + (++idSeq), map = {}, i, k;
    for (i = 0; i < ided.length; i++) { var old = ided[i].id; map[old] = old + suffix; ided[i].id = old + suffix; }
    var nodes = svg.querySelectorAll('*');
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      for (k = 0; k < n.attributes.length; k++) {
        var at = n.attributes[k], v = at.value;
        if (v.indexOf('url(#') > -1) {
          for (var o in map) v = v.split('url(#' + o + ')').join('url(#' + map[o] + ')');
        }
        if ((at.name === 'href' || at.name === 'xlink:href') && v.charAt(0) === '#' && map[v.slice(1)]) {
          v = '#' + map[v.slice(1)];
        }
        if (v !== at.value) at.value = v;
      }
    }
  }

  function render() {
    var node = items[index];
    var cap = captionFor(node);
    setZoom(false);
    if (mediaEl && mediaEl.parentNode) mediaEl.parentNode.removeChild(mediaEl);
    if (node.tagName.toLowerCase() === 'svg') {
      mediaEl = node.cloneNode(true);
      mediaEl.removeAttribute('width');
      mediaEl.removeAttribute('height');
      mediaEl.setAttribute('class', 'itm-lb-media');
      namespaceIds(mediaEl);
      mediaEl.setAttribute('role', 'img');
      mediaEl.setAttribute('aria-label', cap || 'diagram');
    } else {
      mediaEl = el('img', 'itm-lb-media');
      mediaEl.alt = node.alt || cap || '';
      mediaEl.onerror = function () {
        capEl.textContent = (cap ? cap + ' — ' : '') + '(image failed to load)';
        mediaEl.style.minWidth = '220px'; mediaEl.style.minHeight = '120px';
      };
      mediaEl.src = node.currentSrc || node.src;
      mediaEl.setAttribute('tabindex', '0');
    }
    stage.appendChild(mediaEl);
    capEl.textContent = cap;
    var many = items.length > 1;
    prevBtn.hidden = !many; nextBtn.hidden = !many; countEl.hidden = !many;
    var pos = many ? (index + 1) + ' / ' + items.length : '';
    if (many) countEl.textContent = pos;
    overlay.setAttribute('aria-label', (cap || 'Image') + (many ? ' (' + pos + ')' : ''));
  }

  function step(d) {
    if (items.length < 2) return;
    index = (index + d + items.length) % items.length;
    render();
  }

  function close() {
    if (!overlay || !overlay.classList.contains('itm-lb-open')) return; // guard re-entry
    overlay.classList.remove('itm-lb-open');
    setZoom(false);
    unlockScroll();
    releaseBackgroundInert();
    document.removeEventListener('keydown', onKey, true);
    if (mediaEl && mediaEl.parentNode) { mediaEl.parentNode.removeChild(mediaEl); mediaEl = null; }
    if (lastFocus && lastFocus.isConnected && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    else if (document.body && document.body.focus) { try { document.body.focus(); } catch (e2) {} }
    index = -1;
  }

  // ---- scroll lock (iOS-robust: fix the body, restore scroll on close) -------
  function lockScroll() {
    var b = document.body, h = document.documentElement;
    scrollLock = {
      y: window.scrollY || window.pageYOffset || 0,
      bPos: b.style.position, bTop: b.style.top, bWidth: b.style.width, bOf: b.style.overflow,
      hOf: h.style.overflow
    };
    b.style.position = 'fixed'; b.style.top = (-scrollLock.y) + 'px'; b.style.width = '100%';
    b.style.overflow = 'hidden'; h.style.overflow = 'hidden';
  }
  function unlockScroll() {
    if (!scrollLock) return;
    var b = document.body, h = document.documentElement, s = scrollLock;
    b.style.position = s.bPos; b.style.top = s.bTop; b.style.width = s.bWidth;
    b.style.overflow = s.bOf; h.style.overflow = s.hOf;
    window.scrollTo(0, s.y);
    scrollLock = null;
  }

  // ---- make the rest of the page inert while the modal is open --------------
  function makeBackgroundInert() {
    inerted = [];
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === overlay || k.id === 'itm-lb-style') continue;
      inerted.push({ el: k, inert: k.inert, ah: k.getAttribute('aria-hidden') });
      try { k.inert = true; } catch (e) {}
      k.setAttribute('aria-hidden', 'true');
    }
  }
  function releaseBackgroundInert() {
    for (var i = 0; i < inerted.length; i++) {
      var r = inerted[i];
      try { r.el.inert = r.inert; } catch (e) {}
      if (r.ah === null) r.el.removeAttribute('aria-hidden'); else r.el.setAttribute('aria-hidden', r.ah);
    }
    inerted = [];
  }

  // ---- zoom (raster only) + pan ---------------------------------------------
  function canZoom() { return mediaEl && mediaEl.tagName.toLowerCase() === 'img'; }
  function setZoom(on) {
    zoomed = !!on && canZoom();
    stage.classList.toggle('itm-lb-zoom', zoomed);
    if (mediaEl && canZoom()) mediaEl.style.cursor = zoomed ? 'zoom-out' : 'zoom-in';
    if (!zoomed) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  }

  function wireStageGestures() {
    var down = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0, onMedia = false;
    stage.addEventListener('pointerdown', function (e) {
      down = true; moved = false;
      onMedia = !!(mediaEl && (e.target === mediaEl || mediaEl.contains(e.target)));
      sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop;
      if (zoomed && onMedia) { stage.classList.add('itm-lb-grabbing'); try { stage.setPointerCapture(e.pointerId); } catch (er) {} }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > DRAG_PX || Math.abs(dy) > DRAG_PX) moved = true;
      if (zoomed && onMedia) { stage.scrollLeft = sl - dx; stage.scrollTop = st - dy; }
    });
    stage.addEventListener('pointerup', function (e) {
      stage.classList.remove('itm-lb-grabbing');
      var dx = e.clientX - sx;
      if (onMedia && !moved) {                 // a clean click on the image -> toggle zoom
        if (canZoom()) setZoom(!zoomed);
      } else if (!onMedia && !moved) {         // clean click off the image -> close
        close();
      } else if (!zoomed && moved && Math.abs(dx) > 40) {  // swipe to navigate (fit mode)
        step(dx < 0 ? 1 : -1);
      }
      down = false;
    });
    stage.addEventListener('pointercancel', function () { down = false; stage.classList.remove('itm-lb-grabbing'); });
  }

  // ---- keyboard (navigation, zoom/pan, focus trap) --------------------------
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'z' || e.key === 'Z') { if (canZoom()) { e.preventDefault(); setZoom(!zoomed); } return; }
    if (zoomed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') stage.scrollLeft -= PAN_KEY;
      else if (e.key === 'ArrowRight') stage.scrollLeft += PAN_KEY;
      else if (e.key === 'ArrowUp') stage.scrollTop -= PAN_KEY;
      else stage.scrollTop += PAN_KEY;
      return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); index = 0; render(); }
    else if (e.key === 'End') { e.preventDefault(); index = items.length - 1; render(); }
    else if (e.key === 'Tab') {
      var f = [closeBtn, prevBtn, nextBtn, mediaEl].filter(function (b) { return b && !b.hidden; });
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      e.preventDefault();
      var ni = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i >= f.length - 1 ? 0 : i + 1);
      if (f[ni] && f[ni].focus) f[ni].focus();
    }
  }

  // ---- global click delegation (one listener) -------------------------------
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (overlay && overlay.classList.contains('itm-lb-open')) return; // handled inside the viewer
    var node = mediaFromTarget(e.target);
    if (!node || !isZoomable(node)) return;
    e.preventDefault();
    openFrom(node);
  });

  // ---- make zoomable media look interactive + keyboard-openable --------------
  function activate(ev) {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); openFrom(ev.currentTarget); }
  }
  function decorate() {
    collect();
    for (var i = 0; i < items.length; i++) {
      var n = items[i];
      if (n.dataset.itmLb) continue;
      n.dataset.itmLb = '1';
      n.style.cursor = 'zoom-in';
      n.setAttribute('tabindex', '0');
      n.setAttribute('role', 'button');
      if (!n.getAttribute('aria-label')) {
        var lbl = (n.tagName.toLowerCase() === 'img' ? (n.alt || 'image') : (captionFor(n) || 'diagram'));
        n.setAttribute('aria-label', lbl + ' — view full screen');
      }
      n.addEventListener('keydown', activate);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate);
  else decorate();
  // late-loading images change layout/size; re-evaluate after full load
  window.addEventListener('load', decorate);
})();
