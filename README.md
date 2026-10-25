# IITB Placement Watch

A personal placement monitor that runs in Google Apps Script, using its free consumer-account allowance. It checks the official IITB placement blog every 5 minutes, emails new announcements to its configured subscribers, and saves clearly timed future meetings and deadlines to its owner's Google Calendar. If the blog is reachable only on an institute network or VPN, the optional [local HTTPS reader](checker/LOCAL.md) feeds that same Google service from an awake, connected Mac; Google then monitors feed health instead of fetching the source itself.

Production uses no paid AI, browser provider or permanent GitHub runner. GitHub stores only generic code, with an optional manually started development-test workflow. The fixture tests can run locally when GitHub execution is unavailable; no payment is needed for the monitor.

For one-time authentication, use the [Chrome connector](chrome-connector/README.md) in the regular Chrome profile where IITB already remembers your login. Install it yourself, open the real placement blog, then explicitly choose Connect. It sends restricted Secure IITB cookies to your own private Google monitor, asks Google to verify a complete source read, and enables the 5-minute schedule when access and delivery are healthy. It removes its Chrome permissions after the attempt. Enter credentials and OTP only on IITB's official website. Once the connector confirms activation, ongoing checks need neither Chrome nor your computer. The [isolated login helper](login/README.md) remains an alternative for a fresh official login.

## What gets saved

Sign in on the real IITB website and complete any requested OTP yourself. The explicitly approved connector saves only supported IITB cookies to your private Google storage. Login cookies can grant IITB account access; inspect the connector's consent text before choosing Connect. It never collects your password or OTP, reads profile files, copies HTTP authentication credentials, or monitors in the background. Login files, recipient settings, announcement contents, message IDs and event IDs must not be committed or logged. Forwarded setup ports must remain private.

The production monitor uses authenticated HTTPS requests rather than keeping a browser open. IITB can expire the session or require another OTP; reconnect when that happens. Its acceptance of this cloud session must be tested before enabling the monitor.

## Set up the Google monitor

1. Create an Apps Script project in the Google account that should receive the mail and own the calendar. Upload only the files in `apps-script/` allowed by `.claspignore`, including `appsscript.json`. Use Google's default Apps Script Cloud project; no paid Cloud project is needed.
2. In private Script Properties, set `INIT_CONFIG_JSON` with `recipient_email`, `calendar_id`, `timezone` and `baseline_cutoff`. To preserve a previous installation's delivery history, set `INIT_MIGRATION_JSON` with its private state JSON. Neither file belongs in this repository.
3. Run `adminSetup` in the Google editor. Review Google's permissions and authorize the project. It verifies the account and creates its own private storage. Existing data is retained on repeat setup.
4. Deploy the bridge as a web app that executes as you. The endpoint is protected with HMAC; unauthenticated calls reveal no private state. Copy its `/exec` URL and private `BRIDGE_SECRET` to the one-time login helper, never to an issue, repository or chat.
5. Install the one-time Chrome connector in your remembered profile and explicitly choose Connect. A private owner-only package can prefill Google setup values. Connect saves the supported session, verifies actual access from Google, and enables one fixed 5-minute trigger. Wait for its activation confirmation, then remove the connector. If access fails or delivery needs review, the connector reports the issue and does not claim activation.
6. If using the isolated helper instead, complete official IITB sign-in there and choose Save login, then run the owner source-access check and `installMonitor`. A successful deployment, saved browser session, manual announcement delivery and actual cloud source read are separate facts.

## Delivery rules

Only meaningful announcements generate mail. Existing post revisions and verified Gmail delivery IDs prevent repeat alerts. The returned provider ID is saved immediately; a delivery reference and exact message-body check also recover a send whose response was lost. Source text is data, never an instruction to change permissions, recipients or accounts.

Events are private, have no guests, and retain the original meeting link. Their reminders are an email 60 minutes before and a popup 5 minutes before. A missing end time is explicitly marked as a provisional one-hour slot. An ambiguous date or time produces an email asking for clarification, rather than an invented event. Update and cancellation announcements modify the existing matching meeting.

The helper never applies to jobs, fills forms, submits attendance, buys anything or contacts organizers.

## Costs and limits

Production uses the free Google Apps Script allowance. Quota exhaustion stops operations; this code does not provision a billed Google Cloud project or use a paid service. The one-time Chrome connector requires no subscription. Do not start paid Codespaces usage. Timing can vary and account or IITB policy changes can interrupt checks. A successful logged-in browser view alone does not establish unattended cloud access.

Official references: [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable), [GitHub additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces).

## Optional WhatsApp channel

[The separate WhatsApp relay](whatsapp-relay/README.md) supports explicitly selected
receiving numbers and existing groups, using a separately linked sending account.
Its Free Render service can sleep between alerts; a separate Free Supabase
database retains device keys and the durable queue. Google sends only new
announcement payloads to the signed relay, never IITB cookies or its admin secret.
QR linking, recipients and live proof must be verified before enabling the
optional channel. Relay failures leave email and Calendar operations running.
Read the relay setup and limits before deployment; it is disabled by default.

## Development

Use Node 24 or newer. Install dependencies with `npm ci`, then run `npm test`. Tests use synthetic data and do not sign in to IITB, read account data, send email or create events. Do not add a recurring production GitHub Actions workflow.

This is an unofficial personal helper, not an IIT Bombay service.
