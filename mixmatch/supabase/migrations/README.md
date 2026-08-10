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

## Still to build

- **StoreKit receipt verification in the broker.** The client must never be
  taken at its word that a purchase happened. Verify with Apple, then write
  `purchases` (idempotent on `(store, store_txn_id)`) and upsert `subscriptions`.
- **App Store Server Notifications V2** for renewals, refunds, and revocations.
  A refunded purchase that keeps its entitlement is a real loss.
- **Account linking.** StoreKit gives a transaction, not a person — there is no
  email in it. The user must be signed in to Supabase *before* purchasing, or
  the receipt has no `user_id` to attach to. `purchases.user_id` is nullable
  precisely because orphans happen; `store_original_txn_id` is what reconciles
  them later.
