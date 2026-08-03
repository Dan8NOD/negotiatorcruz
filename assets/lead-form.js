/* Contact form. Posts to /api/lead, which inserts server-side with the
   service-role key. Degrades to email/Calendly if the endpoint isn't wired. */
(function () {
  var form = document.getElementById('lead-form');
  var btn = document.getElementById('lead-submit');
  var msg = document.getElementById('lead-msg');
  if (!form) return;

  // Prefill the offer dropdown from ?offer= so the CTAs on /speaking and
  // /academy carry their context across.
  try {
    var want = new URLSearchParams(location.search).get('offer');
    if (want) {
      var sel = document.getElementById('f-offer');
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === want) { sel.selectedIndex = i; break; }
      }
    }
  } catch (e) { /* URLSearchParams unavailable — not worth a fallback */ }

  function say(kind, text) {
    msg.className = 'form-msg show ' + kind;
    msg.textContent = text;
  }

  var FALLBACK =
    ' You can also email negotiatorsondemand@gmail.com directly.';

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    data.page = location.pathname + location.search;
    data.referrer = document.referrer || '';

    if (!data.name || !data.email) {
      say('err', 'Name and email are required.');
      return;
    }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Sending…';
    msg.className = 'form-msg';

    /* fetch has no default timeout, so a stalled connection never settles and
       the button sits on "Sending…" forever with no way back. Give up at 15s —
       longer than the server's own 8s upstream abort, so a real 504 still wins
       the race and shows its more specific message. */
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);

    fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) {
        return r.json().catch(function () { return { ok: r.ok }; });
      })
      .then(function (out) {
        clearTimeout(timer);
        if (out && out.ok) {
          form.reset();
          say('ok',
            "Got it — thanks. I'll come back to you within a day. If it's " +
            'urgent, book straight into my calendar instead: ' +
            'calendly.com/negotiatorsondemand/corporate-training');
          btn.textContent = 'Sent ✓';
          return; // leave the button disabled to prevent double-sends
        }
        say('err', (out && out.error ? out.error : 'That didn\'t go through.') + FALLBACK);
        btn.disabled = false;
        btn.textContent = original;
      })
      .catch(function (err) {
        clearTimeout(timer);
        say('err', (err && err.name === 'AbortError'
          ? 'That took too long and timed out — the message didn\'t send.'
          : 'Network error — the message didn\'t send.') + FALLBACK);
        btn.disabled = false;
        btn.textContent = original;
      });
  });
})();
