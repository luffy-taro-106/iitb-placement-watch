# Google Apps Script component

This component stores the IITB session and placement history in owner-only Google Drive JSON files. Apps Script runs production checks every 30 minutes and uses the owner's authorized Gmail and Google Calendar APIs. GitHub contains source and one-time setup/development helpers; it has no production polling workflow and receives no Google OAuth token.

Upload all `.gs` files and `appsscript.json` to one private Apps Script project. Enable the Advanced Drive v3, Gmail v1 and Calendar v3 services. The manifest uses `drive.file`, permitting files created for this app rather than every Drive file. Public source contains no personal account, delivered message ID, saved event ID, password, OTP or cookie.

## Owner setup

In the private project's **Project Settings → Script properties**, set `INIT_CONFIG_JSON` to the separately supplied configuration with `recipient_email`, `calendar_id`, `timezone: "Asia/Kolkata"` and `baseline_cutoff: "2026-10-11T10:25:30+05:30"`. The account fields must match the current Gmail account and its primary calendar. Set `INIT_MIGRATION_JSON` to the separately supplied private history. Preserve the original `posts`, `meetings`, `deliveries` and cutoff; never commit this JSON to public source.

Run `adminSetup()` manually and authorize Google permissions. It verifies account identity, creates three owner-only JSON files, saves their IDs as `CONFIG_FILE_ID`, `STATE_FILE_ID` and `SESSION_FILE_ID`, generates `BRIDGE_SECRET` if absent, and removes initialization JSON properties after completion. It never logs or returns the secret. Interrupted file creation retains initialization inputs and does not mark partial setup complete; orphan files remain private.

Copy `BRIDGE_SECRET` from these private Script properties into the one-time helper's `IITB_HMAC_SECRET`. Deploy the web app **as yourself**, with access **Anyone**, and use its `/exec` URL as `IITB_BRIDGE_URL`. Public reachability is required for the signed bridge. The harmless `doGet` response is plain text, with no personal data, credential form or HtmlService RPC bridge. Manual setup/install functions additionally check the active owner's identity. Data operations require valid HMAC, fresh timestamp and unused nonce; no Google OAuth token is exposed.

The one-time cloud development login helper visits IITB's official sign-in page. Enter username/password/phone OTP there, select Remember me and save its verified session through the bridge. Cookies stay in private Drive. Shut down the development browser after saving. This component never asks for IITB credentials or OTP on its own page.

Run `runCheck()` manually to verify direct source access and account identity. The migrated cutoff, sent IDs and meeting IDs remain. Existing posts quietly receive the new fingerprint format. A real new announcement exercises Gmail delivery; a clear future meeting exercises Calendar creation. Fixture tests and trigger creation do not prove provider writes succeeded.

When that check succeeds without unfinished calendar work, run `installMonitor()`. It rechecks access, then creates one installable `runCheck` trigger with `everyMinutes(30)`. Existing triggers are reused; multiple matching triggers cause an error. Google controls trigger timing, so this is an approximately 30-minute cadence. Session expiry, revoked Google access, quotas and outages can require attention.

## Signed protocol

POST UTF-8 JSON `{action, nonce, issued_at, payload, signature}` to `/exec`. `nonce` is 16 random bytes rendered as 32 lowercase hexadecimal characters. `issued_at` is integer UNIX seconds. Requests more than 300 seconds old or 60 seconds in the future are rejected. The lowercase hexadecimal signature is HMAC-SHA256 with `BRIDGE_SECRET` over exactly the UTF-8 bytes of `JSON.stringify([action, nonce, issued_at, payload])`.

Nonces are consumed before the action and persist for 10 minutes; retries need new nonces and signatures. Script locks serialize requests and production runs. Follow ContentService response redirects and parse JSON: Apps Script cannot reliably set application HTTP error statuses. Require `ok: true`; HTTP 200 alone is insufficient.

| Action | Payload | Result |
| --- | --- | --- |
| `get_session` | `{}` | `{ok:true,session:storageStateOrNull,last_successful_check:ISOOrNull}` |
| `save_session` | `{source_url,session,verified_at}` | `{ok:true,connected:true}` |
| `ingest_snapshot` | `{source_url,posts,complete:true,observed_at,session?}` | `{ok:true,needs_attention,pending_count,last_successful_check,delivery_count,meeting_count}` |
| `status` | `{}` | Counts, timestamps, session presence/expiry, trigger presence and attention; no cookies or announcement content |

`source_url` must equal the IITB placement blog URL. Sessions use Playwright `storageState`: `cookies` and empty `origins`. Only Secure cookies for exact campus/SSO hosts (optional leading dot) and shared **`.iitb.ac.in`** are accepted. Bare `iitb.ac.in`, other domains and localStorage are rejected. Non-expired cookies do not prove IITB still accepts them.

Snapshots require complete pagination, at least one and at most 500 posts, and total request size ≤1.5 MB. Each post has `id: "post-N"`, matching exact blog `?p=N` URL, title, publication ISO datetime, original normalized text and `{text,url}` links. Bounds: title 1,000 characters, text 64,000, 100 links/post, link text 1,000, link URL 4,096. `observed_at`/`verified_at` must be within 10 minutes. Publication dates remain separate from meeting dates.

## Delivery and recovery

Mail goes only to the configured owner, once per revision. Deterministic RFC Message-ID and persisted send attempts guard uncertain responses. Recovery searches Sent mail and verifies exact Message-ID, To and SENT before acknowledging. An uncertain message that cannot be found requires owner review rather than an automatic resend.

Calendar uses deterministic IDs, migrated IDs, source references and provider readback. Clear future meeting dates/times use Asia/Kolkata. Ambiguous timing or conditional/negated change wording produces a mail warning without changing an event. Missing end means a provisional one-hour slot. Events are private, with no guests or generated Meet conference, original joining link, and email/popup reminders 60/30 minutes before. Conflicts retain the announced time and are noted. Reschedules update one safely matched saved occurrence; unmatched or multiple matches require review. Every existing-event update checks owner organization, no external attendees and source identity. A confirmed, matched cancellation labels the saved event cancelled and transparent, then verifies the result before saving its acknowledgement.

Calendar failures stay pending. Deterministic IDs recover uncertain inserts. If scheduling later succeeds after a failure digest, one followup confirms it. Source failures save a sanitized error and notify once until checks recover. Account/private-storage failures do not send mail or change calendars.

## Verification

Run `node apps-script/apps-script.test.mjs` from the repository root. Google services are mocked. Tests cover canonical HMAC/replay, cookie restrictions, private migration/partial setup, quiet baseline, deterministic events, owner/source guards and cancellation readback, conservative change wording, separate-post reschedules, uncertain send/insert/state-write recovery including later date changes, superseding obsolete calendar retries while retaining sent history and uncertain-email recovery, followups and duplicates. They do not deploy, access credentials, send mail or change calendars. `Source.gs` has separate direct-source fixture tests.

Google references: [advanced Gmail](https://developers.google.com/apps-script/advanced/gmail), [Gmail MIME sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [time triggers](https://developers.google.com/apps-script/guides/triggers/installable), [properties](https://developers.google.com/apps-script/guides/properties).
