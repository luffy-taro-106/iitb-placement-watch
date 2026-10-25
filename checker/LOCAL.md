# Local network reader

When IITB's blog is reachable only on an institute network or VPN, the local
HTTPS reader supplies complete snapshots to the existing private Google bridge.
It uses the explicitly approved saved IITB session, follows bounded GET redirects
only on the supported official hosts, retains TLS verification, and never runs a
browser or submits a password, OTP or form. Source HTML uses the same parser as
the Google reader so moving between readers does not re-mail unchanged posts.

`checker/local-check.mjs` loads the owner's existing private bridge configuration,
retrieves the saved session for the check, reads complete pagination, and sends
`ingest_local_snapshot`. Refreshed restricted cookies remain in the owner's
private Google storage. The local status contains only timestamps, counts and
fixed error codes. The process does not write passwords, cookies or tokens to
logs or ordinary source files. Each process uses a private local lock; crashed
locks become recoverable after ten minutes.

The owner-approved macOS LaunchAgent uses `StartInterval:300` and `RunAtLoad:true`.
It runs in the signed-in user's session while the Mac is awake and connected to
the institute network or VPN. Sleeping, shutdown, logging out, unavailable VPN,
revoked authorization or another required IITB sign-in can interrupt it. There
is no subscription or paid cloud resource.

The first successful complete local check records a separate local observation
and switches the existing Google trigger to health checks of that feed. Google
continues all Gmail and Calendar writes under the same lock and revision history;
it does not run a second delivery schedule. A missing local observation for more
than fifteen minutes produces the existing deduplicated, owner-only failure
notice. A local observation is never described as a successful source read from
Google's servers.

If authentication expires, use the one-time connector in the remembered Chrome
profile. A private connector package can set `source_mode:"local_https"`; in this
mode its approved Connect action saves the restricted session and revokes its
permissions, reporting local verification as pending. It does not attempt to
activate a Google source read while the source is unreachable publicly. The Mac
job verifies the session independently on its next run.

Install only after the owner chooses this runtime. Do not enable the older local
Codex automation, start browser monitoring, or keep a second email/calendar
implementation. The Google owner, subscribers, source and saved provider IDs are
unchanged. Removing the LaunchAgent stops local polling; retain the private
Google history.
