# Getting told when a lead arrives

`/api/lead` inserts a row into `lead_submissions` with `status: 'new'` and
returns `200`. Nothing in this repo emails, texts, or pings anyone. A database
trigger now forwards each new lead to an Edge Function that logs it (Route C),
so there is a record outside the table — but until Route A or B is set up, the
contact page's promise that a message "goes straight to me" still depends on
somebody going to look.

The notification is deliberately **not** in `api/lead.js`. A send in the request
path is one more thing that can fail or hang while a visitor waits on the submit
button, and that path was hardened against exactly that. Firing after the row is
committed means a broken notification can no longer cost you the lead itself.

Route C below is **wired and running now** — leads reach the `claude-webhook`
Edge Function's logs. It does not yet send you anything; Routes A and B are the
two ways to turn it into an actual alert, and both need a dashboard login.

Project: `iubxycckgrplbpdbncfk` · table: `public.lead_submissions`

---

## First, the thing that trips people up

Supabase Database Webhooks send a **fixed payload** and give you no way to
reshape the request body:

```json
{
  "type": "INSERT",
  "table": "lead_submissions",
  "schema": "public",
  "record": {
    "site": "negotiatorcruz",
    "form_type": "contact",
    "name": "Jane Rivera",
    "email": "jane@acme.com",
    "phone": null,
    "message": "Offer: one-day\nCompany: Acme\n---\nOur reps discount the second a buyer pauses.",
    "props": { "offer": "one-day", "company": "Acme", "team_size": "12 reps", "timeline": "Q4", "page": "/contact", "referrer": "" },
    "status": "new"
  },
  "old_record": null
}
```

You can add custom **headers**, but not a custom **body**. So you cannot point a
webhook straight at an email API like Resend — it expects `from` / `to` /
`subject` and will reject this shape with a 422. The destination has to be
something that accepts an arbitrary payload (Route A), or you build the body
yourself in SQL (Route B).

Note the context fields are nested under `props` — `record.props.offer`, not
`record.offer`. `record.message` already repeats that context as readable text
above a `---` divider, so an alert that forwards `message` alone is complete.

---

## Route A — Zapier or Make (no code, ~10 minutes)

Best if you want it working today and might later fan out to SMS or a CRM.

1. In **Zapier**, create a Zap with the trigger **Webhooks by Zapier → Catch
   Hook**. Copy the custom webhook URL it gives you.
2. In **Supabase → Database → Webhooks → Create a new hook**:

   | Field | Value |
   |---|---|
   | Name | `notify-on-new-lead` |
   | Table | `public.lead_submissions` |
   | Events | `INSERT` only |
   | Type | HTTP Request |
   | Method | `POST` |
   | URL | the Catch Hook URL from step 1 |

3. Submit the form at `/contact` once so Zapier receives a sample and learns the
   field names.
4. Add a **Gmail → Send Email** step. Map:
   - Subject: `New lead: {{record__name}} — {{record__props__offer}}`
   - Body: `{{record__message}}`, plus `{{record__email}}` and `{{record__phone}}`
5. Turn the Zap on.

**Filtering by site:** `lead_submissions` has a `site` column because nine of
your properties write to it. A plain webhook fires for all of them. To get only
this site's leads, add a **Filter by Zapier** step: continue only if
`record__site` **contains** `negotiatorcruz`.

Use *contains*, not *exactly matches* — this site is written under two different
values, `negotiatorcruz` and `negotiatorcruz.com`. See "The `site` column is
inconsistent" below.

---

## Route B — all in SQL, no third-party automation account

Everything lives in Supabase. Uses `pg_net`, the same extension the Webhooks UI
uses under the hood, but you control the body — so it can call Resend directly.

**Before you start:** sign up at resend.com **with the address you want the
alerts sent to**. On the free tier, the shared `onboarding@resend.dev` sender can
only deliver to your own account address. Sending to anything else needs a
verified domain.

> **This replaces Route C.** It deliberately reuses the same
> `public.notify_new_lead()` function and `notify_new_lead_trg` trigger names, so
> running it upgrades the live logging-only wiring into a real email alert in
> place. Nothing to uninstall first — but be aware you are overwriting, not
> adding alongside.

`pg_net` is already installed (Route C needed it), so there is nothing to enable.

Run this in **Supabase → SQL Editor**. Replace the key and the recipient.

```sql
-- 1. Store the Resend API key as a database setting.
--    Readable by anyone with database access — acceptable for a send-only key,
--    but do not reuse a key that can do anything else.
alter database postgres set app.resend_key = 're_your_key_here';
```

Then **reconnect** — the setting only applies to new connections, so reload the
SQL Editor tab — and run:

```sql
create or replace function public.notify_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.resend_key', true)
    ),
    body := jsonb_build_object(
      'from', 'Leads <onboarding@resend.dev>',
      'to',   jsonb_build_array('negotiatorsondemand@gmail.com'),
      'subject', 'New lead: ' || coalesce(new.name, '(no name)')
                 || coalesce(' — ' || (new.props ->> 'offer'), ''),
      'text', concat_ws(E'\n',
        'Name:  ' || coalesce(new.name,  ''),
        'Email: ' || coalesce(new.email, ''),
        'Phone: ' || coalesce(new.phone, '—'),
        'Site:  ' || coalesce(new.site,  ''),
        '',
        coalesce(new.message, '(no message)'))
    )
  );
  return new;
end;
$$;

-- The WHEN clause is the site filter. Drop it to be alerted for every
-- property that writes to this table, not just negotiatorcruz.
--
-- Both spellings on purpose -- see "The site column is inconsistent" below.
drop trigger if exists notify_new_lead_trg on public.lead_submissions;
create trigger notify_new_lead_trg
after insert on public.lead_submissions
for each row
when (new.site in ('negotiatorcruz', 'negotiatorcruz.com'))
execute function public.notify_new_lead();
```

`net.http_post` queues the request and returns immediately, so the insert is
never held up waiting on Resend.

One thing to carry over from the live Route C version if you adopt this: wrap the
`perform net.http_post(...)` in a `begin ... exception when others then raise
warning ... end;` block. This is an `AFTER INSERT` trigger, so an uncaught error
rolls the insert back — a broken alert would destroy the lead it was meant to
announce.

---

## Route C — `claude-webhook` — **WIRED AND LIVE**

This is the one currently running. Applied as migration
`notify_new_lead_via_claude_webhook`.

Every insert into `lead_submissions` where `site` is `negotiatorcruz` or
`negotiatorcruz.com` now POSTs to the `claude-webhook` Edge Function, which
validates the JSON, logs the payload and returns `{"ok":true,"received":true}`.

**This logs. It does not yet notify.** Leads land in the Edge Function logs
(Dashboard → Edge Functions → claude-webhook → Logs) rather than in your inbox.
To turn it into a real alert, either extend the function with a send step or
switch to Route A or B above.

Verified end to end on 2026-08-03: a test insert fired the trigger, `pg_net`
recorded `status_code 200` with body `{"ok":true,"received":true}` 24ms later,
and the function logged `POST | 200 | .../claude-webhook`. Both test rows were
deleted afterwards.

To inspect or change it:

```sql
-- what the trigger sends, and whether it is still attached
select pg_get_functiondef('public.notify_new_lead'::regproc);
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.lead_submissions'::regclass and not tgisinternal;

-- delivery history
select id, status_code, left(content,200) as body, error_msg, created
  from net._http_response order by created desc limit 20;

-- turn it off without dropping anything
alter table public.lead_submissions disable trigger notify_new_lead_trg;
```

Two deliberate choices in that trigger worth knowing about:

- **It swallows its own errors.** The send is wrapped in a `begin/exception`
  block that downgrades any failure to a warning. It is an `AFTER INSERT`
  trigger, so an uncaught exception would roll the insert back — a broken
  notification would destroy the lead it was meant to announce.
- **It carries an `Authorization` header.** `claude-webhook` has `verify_jwt`
  enabled, so without it every call returns 401. The header holds the public
  anon key, which grants nothing the browser does not already have.

**It has `verify_jwt: true`, which will silently break a database webhook
pointed at it.** An unauthenticated call gets:

```
HTTP 401  {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
```

Two ways round it, both fine:

- **Add the header to the hook.** In the webhook's HTTP Headers section add
  `Authorization: Bearer <anon key>`. The anon key is safe here — it grants no
  more than the browser already has.
- **Turn `verify_jwt` off** for that function, which is what the project's other
  receivers (`stripe-webhook`, `subscribe-convertkit`, `broker`) already do. If
  you do this, the function is publicly callable, so it should verify a shared
  secret header of its own before acting on a payload.

Confirmed working with the anon key:

```bash
curl -X POST "https://iubxycckgrplbpdbncfk.supabase.co/functions/v1/claude-webhook" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <anon key>" \
  -d '{"message":"hello from claude"}'
# {"ok":true,"received":true}
```

Note this route logs but does not notify. To get an actual alert it still needs
a send step — either extend the function to call Resend, or use Route A/B.

## Confirm it works

Submit the real form at `/contact` with your own address. The alert should
arrive within a few seconds.

If it does not:

- **Route A** — Supabase → Database → Webhooks → the hook → **Logs**. A non-2xx
  response tells you the destination rejected it.
- **Route B** — run `select * from net._http_response order by created desc limit 5;`
  in the SQL Editor. A 422 usually means the recipient is not your Resend account
  address; a 401 means the key setting did not load, so reconnect and retry.

Either way the row still lands in `lead_submissions`. A failed notification does
not fail the insert — that is the intended trade, and it also means a silent
failure here is easy to miss. Check that the alert still fires after any change
to the table.

## The `site` column is inconsistent, and it will split your data

`lead_submissions` is shared across nine properties, and `site` is what every
cross-domain report groups by. Two writers disagree about this site's value:

| Writer | Value written |
|---|---|
| `api/lead.js` (this repo's contact form) | `negotiatorcruz` |
| `subscribe-convertkit` Edge Function (newsletter, shared) | `negotiatorcruz.com` |

That function allowlists all nine properties as full hostnames —
`dancruzhomes.com`, `fatcatpm.com`, `nodnews.com` and so on — so the convention
across the project is clearly **with** the `.com`, and this repo is the outlier.

It has not bitten yet only because no newsletter signup has come from this site.
The moment one does, the same property starts reporting under two different
keys and every "leads by site" figure quietly undercounts.

The fix is a one-word change in `api/lead.js` (`site: 'negotiatorcruz'` →
`'negotiatorcruz.com'`), but it is deliberately **not** made here: other
properties in the account may already filter or report on the short form, and
those repos are outside this one. Confirm nothing else depends on
`negotiatorcruz` before changing it. The trigger above accepts both spellings so
notifications keep working either way.

## Worth adding later

`status` is on the table but nothing ever moves a row off `'new'`. If lead volume
outgrows an inbox, a `contacted` / `booked` / `dead` transition is the next thing
worth having — the column is sitting there waiting for it.
