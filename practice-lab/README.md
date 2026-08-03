# Negotiation Practice Lab — staged build

**This directory is staged in the wrong repository on purpose. Read this before
deploying anything.**

The Practice Lab is a product of **`negotiatorsondemand.com`**, which is built
from the **`Dan8NOD/NOD-ify`** repository. This session was scoped to
`Dan8NOD/negotiatorcruz` and could not attach `NOD-ify`, so the web assets live
here as a self-contained, portable package instead of being dropped in a repo
nobody could reach.

Everything in this directory is excluded from the Vercel build (see
`.vercelignore` at the repo root) so that **none of it can publish on
negotiatorcruz.com**, which is a different property with a different audience.

---

## What is already live, and what is not

The infrastructure half of this build is **done and running**. It is not staged,
because Stripe and Supabase are account-level and shared across every NOD
property — they do not belong to a repo.

| Piece | State |
|---|---|
| Stripe product + 3 prices | **Live** in `acct_1TmRIfS5XoRchjGL` |
| `invoice.paid` webhook subscription | **Live** on `we_1TxMYr…` |
| `sessions` / `registrations` / `cohort_orders` | **Live** in `iubxycckgrplbpdbncfk` |
| Seat cap + RLS + seat gate | **Live**, verified by test |
| `broker` Edge Function (v25) | **Deployed**, smoke-tested |
| Landing page, one-pager, config module | **Staged here.** Not deployed anywhere. |

To finish: copy this directory's contents into `NOD-ify` and deploy. Nothing in
it depends on `negotiatorcruz`.

---

## Where each file goes in NOD-ify

| Here | In NOD-ify |
|---|---|
| `config/pricing.js` | `practice-lab/pricing.js` (served at `/practice-lab/pricing.js`) |
| `web/practice-lab.html` | route `/practice-lab` |
| `web/one-pager.html` | route `/practice-lab/one-pager` |
| `test/pricing.test.js` | the existing test suite |
| `supabase/functions/broker/` | `supabase/functions/broker/` |

Both HTML pages import `/practice-lab/pricing.js` as an ES module, so that path
has to resolve. The landing page reads `window.NOD_SUPABASE` for the project URL
and publishable key, falling back to the project URL with no key (in which case
it shows "dates being finalised" rather than breaking).

> **Note on the deployed broker.** Deployed `broker` v25 is functionally
> identical to `supabase/functions/broker/index.ts` here. Two comments were
> reworded after that deploy to stop them quoting prices — a comment citing a
> price goes stale the same way code does. Deploying from this copy syncs it.

---

## The one thing this build exists to do

An HR department paid **$350** for one employee — a working mediator who found
Dan through the YouTube channel — to attend a four-hour group session. The whole
sales asset was a one-page PDF emailed to an HR administrator. **Nine people
attended. One paid.**

The price was never the problem. At $350 for four hours this is ~$88/seat/hour
against an open-enrollment market band of roughly $31–$47, so it already prices
at or above comparable virtual instructor-led training. **An 11% capture rate is
the problem.**

So the entire business change is one sentence, and it lives in the database and
the webhook, not in the copy:

> The Zoom join link is released only to a registration in `paid` status.

Everything else here is packaging.

---

## How the gate is actually enforced

`zoom_join_url` is **not granted to `anon` or `authenticated` at all** — it is a
column privilege, not a row policy. This matters: RLS filters rows, and no row
policy can stop a caller naming a column in a select list. Withholding the
column privilege is what makes "cannot obtain the link by any route" true rather
than merely intended.

Reads go through `public.session_join_url(session_id)`, which returns the link
only to an operator (`public.is_operator()`) or to someone whose registration on
that session reads `paid`.

Verified against the live database:

```
anon reads zoom_join_url column:  PASS - permission denied for table sessions
anon reads open session title:    PASS
anon reads registrations:         PASS - permission denied for table registrations
anon calls session_join_url():    PASS - permission denied for function
anon calls seats_remaining():     PASS - returns an integer
```

Seat cap is a `BEFORE INSERT OR UPDATE` trigger that locks the session row
(`SELECT … FOR UPDATE`) before counting, so two checkouts completing at the same
instant cannot both pass — which is the only moment a cap matters. Also verified:

```
2 paid seats accepted (cap 2):    PASS
3rd paid seat over cap:           PASS - refused by the database
pending on a full session:        PASS - allowed, holds no seat
pending -> paid over cap:         PASS - refused by the database
```

---

## Applied migrations

Already applied to `iubxycckgrplbpdbncfk`; the database is the source of truth.

1. `practice_lab_sessions_registrations_cohort_orders` — the three tables, RLS,
   column grants, seat-cap trigger, `session_join_url()`,
   `session_seats_remaining()`.
2. `practice_lab_tighten_function_execute_grants` — revokes the default `PUBLIC`
   EXECUTE that left those functions callable over PostgREST.
3. `practice_lab_send_email` — Resend send via Vault + `pg_net`, service-role only.
4. `practice_lab_registrations_cohort_order_link` — `registrations.cohort_order_id`.

### Two deliberate departures from the brief

- **`site` defaults to `'negotiatorsondemand.com'`, not `'nod'`.** Every other
  table in this shared database writes the full hostname, and
  `marketability_submissions` and `practice_sessions` already use exactly this
  value. `docs/lead-notifications.md` documents what the one short-form outlier
  costs: the same property reporting under two keys and every "leads by site"
  figure quietly undercounting. Stripe price metadata still carries `site=nod`
  as specified — that is a separate namespace.

- **`registrations.cohort_order_id` was added.** The brief's schema has no edge
  between `registrations` and `cohort_orders`, but "on `invoice.paid`, mark all
  seats on the `cohort_orders` row paid" cannot be implemented without one. The
  alternative was matching on `(session_id, sku, company_name)`, which silently
  merges two companies buying private cohorts on the same session.

---

## Broker routes added

All under `/functions/v1/broker`, `verify_jwt: false` (unchanged).

| Route | Auth | Does |
|---|---|---|
| `POST /practice-lab/checkout` | none | Creates a `pending` registration, returns a Stripe Checkout URL |
| `POST /practice-lab/invoice-request` | none | Creates a `draft` cohort order and emails Dan. **Sends no invoice.** |
| `POST /practice-lab/issue-invoice` | operator | Issues and sends the Stripe invoice, net 30 |

`/practice-lab/checkout` is deliberately unauthenticated: the one customer this
product has found the channel through YouTube and paid without ever holding an
account, and a signup wall in front of a card payment is friction the sale has
already proved it does not need.

`/practice-lab/issue-invoice` authorises by reading `profiles.is_admin` — the
exact column `public.is_operator()` reads. It is queried directly only because
`is_operator()` resolves `auth.uid()`, which is null when the function talks to
Postgres as the service role. Same source of truth, not a fifth scheme.

---

## Tests

```bash
node --test "practice-lab/test/**/*.test.js"
```

15 pass, 1 skipped. The skipped one is the drift guard: set `STRIPE_SECRET_KEY`
and it verifies every amount, currency, type, active flag, product and metadata
field against **live Stripe**. Set it in CI — that is the test that makes a
dashboard price edit fail the build instead of quietly mispricing a sale, which
is exactly how the chat-token product ended up advertising $15 while pinned to
an archived $3 price.

There is also a mechanised version of acceptance criterion 5: a test that greps
the whole build for `$350` / `35000` / `$3,500` and friends and fails if any
appear outside `config/` and `test/`.

---

## Still blocking a fully hands-off sale

1. **Resend needs a verified domain.** The sender is still the shared
   `onboarding@resend.dev`, which on Resend's free tier delivers **only to the
   address the Resend account was registered with**. A 200 from Resend means
   accepted, not delivered. Until a domain is verified, a stranger who pays $350
   will not receive their join link — the seat is marked paid correctly, but the
   email does not arrive. This is the last thing standing between this build and
   acceptance criterion 1, and it is not in the original checklist.

2. **No session exists yet.** Nothing on the page is real without a date on it.
   The page says "dates being finalised" and refuses to sell rather than
   invent urgency, so this is safe — but it also means zero revenue until a row
   exists in `sessions` with `status = 'open'`.
