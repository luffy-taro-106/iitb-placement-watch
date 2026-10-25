import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
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

export async function readHttpSnapshot(session,{fetchImpl=fetch,lastSuccessfulCheck=null,now=Date.now(),maxPages=25}={}) {
  const parser=sourceParser(),cookies=parser.placementSessionCookies_(filterSession(session,now));
  const signal=AbortSignal.timeout(240000),started=Date.now();
  async function read(url) {
    let target=parser.placementUrl_(url,BLOG,true);const visited=new Set();
    for(let redirects=0;redirects<=12;redirects++) {
      if(Date.now()-started>240000)throw new PolicyError('SOURCE_TIMEOUT');
      if(!allowedSourceUrl(target.href))throw new PolicyError('UNSUPPORTED_SOURCE_REDIRECT');
      const cookie=parser.placementCookieHeader_(cookies,target),identity=target.href+'|'+cookie;
      if(visited.has(identity))throw new PolicyError('IITB_RECONNECT_REQUIRED');visited.add(identity);
      const headers={'User-Agent':parser.PLACEMENT_SOURCE_UA_,Accept:parser.PLACEMENT_SOURCE_ACCEPT_,'Accept-Language':'en-US,en;q=0.9',Referer:BLOG};
      if(cookie)headers.Cookie=cookie;
      let response;
      try {response=await fetchImpl(target.href,{method:'GET',headers,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});}
      catch {throw new PolicyError('IITB_NETWORK_UNAVAILABLE');}
      parser.placementSetCookies_(cookies,{'set-cookie':response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean)},target);
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
      try{return parser.parsePlacementListing_(await boundedHtml(response),target.href);}
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
