# Google Apps Script component

This component stores the IITB session and placement history in owner-only Google Drive JSON files. Apps Script runs production checks every 5 minutes and uses the owner's authorized Gmail and Google Calendar APIs. GitHub contains source and one-time setup/development helpers; it has no production polling workflow and receives no Google OAuth token.

Upload all `.gs` files and `appsscript.json` to one private Apps Script project. Enable the Advanced Drive v3, Gmail v1 and Calendar v3 services. The manifest uses `drive.file`, permitting files created for this app rather than every Drive file. Public source contains no personal account, delivered message ID, saved event ID, password, OTP or cookie.

## Owner setup

In the private project's **Project Settings → Script properties**, set `INIT_CONFIG_JSON` to the separately supplied configuration with `recipient_email`, `calendar_id`, `timezone: "Asia/Kolkata"` and `baseline_cutoff: "2026-10-11T10:25:30+05:30"`. The account fields must match the current Gmail account and its primary calendar. Set `INIT_MIGRATION_JSON` to the separately supplied private history. Preserve the original `posts`, `meetings`, `deliveries` and cutoff; never commit this JSON to public source.

Run `adminSetup()` manually and authorize Google permissions. It verifies account identity, creates three owner-only JSON files, saves their IDs as `CONFIG_FILE_ID`, `STATE_FILE_ID` and `SESSION_FILE_ID`, generates `BRIDGE_SECRET` if absent, and removes initialization JSON properties after completion. It never logs or returns the secret. Interrupted file creation retains initialization inputs and does not mark partial setup complete; orphan files remain private.

Copy `BRIDGE_SECRET` from these private Script properties into the one-time helper's `IITB_HMAC_SECRET`. Deploy the web app **as yourself**, with access **Anyone**, and use its `/exec` URL as `IITB_BRIDGE_URL`. Public reachability is required for the signed bridge. The harmless `doGet` response is plain text, with no personal data, credential form or HtmlService RPC bridge. Manual setup/install functions additionally check the active owner's identity. Data operations require valid HMAC, fresh timestamp and unused nonce; no Google OAuth token is exposed.

The one-time Chrome connector reuses the profile where the user has already signed in on IITB's official page. The user installs it and explicitly approves a restricted Secure-cookie transfer to this private bridge. It never reads passwords, OTPs, profile files or cached HTTP authentication credentials. After saving this candidate session, it sends signed `install_monitor` to perform a real cloud source check and enable the 5-minute schedule. Exact-host Chrome permissions may omit shared parent-domain cookies. Remove the connector after its activation confirmation. Once cloud access is verified, ongoing production requires no browser or computer. The isolated login helper remains an alternative.

Run `runCheck()` manually to verify direct source access and account identity. The migrated cutoff, sent IDs and meeting IDs remain. Existing posts quietly receive the new fingerprint format. A real new announcement exercises Gmail delivery; a clear future meeting exercises Calendar creation. Fixture tests and trigger creation do not prove provider writes succeeded.

The Chrome connector performs activation automatically after the session transfer. The manual alternative is `installMonitor()`. Both use the same locked implementation: a fresh complete source check must succeed without unresolved delivery work before one installable `runCheck` trigger with `everyMinutes(5)` is created. The recorded legacy 30-minute trigger can be replaced by one 5-minute trigger. Unknown or multiple matching triggers cause an error. Signed `configure_monitor` with `{interval_minutes:5}` changes only an already recorded schedule, preserving a source outage until a fresh read proves recovery; it does not activate an unverified new monitor. Google controls trigger timing, so this is an approximately 5-minute cadence. Session expiry, revoked Google access, quotas and outages can require attention.

If the shorter placement session expires while IITB still remembers the account, the reader makes one bounded GET attempt through the official `https://campus.placements.iitb.ac.in/blog/placement/authplacement/` link used by the blog chooser's **Login as** button, then retries the requested page. An official HTTP redirect is upgraded to HTTPS before any request; authentication never travels over HTTP. The reader follows only the existing supported hosts and keeps replacement cookies only after the complete source read succeeds. It never submits credentials, an OTP or a CAPTCHA, executes login-page JavaScript or switches accounts. Rejection or a required credential screen still needs reconnection; remembered sign-in is not a guarantee of permanent access. A live Google check on 12 October 2026 renewed an expired placement cookie, read complete pagination and confirmed the existing 5-minute trigger, with no browser or credential input. This proves that observed renewal flow, not indefinite remembered-account validity.

## Signed protocol

POST UTF-8 JSON `{action, nonce, issued_at, payload, signature}` to `/exec`. `nonce` is 16 random bytes rendered as 32 lowercase hexadecimal characters. `issued_at` is integer UNIX seconds. Requests more than 300 seconds old or 60 seconds in the future are rejected. The lowercase hexadecimal signature is HMAC-SHA256 with `BRIDGE_SECRET` over exactly the UTF-8 bytes of `JSON.stringify([action, nonce, issued_at, payload])`.

Nonces are consumed before the action and persist for 10 minutes; retries need new nonces and signatures. Script locks serialize requests and production runs. Follow ContentService response redirects and parse JSON: Apps Script cannot reliably set application HTTP error statuses. Require `ok: true`; HTTP 200 alone is insufficient.

| Action | Payload | Result |
| --- | --- | --- |
| `get_session` | `{}` | `{ok:true,session:storageStateOrNull,last_successful_check:ISOOrNull}` |
| `save_session` | `{source_url,session,verified_at}` | `{ok:true,connected:true}` |
| `install_monitor` | `{}` | Fresh cloud source check, healthy delivery and exactly one fixed 5-minute trigger; returns sanitized activation metadata |
| `ingest_snapshot` | `{source_url,posts,complete:true,observed_at,session?}` | `{ok:true,needs_attention,pending_count,last_successful_check,delivery_count,meeting_count}` |
| `status` | `{}` | Counts, timestamps, session presence/expiry, trigger presence and attention; no cookies or announcement content |
| `connection_diagnostics` | `{}` | Owner-verified, signed read of the last bounded connection trace: timestamp, fixed stage enums, HTTP status and cookie-presence boolean only |
| `probe_cloud_source` | `{}` | Owner-verified complete Google source read, without delivery or mode change; returns sanitized reachability and actual proof timestamp |
| `restore_cloud_monitor` | `{}` | Restores Google reading on an existing recorded five-minute monitor; reports `source_verified` and `awaiting_cloud_read` separately from the schedule |

`install_monitor` is administrative access available only after HMAC validation, replay protection, account/private-file checks and verification of the deployment's effective Google identity. An effective owner identity is not caller authentication; the HMAC gate remains mandatory. Manual setup functions retain their active-owner guard. Status separates `cloud_source_verified_at` from a browser session timestamp or manually ingested snapshot, and `monitor_interval_minutes` is populated only for a recorded matching trigger.

Connection diagnostics use the same HMAC, replay protection and execution-owner checks, accept no source URL or other arguments, and perform no source or provider operation. They return at most 32 sanitized stages with no cookie names/values, URLs, query parameters, account names or response bodies. Failure to save this optional diagnostic trace never interrupts a source read.

For an explicit owner request to return an existing installation to the cloud, `restore_cloud_monitor` preserves that recorded five-minute trigger, switches source mode to `google_https`, and retains outage and provider history. It may return `source_verified:false, awaiting_cloud_read:true`; this is a recovery schedule, not successful source activation. A new installation still requires the complete source and delivery checks in `install_monitor`. The stricter `configure_source` transition to `google_https` requires a recent complete cloud proof and a connected saved session. `probe_cloud_source` tests the fixed source without sending mail or Calendar updates and without switching source mode; errors return only fixed sanitized reasons. It retains refreshed supported cookies only after the complete source succeeds.

In Google mode, source failures set a bounded retry delay of 5, 10, 30 and then 60 minutes. The five-minute trigger remains installed, but skips attempts before the next allowed retry. Successful ingestion clears the delay and resumes the normal cadence. Manual probes and installation verify access immediately. The original deduplicated failure episode remains; retries do not resend the same attention notice or erase the last successful timestamp. Neither a saved session nor a restored trigger repairs an unreachable source hostname. The selected owner setup is cloud-only; do not reactivate a Mac reader to resolve a cloud outage without a new request.

`source_url` must equal the IITB placement blog URL. Sessions use Playwright `storageState`: `cookies` and empty `origins`. Only Secure cookies for exact campus/SSO hosts (optional leading dot) and shared **`.iitb.ac.in`** are accepted. Bare `iitb.ac.in`, other domains and localStorage are rejected. Non-expired cookies do not prove IITB still accepts them.

Snapshots require complete pagination, at least one and at most 500 posts, and total request size ≤1.5 MB. Each post has `id: "post-N"`, matching exact blog `?p=N` URL, title, publication ISO datetime, original normalized text and `{text,url}` links. Bounds: title 1,000 characters, text 64,000, 100 links/post, link text 1,000, link URL 4,096. `observed_at`/`verified_at` must be within 10 minutes. Publication dates remain separate from meeting dates.

## Delivery and recovery

Announcement mail goes to the owner and their explicitly configured subscribers, once per revision. The configuration keeps the owner as sender and Calendar owner; `announcement_recipients` must contain that owner plus at most nine validated additional addresses. Single-announcement subjects use the announcement title, such as **Sony Japan | JAF Open**. Digests include announcement titles and a remaining-update count when needed. Non-ASCII subjects use UTF-8 MIME encoding; announcement text retains line breaks and full content.

Gmail can replace a supplied Message-ID, so a new send immediately saves its returned immutable provider ID before readback. Verification requires SENT, the exact expected recipient set and owner From, no Cc/Bcc, the expected subject, one UTF-8 HTML body, its expected content hash, and the deterministic delivery reference in the custom header and body. Each attempt freezes its recipient list, so later preference changes cannot misidentify a prior send. An uncertain send is recovered by the exact reference, recipient and sender in Sent, with one verified match. Legacy owner-only/exact-Message-ID recovery remains supported. Unverifiable messages require owner review rather than a blind resend. Source failure notices stay owner-only.

Clearly timed future deadlines (JAF, submission, registration, application and other labelled deadlines) are saved as private, transparent 15-minute deadline markers at the published time in Asia/Kolkata, with an email reminder 60 minutes before and popup 5 minutes before. They include the announcement title, original source and relevant links. Date-only deadlines and unclear timezones are reported in the email without inventing a time. Deadline IDs stay stable when the due time changes and remain separate from meeting occurrences. Existing delivered announcements acquire future deadline entries once without being mailed again. Meeting entries retain original joining links and published times; subscriber addresses are never added as Calendar guests.

Signed `configure_notifications` accepts only `{announcement_recipients:[...]}` and verifies the execution owner after HMAC/replay/private-account checks, preserving all other configuration and state. Signed `resend_announcement` accepts only `{post_id,request_id}` for a known stored announcement and the current recipient list. Each deliberate resend freezes recipients and uses a stable caller-supplied request ID, a separate verified delivery reference and immediate provider-ID persistence. Repeating that request retrieves its receipt instead of sending again, and uncertain sends recover from Sent without overwriting ordinary revision history.

Calendar uses deterministic IDs, migrated IDs, source references and provider readback. Clear future meeting dates/times use Asia/Kolkata. Ambiguous timing or conditional/negated change wording produces a mail warning without changing an event. Missing end means a provisional one-hour slot. Events are private, with no guests or generated Meet conference, original joining link, and email/popup reminders 60/5 minutes before. Conflicts retain the announced time and are noted. Reschedules update one safely matched saved occurrence; unmatched or multiple matches require review. Every existing-event update checks owner organization, no external attendees and source identity. A confirmed, matched cancellation labels the saved event cancelled and transparent, then verifies the result before saving its acknowledgement.

Calendar updates apply in publication order so a backfilled original cannot erase a newer reminder's details. A newly discovered older original matched to a saved meeting with newer source details is retained as a source reference without patching the event; substantive later edits remain actionable. Calendar failures stay pending. Deterministic IDs recover uncertain inserts. If scheduling later succeeds after a failure digest, one followup confirms it. Source failures save a sanitized error and notify once until checks recover. Account/private-storage failures do not send mail or change calendars.

## Verification

Run `node apps-script/apps-script.test.mjs` from the repository root. Google services are mocked. Tests cover canonical HMAC/replay, cookie restrictions, private migration/partial setup, quiet baseline, deterministic events, owner/source guards and cancellation readback, conservative change wording, separate-post reschedules, uncertain send/insert/state-write recovery including later date changes, superseding obsolete calendar retries while retaining sent history and uncertain-email recovery, followups and duplicates. They do not deploy, access credentials, send mail or change calendars. `Source.gs` has separate direct-source fixture tests.

Google references: [advanced Gmail](https://developers.google.com/apps-script/advanced/gmail), [Gmail MIME sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [time triggers](https://developers.google.com/apps-script/guides/triggers/installable), [properties](https://developers.google.com/apps-script/guides/properties).

## Optional local network source

When the source is not reachable from Google, the owner may select the local
HTTPS reader described in `checker/LOCAL.md`. Signed `ingest_local_snapshot`
validates a complete fixed-source snapshot and restricted session under the same
owner and lock checks as ordinary delivery. Its successful observation remains
separate from cloud source proof. Signed `configure_source` accepts only
`{mode:"local_https"}` after a recent successful local ingestion and a recorded
monitor. Signed `source_status` returns the mode, local observation time and
freshness without credentials or announcement contents. In local mode the
existing five-minute trigger checks feed health; it does not fetch IITB or send
another announcement stream. A local report older than fifteen minutes marks
the source unhealthy and uses the existing one-notice failure episode. The local
worker continues to use the same email and Calendar deduplication and owner.

Successful local ingestion also returns the recorded source mode, exact local observation timestamp and freshness, allowing the reader to avoid another mode mutation. Lost responses must be reconciled by that exact observation and delivery status before claiming completion.
