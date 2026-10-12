export const BLOG = 'https://campus.placements.iitb.ac.in/blog/placement/';
export const SSO_COOKIE_URL = 'https://sso.iitb.ac.in/authorize';
export const PERMISSIONS = Object.freeze({
  permissions: Object.freeze(['cookies']),
  origins: Object.freeze([
    'https://campus.placements.iitb.ac.in/*', 'https://sso.iitb.ac.in/*',
    'https://script.google.com/*', 'https://script.googleusercontent.com/*'
  ])
});
const OFFICIAL_HOSTS = new Set(['campus.placements.iitb.ac.in', 'sso.iitb.ac.in']);
const SAME_SITE = {no_restriction:'None', lax:'Lax', strict:'Strict', unspecified:'Lax'};
const encoder = new TextEncoder();

export class ConnectorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new ConnectorError(code); }
function permissionRequest() { return {permissions:[...PERMISSIONS.permissions], origins:[...PERMISSIONS.origins]}; }
export function validateConfig(config) {
  let url;
  try { url = new URL(config?.bridge_url); } catch { fail('CONFIGURATION_REQUIRED'); }
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[a-z\d_-]+\/exec$/i.test(url.pathname) ||
      url.username || url.password || url.search || url.hash || typeof config?.hmac_secret !== 'string' ||
      config.hmac_secret.length < 32 || config.hmac_secret.length > 256) fail('INVALID_CONFIGURATION');
  return {bridge_url:url.href, hmac_secret:config.hmac_secret};
}
export function canonical(action, nonce, issued_at, payload) {
  if (!['status','save_session'].includes(action) || !/^[a-f\d]{32}$/.test(nonce) || !Number.isSafeInteger(issued_at) ||
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
      credentials:'omit',redirect:'follow',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(90000)
    });
    if (!response.ok || !finalBridgeUrl(response.url,config.bridge_url)) fail('BRIDGE_UNAVAILABLE');
    let result;
    try { result=JSON.parse(await boundedText(response,1500000,'BRIDGE_UNAVAILABLE')); } catch { fail('BRIDGE_UNAVAILABLE'); }
    if (result?.ok!==true) fail('BRIDGE_REJECTED');
    // The bridge response can contain private status data. Return only the required success flag.
    return {ok:true};
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
export async function connect(input, deps={}) {
  const chromeImpl=deps.chromeImpl || globalThis.chrome, now=deps.now || Date.now;
  let config=null, rawGroups=null, session=null, result=null;
  try {
    if (chromeImpl.extension?.inIncognitoContext) fail('INCOGNITO_UNSUPPORTED');
    config=validateConfig(input);
    // Keep this first asynchronous API call inside the user's Connect click gesture.
    if (!await chromeImpl.permissions.request(permissionRequest())) fail('PERMISSION_DENIED');
    await bridgeCall(config,'status',{},deps);
    await verifyBlog(deps);
    rawGroups=[];
    // Use only the current Chrome profile/store, with URL-matching Secure cookies. No stores are enumerated.
    for (const url of [BLOG,SSO_COOKIE_URL]) rawGroups.push({url,cookies:await chromeImpl.cookies.getAll({url,secure:true})});
    session=toSession(rawGroups,now());
    await bridgeCall(config,'save_session',{source_url:BLOG,session,verified_at:new Date(now()).toISOString()},deps);
    result={saved:true,source_verified_in_chrome:true,cloud_verified:false,cookie_count:session.cookies.length};
  } catch(error) {
    if (error instanceof ConnectorError) throw error;
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
