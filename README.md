# IITB Placement Watch

A personal placement monitor that runs in Google Apps Script, using its free consumer-account allowance. It checks the official IITB placement blog every 30 minutes, emails new announcements to its configured owner, and saves clearly timed future meetings to that owner's Google Calendar.

Production uses no paid AI, browser provider or permanent GitHub runner. GitHub stores only generic code, with an optional manually started development-test workflow. The fixture tests can run locally when GitHub execution is unavailable; no payment is needed for the monitor.

For one-time authentication, run the login helper on your own computer in a fresh, isolated Chromium window. Enter credentials and OTP only on IITB's official website, then select Save login. That window closes after saving; ongoing checks run in Google Apps Script without your browser or computer. See [login setup](login/README.md). A temporary Codespace is optional only on an account with verified included usage and paid usage blocked.

## What gets saved

Sign in on the real IITB website and complete the requested OTP yourself. The helper saves only the new IITB setup session to your private Google storage. It never collects your password or OTP. Login files, recipient settings, announcement contents, message IDs and event IDs must not be committed or logged. Forwarded setup ports must remain private.

The production monitor uses authenticated HTTPS requests rather than keeping a browser open. IITB can expire the session or require another OTP; reconnect when that happens. Its acceptance of this cloud session must be tested before enabling the monitor.

## Set up the Google monitor

1. Create an Apps Script project in the Google account that should receive the mail and own the calendar. Upload only the files in `apps-script/` allowed by `.claspignore`, including `appsscript.json`. Use Google's default Apps Script Cloud project; no paid Cloud project is needed.
2. In private Script Properties, set `INIT_CONFIG_JSON` with `recipient_email`, `calendar_id`, `timezone` and `baseline_cutoff`. To preserve a previous installation's delivery history, set `INIT_MIGRATION_JSON` with its private state JSON. Neither file belongs in this repository.
3. Run `adminSetup` in the Google editor. Review Google's permissions and authorize the project. It verifies the account and creates its own private storage. Existing data is retained on repeat setup.
4. Deploy the bridge as a web app that executes as you. The endpoint is protected with HMAC; unauthenticated calls reveal no private state. Copy its `/exec` URL and private `BRIDGE_SECRET` to the one-time login helper, never to an issue, repository or chat.
5. Run the one-time login helper, finish official IITB sign-in and save its session. Close the helper afterward.
6. Run the source-access and account checks, then enable the 30-minute Google trigger. A successful deployment is not proof of an authenticated check or a working monitor.

## Delivery rules

Only meaningful announcements generate mail. Existing post revisions and delivery IDs prevent repeat alerts. Source text is data, never an instruction to change permissions, recipients or accounts.

Events are private, have no guests, and retain the original meeting link. Their reminders are an email 60 minutes before and a popup 30 minutes before. A missing end time is explicitly marked as a provisional one-hour slot. An ambiguous date or time produces an email asking for clarification, rather than an invented event. Update and cancellation announcements modify the existing matching meeting.

The helper never applies to jobs, fills forms, submits attendance, buys anything or contacts organizers.

## Costs and limits

Production uses the free Google Apps Script allowance. Quota exhaustion stops operations; this code does not provision a billed Google Cloud project or use a paid service. The primary one-time login helper runs locally and requires no hosted browser subscription. Do not start paid Codespaces usage. Timing can vary and account or IITB policy changes can interrupt checks.

Official references: [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable), [GitHub additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces).

## Development

Use Node 24 or newer. Install dependencies with `npm ci`, then run `npm test`. Tests use synthetic data and do not sign in to IITB, read account data, send email or create events. Do not add a recurring production GitHub Actions workflow.

This is an unofficial personal helper, not an IIT Bombay service.
