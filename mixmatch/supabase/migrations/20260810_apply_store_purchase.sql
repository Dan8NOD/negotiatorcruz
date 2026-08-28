-- The only door from a verified store receipt to access.
--
-- Applied to NOD-ify (iubxycckgrplbpdbncfk) as migration
-- `apply_store_purchase_single_door`.
--
-- Before this, granting entitlement from an Apple or Google receipt meant an
-- edge function writing `purchases`, then upserting `subscriptions`, then maybe
-- calling grant_ai_credit: three writes with no transaction guarantee between
-- them, and every rule about what is allowed living in TypeScript where the
-- next endpoint can forget it. One call, one door, rules in the database.
--
-- It does NOT verify the receipt signature. That happens before this is called,
-- against Apple's servers or Apple's root certificate. This is the transaction
-- and the policy, not the cryptography.
--
-- WHAT IT REFUSES, AND WHY EACH IS A REAL ATTACK
--
--   Replay -- Apple retries a notification until it is acknowledged, and a
--   retry must not grant a second month. The unique index on
--   (store, store_txn_id) is the idempotency key.
--
--   Receipt sharing -- that same index means one transaction attaches to one
--   account, and the unique index on subscriptions.store_original_txn_id means
--   one Apple subscription entitles one user. Passing a friend your receipt
--   does nothing.
--
--   Sandbox against production -- the classic one. Apple's sandbox issues
--   receipts for subscriptions nobody paid for, and a server that ignores
--   `environment` honours them. Here a sandbox purchase is always logged and
--   only grants when the target user is an operator, so you can test on your
--   own account and nobody else can pay with a sandbox receipt.

create or replace function public.apply_store_purchase(
  p_user_id                uuid,
  p_store                  text,
  p_store_txn_id           text,
  p_product                text,                    -- the store's product id
  p_kind                   text,                    -- subscription | unlock | consumable
  p_environment            text default 'production',
  p_store_original_txn_id  text default null,
  p_quantity               integer default 1,
  p_entitlement_product    text default null,       -- nod_pro, for subscription/unlock
  p_expires_at             timestamptz default null,
  p_credit_micros          bigint default null,     -- for consumable token packs
  p_raw                    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_id  uuid;
  v_reference    text := p_store || ':' || p_store_txn_id;
  v_is_sandbox   boolean := p_environment = 'sandbox';
  v_target_is_op boolean;
  v_holder       uuid;
  v_email        text;
  v_balance      bigint;
begin
  -- Only the broker or an admin. Coalesced because auth.role() is NULL for an
  -- unauthenticated caller, and a NULL sails past a bare `not`.
  if coalesce((select auth.role()) = 'service_role', false) is not true
     and coalesce(public.is_operator(), false) is not true then
    raise exception 'apply_store_purchase is server-side only' using errcode = '42501';
  end if;

  if p_kind not in ('subscription', 'unlock', 'consumable') then
    raise exception 'unknown purchase kind: %', p_kind using errcode = '22023';
  end if;
  if p_kind in ('subscription', 'unlock') and p_entitlement_product is null then
    raise exception '% purchases must name the entitlement they grant', p_kind
      using errcode = '22023';
  end if;
  if p_kind = 'consumable' and coalesce(p_credit_micros, 0) <= 0 then
    raise exception 'a consumable must grant a positive number of micros'
      using errcode = '22023';
  end if;

  -- Checked before writing anything, so the caller gets a clear error rather
  -- than a unique violation from three statements later.
  if p_store_original_txn_id is not null then
    select s.user_id into v_holder
    from public.subscriptions s
    where s.store_original_txn_id = p_store_original_txn_id;

    if v_holder is not null and v_holder is distinct from p_user_id then
      raise exception 'store subscription % already belongs to another account',
        p_store_original_txn_id using errcode = '23505';
    end if;
  end if;

  insert into public.purchases (
    user_id, store, store_txn_id, store_original_txn_id,
    product, kind, quantity, environment, raw
  ) values (
    p_user_id, p_store, p_store_txn_id, p_store_original_txn_id,
    p_product, p_kind, greatest(coalesce(p_quantity, 1), 1), p_environment, p_raw
  )
  on conflict (store, store_txn_id) do nothing
  returning id into v_purchase_id;

  if v_purchase_id is null then
    return jsonb_build_object(
      'applied', false, 'reason', 'already_applied', 'reference', v_reference);
  end if;

  select coalesce(p.is_admin, false) into v_target_is_op
  from public.profiles p where p.user_id = p_user_id;

  if v_is_sandbox and coalesce(v_target_is_op, false) is not true then
    return jsonb_build_object(
      'applied', false, 'reason', 'sandbox_receipt_not_granted',
      'purchase_id', v_purchase_id, 'reference', v_reference);
  end if;

  if p_kind = 'consumable' then
    -- Same rail as the Stripe top-up, same ledger, same idempotency: the
    -- ledger's unique reference_id means a double call cannot double-credit
    -- even if this function were somehow entered twice.
    v_balance := public.grant_ai_credit(
      p_user_id,
      p_credit_micros * greatest(coalesce(p_quantity, 1), 1),
      'purchase',
      v_reference,
      null, null,
      format('%s purchase: %s', initcap(p_store), p_product)
    );
    return jsonb_build_object(
      'applied', true, 'kind', 'consumable', 'purchase_id', v_purchase_id,
      'reference', v_reference, 'balance_micros', v_balance);
  end if;

  -- StoreKit gives a transaction, never a person, so this is the only place
  -- the receipt and the email are tied together.
  select u.email into v_email from auth.users u where u.id = p_user_id;

  insert into public.subscriptions (
    user_id, product, source, status, current_period_end,
    store_original_txn_id, email, updated_at
  ) values (
    p_user_id, p_entitlement_product, p_store, 'active',
    case when p_kind = 'unlock' then null else p_expires_at end,
    p_store_original_txn_id, v_email, now()
  )
  on conflict (user_id, product) do update set
    source                = excluded.source,
    status                = 'active',
    -- An unlock is perpetual and must not be downgraded to an expiry by a
    -- later subscription row for the same product.
    current_period_end    = case
                              when public.subscriptions.current_period_end is null
                                   and public.subscriptions.status = 'active'
                                   and p_kind = 'subscription'
                              then null
                              else excluded.current_period_end
                            end,
    store_original_txn_id = coalesce(excluded.store_original_txn_id,
                                     public.subscriptions.store_original_txn_id),
    email                 = coalesce(excluded.email, public.subscriptions.email),
    updated_at            = now();

  return jsonb_build_object(
    'applied', true, 'kind', p_kind, 'purchase_id', v_purchase_id,
    'reference', v_reference, 'product', p_entitlement_product,
    'active', public.has_entitlement(p_entitlement_product, p_user_id));
end;
$$;

-- ── revocation ──────────────────────────────────────────────────────────────

-- A refund that leaves the entitlement standing is money given away twice.
-- Apple's REFUND and REVOKE notifications should land here.
create or replace function public.revoke_store_purchase(
  p_store                 text,
  p_store_original_txn_id text,
  p_reason                text default 'refunded'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  if coalesce((select auth.role()) = 'service_role', false) is not true
     and coalesce(public.is_operator(), false) is not true then
    raise exception 'revoke_store_purchase is server-side only' using errcode = '42501';
  end if;

  update public.subscriptions s
  set status = 'revoked', updated_at = now()
  where s.store_original_txn_id = p_store_original_txn_id
    and s.source = p_store
  returning s.user_id into v_user;

  return jsonb_build_object('revoked', v_user is not null, 'user_id', v_user, 'reason', p_reason);
end;
$$;

revoke all on function public.apply_store_purchase(uuid,text,text,text,text,text,text,integer,text,timestamptz,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.revoke_store_purchase(text,text,text) from public, anon, authenticated;
grant execute on function public.apply_store_purchase(uuid,text,text,text,text,text,text,integer,text,timestamptz,bigint,jsonb) to service_role;
grant execute on function public.revoke_store_purchase(text,text,text) to service_role;
