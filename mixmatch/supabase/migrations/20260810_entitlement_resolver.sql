-- One answer to "is this person entitled?", regardless of who sold it.
--
-- Applied to NOD-ify (iubxycckgrplbpdbncfk) as three migrations:
--   entitlement_resolver_store_agnostic
--   entitlement_resolver_allow_service_role
--   entitlement_resolver_null_safe_guard
-- Consolidated here as the final state. See README.md in this directory for
-- what the two follow-ups fixed and why.

-- ── grace ───────────────────────────────────────────────────────────────────

-- How long past current_period_end access survives while a renewal is still
-- being attempted. This is accuracy, not generosity: Apple retries a failed
-- monthly renewal for up to 16 days and Google for up to 30. Stripe gets a
-- short window because Stripe reports a lapse within minutes, so the only
-- thing being covered there is webhook lag.
create or replace function public.entitlement_grace_days(p_source text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_source
    when 'apple'  then 16
    when 'google' then 30
    when 'amazon' then 16
    when 'stripe' then 3
    else 0
  end;
$$;

-- ── who may ask ─────────────────────────────────────────────────────────────

-- Every branch is coalesced. An unauthenticated caller produces NULLs, and a
-- NULL here is read as "not false" by anything doing `if not ...` — which is
-- exactly how the first version of this let an anonymous caller through.
create or replace function public.may_read_entitlements(p_user_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(p_user_id = (select auth.uid()), false)          -- the person themselves
      or coalesce(public.is_operator(), false)                     -- an admin on a support ticket
      or coalesce((select auth.role()) = 'service_role', false);   -- the broker, server-side
$$;

-- ── the resolver ────────────────────────────────────────────────────────────

create or replace function public.entitlement(
  p_product text,
  p_user_id uuid default auth.uid()
)
returns table (
  product            text,
  active             boolean,
  in_grace           boolean,
  source             text,
  status             text,
  current_period_end timestamptz,
  access_until       timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'entitlement() needs a signed-in user or an explicit user id'
      using errcode = '28000';
  end if;

  -- `is not true`, not `not ...`: a NULL must fail closed.
  if public.may_read_entitlements(p_user_id) is not true then
    raise exception 'not authorised to read another user''s entitlements'
      using errcode = '42501';
  end if;

  return query
  with resolved as (
    select
      s.product, s.source, s.status, s.current_period_end,
      case
        when s.current_period_end is null then null
        else s.current_period_end
             + make_interval(days => public.entitlement_grace_days(s.source))
      end as access_until
    from public.subscriptions s
    where s.user_id = p_user_id and s.product = p_product
  )
  select
    r.product,
    -- A null current_period_end means perpetual: that is how a lifetime
    -- unlock is recorded, and it must not be read as "expired at null".
    r.status = any (array['active', 'trialing', 'grace'])
      and (r.access_until is null or now() < r.access_until),
    -- Past the period end AND still being let in because of it. Not simply
    -- "past the period end", which was true of long-dead subscriptions too.
    r.status = any (array['active', 'trialing', 'grace'])
      and r.current_period_end is not null
      and now() >= r.current_period_end
      and now() < r.access_until,
    r.source, r.status, r.current_period_end, r.access_until
  from resolved r;
end;
$$;

-- The one-liner every feature gate should call.
create or replace function public.has_entitlement(
  p_product text,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select e.active from public.entitlement(p_product, p_user_id) e), false);
$$;

-- ── what the client reads ───────────────────────────────────────────────────

-- security_invoker so the view is governed by the caller's own RLS on
-- subscriptions rather than the view owner's. A view that bypassed RLS would
-- undo the check inside entitlement() by another route.
create or replace view public.my_entitlements
with (security_invoker = true) as
select
  s.product,
  s.status = any (array['active', 'trialing', 'grace'])
    and (
      s.current_period_end is null
      or now() < s.current_period_end
                 + make_interval(days => public.entitlement_grace_days(s.source))
    ) as active,
  s.source,
  s.current_period_end
from public.subscriptions s
where s.user_id = auth.uid();

-- ── grants ──────────────────────────────────────────────────────────────────

revoke all on function public.entitlement_grace_days(text)   from public, anon;
revoke all on function public.may_read_entitlements(uuid)    from public, anon;
revoke all on function public.entitlement(text, uuid)        from public, anon;
revoke all on function public.has_entitlement(text, uuid)    from public, anon;

grant execute on function public.entitlement_grace_days(text) to authenticated, service_role;
grant execute on function public.may_read_entitlements(uuid)  to authenticated, service_role;
grant execute on function public.entitlement(text, uuid)      to authenticated, service_role;
grant execute on function public.has_entitlement(text, uuid)  to authenticated, service_role;

grant select on public.my_entitlements to authenticated;

-- ── follow-up: purchases policy initplan (migration purchases_policy_initplan)
--
-- The performance linter flagged `user reads own purchases` for calling
-- auth.uid() per row instead of once per statement. Every other owner-read
-- policy already uses the (select auth.uid()) form; this one predated the
-- convention, and a receipt log only grows.
drop policy "user reads own purchases" on public.purchases;
create policy "user reads own purchases"
  on public.purchases for select
  to authenticated
  using ((select auth.uid()) = user_id);
