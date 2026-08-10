# Entitlement resolution

Applied to the `NOD-ify` Supabase project (`iubxycckgrplbpdbncfk`). Kept here
because `mixmatch/` is staged in this repository; move it with the rest when
the NOD-ify repo is attachable.

## What was already there

Two tables, and they were the right two:

| | |
|---|---|
| `purchases` | what a **store** told us happened. A receipt log. Unique on `(store, store_txn_id)`, so replaying a webhook is a no-op. `store ∈ {apple, google, amazon, stripe}` |
| `subscriptions` | what the **user** is entitled to. PK `(user_id, product)`, so one person has at most one `nod_pro` row no matter how many stores they have bought through. `source ∈ {apple, google, amazon, stripe}` |

That is already a cross-platform entitlement model. A `nod_pro` bought through
Apple and one bought through Stripe are the same row.

**Purchases is evidence. Subscriptions is truth.** A verified receipt writes
both; everything that gates a feature reads only the functions below.

## What was missing

Nothing read them. With no resolver, every client re-implements "active means
status is active and the period has not ended", they drift, and eventually the
iPad and the browser disagree about whether someone is Pro.

- `entitlement(product, user_id)` — the full picture: `active`, `in_grace`,
  `source`, `status`, `current_period_end`, `access_until`
- `has_entitlement(product, user_id)` — the boolean a feature gate calls
- `my_entitlements` — a `security_invoker` view for the browser and the app
- `entitlement_grace_days(source)` — per-store billing-retry windows

## Grace is accuracy, not generosity

| Store | Days past `current_period_end` | Why |
|---|---|---|
| Apple | 16 | Billing Grace Period on a monthly subscription |
| Google | 30 | Play account hold |
| Amazon | 16 | |
| Stripe | 3 | Webhook lag only — Stripe reports a lapse within minutes |

Cutting someone off the second their period ends punishes a paying customer
for a card that will probably clear, and creates a support email about a
subscription that never actually lapsed.

## Two bugs found by probing, not by reading

Both were caught by running the functions against real scenarios rather than
re-reading the SQL.

### The guard did not hold against an anonymous caller

`may_read_entitlements()` opened with `p_user_id = auth.uid()`. For an anon
caller `auth.uid()` is NULL, so that comparison is NULL — not false — and
`NULL or false or false` is NULL. The caller then did `if not <null>`, which is
also NULL, so **the branch never ran and no exception was raised.** Three-valued
logic walked straight past a check that reads perfectly well in English.

Fixed in both places: every branch of the predicate is now coalesced, and the
caller tests `is not true` so a NULL fails closed. Either fix alone closes it;
a security check is worth both.

### `in_grace` could be true while `active` was false

It only asked "is the period over?", never "is the grace window still open?",
so a Stripe subscription five days dead reported `in_grace = true`. A UI showing
"renewal pending" to somebody who has actually lapsed is a support ticket.

## Verified

Twelve scenarios, run against the live project inside a transaction that was
rolled back. `subscriptions` was empty before and after.

| Scenario | Result |
|---|---|
| Apple sub, 5 days past period end | `active=t in_grace=t` |
| Apple sub, 20 days past (grace spent) | `active=f in_grace=f` |
| Same lapse sold via Stripe (3-day window) | `active=f in_grace=f` |
| Lifetime unlock (null period end) | `active=t`, never expires |
| Cancelled but paid up 30 days | `false` |
| **Bought on Apple, read from the web** | **`true`** |
| Never subscribed | `false` |
| User B reads user A's billing | blocked |
| Anonymous reads billing | blocked |
| Anonymous via `has_entitlement` | blocked |
| No JWT at all | blocked |

---

# `apply_store_purchase` — the single door

`20260810_apply_store_purchase.sql`. Granting access from a receipt used to
mean three separate writes from an edge function — `purchases`, then
`subscriptions`, then maybe `grant_ai_credit` — with no transaction guarantee
between them and every rule living in TypeScript, where the next endpoint can
forget it. Now it is one call, and the rules are in the database.

It does **not** verify the receipt signature. That happens first, against
Apple's servers or Apple's root certificate. This function is the transaction
and the policy, not the cryptography.

## What it refuses, and why each is a real attack

| Refusal | The attack |
|---|---|
| **Replay** | Apple retries a notification until it is acknowledged. A retry must not grant a second month. The unique index on `(store, store_txn_id)` is the idempotency key. |
| **Receipt sharing** | That same index means one transaction attaches to one account, and the unique index on `subscriptions.store_original_txn_id` means one Apple subscription entitles one user. Handing a friend your receipt does nothing. |
| **Sandbox against production** | The classic one. Apple's sandbox issues receipts for subscriptions nobody paid for, and a server that ignores `environment` honours them. Here a sandbox purchase is always *logged* and only ever *grants* when the target user is an operator — so you can test on your own account and nobody else can pay with a sandbox receipt. |
| **Client-side calls** | `service_role` or operator only, and every check coalesced so an anonymous caller gets false rather than null. |

`revoke_store_purchase()` is the other half: a refund that leaves the
entitlement standing is money given away twice. Apple's REFUND and REVOKE
notifications should land there.

## Verified

Nine scenarios against the live project. Tables were empty before and after.

| Scenario | Result |
|---|---|
| Apple monthly subscription | `applied=true, active=true` |
| Same notification retried | `applied=false, already_applied` |
| Entitlement afterwards | `true`, one subscription row |
| Receipt handed to a second account | refused — *already belongs to another account* |
| Sandbox receipt, ordinary user | logged in `purchases`, `has_entitlement=false` |
| $15 pack via Apple, then retried | `0 → 3,000,000 → 3,000,000` micros |
| Refund | access revoked, `has_entitlement=false` |
| Signed-in user granting themselves Pro | refused — *server-side only* |

## Still to build

- **Receipt verification itself.** Verify the JWS against Apple's root
  certificate, or call the App Store Server API, *before* calling
  `apply_store_purchase`. Everything above assumes the receipt is already
  proven real.
- **App Store Server Notifications V2** as the transport: subscribe, verify,
  then call `apply_store_purchase` / `revoke_store_purchase`.
- **Sign-in before the paywall.** StoreKit gives a transaction, not a person —
  there is no email in a receipt. The user must be signed in to Supabase
  *before* purchasing or there is no `user_id` to attach it to.
  `purchases.user_id` is nullable precisely because orphans happen, and
  `store_original_txn_id` is what reconciles them later.


---

# Advisor pass (2026-08-10)

Ran Supabase's security and performance linters after the resolver landed.

**Confirmed safe by omission:** `apply_store_purchase` and
`revoke_store_purchase` do not appear in the "signed-in users can execute"
warnings — the linter sees only `service_role` can reach them, which is the
whole point.

**Flagged and intentional:** `entitlement()` / `has_entitlement()` are
SECURITY DEFINER and callable by `authenticated`. That is their job — a
signed-in user asking about *themselves* is the main caller — and the
`may_read_entitlements()` guard inside is what stops them asking about anyone
else. The guard has its own probes (anon, other-user, no-JWT, all blocked).

**Fixed:** the `user reads own purchases` policy called `auth.uid()` per row
instead of once per statement (`auth_rls_initplan`). Rewritten to the
`(select auth.uid())` form the rest of the project already uses.

**Left alone, deliberately:** `pg_net` living in `public` (moving an extension
mid-flight risks the broker's email path — do it in a supervised window), the
empty-table "unused index" notices, and pre-existing warnings on scorecard
share-token functions, which are share links working as designed.
