import {connect,checkActivation,revokePermissions,validateConfig,ConnectorError,BLOG} from './core.mjs';
import {createGoogleTransport} from './transport.mjs';
const form=document.getElementById('settings'),button=document.getElementById('connect'),output=document.getElementById('result');
const bridge=document.getElementById('bridge'),secret=document.getElementById('secret');
const checkButton=document.getElementById('checkActivation');
const privateSetup=document.getElementById('privateSetup');
const messages={
  CONFIGURATION_REQUIRED:'Enter your private Google monitor URL and connection key.',
  INVALID_CONFIGURATION:'The monitor URL or connection key is not valid. Use the private setup values provided for your monitor.',
  PERMISSION_DENIED:'Chrome access was declined. No session was sent.',
  INCOGNITO_UNSUPPORTED:'Use the regular Chrome profile where your IITB login is remembered.',
  BLOG_NOT_ACCESSIBLE:'Chrome could not verify the placement announcements. Open the official blog in this profile, select your remembered account if shown, then try again. No session was sent.',
  BRIDGE_UNAVAILABLE:'Your Google monitor did not respond correctly. Check that Google setup and consent are complete, then try again.',
  BRIDGE_REJECTED:'Your Google monitor rejected this request. Check the private connection key and Google setup.',
  BRIDGE_INVALID_RESPONSE:'The monitor returned unexpected information. Automatic reminders have not been confirmed.',
  BRIDGE_ACCOUNT_MISMATCH:'Your Google monitor is not connected to the expected account. Automatic reminders have not been activated.',
  CLOUD_SOURCE_UNAVAILABLE:'Google could not read the placement blog with this saved session. Automatic reminders have not been activated. Chrome’s remembered login may not be usable from Google.',
  DELIVERY_REVIEW_REQUIRED:'An earlier email or calendar action needs review before automatic monitoring can start.',
  MONITOR_CONFIGURATION_REQUIRED:'Google could not confirm a single half-hour schedule. Automatic monitoring has not been confirmed.',
  ACTIVATION_UNCONFIRMED:'Activation may still be running on Google. Keep this page open and use Check activation after a short wait. It checks progress without sending your login again. Automatic reminders are not yet confirmed.',
  SESSION_SAVE_UNCONFIRMED:'The session save could not be confirmed, so this connector has not requested activation or sent the session again. Once the Google connection is available, you can retry Connect.',
  PARTITIONED_SESSION_UNSUPPORTED:'This Chrome session uses a cookie format this monitor cannot safely copy. It was not saved.',
  INVALID_SESSION:'The remembered session cannot be safely copied in the supported format. It was not saved.',
  SESSION_REQUIRED:'Chrome returned no supported secure IITB session. It was not saved.',
  SESSION_CHANGED:'The remembered session changed during this attempt. Wait for the blog to finish loading, then retry.',
  SESSION_TOO_LARGE:'The remembered session exceeds the monitor’s limits. It was not saved.',
  REQUEST_TOO_LARGE:'The session exceeds the monitor’s request limits. It was not saved.',
  REMOVE_EXTENSION_REQUIRED:'Chrome could not confirm removal of this connector’s permissions. Remove this extension from Chrome before continuing.',
  CONNECTION_FAILED:'The connection could not finish. No successful connection has been confirmed.'
};
let busy=false,pendingActivation=null,completed=false;
const googleTransport=createGoogleTransport(document.getElementById('bridgeTransport'));
window.addEventListener('pagehide',()=>{secret.value='';void revokePermissions();});
function reportSuccess(result) {
  if (result.activated===true && result.cloud_verified===true && result.interval_minutes===30 && typeof result.cloud_source_verified_at==='string') {
    output.textContent='Automatic placement checks every 30 minutes, email reminders, and calendar meeting updates are activated. Google verified access to the blog. Chrome can be closed and this extension can be removed.';
    pendingActivation=null;completed=true;checkButton.hidden=true;return;
  }
  output.textContent=messages.ACTIVATION_UNCONFIRMED;
}
function reportFailure(error,target) {
  const code=error instanceof ConnectorError?error.code:'CONNECTION_FAILED';
  output.textContent=messages[code] || messages.CONNECTION_FAILED;
  if (error instanceof ConnectorError && error.activationNotBefore) {
    pendingActivation={bridge_url:target,notBefore:error.activationNotBefore};checkButton.hidden=false;
  } else if (pendingActivation && ['CLOUD_SOURCE_UNAVAILABLE','DELIVERY_REVIEW_REQUIRED','MONITOR_CONFIGURATION_REQUIRED'].includes(code)) {
    pendingActivation=null;checkButton.hidden=true;
  }
  if (['CONFIGURATION_REQUIRED','INVALID_CONFIGURATION','BRIDGE_REJECTED'].includes(code)) privateSetup.hidden=false;
}
async function prepareRetry() {
  if (completed || pendingActivation) return;
  const configuration=await loadPrivateConfig();
  try {
    if (configuration?.bridge_url===bridge.value.trim()) secret.value=configuration.hmac_secret;
    else if (!secret.value) privateSetup.hidden=false;
  } finally {if(configuration)configuration.hmac_secret='';}
}
form.addEventListener('submit',async event=>{
  event.preventDefault();
  if (busy || !form.reportValidity() || !document.getElementById('consent').checked) return;
  busy=true;button.disabled=true;checkButton.disabled=true;output.textContent='Checking your private monitor and remembered IITB access…';
  const config={bridge_url:bridge.value.trim(),hmac_secret:secret.value};
  const target=config.bridge_url;
  secret.value='';
  try {
    const result=await connect(config,{fetchImpl:(url,options)=>url===BLOG?fetch(url,options):googleTransport.fetch(url,options),
      onStage:()=>{output.textContent='Session saved. Google is verifying cloud access and activating the 30-minute checks. Keep this page open…';}});
    reportSuccess(result);
  } catch(error) {reportFailure(error,target);}
  finally {config.hmac_secret='';await prepareRetry();busy=false;button.disabled=completed||!!pendingActivation;checkButton.disabled=false;}
});
checkButton.addEventListener('click',async()=>{
  if (busy || !pendingActivation) return;
  busy=true;button.disabled=true;checkButton.disabled=true;output.textContent='Checking Google’s activation status without sending your IITB login again…';
  const expected={...pendingActivation};
  try {
    // checkActivation requests Google permissions before awaiting this loader, preserving the user's click gesture.
    const result=await checkActivation(async()=>{
      let key=secret.value;secret.value='';
      if (!key) {
        const privateConfig=await loadPrivateConfig();
        if (privateConfig?.bridge_url===expected.bridge_url) key=privateConfig.hmac_secret;
        if (privateConfig) privateConfig.hmac_secret='';
      }
      return {bridge_url:expected.bridge_url,hmac_secret:key};
    },{notBefore:expected.notBefore,fetchImpl:(url,options)=>googleTransport.fetch(url,options)});
    reportSuccess(result);
  } catch(error) {reportFailure(error,expected.bridge_url);}
  finally {secret.value='';await prepareRetry();busy=false;button.disabled=completed||!!pendingActivation;checkButton.disabled=false;}
});
async function loadPrivateConfig() {
  let configuration=null;
  try {
    const response=await fetch(new URL('config.private.json',import.meta.url),{credentials:'omit',cache:'no-store'});
    if (!response.ok) return null;
    configuration=await response.json();
    return validateConfig(configuration);
  } catch { /* Manual configuration remains available; no provider exceptions are displayed. */ }
  finally {if(configuration && typeof configuration==='object')configuration.hmac_secret='';configuration=null;}
  return null;
}
async function initialize() {
  if (!await revokePermissions()) { output.textContent=messages.REMOVE_EXTENSION_REQUIRED;return; }
  try { await googleTransport.ready; } catch { output.textContent=messages.BRIDGE_UNAVAILABLE;return; }
  // A private user-owned package may include this ignored file. The generic source includes no real key.
  let configuration=null;
  try {
    configuration=await loadPrivateConfig();
    if (configuration) {bridge.value=configuration.bridge_url;secret.value=configuration.hmac_secret;privateSetup.hidden=true;}
    else privateSetup.hidden=false;
  } catch { /* Manual configuration remains available. Never show provider exceptions. */ }
  finally { if (configuration && typeof configuration==='object') configuration.hmac_secret='';configuration=null; }
  output.textContent='Ready. Open the official blog first, then click Connect to save this session and activate automatic reminders.';
  button.disabled=false;
}
void initialize();
