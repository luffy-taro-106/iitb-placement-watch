#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${CODESPACES:-}" != "true" || -z "${CODESPACE_NAME:-}" ]]; then
  printf '%s\n' 'This setup desktop runs only in your own GitHub Codespace.'
  exit 1
fi
if ! gh codespace ports visibility 3000:private 6080:private --codespace "$CODESPACE_NAME" >/dev/null 2>&1; then
  printf '%s\n' 'Could not ensure private forwarded ports. No desktop was started.'
  exit 1
fi
# A separate random desktop password protects VNC in addition to GitHub's private forwarding.
# It is never printed automatically, passed as a process argument, or stored in the repository.
runtime_dir=/tmp/iitb-placement-login
if [[ -L "$runtime_dir" ]]; then
  printf '%s\n' 'Desktop setup could not create private temporary storage.'
  exit 1
fi
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
if [[ -L "$runtime_dir/desktop-password" ]]; then
  printf '%s\n' 'Desktop setup could not create private temporary storage.'
  exit 1
fi
if [[ ! -s "$runtime_dir/desktop-password" ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("base64")+"\n")' >"$runtime_dir/desktop-password"
fi
chmod 600 "$runtime_dir/desktop-password"
# These listeners stay on loopback. Codespaces forwarded ports must remain Private.
if ! pgrep -x Xvfb >/dev/null; then
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
fi
export DISPLAY=:99
for attempt in {1..20}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  printf '%s\n' 'The private desktop display could not start.'
  exit 1
fi
if ! pgrep -f 'xfce4-session' >/dev/null; then
  dbus-run-session -- xfce4-session >/dev/null 2>&1 &
fi
if ! pgrep -x x11vnc >/dev/null; then
  x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -passwdfile "$runtime_dir/desktop-password" -noxdamage >/dev/null 2>&1 &
fi
if ! pgrep -f 'websockify.*6080' >/dev/null; then
  websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
fi
printf '%s\n' 'Private login desktop is ready. Keep ports 3000 and 6080 Private. Start npm run login only after bridge secrets are configured.'
