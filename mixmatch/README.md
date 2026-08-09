# Mix & Match — the token arcade

**Foundation only.** This directory contains one config module, its tests, and a
Swift port of it held to the same numbers by CI. No *feature* here is built. It
exists so that when each one *is* built, it is a config entry rather than a new
pricing scheme.

Staged in `negotiatorcruz` for the same reason `practice-lab/` is: Mix & Match
belongs to `negotiatorsondemand.com` (the `NOD-ify` repo), which this session
could not attach. Excluded from the Vercel build so it cannot publish here.

---

## The idea, stated plainly

$5/month for Mix & Match, plus token top-ups like an arcade. Tokens buy:

- **NOD Coach** questions (built, live today)
- **Conversation debrief** — the user describes a negotiation that just
  happened; the AI reads it back for pointers and missed moves
- **Arcade** — a game round, priced as a coin

The tokens are the through-line: a user who spends them on something fun is a
user who tops up for something useful.

## Is it buildable? Mostly yes — about 70% already exists

The expensive half is done and running in production. None of it needs
rebuilding:

| | |
|---|---|
| `ai_credit_accounts`, `ai_credit_ledger`, `ai_usage` | balances, audit trail, per-request records |
| `reserve_ai_credit` / `refund_ai_credit` / `grant_ai_credit` | reserve → do work → settle-and-refund |
| `claim_ai_usage_slot` | atomic quota claim under an advisory lock |
| $15 top-up rail | Payment Link → broker webhook → credit granted |
| $5/mo rail | `invoice.paid` → 2,000,000 micros granted monthly |
| `entitlements` | free vs paid tiers, already gating the coach |
| `rocketman/` | a finished game — 380 simulation tests, 38 browser tests |

**Note on the game:** `rocketman/` is a real-time strategy game (base building
plus piloted mechs), not a space shooter. It is complete and self-contained, and
it has no auth or token integration at all — it is a standalone static page. The
game does not need building. Wiring it to a balance does.

## The two things that are genuinely hard

### 1. Claude cannot transcribe audio

Not a limitation of this setup — the Messages API accepts text, images and PDFs,
and no audio. Transcription requires a **second vendor** (Whisper, Deepgram,
AssemblyAI, or similar): a new key, a new cost line, a new failure mode, and a
per-minute charge that is not model spend.

This is why `transcribe_minute` is `status: 'blocked'` in `config/tokens.js`, and
why its cost basis is marked `costsVerified: false`. The test suite refuses to
let it go live until a real vendor rate replaces the placeholder.

### 2. Recording law — the actual blocker, and it is not technical

**Illinois is an all-party consent state** (Illinois Eavesdropping Act), as are
California, Florida, Pennsylvania, Washington, Maryland and Massachusetts. A
feature headlined *"turn your microphone on and record the negotiation"* hands
users legal exposure, and hands the business some if the interface implies it is
fine. **Run this past a lawyer before it ships — not past an AI.**

There is a design answer that is also a better product:

> **Default to self-debrief, not live capture.** The user talks *to the app*
> after the call — "here's what just happened, here's what they said, here's
> where I froze." Single-party by construction, legal everywhere, no consent UI
> required.

For coaching this is arguably the stronger product anyway: recall and reflection
is where the learning happens, and you get the user's own framing, which is the
thing being coached. Live two-party capture then becomes an advanced mode behind
an explicit consent gate — or something skipped entirely.

**Everything valuable in the original idea survives this change.** Only the
microphone-on-during-the-call part is deferred.

---

## The unit problem this module fixes

`ai_credit_accounts.balance_micros` stores **millionths of a dollar of real
spend**. That was correct when the only metered thing was the coach, where a
unit of balance and a unit of model cost are the same unit.

An arcade breaks that three ways: a game round costs nothing to serve,
transcription costs a third-party per-minute fee that is not model spend, and
the user should see one currency rather than three cost bases.

So: **the balance stays in micros and the ledger does not change.** A *token*
becomes the user-facing unit worth a fixed number of micros, and every feature
declares its price in `config/tokens.js` and nowhere else.

### The numbers fall out of constants already shipping

| | |
|---|---|
| 1 token | 20,000 micros ($0.02 of internal budget) |
| $15 top-up | **150 tokens** (existing 3,000,000-micro grant) |
| $5/mo subscription | **100 tokens/month** (existing 2,000,000-micro grant) |

Neither round number was chosen to make it come out even — both are what the
broker already grants, divided by the token unit. Subscribing lands at better
per-token value than topping up, which is the right way round: the subscription
is the commitment, top-ups are the impulse buy. A test asserts that stays true.

### Current meter prices

| Meter | Tokens | Worst-case cost to us | Status |
|---|---|---|---|
| `coach_request` | 2 | 34,500 micros | **live** |
| `arcade_play` | 1 | 0 | planned |
| `debrief_analysis` | 8 | 120,000 micros | planned |
| `transcribe_minute` | 1 | *unverified* | blocked |

**Treat these as a starting point to tune, not a decision** — the same
discipline that held the Practice Lab at $350. What the tests enforce is that
no meter is ever priced below what it costs to serve, and that nothing goes
chargeable on a guessed cost basis.

---

## Segmentation — four phases, each shipping value

**Phase 0 — foundation.** *This directory.* The token unit, the grant map, the
meter registry, and the guards. No user-visible change.

**Phase 1 — meter the arcade.** Lowest risk in the whole plan: no new vendor, no
legal surface, and the game already exists and is tested. Wire Rocketman to
auth, spend one token per round, prove reserve → play → settle end to end. If
the loop works for a game it works for everything else.

**Phase 2 — self-debrief coaching.** Text only, no audio. The user types or
pastes what happened; `debrief_analysis` runs one pass. Reuses the coach's
existing model call, grounding corpus and settle logic. **No new vendor, no
consent problem.** This is the feature most of the original value lives in.

**Phase 3 — audio, self-recorded.** Add an STT vendor. The user records
*themselves* debriefing out loud. Still single-party, still legal everywhere.
Confirm the real per-minute rate, flip `costsVerified`, unblock the meter.

**Phase 4 — live capture.** Only with counsel's sign-off, an explicit consent
step, and per-jurisdiction handling. A legitimate decision here is *never*.

Phases 1 and 2 need nothing that does not already exist.

---

## The iOS port — `swift/`

`swift/` is a Swift package, `MixMatchKit`, holding the same token meter in
Swift. It exists because the iPad app has to price a feature *before* spending,
and a Swift package cannot import an ESM module — so the numbers exist twice.

**A second copy of a price is exactly what produced the $3/$5/$10/$15 chat-token
drift.** So the copy is not trusted. `mixmatch/tools/export-token-fixtures.mjs`
dumps `config/tokens.js` to
`swift/Tests/MixMatchKitTests/Fixtures/tokens.json`, and the XCTest suite
asserts every Swift constant against it — the unit, both grants, all four
meters, the flooring behaviour, and the guards (nothing priced below cost,
nothing live on an unverified cost basis, nothing chargeable unless live).

When you change a price:

```sh
# edit mixmatch/config/tokens.js, then
npm test                    # the JavaScript guards
npm run mixmatch:fixtures   # regenerate the fixture
git add mixmatch/swift/Tests/MixMatchKitTests/Fixtures
```

CI regenerates the fixture and fails on a diff, so a price edited in JavaScript
without a matching Swift change shows up as a red build rather than as an iPad
charging a number the web app no longer honours. **Never regenerate a fixture to
make a red test green** — red there means the two rails disagree about money.

Two CI jobs cover this: the `unit` job checks the fixture is current, and
`Mix & Match (Swift)` runs `swift test` in the official `swift:6.0` container.
`MixMatchKit` is deliberately free of UIKit and SwiftUI so that second job needs
no Mac — the numbers deciding what a customer is charged are verified on every
push rather than only when someone opens Xcode.

**What it does not do:** hold or spend a balance. Balances live in
`ai_credit_accounts` and only ever move through `reserve_ai_credit` /
`refund_ai_credit` / `grant_ai_credit` on the server. A client-side balance that
can diverge from the ledger is a money bug waiting to happen; `MixMatchKit` does
arithmetic and nothing else.

`GrantRail` carries an `apple_iap` case with no grant using it yet. Apple's
commission is materially larger than Stripe's fee, so a pack bought on iPad is
worth less to the business than the same pack bought on the web even though the
buyer pays the same and gets the same tokens — the rail has to be recorded at
grant time for that to ever be visible. See `05 iOS Port` in the handover docs
for the App Store rules that decide which purchases *must* go through IAP.

---

## What is deliberately not decided here

- **Which STT vendor.** Pricing, latency and accuracy all differ; picking one
  before Phase 3 would be guessing.
- **The "plus plan."** A third tier is easy to add once the meter exists — it is
  another entry in `GRANTS`. Worth deciding *after* there is usage data showing
  which meters people actually spend on.
- **Whether the arcade should be free for subscribers.** A game round costing a
  token is an arcade; a game round being free is a retention feature. Both are
  defensible and the answer depends on whether tokens need a sink or the
  subscription needs a perk.
