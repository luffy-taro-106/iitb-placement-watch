# One-time setup on your computer

This free option needs no GitHub Actions or Codespace. Your computer is used once to sign in; Google Apps Script does the ongoing checks, email announcements and calendar reminders.

On a Mac, double-click `login/start-local-login.command`. It prepares the bundled Chromium browser and opens the setup page at `http://127.0.0.1:3000/`. If your Mac asks how to open the file, open it with Terminal.

1. Enter your own Google Apps Script deployment URL and bridge secret on the local setup page. These are kept only in memory, never in a file or log. The page has no IITB username, password or OTP fields.
2. Choose **Open official IITB login**. A new temporary Chromium window opens. It has its own fresh session and does not use your existing Chrome, Safari or Codex browser profile.
3. Sign in on IITB's official website, complete CAPTCHA and your phone OTP, and select **Remember me**. Wait until placement posts appear.
4. Return to the local setup page and choose **Save login**. It verifies the placement page and sends only restricted Secure IITB cookies to your authenticated private Google bridge. Passwords, OTPs and browser local storage are never exported.
5. After the success message, close the setup page. The temporary browser closes immediately and the helper exits after ten seconds. Your computer can be switched off once the Google monitor is installed.

If using a terminal instead of the Mac launcher, run these once from the project folder:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run browser:install
npm run login:once
```

Open the local URL printed by the program. Node.js 22 or newer is required. The helper binds only to `127.0.0.1`, checks the localhost Origin and a random form token, and automatically closes after 30 minutes. No local browser is started by installing the project or running its fixture tests.

Advanced users may provide `IITB_BRIDGE_URL` and `IITB_HMAC_SECRET` as private environment variables instead of entering them on the local page. Never put real values in repository files, shell command arguments or chat. IITB can expire or revoke the saved session; a requested reconnect repeats this one-time official login.
