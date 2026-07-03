/* osshp first-party photo lightbox — vanilla JS, zero deps, CSP-strict.
 *
 * Replaces GLightbox (M2.11) which set inline `style` attributes via
 * setAttribute("style", ...) — those are governed by the app's nonce-based CSP
 * (style-src 'self' 'nonce-...', no 'unsafe-inline') and threw style-src-attr
 * violations on open. This implementation NEVER writes an inline style attribute:
 * all visual state is carried by CSS classes (lightbox.css) and element
 * properties (img.src/alt, textContent). Loaded by the theme on /photos only,
 * via a nonce-carried <script src> (strict-dynamic trusts it).
 *
 * Markup hook (theme-authored, trusted): an <a class="glightbox" href="<full>"
 * data-gallery="<name>" data-title data-description> wrapping an <img alt>.
 */
(function () {
  "use strict";

  var SELECTOR = ".glightbox";

  var overlay,
    imgEl,
    titleEl,
    descEl,
    btnClose,
    btnPrev,
    btnNext,
    liveEl;
  var group = []; // [{ href, title, desc, alt }]
  var index = 0;
  var lastFocused = null;
  var built = false;

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

    var figure = document.createElement("figure");
    figure.className = "oshlb-figure";

    var stage = document.createElement("div");
    stage.className = "oshlb-stage";

    imgEl = document.createElement("img");
    imgEl.className = "oshlb-img";
    imgEl.alt = "";

    btnPrev = makeButton("oshlb-prev", "Previous image", "‹");
    btnNext = makeButton("oshlb-next", "Next image", "›");
    btnPrev.addEventListener("click", function () {
      go(-1);
    });
    btnNext.addEventListener("click", function () {
      go(1);
    });

    stage.appendChild(btnPrev);
    stage.appendChild(imgEl);
    stage.appendChild(btnNext);

    var caption = document.createElement("figcaption");
    caption.className = "oshlb-caption";
    titleEl = document.createElement("p");
    titleEl.className = "oshlb-title";
    descEl = document.createElement("p");
    descEl.className = "oshlb-desc";
    caption.appendChild(titleEl);
    caption.appendChild(descEl);

    figure.appendChild(stage);
    figure.appendChild(caption);

    btnClose = makeButton("oshlb-close", "Close image viewer", "✕");
    btnClose.addEventListener("click", close);

    liveEl = document.createElement("div");
    liveEl.className = "oshlb-live";
    liveEl.setAttribute("aria-live", "polite");

    overlay.appendChild(backdrop);
    overlay.appendChild(btnClose);
    overlay.appendChild(figure);
    overlay.appendChild(liveEl);
    overlay.addEventListener("keydown", onKeydown);

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

  function render() {
    var item = group[index];
    if (!item) return;
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
    render();
    overlay.classList.add("is-open");
    document.documentElement.classList.add("oshlb-open");
    btnClose.focus();
  }

  function close() {
    if (!built || !overlay.classList.contains("is-open")) return;
    overlay.classList.remove("is-open");
    document.documentElement.classList.remove("oshlb-open");
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function focusables() {
    return Array.prototype.slice
      .call(overlay.querySelectorAll("button"))
      .filter(function (b) {
        return !b.hidden;
      });
  }

  function trapTab(e) {
    var f = focusables();
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      if (group.length > 1) {
        e.preventDefault();
        go(-1);
      }
    } else if (e.key === "ArrowRight") {
      if (group.length > 1) {
        e.preventDefault();
        go(1);
      }
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
