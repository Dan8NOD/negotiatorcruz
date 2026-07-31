# Getting told when a lead arrives

`/api/lead` inserts a row into `leads` with `status: 'new'` and returns `200`.
That is the whole of it — nothing in this repo emails, texts, or pings anyone.
Until the webhook below exists, the contact page's promise that a message "goes
straight to me" depends on somebody remembering to open the table.

The notification is deliberately **not** in `api/lead.js`. A send in the request
path is one more thing that can fail or hang while a visitor waits on the submit
button, and that path was just hardened against exactly that. A database webhook
fires after the row is committed, so a broken notification can no longer cost you
the lead itself.

Configuring it needs a Supabase dashboard login, so it is written out here rather
than done for you.

---

## Setup

**Supabase dashboard → Database → Webhooks → "Create a new hook"**

| Field | Value |
|---|---|
| Name | `notify-on-new-lead` |
| Table | `leads` |
| Events | `INSERT` only |
| Type | HTTP Request |
| Method | `POST` |

For the URL, pick whichever you already have an account with:

- **Zapier / Make** — create a "Catch Hook" trigger, paste its URL here, and add
  a Gmail "send email" step. No code, and it can fan out to SMS later.
- **Resend** — `https://api.resend.com/emails`, with headers
  `Authorization: Bearer <your key>` and `Content-Type: application/json`.
  Keys live in the Supabase webhook config, not in this repo.

Supabase posts a JSON body shaped like:

```json
{ "type": "INSERT", "table": "leads", "record": { "name": "...", "email": "...", "message": "...", "status": "new" } }
```

so the fields to surface in the alert are `record.name`, `record.email`,
`record.offer` and `record.message`.

## Confirm it works

Submit the real form at `/contact` with your own address. You should get the
alert within a few seconds, and the row should still appear in `leads` either
way. If the alert does not arrive, check **Database → Webhooks → Logs** — a
failed webhook does not fail the insert, which is the intended trade and also
means a silent failure here is easy to miss.

## Worth adding later

`status` is already on the table but nothing ever moves a row off `'new'`. If
lead volume grows past what an inbox handles comfortably, a `contacted` /
`booked` / `dead` transition is the next thing worth having — the column is
sitting there waiting for it.
