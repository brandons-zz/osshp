/* osshp first-party photo lightbox — vanilla JS, zero deps, CSP-strict.
 *
 * Replaces GLightbox (M2.11) which set inline `style` attributes via
 * setAttribute("style", ...) — those are governed by the app's nonce-based CSP
 * (style-src 'self' 'nonce-...', no 'unsafe-inline') and threw style-src-attr
 * violations on open. This implementation NEVER writes an inline style ATTRIBUTE
 * (setAttribute("style", …)): all static visual state is carried by CSS classes
 * (lightbox.css) and element properties (img.src/alt, textContent).
 *
 * The ONE dynamic-visual exception (issue 065 zoom/pan) is the live image
 * transform, applied through the CSSOM property setter `img.style.transform = …`.
 * The CSSOM `.style` interface is NOT governed by CSP style-src-attr — only the
 * `style` content attribute (a literal `style="…"` or `setAttribute("style", …)`)
 * is. GLightbox tripped CSP precisely because it used setAttribute; the CSSOM
 * setter does not. (Verified against the live nonce-based CSP.)
 *
 * Markup hook (theme-authored, trusted): an <a class="glightbox" href="<full>"
 * data-gallery="<name>" data-title data-description> wrapping an <img alt>.
 */
(function () {
  "use strict";

  var SELECTOR = ".glightbox";

  var overlay,
    figureEl,
    stageEl,
    imgEl,
    titleEl,
    descEl,
    btnClose,
    btnPrev,
    btnNext,
    btnZoomOut,
    btnZoomIn,
    liveEl;
  var group = []; // [{ href, title, desc, alt }]
  var index = 0;
  var lastFocused = null;
  var built = false;

  // ── Zoom/pan state (issue 065) ─────────────────────────────────────────────
  // The current image transform: uniform scale about its center plus a pixel
  // translation (pan). scale==1 && tx==ty==0 is "fit" — every image opens and
  // every navigation RESETS to this, so a zoomed image never bleeds into the
  // next one (the core ask). Applied via CSSOM (see file header re: CSP).
  var MIN_SCALE = 1;
  var MAX_SCALE = 4;
  var DOUBLE_SCALE = 2.5; // double-tap / double-click target
  var scale = 1;
  var tx = 0;
  var ty = 0;

  function makeButton(cls, label, glyph) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.setAttribute("aria-label", label);
    var span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.textContent = glyph;
    b.appendChild(span);
    return b;
  }

  function build() {
    if (built) return;

    overlay = document.createElement("div");
    overlay.className = "oshlb";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Image viewer");

    var backdrop = document.createElement("div");
    backdrop.className = "oshlb-backdrop";
    backdrop.addEventListener("click", close);

    figureEl = document.createElement("figure");
    figureEl.className = "oshlb-figure";

    stageEl = document.createElement("div");
    stageEl.className = "oshlb-stage";

    imgEl = document.createElement("img");
    imgEl.className = "oshlb-img";
    imgEl.alt = "";
    imgEl.draggable = false;

    btnPrev = makeButton("oshlb-prev", "Previous image", "‹");
    btnNext = makeButton("oshlb-next", "Next image", "›");
    btnPrev.addEventListener("click", function () {
      go(-1);
    });
    btnNext.addEventListener("click", function () {
      go(1);
    });

    stageEl.appendChild(btnPrev);
    stageEl.appendChild(imgEl);
    stageEl.appendChild(btnNext);

    // Zoom controls — keyboard-reachable, focus-trapped, name/role/value (AA
    // 4.1.2 / 2.1.1 / 2.4.7). They zoom about the image CENTER, which is what a
    // pointer-free (keyboard) user expects.
    var zoomBar = document.createElement("div");
    zoomBar.className = "oshlb-zoombar";
    btnZoomOut = makeButton("oshlb-zoomout", "Zoom out", "−");
    btnZoomIn = makeButton("oshlb-zoomin", "Zoom in", "+");
    btnZoomOut.addEventListener("click", function () {
      zoomByStep(1 / 1.5);
    });
    btnZoomIn.addEventListener("click", function () {
      zoomByStep(1.5);
    });
    zoomBar.appendChild(btnZoomOut);
    zoomBar.appendChild(btnZoomIn);

    var caption = document.createElement("figcaption");
    caption.className = "oshlb-caption";
    titleEl = document.createElement("p");
    titleEl.className = "oshlb-title";
    descEl = document.createElement("p");
    descEl.className = "oshlb-desc";
    caption.appendChild(titleEl);
    caption.appendChild(descEl);

    figureEl.appendChild(stageEl);
    figureEl.appendChild(zoomBar);
    figureEl.appendChild(caption);

    btnClose = makeButton("oshlb-close", "Close image viewer", "✕");
    btnClose.addEventListener("click", close);

    liveEl = document.createElement("div");
    liveEl.className = "oshlb-live";
    liveEl.setAttribute("aria-live", "polite");

    overlay.appendChild(backdrop);
    overlay.appendChild(btnClose);
    overlay.appendChild(figureEl);
    overlay.appendChild(liveEl);

    // Touch gestures (pinch/pan/swipe/double-tap) are bound to the STAGE so
    // they never fire on the backdrop/caption. touch-action:none on the stage
    // (lightbox.css) hands the browser's pinch/scroll to us on the image only —
    // page pinch-zoom OUTSIDE the lightbox is untouched.
    stageEl.addEventListener("touchstart", onTouchStart, { passive: false });
    stageEl.addEventListener("touchmove", onTouchMove, { passive: false });
    stageEl.addEventListener("touchend", onTouchEnd);
    stageEl.addEventListener("touchcancel", onTouchCancel);

    // Desktop: double-click toggles zoom at the pointer; wheel zooms at the
    // pointer; drag pans when zoomed. mousedown on the image is prevented from
    // moving focus to <body> (issue 063 — keeps keyboard nav alive after a
    // pointer interaction).
    imgEl.addEventListener("dblclick", onDblClick);
    stageEl.addEventListener("wheel", onWheel, { passive: false });
    imgEl.addEventListener("mousedown", onMouseDown);

    document.body.appendChild(overlay);
    built = true;
  }

  function setText(el, txt) {
    el.textContent = txt || "";
    el.hidden = !txt;
  }

  function collectGroup(trigger) {
    var name = trigger.getAttribute("data-gallery");
    var nodes;
    if (name) {
      nodes = Array.prototype.slice
        .call(document.querySelectorAll(SELECTOR))
        .filter(function (a) {
          return a.getAttribute("data-gallery") === name;
        });
    } else {
      nodes = [trigger];
    }
    return nodes.map(function (a) {
      var im = a.querySelector("img");
      var title = a.getAttribute("data-title") || "";
      return {
        href: a.getAttribute("href"),
        title: title,
        desc: a.getAttribute("data-description") || "",
        alt: (im && im.getAttribute("alt")) || title || "",
      };
    });
  }

  // ── Transform application (issue 065) ──────────────────────────────────────
  function applyTransform() {
    // CSSOM property setter — see file header re: CSP (NOT an inline style attr).
    imgEl.style.transform =
      "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    var zoomed = scale > MIN_SCALE + 0.001;
    stageEl.classList.toggle("is-zoomed", zoomed);
    // Keyboard/name-role-value: reflect the zoom state on the controls.
    btnZoomOut.disabled = !zoomed;
    btnZoomIn.disabled = scale >= MAX_SCALE - 0.001;
  }

  function resetZoom() {
    scale = MIN_SCALE;
    tx = 0;
    ty = 0;
    if (imgEl) {
      imgEl.style.transform = ""; // back to CSS-defined fit
      stageEl.classList.remove("is-zoomed");
      btnZoomOut.disabled = true;
      btnZoomIn.disabled = false;
    }
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Keep the pan within the image's own edges: at scale s the image overflows
  // its fit box by (s-1)*half on each side, so |t| may not exceed that — panning
  // never reveals empty space beyond the picture.
  function clampPan() {
    var maxX = ((scale - 1) * imgEl.clientWidth) / 2;
    var maxY = ((scale - 1) * imgEl.clientHeight) / 2;
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  // Zoom to `newScale` while keeping the picture point currently under the
  // client point (cx,cy) fixed there. Derivation (origin = image center):
  //   screenX(f) = centerX + scale*f  → f = (cx-centerX)/scale
  //   keep cx fixed at newScale ⇒ tx += (cx-centerX)*(1 - newScale/scale)
  function zoomAtClient(newScale, cx, cy) {
    newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
    var rect = imgEl.getBoundingClientRect();
    var centerX = rect.left + rect.width / 2;
    var centerY = rect.top + rect.height / 2;
    var ratio = newScale / scale;
    tx += (cx - centerX) * (1 - ratio);
    ty += (cy - centerY) * (1 - ratio);
    scale = newScale;
    if (scale <= MIN_SCALE) {
      scale = MIN_SCALE;
      tx = 0;
      ty = 0;
    }
    clampPan();
    applyTransform();
  }

  // Zoom about the image center by a multiplicative step (keyboard +/− buttons).
  function zoomByStep(factor) {
    var rect = imgEl.getBoundingClientRect();
    zoomAtClient(
      scale * factor,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  }

  // Toggle 1× ↔ DOUBLE_SCALE centered on a client point (double-tap/dbl-click).
  function toggleZoomAt(cx, cy) {
    if (scale > MIN_SCALE + 0.001) {
      resetZoom();
      applyTransform();
    } else {
      zoomAtClient(DOUBLE_SCALE, cx, cy);
    }
  }

  function render() {
    var item = group[index];
    if (!item) return;
    // RESET-ON-NAVIGATE (core ask): every image swap starts at fit — a zoomed
    // image never carries its zoom into the next one.
    resetZoom();
    imgEl.src = item.href;
    imgEl.alt = item.alt;
    setText(titleEl, item.title);
    setText(descEl, item.desc);
    var multi = group.length > 1;
    btnPrev.hidden = !multi;
    btnNext.hidden = !multi;
    liveEl.textContent = multi
      ? "Image " + (index + 1) + " of " + group.length
      : "";
  }

  function go(delta) {
    if (group.length < 2) return;
    index = (index + delta + group.length) % group.length; // loop
    render();
  }

  function open(trigger) {
    build();
    group = collectGroup(trigger);
    if (!group.length) return;
    var href = trigger.getAttribute("href");
    index = 0;
    for (var i = 0; i < group.length; i++) {
      if (group[i].href === href) {
        index = i;
        break;
      }
    }
    lastFocused = trigger;
    render(); // starts at fit (resetZoom inside)
    overlay.classList.add("is-open");
    document.documentElement.classList.add("oshlb-open");
    // Arrow/Escape/Tab handling lives on `document` while open (issue 063) so a
    // pointer tap on the image — which moves focus to <body> — never silences
    // the keyboard controls. Removed again on close (no global listener leaks).
    document.addEventListener("keydown", onKeydown);
    btnClose.focus();
  }

  function close() {
    if (!built || !overlay.classList.contains("is-open")) return;
    overlay.classList.remove("is-open");
    document.documentElement.classList.remove("oshlb-open");
    document.removeEventListener("keydown", onKeydown);
    resetZoom();
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function focusables() {
    return Array.prototype.slice
      .call(overlay.querySelectorAll("button"))
      .filter(function (b) {
        return !b.hidden && !b.disabled;
      });
  }

  function trapTab(e) {
    var f = focusables();
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var active = document.activeElement;
    // If focus has escaped the overlay entirely (e.g. it slipped to <body> after
    // a tap), pull it back in rather than letting Tab walk the page behind the
    // modal — keeps the focus trap intact (issue 063).
    if (!overlay.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ── Touch gestures (issues 062 swipe + 065 zoom/pan) ───────────────────────
  var SWIPE_THRESHOLD = 40; // px — smaller horizontal drags are a tap/jitter
  var INTENT_THRESHOLD = 10; // px — how far before we commit to a direction
  var DOUBLE_TAP_MS = 300;
  var TAP_SLOP = 24; // px — max movement for a touch to still count as a tap

  // One-finger tracking (swipe when scale==1, pan when zoomed).
  var oneStartX = 0,
    oneStartY = 0,
    oneLastX = 0,
    oneLastY = 0,
    oneTracking = false,
    oneHorizontal = false,
    oneMoved = 0;
  // Two-finger pinch tracking.
  var pinching = false,
    pinchStartDist = 0,
    pinchStartScale = 1,
    pinchLastMidX = 0,
    pinchLastMidY = 0;
  // Double-tap tracking.
  var lastTapTime = 0,
    lastTapX = 0,
    lastTapY = 0;
  // Timestamp of the most recent touch interaction. A tap on a touch device also
  // synthesizes compatibility mouse events (mousedown/click/dblclick); without
  // this guard a touch double-tap would fire BOTH the touch handler AND the
  // synthesized dblclick, toggling zoom twice and cancelling out. onDblClick
  // ignores any dblclick that closely follows a touch (real mouse dblclicks have
  // no recent touch).
  var lastTouchTs = 0;
  var TOUCH_MOUSE_GUARD_MS = 700;

  function touchDist(a, b) {
    var dx = a.clientX - b.clientX;
    var dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onTouchStart(e) {
    lastTouchTs = Date.now();
    if (e.touches.length === 2) {
      // Begin a pinch — supersedes any one-finger tracking in progress.
      pinching = true;
      oneTracking = false;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      pinchLastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchLastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    oneTracking = true;
    oneHorizontal = false;
    oneMoved = 0;
    oneStartX = oneLastX = t.clientX;
    oneStartY = oneLastY = t.clientY;
  }

  function onTouchMove(e) {
    if (pinching && e.touches.length >= 2) {
      e.preventDefault();
      var d = touchDist(e.touches[0], e.touches[1]);
      var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (pinchStartDist > 0) {
        zoomAtClient(pinchStartScale * (d / pinchStartDist), midX, midY);
      }
      // Two-finger pan: follow the midpoint as it moves.
      tx += midX - pinchLastMidX;
      ty += midY - pinchLastMidY;
      clampPan();
      applyTransform();
      pinchLastMidX = midX;
      pinchLastMidY = midY;
      return;
    }
    if (!oneTracking || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - oneLastX;
    var dy = t.clientY - oneLastY;
    oneMoved += Math.abs(dx) + Math.abs(dy);

    if (scale > MIN_SCALE + 0.001) {
      // ZOOMED: one-finger drag PANS (never changes image). Suppress the
      // browser default (scroll/synthetic-click) so the pan is smooth.
      e.preventDefault();
      tx += dx;
      ty += dy;
      clampPan();
      applyTransform();
      oneLastX = t.clientX;
      oneLastY = t.clientY;
      return;
    }

    // AT FIT (scale==1): preserve the 062 swipe-to-change behavior.
    var totalX = t.clientX - oneStartX;
    var totalY = t.clientY - oneStartY;
    if (
      !oneHorizontal &&
      (Math.abs(totalX) > INTENT_THRESHOLD ||
        Math.abs(totalY) > INTENT_THRESHOLD)
    ) {
      oneHorizontal = Math.abs(totalX) > Math.abs(totalY);
    }
    if (oneHorizontal) {
      // Confirmed horizontal drag: suppress default (scroll/bounce) — this also
      // suppresses the synthetic click that would otherwise close on the backdrop.
      e.preventDefault();
    }
    oneLastX = t.clientX;
    oneLastY = t.clientY;
  }

  function onTouchEnd(e) {
    lastTouchTs = Date.now();
    if (pinching) {
      // End the pinch when fewer than two fingers remain. If the image zoomed
      // back to (or below) fit, snap it clean.
      if (e.touches.length < 2) {
        pinching = false;
        if (scale <= MIN_SCALE + 0.001) {
          resetZoom();
          applyTransform();
        }
      }
      return;
    }
    if (!oneTracking) return;
    oneTracking = false;
    var wasHorizontal = oneHorizontal;
    oneHorizontal = false;

    // A tap (little movement): candidate for double-tap-to-zoom.
    if (oneMoved <= TAP_SLOP) {
      var t = e.changedTouches && e.changedTouches[0];
      if (t) {
        var now = Date.now();
        if (
          now - lastTapTime < DOUBLE_TAP_MS &&
          Math.abs(t.clientX - lastTapX) < TAP_SLOP &&
          Math.abs(t.clientY - lastTapY) < TAP_SLOP
        ) {
          toggleZoomAt(t.clientX, t.clientY);
          lastTapTime = 0; // consume — a 3rd tap starts fresh
        } else {
          lastTapTime = now;
          lastTapX = t.clientX;
          lastTapY = t.clientY;
        }
      }
      return;
    }

    // A drag at fit: swipe-to-change if it went far enough horizontally.
    if (!wasHorizontal) return; // vertical drag — leave click-to-close alone
    var end = e.changedTouches && e.changedTouches[0];
    if (!end) return;
    var totalX = end.clientX - oneStartX;
    if (Math.abs(totalX) < SWIPE_THRESHOLD) return;
    go(totalX > 0 ? -1 : 1); // swipe right → previous, swipe left → next
  }

  function onTouchCancel() {
    oneTracking = false;
    oneHorizontal = false;
    pinching = false;
  }

  // ── Desktop pointer (issue 065) ────────────────────────────────────────────
  function onDblClick(e) {
    // Ignore a dblclick synthesized from a touch double-tap — the touch handler
    // already toggled zoom (double-firing would cancel it out).
    if (Date.now() - lastTouchTs < TOUCH_MOUSE_GUARD_MS) return;
    e.preventDefault();
    toggleZoomAt(e.clientX, e.clientY);
  }

  function onWheel(e) {
    // The page is scroll-locked while the lightbox is open (html.oshlb-open),
    // so hijacking the wheel here does not steal a page scroll; when closed this
    // listener is not reachable (the overlay is display:none / detached focus).
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAtClient(scale * factor, e.clientX, e.clientY);
  }

  var mousePanning = false,
    mouseLastX = 0,
    mouseLastY = 0;

  function onMouseDown(e) {
    // Prevent focus from jumping to <body> on click (issue 063) and suppress the
    // native image drag-ghost.
    e.preventDefault();
    // A mousedown synthesized from a touch tap is already handled by the touch
    // path — don't also start a mouse-pan from it.
    if (Date.now() - lastTouchTs < TOUCH_MOUSE_GUARD_MS) return;
    if (scale <= MIN_SCALE + 0.001) return; // only pan when zoomed
    mousePanning = true;
    mouseLastX = e.clientX;
    mouseLastY = e.clientY;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!mousePanning) return;
    tx += e.clientX - mouseLastX;
    ty += e.clientY - mouseLastY;
    clampPan();
    applyTransform();
    mouseLastX = e.clientX;
    mouseLastY = e.clientY;
  }

  function onMouseUp() {
    mousePanning = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      if (group.length > 1) {
        e.preventDefault();
        go(-1); // resets zoom via render()
      }
    } else if (e.key === "ArrowRight") {
      if (group.length > 1) {
        e.preventDefault();
        go(1);
      }
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomByStep(1.5);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomByStep(1 / 1.5);
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  }

  function onDocClick(e) {
    var t = e.target;
    var a = t && t.closest ? t.closest(SELECTOR) : null;
    if (!a) return;
    e.preventDefault();
    open(a);
  }

  document.addEventListener("click", onDocClick);
})();
