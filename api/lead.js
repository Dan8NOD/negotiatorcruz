/**
 * POST /api/lead — inbound lead capture for negotiatorcruz.com
 *
 * Why a serverless function instead of posting to Supabase from the browser:
 * the `lead_submissions` table has RLS enabled and no anon INSERT policy
 * (verified: PostgREST returns 42501 for an anonymous insert). The two ways
 * to fix that are (a) open a public insert policy, which invites spam
 * straight into the table, or (b) insert server-side with the service-role
 * key, which never touches the client. This is (b).
 *
 * Required environment variables (set in Vercel → Project → Settings → Env):
 *   SUPABASE_URL               https://iubxycckgrplbpdbncfk.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  the service_role key (SECRET — server only)
 *
 * Zero dependencies on purpose: this repo has no package.json and no build
 * step, so we talk to PostgREST over fetch rather than pulling in the SDK.
 */

'use strict';

const TABLE = 'lead_submissions';
const MAX = { name: 120, email: 200, phone: 40, message: 4000, context: 400 };

/* Best-effort throttle. Serverless instances are ephemeral and not shared,
   so this stops a single hot instance being hammered — it is NOT a real
   rate limiter. If spam becomes a problem, put Vercel's WAF or a Turnstile
   challenge in front of this. */
const HITS = new Map();
const WINDOW_MS = 60_000;
const LIMIT = 5;
/* Each entry is an IP plus at most LIMIT+1 timestamps, so a few thousand of
   them is well under a megabyte — cheap insurance against evicting a real
   offender just because the site had a good traffic day. */
const CEILING = 2000;

/* Vercel's default function ceiling is 10s. Abort the upstream call before
   that so a hung PostgREST returns a real error the visitor can act on,
   instead of the platform killing us mid-request with no response body. */
const UPSTREAM_TIMEOUT_MS = 8000;

function throttled(ip) {
  const now = Date.now();

  const hits = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);

  /* Delete-then-set moves this IP to the end of the Map. Map preserves
     insertion order and re-setting an existing key does not update it, so
     without the delete the iteration order below would be arrival order
     rather than recency. */
  HITS.delete(ip);
  HITS.set(ip, hits);

  /* Bound memory by evicting the least-recently-seen IPs — the front of the
     map after the shuffle above.

     This used to be a flat HITS.clear() at the ceiling, which reset every
     counter in the map. That is backwards: the traffic pushing the map past
     its ceiling is exactly the traffic worth counting, so a burst of unique
     IPs handed whoever was hammering the endpoint a clean slate at the moment
     the limit mattered most. Evicting by recency drops idle visitors instead
     and leaves an active offender's count intact. */
  if (HITS.size > CEILING) {
    for (const k of HITS.keys()) {
      if (HITS.size <= CEILING) break;
      if (k !== ip) HITS.delete(k);
    }
  }

  return hits.length > LIMIT;
}

const clean = (v, max) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

// Deliberately permissive — the goal is catching typos, not policing which
// addresses are "valid". Anything with a local part, @, and a dotted domain.
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(e);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('lead: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    // Don't imply the visitor did something wrong.
    return res.status(503).json({
      ok: false,
      error: 'The form is not configured yet. Please email negotiatorsondemand@gmail.com.',
    });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: 'Too many submissions. Try again in a minute.' });
  }

  // Vercel parses JSON bodies for us, but be defensive about strings.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // Honeypot: a field hidden from humans via CSS. Bots fill it in.
  // Return 200 so the bot believes it succeeded and doesn't retry.
  if (clean(body.company_website, 200)) {
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, MAX.name);
  const email = clean(body.email, MAX.email);
  const phone = clean(body.phone, MAX.phone);
  const note = clean(body.message, MAX.message);

  if (!name || !email) {
    return res
      .status(400)
      .json({ ok: false, error: 'Name and email are required.' });
  }
  if (!looksLikeEmail(email)) {
    return res
      .status(400)
      .json({ ok: false, error: "That email address doesn't look right." });
  }

  /* Table schema: lead_submissions (id, site, form_type, name, email, phone,
     message, props jsonb, status, visitor_id, user_id, submitted_at, ...).
     `site` and `form_type` are NOT NULL. Context fields go into `props`. */
  const ctx = [
    ['Offer', clean(body.offer, MAX.context)],
    ['Company', clean(body.company, MAX.context)],
    ['Team size', clean(body.team_size, MAX.context)],
    ['Timeline', clean(body.timeline, MAX.context)],
    ['Page', clean(body.page, MAX.context)],
    ['Referrer', clean(body.referrer, MAX.context)],
  ].filter(([, v]) => v);

  const message =
    (ctx.length ? ctx.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n' : '') +
    (note || '(no message)');

  const props = {};
  for (const [k, v] of ctx) props[k.toLowerCase().replace(/\s+/g, '_')] = v;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${TABLE}`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        apikey: `${key}`,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        site: 'negotiatorcruz',
        form_type: 'contact',
        name,
        email,
        phone: phone || null,
        message,
        props,
        status: 'new',
      }),
    });

    if (!r.ok) {
      // Log the detail server-side; never echo PostgREST internals to the client.
      console.error('lead: supabase insert failed', r.status, await r.text());
      return res.status(502).json({
        ok: false,
        error:
          'Something broke on our end. Please email negotiatorsondemand@gmail.com and I\'ll get straight back to you.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Upstream never answered. The lead is lost either way, so the only
      // useful thing we can do is hand back a route that doesn't depend on us.
      console.error('lead: supabase timed out after', UPSTREAM_TIMEOUT_MS, 'ms');
      return res.status(504).json({
        ok: false,
        error:
          'The form timed out before it saved. Please email negotiatorsondemand@gmail.com and I\'ll get straight back to you.',
      });
    }
    console.error('lead: unexpected error', err);
    return res.status(500).json({
      ok: false,
      error:
        'Something broke on our end. Please email negotiatorsondemand@gmail.com and I\'ll get straight back to you.',
    });
  } finally {
    clearTimeout(timer);
  }
};
