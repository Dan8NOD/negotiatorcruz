# Getting told when a lead arrives

`/api/lead` inserts a row into `lead_submissions` with `status: 'new'` and
returns `200`.
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
| Table | `lead_submissions` |
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
{
  "type": "INSERT",
  "table": "lead_submissions",
  "record": {
    "site": "negotiatorcruz",
    "form_type": "contact",
    "name": "...",
    "email": "...",
    "phone": null,
    "message": "Offer: one-day\nCompany: ...\n---\n<their note>",
    "props": { "offer": "one-day", "company": "...", "team_size": "...", "timeline": "...", "page": "/contact", "referrer": "..." },
    "status": "new"
  }
}
```

So the fields worth surfacing in the alert are `record.name`, `record.email`,
`record.props.offer` and `record.message`.

Note the shape: the context fields are **nested under `props`**, not top-level
columns — `record.props.offer`, not `record.offer`. `message` already has the
same context prepended as readable text above a `---` divider, so an alert that
sends `record.message` alone is complete on its own.

## Confirm it works

Submit the real form at `/contact` with your own address. You should get the
alert within a few seconds, and the row should still appear in `lead_submissions` either
way. If the alert does not arrive, check **Database → Webhooks → Logs** — a
failed webhook does not fail the insert, which is the intended trade and also
means a silent failure here is easy to miss.

## Worth adding later

`status` is already on the table but nothing ever moves a row off `'new'`. If
lead volume grows past what an inbox handles comfortably, a `contacted` /
`booked` / `dead` transition is the next thing worth having — the column is
sitting there waiting for it.
