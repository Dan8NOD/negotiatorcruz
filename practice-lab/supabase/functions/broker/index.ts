// NOD-ify Stripe Broker — Supabase Edge Function
//
// Routes (all under /functions/v1/broker):
//   POST /checkout                     — Stripe Checkout for the signed-in user
//   GET  /verify                       — active-subscription check
//   POST /webhook                      — Stripe webhook receiver
//   POST /practice-lab/checkout        — buy one Practice Lab seat (no login)
//   POST /practice-lab/invoice-request — company asks to be invoiced (draft only)
//   POST /practice-lab/issue-invoice   — operator approves and Stripe sends it
//
// Secrets (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe dashboard webhook setup)
//   STRIPE_PRICE_ID        — price_... (the recurring price ID for $5/mo)
//   STRIPE_PRICE_ID_50     — price_... (the recurring price ID for $50/mo, future)
//   SITE_URL               — https://negotiatorsondemand.com (for redirects)
//
// The one-time chat-token product is the public $15 Payment Link below. Price
// and grant are constants (TOKEN_PURCHASE_PRICE_CENTS, TOKEN_PURCHASE_MICROS)
// that the regression suite holds the customer-facing copy to. The frontend
// appends a short-lived server-created purchase intent reference; the webhook
// grants $3 of model credit only after Stripe confirms the completed, paid
// session.
//
// Practice Lab prices are NOT constants here — they are imported from
// ./pricing.js, which is the single source of truth shared with the landing
// page, the one-pager and the tests. That is deliberate: the chat-token price
// drifted across $3/$5/$10/$15 precisely because the number had four homes.
//
// /verify no longer accepts a `?token=` query parameter. That fallback read
// `subscriptions` by stripe_customer_id through the service-role client with
// no authentication, on a function that runs with verify_jwt: false — an open
// subscription-status oracle. It is gone; see docs/broker-function-audit.md.

import { Stripe } from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cohortAmountCents,
  cohortLineItems,
  DURATION_HOURS,
  formatCents,
  INVOICE_DAYS_UNTIL_DUE,
  PRODUCT_NAME,
  SKUS,
} from "./pricing.js";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://negotiatorsondemand.com";
const PRICE_ID = Deno.env.get("STRIPE_PRICE_ID") ?? "";
const PRICE_ID_50 = Deno.env.get("STRIPE_PRICE_ID_50") ?? "";
// Pricing audit 2026-08-02. The prior link (…cIE04) was pinned to an archived
// $3.00 price and has been deactivated in Stripe; matching against it here
// would silently refuse to grant credit on every purchase.
//
// KNOWN FRAGILITY: this matches on URL string. Stripe Payment Links pin to a
// price object at creation, so any future price change produces a new link and
// a new URL, and this constant drifts again — which is exactly how the $3/$5/$10
// three-way mismatch happened. The durable fix is to resolve the link's line
// item and read price.metadata.credit_grant_micros (already populated on
// price_1U0AbnS5XoRchjGL59y8DHE0) instead of comparing URLs and hardcoding the
// grant. Deliberately not done in this deploy to keep the hotfix surgical.
const TOKEN_PAYMENT_LINK_URL = "https://buy.stripe.com/9B628t57Nc1rbOicodcIE06";
// The Stripe price object the link above is pinned to. The URL alone is opaque;
// recording the price ID next to it is what lets a reviewer tie this repo to
// one specific price in the dashboard, and it is how the 2026-08-03 drift was
// caught — the configured link had been deactivated and its price superseded
// under the same product, which no amount of staring at the URL would reveal.
const TOKEN_PURCHASE_PRICE_ID = "price_1U0AbnS5XoRchjGL59y8DHE0";
// What Stripe is configured to charge for that link, in cents. This number is
// advertised to the customer in MixMatch.html and js/coach.js, and the
// regression suite generates that copy from this constant and compares it
// literally — a price edit that touches only the copy, or only the ledger
// grant, now fails CI instead of shipping. See the drift alarm in
// fulfillTokenPurchase for the runtime half of the same guard.
const TOKEN_PURCHASE_PRICE_CENTS = 1500;
// $15 buys $3.00 of model credit. The coach's reservation is derived from
// model pricing rather than hardcoded (see CREDIT_RESERVATION_MICROS in
// supabase/functions/nod-negotiation-coach/index.ts): on Claude Sonnet 5 the
// worst case is ~$0.0345, so $3.00 is ~87 guaranteed requests. That is the
// floor, not the expectation — the reservation is refunded down to actual
// usage on every path, and a typical answer costs a fraction of the worst
// case, so most buyers get several times that. Sizing the grant off the
// worst case is deliberate: it is the only number that cannot leave a user
// stranded mid-session. Must stay in step with
// price_1U0AbnS5XoRchjGL59y8DHE0's metadata.credit_grant_micros.
const TOKEN_PURCHASE_MICROS = 3_000_000;
const MONTHLY_TOKEN_GRANT_MICROS = 2_000_000;

// Marks a Checkout Session as a Practice Lab seat rather than a chat-token
// purchase. Both are mode:"payment", so the webhook needs something on the
// session itself to tell them apart before it starts granting anything.
const PRACTICE_LAB_TAG = "practice_lab";
const OPERATOR_EMAIL = "negotiatorsondemand@gmail.com";

// ─── helpers ──────────────────────────────────────────────────────────────

/** Extract the Supabase auth user from the request's Authorization header.
 *
 * The `Bearer ` prefix MUST be stripped. supabase-js v2's `auth.getUser(jwt)`
 * takes the raw token and builds the header itself, so handing it the whole
 * header value produced `Authorization: Bearer Bearer eyJ…` — always invalid,
 * always a null user, so every caller got a 401 no matter how good their
 * session was. Confirmed against production: a token that `GET /auth/v1/user`
 * accepts with a 200 was rejected here on /checkout, /create-checkout-session
 * and the root path alike.
 *
 * This is why the $5/mo MixMatch checkout had never completed for anyone, and
 * it lines up with Stripe showing zero subscriptions and zero charges in live
 * mode. dancruzhomes' create-checkout has always stripped the prefix and does
 * work, which is what pinned the cause down.
 */
async function getAuthUser(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error) {
    console.error("getAuthUser failed:", error.message);
    return null;
  }
  return user?.id ?? null;
}

/** CORS headers for the frontend. */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, stripe-signature",
};

/** JSON response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/** Read a subscription's current period end as an ISO string, or null.
 *
 * Captured from the deployed function (broker v23), which carried this fix
 * without it ever reaching git — the same production-ahead-of-repo drift #143
 * had to capture for migrations.
 *
 * Stripe moved `current_period_start`/`current_period_end` OFF the Subscription
 * object and onto each subscription item in API version 2025-03-31.basil. This
 * project's webhook endpoint (we_1TxMYrS5XoRchjGLD43TU3eG) is pinned to
 * 2026-06-24.dahlia, so every `customer.subscription.*` event payload arrives
 * WITHOUT the legacy top-level field.
 *
 * The old code did `new Date(subscription.current_period_end * 1000).toISOString()`
 * directly on that payload. With the field absent that is
 * `new Date(NaN).toISOString()`, which throws `RangeError: Invalid time value`
 * rather than returning a bad string — the handler's catch turned it into a 500,
 * Stripe retried and eventually gave up, and subscription status changes never
 * synced. A cancellation would leave the row 'active' forever (access retained
 * after paying stops) and a failed payment would never flip to past_due.
 *
 * Note the SDK is pinned to apiVersion 2024-06-20, so objects fetched via
 * `stripe.subscriptions.retrieve()` DO still carry the legacy top-level field.
 * Both shapes have to work here, hence the fallback rather than a straight swap.
 */
function periodEndISO(subscription: any): string | null {
  const seconds = subscription?.items?.data?.[0]?.current_period_end ??
    subscription?.current_period_end;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

async function resolveUserId(candidate: string | null | undefined): Promise<string | null> {
  if (!candidate || !/^[0-9a-f-]{36}$/i.test(candidate)) return null;
  const { data: { user } } = await supabase.auth.admin.getUserById(candidate);
  return user?.id ?? null;
}

async function resolveTokenPurchaseUser(referenceId: string | null | undefined): Promise<string | null> {
  if (!referenceId || !referenceId.startsWith("nod-")) return null;
  const { data } = await supabase
    .from("ai_credit_purchase_intents")
    .select("user_id,expires_at,fulfilled_at")
    .eq("reference_id", referenceId)
    .maybeSingle();
  if (!data || data.fulfilled_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.user_id;
}

async function grantAiCredit(args: {
  userId: string;
  amountMicros: number;
  kind: "purchase" | "subscription_grant";
  referenceId: string;
  stripeEventId: string;
  stripeSessionId?: string;
  description: string;
}): Promise<void> {
  const { error } = await supabase.rpc("grant_ai_credit", {
    p_user_id: args.userId,
    p_amount_micros: args.amountMicros,
    p_kind: args.kind,
    p_reference_id: args.referenceId,
    p_stripe_event_id: args.stripeEventId,
    p_stripe_session_id: args.stripeSessionId ?? null,
    p_description: args.description,
  });
  if (error) throw error;
}

async function isTokenPaymentLink(session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.mode !== "payment" || session.payment_status !== "paid" || !session.payment_link) return false;
  if (session.currency !== "usd") return false;
  const paymentLink = await stripe.paymentLinks.retrieve(session.payment_link as string);
  return paymentLink.url === TOKEN_PAYMENT_LINK_URL;
}

async function fulfillTokenPurchase(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  if (!(await isTokenPaymentLink(session))) return;
  // Drift alarm, not a gate. session.amount_total is what Stripe actually
  // charged; TOKEN_PURCHASE_PRICE_CENTS is what this repo advertises. A
  // mismatch means the Payment Link's price was edited in the Stripe
  // dashboard without a matching code change, so every "$15" string in the app
  // is now a lie. It is deliberately not a rejection: the customer has already
  // paid, and withholding their credit to punish a config error would turn a
  // copy bug into a billing incident. Grant, and make the log loud.
  if (session.amount_total !== null && session.amount_total !== TOKEN_PURCHASE_PRICE_CENTS) {
    console.error(
      `Token purchase price drift: Stripe charged ${session.amount_total} cents, ` +
      `TOKEN_PURCHASE_PRICE_CENTS is ${TOKEN_PURCHASE_PRICE_CENTS} ` +
      `(expected price ${TOKEN_PURCHASE_PRICE_ID}). ` +
      `Update the constant and the advertised copy, session ${session.id}.`,
    );
  }
  const userId = await resolveTokenPurchaseUser(session.client_reference_id);
  if (!userId) {
    console.error("Token purchase has no valid signed-in user reference:", session.id);
    return;
  }
  await grantAiCredit({
    userId,
    amountMicros: TOKEN_PURCHASE_MICROS,
    kind: "purchase",
    referenceId: `stripe:token-purchase:${session.id}`,
    stripeEventId: eventId,
    stripeSessionId: session.id,
    // Generated from the constants rather than written out, so the ledger
    // entry cannot describe a price the code no longer charges.
    description: `$${TOKEN_PURCHASE_PRICE_CENTS / 100} NOD Coach chat-token purchase ($${TOKEN_PURCHASE_MICROS / 1_000_000} model credit)`,
  });
  await supabase
    .from("ai_credit_purchase_intents")
    .update({ fulfilled_at: new Date().toISOString() })
    .eq("reference_id", session.client_reference_id)
    .is("fulfilled_at", null);
}

async function fulfillMonthlyTokenGrant(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId || priceId !== PRICE_ID) return;

  let userId = await resolveUserId(subscription.metadata?.user_id ?? null);
  if (!userId) {
    const { data } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_subscription_id", subscription.id)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    console.error("Paid subscription invoice has no mapped NOD user:", invoice.id);
    return;
  }

  await grantAiCredit({
    userId,
    amountMicros: MONTHLY_TOKEN_GRANT_MICROS,
    kind: "subscription_grant",
    referenceId: `stripe:subscription-invoice:${invoice.id}`,
    stripeEventId: eventId,
    description: "$5/month NOD Coach chat-token allowance",
  });
}

// ─── Practice Lab ─────────────────────────────────────────────────────────

/** Send mail through the database. The Resend key lives in Supabase Vault, so
 *  public.practice_lab_send_email() (service-role only) is the one place that
 *  can read it. Failures are warnings there, never exceptions — a bounced
 *  notification must not roll back the payment bookkeeping that triggered it. */
async function sendMail(to: string, subject: string, text: string, replyTo?: string) {
  const { error } = await supabase.rpc("practice_lab_send_email", {
    p_to: to,
    p_subject: subject,
    p_text: text,
    p_reply_to: replyTo ?? null,
  });
  if (error) console.error("practice_lab_send_email failed:", error.message);
}

function sessionWhen(startsAt: string): string {
  return new Date(startsAt).toUTCString();
}

function joinLinkEmail(args: {
  name: string;
  title: string;
  startsAt: string;
  joinUrl: string | null;
}): string {
  return [
    `${args.name},`,
    ``,
    `You're in. Your seat in the ${PRODUCT_NAME} is confirmed.`,
    ``,
    `Session: ${args.title}`,
    `Starts:  ${sessionWhen(args.startsAt)}`,
    `Length:  ${DURATION_HOURS} hours`,
    ``,
    args.joinUrl
      ? `Join link: ${args.joinUrl}`
      : `Your join link is being finalised and will follow in a separate email.`,
    ``,
    `Come with a live negotiation you are actually stuck on. The room works`,
    `best when the material is real.`,
    ``,
    `— Negotiators on Demand`,
  ].join("\n");
}

/** POST /practice-lab/checkout
 *
 *  Deliberately unauthenticated. The one customer this product has so far found
 *  the channel through YouTube and bought a seat without ever holding an account
 *  here; putting a signup wall in front of a card payment would be inventing
 *  friction the sale has already proved it does not need.
 *
 *  Creates the registration in 'pending' and returns a Stripe Checkout URL.
 *  Pending holds no seat and releases nothing — the row only becomes real when
 *  Stripe says the money moved. */
async function handlePracticeLabCheckout(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  const sku = SKUS[body?.sku as keyof typeof SKUS];
  if (!sku || sku.rail !== "checkout") {
    return json({ error: "Unknown or non-card SKU" }, 400);
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  const fullName = String(body?.full_name ?? "").trim();
  const sessionId = String(body?.session_id ?? "").trim();
  const company = body?.company ? String(body.company).trim() : null;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "A valid email is required" }, 400);
  }
  if (!fullName) return json({ error: "A name is required" }, 400);
  if (!sessionId) return json({ error: "A session is required" }, 400);

  const { data: session } = await supabase
    .from("sessions")
    .select("id,title,starts_at,status,seat_cap")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session || session.status !== "open") {
    return json({ error: "That session is not open for registration" }, 409);
  }

  const { data: remaining } = await supabase
    .rpc("session_seats_remaining", { p_session_id: sessionId });
  if (typeof remaining === "number" && remaining <= 0) {
    return json({ error: "That session is full" }, 409);
  }

  // One row per (session, email). A repeat visitor who abandoned checkout gets
  // their pending row reused rather than a unique-constraint error.
  const { data: existing } = await supabase
    .from("registrations")
    .select("id,status")
    .eq("session_id", sessionId)
    .eq("email", email)
    .maybeSingle();

  if (existing && ["paid", "attended"].includes(existing.status)) {
    return json({ error: "That email already holds a paid seat on this session" }, 409);
  }

  let registrationId = existing?.id ?? null;
  if (!registrationId) {
    const { data: created, error } = await supabase
      .from("registrations")
      .insert({
        session_id: sessionId,
        email,
        full_name: fullName,
        company,
        sku: sku.sku,
        status: "pending",
        amount_cents: sku.amountCents,
      })
      .select("id")
      .single();
    if (error || !created) {
      console.error("Could not create registration:", error?.message);
      return json({ error: "Could not start registration" }, 500);
    }
    registrationId = created.id;
  } else {
    await supabase
      .from("registrations")
      .update({ full_name: fullName, company, sku: sku.sku, amount_cents: sku.amountCents })
      .eq("id", registrationId);
  }

  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: sku.priceId, quantity: 1 }],
      customer_email: email,
      allow_promotion_codes: true,
      success_url: `${SITE_URL}/practice-lab?seat=confirmed`,
      cancel_url: `${SITE_URL}/practice-lab?seat=canceled`,
      metadata: {
        product: PRACTICE_LAB_TAG,
        registration_id: registrationId,
        session_id: sessionId,
        sku: sku.sku,
      },
    });
    return json({ url: checkout.url });
  } catch (err) {
    console.error("Practice Lab checkout error:", err);
    return json({ error: "Could not create checkout session" }, 500);
  }
}

/** checkout.session.completed for a Practice Lab seat.
 *
 *  This is the whole business change: status goes to 'paid' and only then does
 *  a join link leave the building. */
async function fulfillPracticeLabSeat(
  checkout: Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  const registrationId = checkout.metadata?.registration_id;
  if (!registrationId) {
    console.error("Practice Lab checkout carries no registration_id:", checkout.id);
    return;
  }
  if (checkout.payment_status !== "paid") {
    console.warn(`Practice Lab checkout ${checkout.id} completed unpaid; seat stays pending.`);
    return;
  }

  // Drift alarm, matching the chat-token one. Stripe is the authority on what
  // was charged; a mismatch means the price was edited in the dashboard and the
  // advertised number is now a lie. Grant the seat anyway — they paid — and
  // make the log loud.
  const expected = SKUS[checkout.metadata?.sku as keyof typeof SKUS]?.amountCents;
  if (expected !== undefined && checkout.amount_total !== null &&
      checkout.amount_total !== expected) {
    console.error(
      `Practice Lab price drift: Stripe charged ${checkout.amount_total} cents for ` +
      `${checkout.metadata?.sku}, config says ${expected}. Session ${checkout.id}.`,
    );
  }

  const { data: updated, error } = await supabase
    .from("registrations")
    .update({
      status: "paid",
      stripe_object_id: checkout.id,
      amount_cents: checkout.amount_total ?? undefined,
    })
    .eq("id", registrationId)
    .in("status", ["pending", "paid"])
    .select("id,email,full_name,session_id")
    .maybeSingle();

  if (error) {
    // The seat-cap trigger raises here when a session oversold between checkout
    // creation and payment. The customer has been charged, so this is a refund
    // decision for a human, not something to swallow.
    console.error(
      `Could not mark registration ${registrationId} paid (event ${eventId}): ${error.message}`,
    );
    await sendMail(
      OPERATOR_EMAIL,
      `Practice Lab: PAID SEAT COULD NOT BE CONFIRMED`,
      [
        `Stripe checkout ${checkout.id} was paid but registration ${registrationId}`,
        `could not be marked paid:`,
        ``,
        `  ${error.message}`,
        ``,
        `The most likely cause is the session filling between checkout starting`,
        `and payment completing. This needs a human: either free a seat or`,
        `refund the charge in Stripe.`,
      ].join("\n"),
    );
    return;
  }
  if (!updated) return;

  const { data: sess } = await supabase
    .from("sessions")
    .select("title,starts_at,zoom_join_url")
    .eq("id", updated.session_id)
    .maybeSingle();

  await sendMail(
    updated.email,
    `You're in — ${PRODUCT_NAME}`,
    joinLinkEmail({
      name: updated.full_name,
      title: sess?.title ?? PRODUCT_NAME,
      startsAt: sess?.starts_at ?? new Date().toISOString(),
      joinUrl: sess?.zoom_join_url ?? null,
    }),
  );

  await sendMail(
    OPERATOR_EMAIL,
    `Practice Lab seat sold — ${updated.full_name}`,
    [
      `${updated.full_name} <${updated.email}> paid for a seat.`,
      `SKU: ${checkout.metadata?.sku}`,
      `Amount: ${formatCents(checkout.amount_total ?? 0)}`,
      `Session: ${sess?.title ?? updated.session_id}`,
    ].join("\n"),
    updated.email,
  );
}

/** POST /practice-lab/invoice-request
 *
 *  Creates a cohort order in 'draft' and tells Dan. It does NOT send an
 *  invoice. Corporate pricing has negotiation in it, which is the one thing
 *  this client should be good at. */
async function handleInvoiceRequest(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }

  const companyName = String(body?.company_name ?? "").trim();
  const contactName = String(body?.billing_contact_name ?? "").trim();
  const contactEmail = String(body?.billing_contact_email ?? "").trim().toLowerCase();
  const seatCount = Number.parseInt(body?.seat_count, 10);
  const sessionId = String(body?.session_id ?? "").trim();

  if (!companyName) return json({ error: "Company name is required" }, 400);
  if (!contactName) return json({ error: "A billing contact name is required" }, 400);
  if (!contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return json({ error: "A valid billing contact email is required" }, 400);
  }
  if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 200) {
    return json({ error: "Seat count must be between 1 and 200" }, 400);
  }
  if (!sessionId) return json({ error: "A preferred session is required" }, 400);

  const { data: session } = await supabase
    .from("sessions")
    .select("id,title,starts_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 409);

  const amountCents = cohortAmountCents(seatCount);

  const { data: order, error } = await supabase
    .from("cohort_orders")
    .insert({
      session_id: sessionId,
      company_name: companyName,
      billing_contact_name: contactName,
      billing_contact_email: contactEmail,
      seat_count: seatCount,
      amount_cents: amountCents,
      status: "draft",
    })
    .select("id")
    .single();

  if (error || !order) {
    console.error("Could not create cohort order:", error?.message);
    return json({ error: "Could not record the request" }, 500);
  }

  await sendMail(
    OPERATOR_EMAIL,
    `Invoice request: ${companyName} — ${seatCount} seats — ${formatCents(amountCents)}`,
    [
      `${contactName} <${contactEmail}> at ${companyName} asked to be invoiced.`,
      ``,
      `Seats:   ${seatCount}`,
      `Amount:  ${formatCents(amountCents)}`,
      `Session: ${session.title} (${sessionWhen(session.starts_at)})`,
      `Order:   ${order.id}`,
      ``,
      `Nothing has been sent. Approve it to issue the Stripe invoice:`,
      `  POST ${SITE_URL.replace(/\/$/, "")} -> broker /practice-lab/issue-invoice`,
      `  { "cohort_order_id": "${order.id}" }   (operator auth required)`,
      ``,
      `Reply straight to this email to reach them.`,
    ].join("\n"),
    contactEmail,
  );

  return json({ ok: true, cohort_order_id: order.id, amount_cents: amountCents });
}

/** POST /practice-lab/issue-invoice — operator only.
 *
 *  Authorization reads profiles.is_admin, which is the exact column
 *  public.is_operator() reads. It is queried directly here only because
 *  is_operator() resolves auth.uid(), and this function talks to Postgres as
 *  the service role where auth.uid() is null. Same source of truth, not a
 *  second scheme. */
async function handleIssueInvoice(req: Request): Promise<Response> {
  const userId = await getAuthUser(req);
  if (!userId) return json({ error: "Not authenticated" }, 401);

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("user_id", userId)
    .maybeSingle();
  if (!profile?.is_admin) return json({ error: "Not authorised" }, 403);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }
  const orderId = String(body?.cohort_order_id ?? "").trim();
  if (!orderId) return json({ error: "cohort_order_id is required" }, 400);

  const { data: order } = await supabase
    .from("cohort_orders")
    .select("id,company_name,billing_contact_name,billing_contact_email,seat_count,amount_cents,status,session_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return json({ error: "Unknown cohort order" }, 404);
  if (order.status !== "draft") {
    return json({ error: `Order is already ${order.status}` }, 409);
  }

  const { data: session } = await supabase
    .from("sessions")
    .select("id,title,starts_at,seat_cap")
    .eq("id", order.session_id)
    .maybeSingle();
  if (!session) return json({ error: "Order's session no longer exists" }, 409);
  if (order.seat_count > session.seat_cap) {
    // Better to refuse now than to take a cohort payment for seats the
    // database will refuse to hand out when invoice.paid arrives.
    return json({
      error: `Order is for ${order.seat_count} seats but session caps at ` +
        `${session.seat_cap}. Raise the cap first.`,
    }, 409);
  }

  try {
    const customer = await stripe.customers.create({
      name: order.company_name,
      email: order.billing_contact_email,
      metadata: { cohort_order_id: order.id, site: "nod" },
    });

    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: INVOICE_DAYS_UNTIL_DUE,
      description:
        `${PRODUCT_NAME} — private cohort for ${order.company_name}. ` +
        `${session.title}, ${sessionWhen(session.starts_at)}.`,
      metadata: { cohort_order_id: order.id, product: PRACTICE_LAB_TAG },
    });

    // Line items come from the pricing module so the flat rate and the overage
    // are always consistent with what the landing page quoted.
    for (const line of cohortLineItems(order.seat_count)) {
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: invoice.id,
        amount: line.amountCents,
        currency: "usd",
        description: line.description,
      });
    }

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalized.id);

    await supabase
      .from("cohort_orders")
      .update({ stripe_invoice_id: finalized.id, status: "sent" })
      .eq("id", order.id);

    // Seats are created now, still pending. invoice.paid flips them, which
    // keeps the gate in exactly one place for both rails.
    await supabase.from("registrations").insert({
      session_id: order.session_id,
      email: order.billing_contact_email,
      full_name: order.billing_contact_name,
      company: order.company_name,
      sku: "cohort_private",
      status: "pending",
      amount_cents: order.amount_cents,
      cohort_order_id: order.id,
    });

    return json({
      ok: true,
      invoice_id: finalized.id,
      hosted_invoice_url: finalized.hosted_invoice_url,
    });
  } catch (err) {
    console.error("Could not issue cohort invoice:", err);
    return json({ error: "Could not issue invoice" }, 500);
  }
}

/** invoice.paid for a private cohort. Marks every seat on the order paid and
 *  sends the billing contact the join link to distribute. */
async function fulfillCohortOrder(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const invoiceId = invoice.id;
  if (!invoiceId) return;

  const { data: order } = await supabase
    .from("cohort_orders")
    .select("id,company_name,billing_contact_name,billing_contact_email,seat_count,session_id,status")
    .eq("stripe_invoice_id", invoiceId)
    .maybeSingle();

  // Not a cohort invoice — the subscription grant handler owns this event too.
  if (!order) return;
  if (order.status === "paid") return; // Stripe retries; stay idempotent.

  await supabase.from("cohort_orders").update({ status: "paid" }).eq("id", order.id);

  const { error: seatErr } = await supabase
    .from("registrations")
    .update({ status: "paid", stripe_object_id: invoiceId })
    .eq("cohort_order_id", order.id)
    .eq("status", "pending");

  if (seatErr) {
    console.error(
      `Cohort ${order.id} paid (event ${eventId}) but seats could not be confirmed: ${seatErr.message}`,
    );
    await sendMail(
      OPERATOR_EMAIL,
      `Practice Lab: COHORT PAID BUT SEATS NOT PROVISIONED`,
      `Invoice ${invoiceId} for ${order.company_name} is paid, but marking its ` +
      `seats paid failed:\n\n  ${seatErr.message}\n\nThis needs a human.`,
    );
  }

  const { data: sess } = await supabase
    .from("sessions")
    .select("title,starts_at,zoom_join_url")
    .eq("id", order.session_id)
    .maybeSingle();

  await sendMail(
    order.billing_contact_email,
    `Confirmed — ${PRODUCT_NAME} for ${order.company_name}`,
    [
      `${order.billing_contact_name},`,
      ``,
      `Payment received. ${order.company_name}'s private session is confirmed for`,
      `${order.seat_count} ${order.seat_count === 1 ? "seat" : "seats"}.`,
      ``,
      `Session: ${sess?.title ?? PRODUCT_NAME}`,
      `Starts:  ${sess?.starts_at ? sessionWhen(sess.starts_at) : "to be confirmed"}`,
      `Length:  ${DURATION_HOURS} hours`,
      ``,
      sess?.zoom_join_url
        ? `Join link, to forward to your attendees:\n${sess.zoom_join_url}`
        : `The join link will follow in a separate email.`,
      ``,
      `Ask your attendees to bring a live negotiation they are stuck on.`,
      ``,
      `— Negotiators on Demand`,
    ].join("\n"),
  );

  await sendMail(
    OPERATOR_EMAIL,
    `Cohort invoice PAID — ${order.company_name}`,
    `${order.company_name} paid invoice ${invoiceId} for ${order.seat_count} seats.`,
    order.billing_contact_email,
  );
}

// ─── POST /checkout ──────────────────────────────────────────────────────

async function handleCheckout(req: Request): Promise<Response> {
  const userId = await getAuthUser(req);
  if (!userId) return json({ error: "Not authenticated" }, 401);

  if (!PRICE_ID) return json({ error: "Stripe price not configured" }, 500);

  // Look up the user's email for Stripe customer creation
  const { data: { user } } = await supabase.auth.admin.getUserById(userId);
  const email = user?.email ?? "";

  // Check if they already have a Stripe customer ID.
  // maybeSingle(), not single(): a first-time subscriber has no row here, and
  // single() treats "no rows" as an error (PGRST116) that gets logged as a
  // failure on the one path that is guaranteed to hit it — every new customer.
  // Captured from the deployed function, which had this fix uncommitted.
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id, stripe_subscription_id, status")
    .eq("user_id", userId)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id;

  // If they have a customer ID and an active subscription, don't create a new one
  if (existing?.status === "active" || existing?.status === "trialing") {
    return json({
      error: "You already have an active subscription.",
      url: `${SITE_URL}/MixMatch.html`,
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      ...(customerId ? { customer: customerId } : {}),
      ...(email && !customerId ? { customer_email: email } : {}),
      // Without this Stripe Checkout renders no promo-code field at all, and
      // every coupon in the dashboard is unredeemable — the campaign code
      // would look valid in Stripe and have nowhere to be typed.
      allow_promotion_codes: true,
      client_reference_id: userId,
      success_url: `${SITE_URL}/MixMatch.html?checkout=success`,
      cancel_url: `${SITE_URL}/MixMatch.html?checkout=canceled`,
      metadata: { user_id: userId },
      subscription_data: { metadata: { user_id: userId } },
    });

    return json({ url: session.url });
  } catch (err) {
    console.error("Checkout session error:", err);
    return json({ error: "Could not create checkout session" }, 500);
  }
}

// ─── GET /verify ──────────────────────────────────────────────────────────

async function handleVerify(req: Request): Promise<Response> {
  const userId = await getAuthUser(req);

  // No Authorization header, no answer. There used to be a `?token=` fallback
  // here that looked a subscription up by stripe_customer_id using the
  // service-role client — no auth, RLS bypassed. Because this function runs
  // with verify_jwt: false, that made it an open subscription-status oracle
  // for anyone who could name a cus_… ID (they appear in Stripe receipts,
  // invoices and support threads). Its own comment called it legacy and said
  // it would go once sign-in was the primary flow; sign-in is the primary
  // flow, and no caller in this repo ever passed ?token=. See
  // docs/broker-function-audit.md.
  if (!userId) return json({ active: false });
  const tokenUserId = userId;

  const { data } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", tokenUserId)
    .maybeSingle();

  const active = data?.status === "active" || data?.status === "trialing";
  return json({
    active,
    current_period_end: data?.current_period_end ?? null,
  });
}

// ─── POST /webhook ──────────────────────────────────────────────────────────

async function handleWebhook(req: Request): Promise<Response> {
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!sig || !webhookSecret) {
    return json({ error: "Missing signature or secret" }, 400);
  }

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Practice Lab seats and chat-token purchases are both mode:"payment",
        // so the tag has to be checked before the token path claims the event.
        if (session.metadata?.product === PRACTICE_LAB_TAG) {
          await fulfillPracticeLabSeat(session, event.id);
          break;
        }
        if (session.mode === "payment") {
          await fulfillTokenPurchase(session, event.id);
          break;
        }
        const userId = session.client_reference_id ?? session.metadata?.user_id;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;
        if (!subscriptionId) break;

        // Fetch the subscription to get period end
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const status = subscription.status; // active, trialing, etc.
        const periodEnd = periodEndISO(subscription);

        if (userId) {
          await supabase.from("subscriptions").upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status,
            current_period_end: periodEnd,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.product === PRACTICE_LAB_TAG) {
          await fulfillPracticeLabSeat(session, event.id);
          break;
        }
        await fulfillTokenPurchase(session, event.id);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        // Two products land on this event. The cohort handler no-ops when the
        // invoice is not one of its own, and the subscription grant already
        // filters on price, so both can run unconditionally.
        await fulfillMonthlyTokenGrant(invoice, event.id);
        await fulfillCohortOrder(invoice, event.id);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const { data: order } = await supabase
          .from("cohort_orders")
          .select("id,company_name,billing_contact_email,seat_count")
          .eq("stripe_invoice_id", invoice.id)
          .maybeSingle();
        if (order) {
          // Seats stay pending, so nothing is released. Dan just needs to know.
          await sendMail(
            OPERATOR_EMAIL,
            `Cohort invoice payment FAILED — ${order.company_name}`,
            `Invoice ${invoice.id} for ${order.company_name} (${order.seat_count} seats) ` +
            `failed. Seats remain pending and no join link has gone out.`,
            order.billing_contact_email,
          );
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const status = subscription.status;
        const periodEnd = periodEndISO(subscription);

        // Find the user by customer ID
        const { data: existing } = await supabase
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();

        if (existing?.user_id) {
          await supabase.from("subscriptions").upsert({
            user_id: existing.user_id,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscription.id,
            status,
            current_period_end: periodEnd,
            updated_at: new Date().toISOString(),
          });
        }
        break;
      }

      default:
        // Unhandled event — acknowledge it
        break;
    }

    return json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return json({ error: "Webhook handler failed" }, 500);
  }
}

// ─── main handler ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Supabase serves the function at /functions/v1/broker — strip the prefix
  // to get the sub-path (checkout, verify, webhook, or empty for root)
  const path = url.pathname.replace(/^\/+functions\/v1\/broker\/?/, "")
    .replace(/^\/+broker\/?/, "");

  // Route: path can be empty (root), or /checkout, /verify, /webhook, etc.
  // Also handle legacy paths: /create-checkout-session → /checkout, /verify → /verify

  if (req.method === "POST" && path === "practice-lab/checkout") {
    return handlePracticeLabCheckout(req);
  }

  if (req.method === "POST" && path === "practice-lab/invoice-request") {
    return handleInvoiceRequest(req);
  }

  if (req.method === "POST" && path === "practice-lab/issue-invoice") {
    return handleIssueInvoice(req);
  }

  if (req.method === "POST" && (path === "checkout" || path === "create-checkout-session" || path === "")) {
    return handleCheckout(req);
  }

  if (req.method === "GET" && (path === "verify" || path === "")) {
    return handleVerify(req);
  }

  if (req.method === "POST" && path === "webhook") {
    return handleWebhook(req);
  }

  return json({ error: "Not found", path }, 404);
});
