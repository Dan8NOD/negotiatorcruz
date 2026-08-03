/* ==========================================================================
   Negotiators Cruz — shared behaviour
   Consolidated from the three inline <script> blocks that were in the
   original single-page index.html. Everything here degrades gracefully:
   with JS off you still get the full page, just without motion.
   ========================================================================== */
(function () {
  'use strict';

  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = matchMedia('(pointer:fine)').matches;

  /* ---- Mobile nav toggle ------------------------------------------- */
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    /* One place that owns the open/closed state. The three call sites below
       used to each set the class, aria-expanded and the glyph by hand, and the
       aria-label was set once in the markup and never updated — so the button
       still announced itself as "Open menu" while the menu was open. */
    var setMenu = function (open) {
      links.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      toggle.textContent = open ? '✕' : '☰';
    };

    toggle.addEventListener('click', function () {
      setMenu(!links.classList.contains('open'));
    });
    // Close the menu after tapping a link (same-page anchors would otherwise
    // leave the panel covering the target).
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A' && links.classList.contains('open')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && links.classList.contains('open')) {
        setMenu(false);
        toggle.focus(); // return focus to the control that opened the panel
      }
    });
  }

  /* ---- Scroll reveal ----------------------------------------------- */
  // Auto-tag the repeating components so pages don't carry .rv in markup.
  var targets = document.querySelectorAll(
    '.tier,.industry,.card,.stage,.rung,.channel,.cred-item,.stage-deep,section h3'
  );
  for (var i = 0; i < targets.length; i++) targets[i].classList.add('rv');

  var rv = document.querySelectorAll('.rv');
  for (var j = 0; j < rv.length; j++) rv[j].style.transitionDelay = (j % 8) * 60 + 'ms';

  if (reduced || !('IntersectionObserver' in window)) {
    // No observer (or user opted out): show everything immediately.
    for (var k = 0; k < rv.length; k++) rv[k].classList.add('in');
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });
    for (var m = 0; m < rv.length; m++) io.observe(rv[m]);
  }

  if (reduced) return; // everything below is motion-only

  /* ---- Pointer glow (desktop only) --------------------------------- */
  if (fine) {
    var g = document.createElement('div');
    g.style.cssText =
      'position:fixed;width:420px;height:420px;border-radius:50%;pointer-events:none;' +
      'z-index:0;background:radial-gradient(circle,rgba(212,168,83,.10),transparent 60%);' +
      'transform:translate(-50%,-50%);transition:opacity .3s;opacity:0';
    document.body.appendChild(g);
    var gx = 0, gy = 0, cx = 0, cy = 0;
    addEventListener('pointermove', function (e) {
      gx = e.clientX; gy = e.clientY; g.style.opacity = 1;
    }, { passive: true });
    document.addEventListener('pointerleave', function () { g.style.opacity = 0; });
    (function loop() {
      cx += (gx - cx) * 0.12; cy += (gy - cy) * 0.12;
      g.style.left = cx + 'px'; g.style.top = cy + 'px';
      requestAnimationFrame(loop);
    })();
  }

  /* ---- Hero parallax ----------------------------------------------- */
  // Opt-in via .hero-parallax so the compact interior heroes stay still.
  // Note this also drags the .skyline children, which is why their own
  // multipliers below are deliberately small.
  var heroPx = document.querySelector('.hero-parallax');
  if (heroPx) {
    var hTick = false;
    addEventListener('scroll', function () {
      if (hTick) return;
      hTick = true;
      requestAnimationFrame(function () {
        // Clamp rather than skip: bailing out past the cutoff leaves the layer
        // stuck at whatever offset the last handled frame gave it.
        var y = Math.min(scrollY, 600);
        heroPx.style.transform = 'translateY(' + y * 0.18 + 'px)';
        hTick = false;
      });
    }, { passive: true });
  }

  /* ---- Skyline parallax -------------------------------------------- */
  // back 0.10x, front 0.25x, rAF-throttled. Scroll offset is clamped at 900px,
  // past which the hero is off screen and the layers hold their end position.
  var back = document.querySelector('.skyline.back');
  var front = document.querySelector('.skyline.front');
  if (back && front) {
    var tick = false;
    addEventListener('scroll', function () {
      if (tick) return;
      tick = true;
      requestAnimationFrame(function () {
        var y = Math.min(scrollY, 900);
        back.style.transform = 'translateY(' + y * 0.1 + 'px)';
        front.style.transform = 'translateY(' + y * 0.25 + 'px)';
        tick = false;
      });
    }, { passive: true });
  }
})();
