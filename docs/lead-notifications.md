# Getting told when a lead arrives

`/api/lead` inserts a row into `lead_submissions` with `status: 'new'` and
returns `200`. That is the whole of it — nothing in this repo emails, texts, or
pings anyone. Until one of the routes below exists, the contact page's promise
that a message "goes straight to me" depends on somebody remembering to open the
table.

The notification is deliberately **not** in `api/lead.js`. A send in the request
path is one more thing that can fail or hang while a visitor waits on the submit
button, and that path was hardened against exactly that. Firing after the row is
committed means a broken notification can no longer cost you the lead itself.

Both routes need a Supabase dashboard login, so they are written out here rather
than done for you.

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

**Filtering by site:** `lead_submissions` has a `site` column because more than
one of your properties writes to it. A plain webhook fires for all of them. To
get only this site's leads, add a **Filter by Zapier** step: continue only if
`record__site` **exactly matches** `negotiatorcruz`.

---

## Route B — all in SQL, no third-party automation account

Everything lives in Supabase. Uses `pg_net`, the same extension the Webhooks UI
uses under the hood, but you control the body — so it can call Resend directly.

**Before you start:** sign up at resend.com **with the address you want the
alerts sent to**. On the free tier, the shared `onboarding@resend.dev` sender can
only deliver to your own account address. Sending to anything else needs a
verified domain.

Run this in **Supabase → SQL Editor**. Replace the key and the recipient.

```sql
-- 1. Store the Resend API key as a database setting.
--    Readable by anyone with database access — acceptable for a send-only key,
--    but do not reuse a key that can do anything else.
alter database postgres set app.resend_key = 're_your_key_here';
```

Then **reconnect** (the setting only applies to new connections — reload the SQL
Editor tab), and run:

Enable **pg_net** first from **Database → Extensions** (search `pg_net`, toggle
it on). Enabling it from the UI avoids guessing which schema the extension
installs into — it exposes `net.http_post` either way.

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
drop trigger if exists notify_new_lead_trg on public.lead_submissions;
create trigger notify_new_lead_trg
after insert on public.lead_submissions
for each row
when (new.site = 'negotiatorcruz')
execute function public.notify_new_lead();
```

`net.http_post` queues the request and returns immediately, so the insert is
never held up waiting on Resend.

---

---

## Route C — the existing `claude-webhook` Edge Function

The project already has a `claude-webhook` function. As of this writing it is a
receiver stub: it validates the JSON, logs the payload, and returns
`{"ok":true,"received":true}`. Useful as a wiring target while you build the
notification out, since the Edge Function logs give you a record of every lead
even before an alert exists.

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

## Worth adding later

`status` is on the table but nothing ever moves a row off `'new'`. If lead volume
outgrows an inbox, a `contacted` / `booked` / `dead` transition is the next thing
worth having — the column is sitting there waiting for it.
