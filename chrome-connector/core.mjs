export const BLOG = 'https://campus.placements.iitb.ac.in/blog/placement/';
export const SSO_COOKIE_URL = 'https://sso.iitb.ac.in/authorize';
export const PERMISSIONS = Object.freeze({
  permissions: Object.freeze(['cookies']),
  origins: Object.freeze([
    'https://campus.placements.iitb.ac.in/*', 'https://sso.iitb.ac.in/*',
    'https://script.google.com/*', 'https://script.googleusercontent.com/*'
  ])
});
export const GOOGLE_PERMISSIONS = Object.freeze({permissions:Object.freeze([]),origins:Object.freeze(PERMISSIONS.origins.slice(2))});
const OFFICIAL_HOSTS = new Set(['campus.placements.iitb.ac.in', 'sso.iitb.ac.in']);
const SAME_SITE = {no_restriction:'None', lax:'Lax', strict:'Strict', unspecified:'Lax'};
const encoder = new TextEncoder();

export class ConnectorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new ConnectorError(code); }
function permissionRequest(scope=PERMISSIONS) { return {permissions:[...scope.permissions], origins:[...scope.origins]}; }
export function validateConfig(config) {
  let url;
  try { url = new URL(config?.bridge_url); } catch { fail('CONFIGURATION_REQUIRED'); }
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[a-z\d_-]+\/exec$/i.test(url.pathname) ||
      url.username || url.password || url.search || url.hash || typeof config?.hmac_secret !== 'string' ||
      config.hmac_secret.length < 32 || config.hmac_secret.length > 256) fail('INVALID_CONFIGURATION');
  if(config.source_mode!==undefined && config.source_mode!=='local_https')fail('INVALID_CONFIGURATION');
  return {bridge_url:url.href, hmac_secret:config.hmac_secret,...(config.source_mode?{source_mode:config.source_mode}:{})};
}
export function canonical(action, nonce, issued_at, payload) {
  if (!['status','save_session','install_monitor'].includes(action) || !/^[a-f\d]{32}$/.test(nonce) || !Number.isSafeInteger(issued_at) ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST');
  return JSON.stringify([action, nonce, issued_at, payload]);
}
export async function signedRequest(action, payload, secret, {cryptoImpl=globalThis.crypto, now=Date.now}={}) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) fail('INVALID_CONFIGURATION');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  const nonce = [...bytes].map(byte => byte.toString(16).padStart(2,'0')).join('');
  const issued_at = Math.floor(now()/1000);
  const key = await cryptoImpl.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const digest = await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(canonical(action,nonce,issued_at,payload)));
  const signature = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
  return {action,nonce,issued_at,payload,signature};
}
export async function boundedText(response, limit, code) {
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>limit)) fail(code);
  if (!response.body?.getReader) fail(code);
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let length=0, text='';
  try {
    for (;;) {
      const chunk=await reader.read();
      if (chunk.done) break;
      length+=chunk.value.byteLength;
      if (length>limit) { await reader.cancel(); fail(code); }
      text+=decoder.decode(chunk.value,{stream:true});
    }
    return text+decoder.decode();
  } finally { reader.releaseLock(); }
}
export function finalBridgeUrl(value, configured) {
  let url;
  try { url=new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash || url.href.length>8192) return false;
  return url.href===configured || (url.origin==='https://script.googleusercontent.com' && url.pathname==='/macros/echo');
}
function objectWithKeys(value,allowed) {
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key));
}
export function validInstant(value,now=Date.now(),nullable=false) {
  if (value===null && nullable) return null;
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('BRIDGE_INVALID_RESPONSE');
  const time=Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,19)!==value.slice(0,19) || time>now+60000) fail('BRIDGE_INVALID_RESPONSE');
  return time;
}
export function validateBridgeResult(action,result,now=Date.now()) {
  if (!result || typeof result!=='object' || Array.isArray(result)) fail('BRIDGE_INVALID_RESPONSE');
  if (result.ok===false) {
    if (!objectWithKeys(result,['ok','error']) || typeof result.error!=='string') fail('BRIDGE_INVALID_RESPONSE');
    const codes={busy:'BRIDGE_BUSY',source_connection_required:'CLOUD_SOURCE_UNAVAILABLE',monitor_verification_required:'MONITOR_CONFIGURATION_REQUIRED',
      delivery_needs_review:'DELIVERY_REVIEW_REQUIRED',duplicate_monitor_triggers:'MONITOR_CONFIGURATION_REQUIRED',wrong_account:'BRIDGE_ACCOUNT_MISMATCH'};
    const generic=['invalid_request','invalid_payload','expired_request','replayed_request','authentication_failed','setup_required','invalid_source','invalid_session',
      'invalid_timestamp','stale_snapshot','invalid_snapshot','private_storage_required','uncertain_email_delivery','calendar_review_required','operation_failed'];
    if (Object.hasOwn(codes,result.error)) fail(codes[result.error]);
    if (generic.includes(result.error)) fail('BRIDGE_REJECTED');
    fail('BRIDGE_INVALID_RESPONSE');
  }
  if (result.ok!==true) fail('BRIDGE_INVALID_RESPONSE');
  if (action==='save_session') {
    if (!objectWithKeys(result,['ok','connected']) || result.connected!==true) fail('BRIDGE_INVALID_RESPONSE');
    return {ok:true,connected:true};
  }
  if (action==='install_monitor') {
    if (!objectWithKeys(result,['ok','installed','interval_minutes','cloud_source_verified_at','last_cloud_source_check']) ||
        result.installed!==true || ![5,30].includes(result.interval_minutes)) fail('BRIDGE_INVALID_RESPONSE');
    validInstant(result.cloud_source_verified_at,now);
    if (result.last_cloud_source_check!==undefined) validInstant(result.last_cloud_source_check,now);
    return {ok:true,installed:true,interval_minutes:result.interval_minutes || result.monitor_interval_minutes,cloud_source_verified_at:result.cloud_source_verified_at};
  }
  if (action!=='status') fail('BRIDGE_INVALID_RESPONSE');
  const allowed=['ok','connected','session_status','session_verified_at','last_successful_check','last_error','post_count','pending_count','meeting_count','delivery_count',
    'monitor_installed','needs_attention','cloud_source_verified_at','last_cloud_source_check','interval_minutes','monitor_interval_minutes'];
  if (!objectWithKeys(result,allowed) || typeof result.monitor_installed!=='boolean' ||
      typeof result.connected!=='boolean' || typeof result.needs_attention!=='boolean' || !Object.hasOwn(result,'last_error') ||
      !Object.hasOwn(result,'cloud_source_verified_at') || !Object.hasOwn(result,'monitor_interval_minutes') ||
      (result.monitor_installed?![5,30].includes(result.monitor_interval_minutes):result.monitor_interval_minutes!==null)) fail('BRIDGE_INVALID_RESPONSE');
  if (result.interval_minutes!==undefined && result.interval_minutes!==result.monitor_interval_minutes) fail('BRIDGE_INVALID_RESPONSE');
  for (const field of ['connected','needs_attention']) if (result[field]!==undefined && typeof result[field]!=='boolean') fail('BRIDGE_INVALID_RESPONSE');
  if (result.session_status!==undefined && !['missing','saved_not_live_verified','expired','live_verified','cloud_verified'].includes(result.session_status)) fail('BRIDGE_INVALID_RESPONSE');
  for (const field of ['post_count','pending_count','meeting_count','delivery_count']) if (result[field]!==undefined && (!Number.isSafeInteger(result[field]) || result[field]<0 || result[field]>1000000000)) fail('BRIDGE_INVALID_RESPONSE');
  const safeErrors=['source_check_failed','delivery_needs_review','calendar_needs_review','operation_failed'];
  if (result.last_error!==null && !safeErrors.includes(result.last_error)) fail('BRIDGE_INVALID_RESPONSE');
  for (const field of ['cloud_source_verified_at','last_cloud_source_check','session_verified_at','last_successful_check']) {
    if (result[field]!==undefined) validInstant(result[field],now,true);
  }
  return {ok:true,monitor_installed:result.monitor_installed,monitor_interval_minutes:result.monitor_interval_minutes,
    connected:result.connected,healthy:result.connected && !result.needs_attention && result.last_error===null,
    needs_attention:result.needs_attention,last_error:result.last_error,session_verified_at:result.session_verified_at || null,
    cloud_source_verified_at:result.cloud_source_verified_at};
}
export async function bridgeCall(config, action, payload, deps={}) {
  const fetchImpl=deps.fetchImpl || globalThis.fetch;
  let envelope=null, body=null;
  try {
    envelope=await signedRequest(action,payload,config.hmac_secret,deps);
    body=JSON.stringify(envelope);
    if (encoder.encode(body).byteLength>1500000) fail('REQUEST_TOO_LARGE');
    // In the UI, this fetch runs in an extension-owned frame with a Google-only connect-src CSP.
    const response=await fetchImpl(config.bridge_url, {
      method:'POST',headers:{'content-type':'application/json'},body,
      credentials:'omit',redirect:'follow',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(deps.timeoutMs || 90000),timeoutMs:deps.timeoutMs || 90000
    });
    if (!response.ok || !finalBridgeUrl(response.url,config.bridge_url)) fail('BRIDGE_UNAVAILABLE');
    let result;
    try { result=JSON.parse(await boundedText(response,16384,'BRIDGE_INVALID_RESPONSE')); } catch { fail('BRIDGE_INVALID_RESPONSE'); }
    // Validate only this protocol's small metadata and never return arbitrary account/session fields.
    return validateBridgeResult(action,result,(deps.now || Date.now)());
  } catch(error) {
    if (error instanceof ConnectorError) throw error;
    fail('BRIDGE_UNAVAILABLE');
  } finally {
    if (envelope) envelope.payload=null;
    envelope=null; body=null;
  }
}
export async function verifyBlog({fetchImpl=globalThis.fetch, parseHtml=html=>new DOMParser().parseFromString(html,'text/html')}={}) {
  try {
    const response=await fetchImpl(BLOG, {
      method:'GET',headers:{accept:'text/html'},credentials:'include',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',signal:AbortSignal.timeout(45000)
    });
    if (response.status!==200 || response.url!==BLOG || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('BLOG_NOT_ACCESSIBLE');
    let html=await boundedText(response,2000000,'BLOG_NOT_ACCESSIBLE');
    const document=parseHtml(html); html=null;
    const articles=[...document.querySelectorAll('article[id^="post-"]')];
    if (!articles.some(article => /^post-[1-9]\d{0,14}$/.test(article.id) &&
        article.querySelector('h1,h2,h3')?.textContent?.trim() && article.textContent?.trim())) fail('BLOG_NOT_ACCESSIBLE');
    return {verified:true};
  } catch { fail('BLOG_NOT_ACCESSIBLE'); }
}
function pathMatches(path, target) {
  return target===path || (target.startsWith(path) && (path.endsWith('/') || target.charAt(path.length)==='/'));
}
export function toSession(groups, now=Date.now()) {
  if (!Array.isArray(groups) || groups.length!==2 || !Number.isFinite(now)) fail('INVALID_SESSION');
  const selected=new Map();
  for (const group of groups) {
    if (![BLOG,SSO_COOKIE_URL].includes(group?.url) || !Array.isArray(group.cookies) || group.cookies.length>128) fail('INVALID_SESSION');
    const target=new URL(group.url);
    for (const cookie of group.cookies) {
      if (!cookie || cookie.secure!==true) continue;
      if (cookie.partitionKey!==undefined) fail('PARTITIONED_SESSION_UNSUPPORTED');
      if (typeof cookie.domain!=='string' || typeof cookie.hostOnly!=='boolean') fail('INVALID_SESSION');
      const domain=cookie.domain.toLowerCase(), host=domain.replace(/^\./,'');
      if (!OFFICIAL_HOSTS.has(host) && domain!=='.iitb.ac.in') continue;
      if ((domain==='.iitb.ac.in' && cookie.hostOnly) || (cookie.hostOnly && domain.startsWith('.'))) fail('INVALID_SESSION');
      if ((host!==target.hostname && !(domain==='.iitb.ac.in' && !cookie.hostOnly)) ||
          typeof cookie.path!=='string' || !cookie.path.startsWith('/') || cookie.path.length>1024 ||
          /[\x00-\x20\x7f;]/.test(cookie.path) || !pathMatches(cookie.path,target.pathname)) fail('INVALID_SESSION');
      if (typeof cookie.name!=='string' || !/^[!#$%&'*+.^_`|~a-z\d-]{1,256}$/i.test(cookie.name) ||
          typeof cookie.value!=='string' || cookie.value.length>4096 || /[\x00-\x20\x7f;,]/.test(cookie.value) ||
          typeof cookie.httpOnly!=='boolean' || typeof cookie.session!=='boolean' || !Object.hasOwn(SAME_SITE,cookie.sameSite)) fail('INVALID_SESSION');
      const expires=cookie.expirationDate===undefined && cookie.session ? -1 : cookie.expirationDate;
      if (typeof expires!=='number' || !Number.isFinite(expires) || expires<0 && expires!==-1 || (!cookie.session && expires===-1)) fail('INVALID_SESSION');
      if (expires!==-1 && expires*1000<=now) continue;
      const normalized={name:cookie.name,value:cookie.value,domain:cookie.hostOnly?host:'.'+host,path:cookie.path,
        expires,httpOnly:cookie.httpOnly,secure:true,sameSite:SAME_SITE[cookie.sameSite]};
      const key=JSON.stringify([normalized.domain,normalized.path,normalized.name]);
      const prior=selected.get(key);
      if (prior && JSON.stringify(prior)!==JSON.stringify(normalized)) fail('SESSION_CHANGED');
      selected.set(key,normalized);
      if (selected.size>64) fail('SESSION_TOO_LARGE');
    }
  }
  if (!selected.size) fail('SESSION_REQUIRED');
  return {cookies:[...selected.values()],origins:[]};
}
export async function revokePermissions(chromeImpl=globalThis.chrome) {
  try {
    await chromeImpl.permissions.remove(permissionRequest());
    const current=await chromeImpl.permissions.getAll();
    return !current.permissions?.includes('cookies') && !current.origins?.length;
  } catch { return false; }
}
function activated(result,notBefore,now) {
  const installed=result.installed===true || result.monitor_installed===true;
  const interval=[5,30].includes(result.interval_minutes || result.monitor_interval_minutes);
  if (!installed || !interval || (result.monitor_installed!==undefined && result.healthy!==true) || !result.cloud_source_verified_at) return false;
  const proof=validInstant(result.cloud_source_verified_at,now);
  return proof>=notBefore-60000;
}
function activationResult(result) {
  return {activated:true,cloud_verified:true,interval_minutes:result.interval_minutes || result.monitor_interval_minutes,cloud_source_verified_at:result.cloud_source_verified_at};
}
function clock(deps) { return (deps.monotonicNow || (()=>performance.now()))(); }
async function pause(ms,deps) {
  if (deps.waitImpl) await deps.waitImpl(ms);
  else await new Promise(resolve=>setTimeout(resolve,ms));
}
async function pollActivation(config,notBefore,deadline,deps) {
  const now=deps.now || Date.now;
  for (let count=0;count<3;count++) {
    const remaining=Math.floor(deadline-clock(deps));
    if (remaining<=0) break;
    try {
      const status=await bridgeCall(config,'status',{}, {...deps,timeoutMs:Math.min(10000,remaining)});
      if (activated(status,notBefore,now())) return activationResult(status);
      if (!status.connected || status.last_error==='source_check_failed') fail('CLOUD_SOURCE_UNAVAILABLE');
      if (status.needs_attention || status.last_error) fail('DELIVERY_REVIEW_REQUIRED');
    } catch(error) {
      if (!(error instanceof ConnectorError) || !['BRIDGE_UNAVAILABLE','BRIDGE_BUSY'].includes(error.code)) throw error;
    }
    if (count<2) {
      const remaining=Math.floor(deadline-clock(deps));
      if (remaining<=0) break;
      await pause(Math.min(2000,remaining),deps);
    }
  }
  fail('ACTIVATION_UNCONFIRMED');
}
async function activate(config,notBefore,deps) {
  const deadline=clock(deps)+90000;
  try {
    const result=await bridgeCall(config,'install_monitor',{}, {...deps,timeoutMs:65000});
    if (!activated(result,notBefore,(deps.now || Date.now)())) fail('BRIDGE_INVALID_RESPONSE');
    return activationResult(result);
  } catch(error) {
    if (!(error instanceof ConnectorError) || !['BRIDGE_UNAVAILABLE','BRIDGE_BUSY','BRIDGE_INVALID_RESPONSE'].includes(error.code)) throw error;
    // An uncertain install may still be running on Google. Poll status, never repeat installation or resave the session.
    return pollActivation(config,notBefore,deadline,deps);
  }
}
export async function checkActivation(input,{notBefore,...deps}={}) {
  const chromeImpl=deps.chromeImpl || globalThis.chrome, now=deps.now || Date.now;
  let configuration=null;
  try {
    // Request only Google access immediately from this separate Check activation click.
    if (!await chromeImpl.permissions.request(permissionRequest(GOOGLE_PERMISSIONS))) fail('PERMISSION_DENIED');
    configuration=validateConfig(typeof input==='function'?await input():input);
    const expected=validInstant(notBefore,now());
    return {...await pollActivation(configuration,expected,clock(deps)+90000,deps),permissions_revoked:true};
  } catch(error) {
    if (error instanceof ConnectorError) throw error;
    fail('CONNECTION_FAILED');
  } finally {
    try {
      if (configuration) configuration.hmac_secret='';
      if (input && typeof input==='object') Reflect.set(input,'hmac_secret','');
    } finally {
      configuration=null;
      if (!await revokePermissions(chromeImpl)) fail('REMOVE_EXTENSION_REQUIRED');
    }
  }
}
export async function connect(input, deps={}) {
  const chromeImpl=deps.chromeImpl || globalThis.chrome, now=deps.now || Date.now;
  let config=null, rawGroups=null, session=null, result=null, savedAt=null;
  try {
    if (chromeImpl.extension?.inIncognitoContext) fail('INCOGNITO_UNSUPPORTED');
    config=validateConfig(input);
    // Keep this first asynchronous API call inside the user's Connect click gesture.
    if (!await chromeImpl.permissions.request(permissionRequest())) fail('PERMISSION_DENIED');
    await bridgeCall(config,'status',{}, {...deps,timeoutMs:20000});
    await verifyBlog(deps);
    rawGroups=[];
    // Use only the current Chrome profile/store, with URL-matching Secure cookies. No stores are enumerated.
    for (const url of [BLOG,SSO_COOKIE_URL]) rawGroups.push({url,cookies:await chromeImpl.cookies.getAll({url,secure:true})});
    session=toSession(rawGroups,now());
    const candidateTime=now();
    const candidateInstant=new Date(candidateTime).toISOString();
    try {
      await bridgeCall(config,'save_session',{source_url:BLOG,session,verified_at:candidateInstant},deps);
    } catch(error) {
      if (!(error instanceof ConnectorError) || error.code!=='BRIDGE_UNAVAILABLE') throw error;
      // A lost save response must not cause an automatic retransmission. Confirm the exact saved timestamp once.
      let stored=null;
      try {stored=await bridgeCall(config,'status',{}, {...deps,timeoutMs:15000});} catch {}
      if (!stored?.connected || stored.session_verified_at!==candidateInstant) fail('SESSION_SAVE_UNCONFIRMED');
    }
    savedAt=candidateTime;
    deps.onStage?.(config.source_mode==='local_https'?'local_verification':'activation');
    if(config.source_mode==='local_https')result={saved:true,source_verified_in_chrome:true,activated:false,local_verification_pending:true};
    else result={saved:true,source_verified_in_chrome:true,cookie_count:session.cookies.length,...await activate(config,savedAt,deps)};
  } catch(error) {
    if (error instanceof ConnectorError) {
      if (savedAt!==null && ['ACTIVATION_UNCONFIRMED','BRIDGE_UNAVAILABLE','BRIDGE_BUSY','BRIDGE_INVALID_RESPONSE'].includes(error.code)) error.activationNotBefore=new Date(savedAt).toISOString();
      throw error;
    }
    fail('CONNECTION_FAILED');
  } finally {
    try {
      if (config) config.hmac_secret='';
      if (input && typeof input==='object') Reflect.set(input,'hmac_secret','');
      for (const group of rawGroups || []) for (const cookie of group.cookies || []) if (cookie && typeof cookie==='object') Reflect.set(cookie,'value','');
      for (const cookie of session?.cookies || []) cookie.value='';
    } finally {
      rawGroups=null; session=null; config=null;
      if (!await revokePermissions(chromeImpl)) fail('REMOVE_EXTENSION_REQUIRED');
    }
  }
  return {...result,permissions_revoked:true};
}
