import {connect,revokePermissions,ConnectorError,BLOG} from './core.mjs';
import {createGoogleTransport} from './transport.mjs';
const form=document.getElementById('settings'),button=document.getElementById('connect'),output=document.getElementById('result');
const bridge=document.getElementById('bridge'),secret=document.getElementById('secret');
const messages={
  CONFIGURATION_REQUIRED:'Enter your private Google monitor URL and connection key.',
  INVALID_CONFIGURATION:'The monitor URL or connection key is not valid. Use the private setup values provided for your monitor.',
  PERMISSION_DENIED:'Chrome access was declined. No session was sent.',
  INCOGNITO_UNSUPPORTED:'Use the regular Chrome profile where your IITB login is remembered.',
  BLOG_NOT_ACCESSIBLE:'Chrome could not verify the placement announcements. Open the official blog in this profile, select your remembered account if shown, then try again. No session was sent.',
  BRIDGE_UNAVAILABLE:'Your Google monitor did not respond correctly. Check that Google setup and consent are complete, then try again.',
  BRIDGE_REJECTED:'Your Google monitor rejected this request. Check the private connection key and Google setup.',
  PARTITIONED_SESSION_UNSUPPORTED:'This Chrome session uses a cookie format this monitor cannot safely copy. It was not saved.',
  INVALID_SESSION:'The remembered session cannot be safely copied in the supported format. It was not saved.',
  SESSION_REQUIRED:'Chrome returned no supported secure IITB session. It was not saved.',
  SESSION_CHANGED:'The remembered session changed during this attempt. Wait for the blog to finish loading, then retry.',
  SESSION_TOO_LARGE:'The remembered session exceeds the monitor’s limits. It was not saved.',
  REQUEST_TOO_LARGE:'The session exceeds the monitor’s request limits. It was not saved.',
  REMOVE_EXTENSION_REQUIRED:'Chrome could not confirm removal of this connector’s permissions. Remove this extension from Chrome before continuing.',
  CONNECTION_FAILED:'The connection could not finish. No successful connection has been confirmed.'
};
let busy=false;
const googleTransport=createGoogleTransport(document.getElementById('bridgeTransport'));
window.addEventListener('pagehide',()=>{secret.value='';void revokePermissions();});
form.addEventListener('submit',async event=>{
  event.preventDefault();
  if (busy || !form.reportValidity() || !document.getElementById('consent').checked) return;
  busy=true;button.disabled=true;output.textContent='Checking your private monitor and remembered IITB access…';
  const config={bridge_url:bridge.value.trim(),hmac_secret:secret.value};
  secret.value='';
  try {
    const result=await connect(config,{fetchImpl:(url,options)=>url===BLOG?fetch(url,options):googleTransport.fetch(url,options)});
    output.textContent=result.saved ? 'Session saved. The Google monitor still needs to verify that IITB accepts this session from the cloud. This connector’s Chrome permissions have been removed. You can remove the extension now.' : messages.CONNECTION_FAILED;
  } catch(error) { output.textContent=messages[error instanceof ConnectorError ? error.code : 'CONNECTION_FAILED'] || messages.CONNECTION_FAILED; }
  finally { config.hmac_secret='';busy=false;button.disabled=false; }
});
async function initialize() {
  if (!await revokePermissions()) { output.textContent=messages.REMOVE_EXTENSION_REQUIRED;return; }
  try { await googleTransport.ready; } catch { output.textContent=messages.BRIDGE_UNAVAILABLE;return; }
  // A private user-owned package may include this ignored file. The generic source includes no real key.
  let configuration=null;
  try {
    const response=await fetch(new URL('config.private.json',import.meta.url),{credentials:'omit',cache:'no-store'});
    if (response.ok) {
      configuration=await response.json();
      if (typeof configuration?.bridge_url==='string') bridge.value=configuration.bridge_url;
      if (typeof configuration?.hmac_secret==='string') secret.value=configuration.hmac_secret;
    }
  } catch { /* Manual configuration remains available. Never show provider exceptions. */ }
  finally { if (configuration && typeof configuration==='object') configuration.hmac_secret='';configuration=null; }
  output.textContent='Ready. Open the official blog first, then click Connect when you want to save this session.';
  button.disabled=false;
}
void initialize();
