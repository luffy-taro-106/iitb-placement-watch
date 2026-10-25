import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {BLOG,allowedSourceUrl,filterSession,listingUrl,PolicyError} from './policy.mjs';

const source=await readFile(new URL('../apps-script/Source.gs',import.meta.url),'utf8');
const MAX_BYTES=1500000;

// Reuse the deployed parser and restricted cookie rules. Site HTML is parsed as data,
// never evaluated, and this sandbox has no filesystem, browser, or network capability.
export function sourceParser() {
  const context=vm.createContext({Date});
  vm.runInContext(source,context,{timeout:1000});
  return context;
}

async function boundedHtml(response) {
  const size=response.headers.get('content-length');
  if(size && Number(size)>MAX_BYTES)throw new PolicyError('SOURCE_TOO_LARGE');
  if(!response.body)throw new PolicyError('INCOMPLETE_SOURCE');
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try {
    for(;;){const row=await reader.read();if(row.done)break;bytes+=row.value.byteLength;
      if(bytes>MAX_BYTES){await reader.cancel();throw new PolicyError('SOURCE_TOO_LARGE');}parts.push(row.value);}
  } finally {reader.releaseLock();}
  return Buffer.concat(parts,bytes).toString('utf8');
}

export async function readHttpSnapshot(session,{fetchImpl=fetch,lastSuccessfulCheck=null,now=Date.now(),maxPages=25,signal:parentSignal,timeoutMs=parentSignal?110000:240000,requestTimeoutMs=20000,waitImpl=(ms,{signal}={})=>delay(ms,undefined,{signal})}={}) {
  if(parentSignal?.aborted)throw new PolicyError('SOURCE_ABORTED');
  const parser=sourceParser(),cookies=parser.placementSessionCookies_(filterSession(session,now));
  const budget=AbortSignal.timeout(timeoutMs),signal=parentSignal?AbortSignal.any([parentSignal,budget]):budget;
  const retryDelays=[500,1500];
  function checkAbort() {
    if(parentSignal?.aborted)throw new PolicyError('SOURCE_ABORTED');
    if(budget.aborted)throw new PolicyError('SOURCE_TIMEOUT');
  }
  async function pause(ms) {
    checkAbort();
    try {await waitImpl(ms,{signal});}catch(error){checkAbort();throw error;}
    checkAbort();
  }
  async function request(target) {
    for(let attempt=0;;attempt++) {
      checkAbort();
      // Recompute from the same jar after every response, including transient errors
      // which may rotate the official short session before a retry succeeds.
      const cookie=parser.placementCookieHeader_(cookies,target);
      const headers={'User-Agent':parser.PLACEMENT_SOURCE_UA_,Accept:parser.PLACEMENT_SOURCE_ACCEPT_,'Accept-Language':'en-US,en;q=0.9',Referer:BLOG};
      if(cookie)headers.Cookie=cookie;
      let response;
      try {response=await fetchImpl(target.href,{method:'GET',headers,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(requestTimeoutMs)])});}
      catch {
        checkAbort();
        if(attempt>=retryDelays.length)throw new PolicyError('IITB_NETWORK_UNAVAILABLE');
        await pause(retryDelays[attempt]);continue;
      }
      checkAbort();
      parser.placementSetCookies_(cookies,{'set-cookie':response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean)},target);
      if(![408,425,429,500,502,503,504].includes(response.status) || attempt>=retryDelays.length)return response;
      const retryAfter=response.headers.get('retry-after');
      const requested=retryAfter?( /^\d+(?:\.\d+)?$/.test(retryAfter)?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-Date.now()) ):0;
      // Never shorten a server's longer throttling instruction to squeeze in a retry.
      if(Number.isFinite(requested) && requested>5000)return response;
      await response.body?.cancel();
      await pause(Math.max(retryDelays[attempt],Number.isFinite(requested)?requested:0));
    }
  }
  async function read(url) {
    let target=parser.placementUrl_(url,BLOG,true);const visited=new Set();
    for(let redirects=0;redirects<=12;redirects++) {
      checkAbort();
      if(!allowedSourceUrl(target.href))throw new PolicyError('UNSUPPORTED_SOURCE_REDIRECT');
      const cookie=parser.placementCookieHeader_(cookies,target),identity=target.href+'|'+cookie;
      if(visited.has(identity))throw new PolicyError('IITB_RECONNECT_REQUIRED');visited.add(identity);
      const response=await request(target);
      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location || redirects===12)throw new PolicyError('IITB_RECONNECT_REQUIRED');
        try {target=parser.placementRedirect_(location,target.href);}catch {throw new PolicyError('UNSUPPORTED_SOURCE_REDIRECT');}
        continue;
      }
      if(response.status===401 || response.status===403 || !listingUrl(target.href)) {await response.body?.cancel();throw new PolicyError('IITB_RECONNECT_REQUIRED');}
      if(response.status!==200) {await response.body?.cancel();throw new PolicyError('IITB_SOURCE_UNAVAILABLE');}
      const type=response.headers.get('content-type');
      if(type && !/^text\/html(?:\s*;|$)/i.test(type)){await response.body?.cancel();throw new PolicyError('INVALID_SOURCE_CONTENT');}
      let text;
      try {text=await boundedHtml(response);}catch(error){checkAbort();if(error instanceof PolicyError)throw error;throw new PolicyError('IITB_NETWORK_UNAVAILABLE');}
      checkAbort();
      try{return parser.parsePlacementListing_(text,target.href);}
      catch(error){if(error.placementReconnect)throw new PolicyError('IITB_RECONNECT_REQUIRED');throw error;}
    }
    throw new PolicyError('IITB_RECONNECT_REQUIRED');
  }
  let renewed=false;
  async function listing(url) {
    try{return await read(url);}catch(error){
      if(error.code!=='IITB_RECONNECT_REQUIRED' || renewed)throw error;renewed=true;
      const result=await read(parser.PLACEMENT_SOURCE_RENEW_);
      return url===BLOG?result:read(url);
    }
  }
  const prior=Date.parse(lastSuccessfulCheck),threshold=Number.isFinite(prior)?Math.min(now-30*86400000,prior):now-30*86400000;
  const posts=[],ids=new Set(),pages=new Set();let url=BLOG;
  for(let count=0;url&&count<maxPages;count++) {
    if(!listingUrl(url)||pages.has(url))throw new PolicyError('INVALID_SOURCE_PAGINATION');pages.add(url);
    const page=await listing(url);
    for(const post of page.posts){if(ids.has(post.id))throw new PolicyError('SOURCE_CHANGED_DURING_READ');ids.add(post.id);posts.push(post);}
    if(posts.length>500 || Buffer.byteLength(JSON.stringify(posts))>MAX_BYTES)throw new PolicyError('SOURCE_TOO_LARGE');
    url=Math.min(...page.posts.map(post=>Date.parse(post.published)))<=threshold?null:page.next;
  }
  if(url||!posts.length)throw new PolicyError('INCOMPLETE_SOURCE');
  const snapshot={source_url:BLOG,complete:true,posts,observed_at:new Date().toISOString(),session:filterSession({cookies,origins:[]})};
  if(Buffer.byteLength(JSON.stringify(snapshot))>MAX_BYTES)throw new PolicyError('SOURCE_TOO_LARGE');
  return snapshot;
}
