# Optional free WhatsApp relay

This is a separate, currently optional channel. It does not replace the Google
Apps Script source, email or Calendar monitor. It uses whatsmeow's linked-device
SDK; whatscli is a terminal UI and does not support automated command sending.

Deploy a **Free** Render web service from this directory with Docker, no payment
method and no paid add-ons. Its included hours are shared with the workspace.
Free services sleep after 15 minutes and can take about one minute to wake. A
new Google alert wakes the relay; the device keys and queue survive restarts in
a separate **Free** Supabase PostgreSQL project. Free quotas, pauses, outages,
protocol changes or a revoked linked device can interrupt delivery. This is not
a promise of forever-free or uninterrupted service. There are no paid API calls
or artificial keepalive requests.

The database uses a dedicated `placement_wa` login and unexposed
`whatsapp_relay` schema. The role owns only this schema, has no bypass-RLS,
role-creation or database-creation permissions. Disable the project's Data API.
Revoke schema/default object grants from PUBLIC, anon and authenticated. The
service enables RLS on its own and the SDK's private tables during upgrade.
Use the exact **session** pooler host from the dashboard, not transaction mode,
with certificate/hostname verification (`sslmode=verify-full`). Do not guess the
pooler host from the region or use a database superuser in the service.
The relay embeds Supabase's public Root 2021 CA (SHA-256
`807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`)
downloaded from its official Dashboard certificate link. TLS chain, expiration
and hostname verification remain enabled; refresh this certificate if the
provider rotates it or before its April 2031 expiry.

Set the private values in `.env.example` as Render environment secrets. Use
different randomly generated 32-byte hex ADMIN_TOKEN and RELAY_SECRET values.
Neither belongs in a source file, URL, browser storage, logs or chat. The relay
does not receive the Google admin bridge secret, IITB credentials or cookies.

Open the service and enter the private setup key. Linking requires an explicit
checkbox and the user's own QR scan from the separate sending phone. Configure
E.164 numbers and/or select existing groups the account is already in. Saving
recipients verifies the numbers are on WhatsApp and the selected groups are
joined. No email-to-phone lookup, arbitrary destinations in announcement text,
group creation or automatic addition of friends is supported. The SDK receives
protocol events but the relay does not collect/log incoming chat text or expose
message history. Linked-device keys are sensitive and private to this project.

POST `/v1` accepts only HMAC-signed `deliver` and `status` actions, with a
32-character hex nonce, timestamp within -300/+60 seconds, and a signature over
`JSON.stringify([action,nonce,issued_at,payload])`. Nonces are persisted before
execution. A delivery payload is exactly
`{delivery_key,post_id,fingerprint,title,text,source_url}`, where the key is
`post_id + ':' + fingerprint` and source_url is the fixed official post URL.
Recipients come only from private saved preferences. Repeated delivery keys
must have the same body and reuse the original recipient snapshot.

HTTP 202 `state:accepted` means durable queue acceptance, **not** delivery.
The worker commits a generated WhatsApp message ID and `attempting` state
before network sending. A server acknowledgment marks `acknowledged`; receipt
signals are recorded separately (a group receipt does not prove every member
received/read the message). Crash/timeout attempts become `uncertain` and never
automatically resend. A receipt can resolve uncertainty. Delivery review and
account reconnect are owner-only actions. A session advisory lock prevents
overlapping deployments from sending through the same linked device.

Run `go test -race ./...` and `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...`.
Tests use synthetic announcements and never connect to WhatsApp or send alerts.
Do not activate Google's optional channel until private status shows linked,
connected, intended destinations and no unresolved attention. Activation sets
a fresh cutoff and never blasts historical announcements.
