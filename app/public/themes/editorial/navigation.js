// Progressive enhancement: without JavaScript the primary links remain visible.
(function () {
  'use strict';
  var header = document.querySelector('.site-head-bar');
  if (!header) return;
  var button = header.querySelector('[data-nav-toggle]');
  var nav = header.querySelector('#primary-navigation');
  if (!button || !nav) return;

  var mobile = window.matchMedia('(max-width: 1024px)');
  var lastY = Math.max(0, window.scrollY);
  var travel = 0;
  var frame = 0;

  function showHeader() {
    header.removeAttribute('data-scroll-hidden');
  }
  function closeMenu(restoreFocus) {
    header.removeAttribute('data-nav-open');
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }
  function reset() {
    closeMenu(false);
    showHeader();
    lastY = Math.max(0, window.scrollY);
    travel = 0;
  }

  button.addEventListener('click', function () {
    var open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    header.toggleAttribute('data-nav-open', open);
    showHeader();
  });
  header.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      closeMenu(true);
      event.preventDefault();
    }
  });
  nav.addEventListener('click', function (event) {
    if (event.target.closest('a')) closeMenu(false);
  });
  document.addEventListener('click', function (event) {
    if (!header.contains(event.target)) closeMenu(false);
  });
  header.addEventListener('focusin', showHeader);
  header.addEventListener('focusout', function (event) {
    if (!header.contains(event.relatedTarget)) closeMenu(false);
  });

  function updateScroll() {
    frame = 0;
    // Clamp Safari's rubber-band overscroll at both ends of the document.
    var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    var y = Math.min(maxY, Math.max(0, window.scrollY));
    var delta = y - lastY;
    lastY = y;
    if (!mobile.matches || y <= header.offsetHeight ||
        header.hasAttribute('data-nav-open') || header.querySelector(':focus-visible')) {
      travel = 0;
      showHeader();
      return;
    }
    if ((delta > 0 && travel < 0) || (delta < 0 && travel > 0)) travel = 0;
    travel += delta;
    // A small dead band avoids flickering on tiny changes of scroll direction.
    if (Math.abs(travel) >= 12) {
      header.toggleAttribute('data-scroll-hidden', travel > 0);
      travel = 0;
    }
  }
  window.addEventListener('scroll', function () {
    if (!frame) frame = window.requestAnimationFrame(updateScroll);
  }, { passive: true });
  window.addEventListener('resize', reset);
  window.addEventListener('pageshow', reset);
  mobile.addEventListener('change', reset);
  header.setAttribute('data-nav-ready', '');
  button.hidden = false;
})();
