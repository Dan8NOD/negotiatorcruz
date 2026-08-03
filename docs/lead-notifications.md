# Getting told when a lead arrives

**Email alerts are live.** A database trigger emails
`negotiatorsondemand@gmail.com` via Resend the moment a lead lands, with
`reply_to` set to the sender so replying goes straight back to them. Route B
below is the version running; Routes A and C are alternatives kept for reference.

`/api/lead` itself only inserts a row into `lead_submissions` with
`status: 'new'` and returns `200` — nothing in the request path sends anything.

The notification is deliberately **not** in `api/lead.js`. A send in the request
path is one more thing that can fail or hang while a visitor waits on the submit
button, and that path was hardened against exactly that. Firing after the row is
committed means a broken notification can no longer cost you the lead itself.

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

## Route B — Resend via SQL — **THIS IS WHAT IS RUNNING**

Applied as migration `notify_new_lead_via_resend_email`. Everything lives in
Supabase: `pg_net` posts to Resend, and the trigger builds the email body itself.

**Sender constraint:** on Resend's free tier the shared `onboarding@resend.dev`
address can only deliver to the address the Resend account was registered with.
Sending anywhere else needs a verified domain. A `200` from Resend means
*accepted for delivery*, not delivered — if the alert never lands, that mismatch
is the first thing to check.

### The key lives in Vault, not in a database setting

The obvious approach does not work here:

```sql
alter database postgres set app.resend_key = '...';
-- ERROR: 42501: permission denied to set parameter "app.resend_key"
```

`ALTER DATABASE ... SET` needs privileges the project connection does not have.
Supabase Vault is the supported route, and it is better anyway — the secret is
encrypted at rest and never appears in `pg_get_functiondef`, so the key cannot
leak through a schema dump.

```sql
-- Store once. Returns the secret's uuid.
select vault.create_secret('re_your_key_here', 'resend_api_key',
                           'Resend send-only key for lead alerts');

-- Rotate later without touching any code:
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'resend_api_key'),
--   're_new_key_here');
```

The trigger function then reads it at send time:

```sql
create or replace function public.notify_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text;
  v_offer text := new.props ->> 'offer';
begin
  /* Never let a notification failure cost the lead. This is an AFTER INSERT
     trigger, so an uncaught exception rolls the insert back -- a broken alert
     would destroy the submission it exists to announce. */
  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets
     where name = 'resend_api_key'
     limit 1;

    if v_key is null then
      raise warning 'notify_new_lead: vault secret resend_api_key not found';
      return new;
    end if;

    perform net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'from', 'Negotiators Cruz <onboarding@resend.dev>',
        'to',   jsonb_build_array('negotiatorsondemand@gmail.com'),
        -- Reply goes to the lead, not into the void.
        'reply_to', coalesce(new.email, 'negotiatorsondemand@gmail.com'),
        -- coalesce(' — ' || v_offer, '') yields '' when offer is null, so the
        -- subject never trails a dangling separator.
        'subject', 'New lead: ' || coalesce(new.name, '(no name)')
                   || coalesce(' — ' || v_offer, ''),
        'text', concat_ws(E'\n',
          'Name:    ' || coalesce(new.name,  ''),
          'Email:   ' || coalesce(new.email, ''),
          'Phone:   ' || coalesce(new.phone, '—'),
          'Company: ' || coalesce(new.props ->> 'company', '—'),
          'Team:    ' || coalesce(new.props ->> 'team_size', '—'),
          'When:    ' || coalesce(new.props ->> 'timeline', '—'),
          'Site:    ' || coalesce(new.site,  ''),
          '',
          coalesce(new.message, '(no message)'),
          '',
          '— reply straight to this email to reach them')
      )
    );
  exception when others then
    raise warning 'notify_new_lead: %', sqlerrm;
  end;
  return new;
end;
$$;

-- The WHEN clause is the site filter. Drop it to be alerted for every property
-- that writes to this table, not just negotiatorcruz. Both spellings on purpose
-- -- see "The site column is inconsistent" below.
drop trigger if exists notify_new_lead_trg on public.lead_submissions;
create trigger notify_new_lead_trg
after insert on public.lead_submissions
for each row
when (new.site in ('negotiatorcruz', 'negotiatorcruz.com'))
execute function public.notify_new_lead();
```

`net.http_post` queues the request and returns immediately, so the insert is
never held up waiting on Resend.

Verified end to end on 2026-08-03: a test insert fired the trigger and `pg_net`
recorded `status_code 200` from Resend with a message id, 26ms after the insert.
The test row was deleted afterwards, so the table is empty and the first real
lead will not be sitting behind test noise.

---

## Route C — `claude-webhook` — superseded, kept for reference

Was wired briefly (migration `notify_new_lead_via_claude_webhook`) and replaced
by Route B once an email key existed. It POSTed each lead to the `claude-webhook`
Edge Function, which logs the payload and returns `{"ok":true,"received":true}`.

Worth keeping in mind as a debugging target: pointing the trigger back at it
gives a payload log with no email provider involved.

**`claude-webhook` has `verify_jwt` enabled**, so anything calling it must send
`Authorization: Bearer <anon key>` — without it every call returns 401 while
inserts keep succeeding, and nothing anywhere reports a problem. The project's
other receivers (`stripe-webhook`, `subscribe-convertkit`, `broker`) have
`verify_jwt` off instead.

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
