# One-time official IITB login

This helper is for a one-time setup and development check. The Codespace does not run the ongoing monitor. Google Apps Script handles scheduled checks after setup.

Create a Codespace only after confirming that its free allowance remains and paid usage is blocked. Keep ports **3000** and **6080** set to **Private**. The helper checks this before opening IITB and again before saving the session.

1. Configure the Codespace secrets `IITB_BRIDGE_URL` and `IITB_HMAC_SECRET` from your private Google Apps Script deployment. Do not enter IITB credentials in these settings.
2. Start `npm run login` in the private Codespace terminal.
3. Open the forwarded **6080** port. Add `/vnc.html` to its URL and choose **Connect**. When prompted for the desktop password, view it in your own private Codespace terminal with `cat /tmp/iitb-placement-login/desktop-password`. This is a random desktop password, separate from your IITB password. Do not paste it into chat or repository files.
4. In the remote Chromium window, sign in on the official IITB website, complete CAPTCHA and your phone OTP, and select **Remember me**. Wait until placement posts appear.
5. Open the private **3000** port and select **Save login**. The helper verifies the placement page, sends only restricted IITB cookies to the authenticated private Google bridge, and closes Chromium. Passwords, OTPs and browser local storage are never exported.
6. Stop the Codespace immediately after the success message. The saved session can expire or be revoked by IITB; if a reconnect is needed, repeat this official login.

The private desktop password stays in a mode-600 file in `/tmp`, outside the repository. VNC and the save control listen on loopback, and their forwarded ports require your GitHub account. Source extraction accepts only the official placement and SSO hosts. No local browser cookies are accessed.

The helper rechecks private port visibility every minute and closes the browser/control after 30 minutes. This does not stop the Codespace itself; stop it after saving to protect your free allowance.

`npm run check:source` is an optional one-off administrator/source test. It is not a production scheduler. It retrieves the saved session in memory, reads bounded recent placement pages, and sends a complete snapshot with refreshed restricted cookies to the same authenticated bridge.
