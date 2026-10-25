# One-time remembered Chrome connection

This optional connector reuses the IITB session in the Chrome profile where you manually install it. It never starts Chrome, reads a profile on disk, collects passwords or OTPs, changes cookies, or runs a background monitor. Ongoing monitoring belongs to Google Apps Script and must work with Chrome closed.

## Use it yourself

1. In your existing regular Chrome profile, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select this `chrome-connector` directory. Do not enable incognito access.
2. Open the official [placement blog](https://campus.placements.iitb.ac.in/blog/placement/) in the same profile. If it shows your remembered account, select it on IITB’s page. Wait until real announcements appear.
3. Open this extension from Chrome’s extension menu, then choose **Open connection page**. A full page keeps the attempt open while it finishes.
4. A preconfigured private package already contains your monitor’s setup values and hides these settings. A generic package shows fields for the private Google monitor URL and connection key. These are Google setup values; never enter an IITB password or phone OTP here.
5. Read the consent text and click **Connect and save once**. Chrome asks for temporary access to only the two official IITB hosts and the two Google Apps Script hosts. The connector checks a signed monitor status and verifies a fresh credentialed blog response contains announcement articles before reading any cookies.
6. Keep the connection page open. After saving the scoped session, Connect asks Google to perform its own complete blog read and activate the single 5-minute monitor. It reports success only after Google confirms the schedule and a fresh cloud source verification. Automatic emails and calendar updates then run on Google with Chrome closed.
7. The activation attempt has a 90-second window, including one installation request and any signed status recovery. If completion is still uncertain, use **Check activation** on this page after a short wait. That button requests only Google access and checks status; it never reads or transfers IITB cookies. A private package reloads its connection key when you click; manual setup may require entering that private key again. Do not repeat Connect while the previous activation is unresolved. A confirmed cloud-access failure permits a deliberate retry after reconnecting on IITB’s official page.
8. Remove this extension after confirmed activation. Its permissions are revoked after every attempt, including failures. If Chrome cannot confirm revocation, the page tells you to remove the extension. Closing the connection page mid-request can interrupt cleanup; remove the extension if you do so.

The server may reject a copied session or require reconnecting later. A successful Chrome request can use non-cookie authentication, such as an HTTP authentication cache, which this connector does not export. Remembered-account cookies alone may not be an active placement-blog session. Device-bound keys and partitioned cookies cannot be safely represented by the monitor’s cookie-only session format. This tool cannot promise permanent OTP-free access.

## Private setup and data

The generic extension contains no account identity, bridge URL for a real deployment, or secret. A private owner-only package can include ignored `config.private.json` using the field names in `config.example.json`. Keep that file outside public commits and shared archives, with owner-only file permissions. The connection key authorizes the private bridge and must be treated as a credential.

Only Secure, unexpired cookies matching the exact blog URL or the fixed SSO `/authorize` URL are considered. The code accepts only exact placement/SSO hosts and a domain cookie named `.iitb.ac.in`; the latter may also grant IITB SSO access beyond placements. Chrome can exclude shared parent-domain cookies under the connector’s exact-host permissions, so they are not assumed available. It never requests a wildcard or parent IITB host permission. The Chrome cookie API permission permits read/write; this source calls only `getAll` and never `set`, `remove`, listeners, or cookie-store enumeration. The credentialed blog GET refuses redirects.

The saved session has `origins: []`: no local storage, remembered passwords, OTPs, or browser auth cache. At most 64 cookies are sent, with 4 KiB values, fixed domains, validated paths and expiry, and the monitor’s existing cookie schema. No cookie or key is displayed or logged. Runtime data remains in the extension page’s memory and is discarded after the attempt; no Chrome storage permission or persistence API is used.

The signed bridge POST follows the existing HMAC-SHA256 envelope, replay nonce, and timestamp protocol. Supported actions are `status`, `save_session`, and `install_monitor`. The key is not sent. Google requests run in a local, non-web-accessible extension frame with an additional Google-only `connect-src` CSP, `credentials: 'omit'`, and an exact validated deployment URL. A redirected POST cannot send the session body to an IITB or other origin. Google’s ContentService redirect is accepted only at the expected Google response endpoint. Replies are limited to 16 KiB and validated against the expected small metadata schema; session data, private identities, arbitrary error strings, and unknown fields are rejected. The main extension page can perform the separate fixed-blog GET. The loaded remote HTML is parsed in an inert document and never attached to the extension page or executed.

## Verification without browser access

Run `node --test chrome-connector/test/*.test.mjs` from the repository root after installing the existing development dependencies. The tests use synthetic HTML, synthetic cookies, mocked Chrome APIs, and mocked network responses. They never start a browser or contact IITB or Google. Live acceptance and activation must be tested by the user’s explicit Connect action; it includes the Google source check.

Chrome documentation: [manual unpacked installation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [cookies API](https://developer.chrome.com/docs/extensions/reference/api/cookies), [optional permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), and [extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

For an explicitly chosen local network reader, the private owner-only package may
set `source_mode:"local_https"`. Connect then saves the approved session once and
reports that local verification is pending. It does not claim that Google can
reach an institute-only source. The separately installed Mac job verifies that
session on its next five-minute run; Chrome can be closed after verification.
