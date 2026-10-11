import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createHmac} from 'node:crypto';
import {BLOG,filterSession,listingUrl,normalizePosts,sourceConfig,validIso} from '../policy.mjs';
import {bridgeCall,bridgeConfig,canonical,signedRequest} from '../bridge.mjs';
import {capturePage,collectSnapshot,installNetworkPolicy} from '../extract.mjs';
import {runSourceCheck} from '../run.mjs';
import {allowedControlOrigin,assertPrivatePorts} from '../../login/server.mjs';

const fixtureCookie={name:'fixture_session',value:'not-a-real-cookie',domain:'campus.placements.iitb.ac.in',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'};
const fixtureEnv={IITB_BRIDGE_URL:'https://script.google.com/macros/s/deployment-fixture/exec',IITB_HMAC_SECRET:'fixture-hmac-secret-never-real-0000'};
const article=(id=900,published='2026-10-10T18:00:00+05:30',description='Date: 12 October 2026. Time: 8 PM. Fixture only.')=>
  `<article id="post-${id}"><time datetime="${published}"></time><h2><a href="?p=${id}">Fixture &amp; announcement</a></h2><p>${description}</p><a href="https://example.org/join/fixture">Fixture joining link</a><a href="javascript:alert(1)">Ignore unsafe link</a><script>notSourceFacts()</script></article>`;
function domCapture(html,url=BLOG) {
  const old=globalThis.document;globalThis.document=parseHTML(html).document;
  try{return capturePage({sourceUrl:url});}finally{globalThis.document=old;}
}
function fixturePage(pages,{redirectTo=null}={}) {
  let current=BLOG,body='',visits=[];
  return {visits,url:()=>current,
    async goto(url){visits.push(url);current=redirectTo || url;body=pages[url] || '';return {ok:()=>true};},
    locator(){return {first(){return {async waitFor(){if(!body.includes('<article'))throw new Error('Fixture missing article');}};}};},
    async evaluate(fn,args){assert.equal(fn,capturePage);return domCapture(body,args.sourceUrl);}
  };
}

test('HMAC matches an independent UTF-8 vector and signs the exact ordered array',()=>{
  const payload={source_url:BLOG,note:'Fixture Σ'},nonce='00112233445566778899aabbccddeeff',issued_at=1791691200;
  const signed=signedRequest('save_session',payload,fixtureEnv.IITB_HMAC_SECRET,{nonce,issued_at});
  assert.equal(signed.signature,'5fbef4615d2803df9645a044df8534a0d68a9be9b215551e4fd02d146a7a1a57');
  assert.equal(canonical(signed.action,nonce,issued_at,payload),JSON.stringify(['save_session',nonce,issued_at,payload]));
  assert.notEqual(signed.signature,signedRequest('save_session',{...payload,note:'Changed'},fixtureEnv.IITB_HMAC_SECRET,{nonce,issued_at}).signature);
  assert.throws(()=>canonical('send_email',nonce,issued_at,{}));
});
test('bridge validates configuration and rejects provider errors without echoing private response text',async()=>{
  const config=bridgeConfig(fixtureEnv);
  assert.throws(()=>bridgeConfig({...fixtureEnv,IITB_BRIDGE_URL:fixtureEnv.IITB_BRIDGE_URL+'?secret=fixture'}));
  assert.throws(()=>bridgeConfig({...fixtureEnv,IITB_BRIDGE_URL:fixtureEnv.IITB_BRIDGE_URL.replace('script.google.com','script.google.com:444')}));
  assert.throws(()=>sourceConfig({IITB_BLOG_URL:'https://evil.example'}));
  const result=await bridgeCall(config,'status',{},async(url,options)=>{
    assert.equal(url,fixtureEnv.IITB_BRIDGE_URL);assert.equal(options.redirect,'manual');
    const envelope=JSON.parse(options.body);
    assert.equal(envelope.signature,createHmac('sha256',fixtureEnv.IITB_HMAC_SECRET).update(JSON.stringify([envelope.action,envelope.nonce,envelope.issued_at,envelope.payload])).digest('hex'));
    return Response.json({ok:true,connected:false});
  });
  assert.equal(result.connected,false);
  await assert.rejects(bridgeCall(config,'status',{},async()=>Response.json({ok:false,error:'fixture private material'})),error=>error.message==='BRIDGE_REQUEST_REJECTED');
  let calls=0;
  await assert.rejects(bridgeCall(config,'status',{},async()=>{calls++;return new Response('',{status:307,headers:{location:'https://evil.example'}});}),/BRIDGE_UNREACHABLE/);
  assert.equal(calls,1);
  await assert.rejects(bridgeCall(config,'status',{},async()=>new Response('x'.repeat(1500001))),/INVALID_BRIDGE_RESPONSE/);
});
test('Apps Script output redirect follows only Google response hosting with GET and no request body',async()=>{
  let calls=0;
  const result=await bridgeCall(bridgeConfig(fixtureEnv),'status',{},async(url,options)=>{
    calls++;
    if(calls===1)return new Response('',{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?fixture=synthetic'}});
    assert.equal(new URL(url).hostname,'script.googleusercontent.com');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    return Response.json({ok:true});
  });
  assert.equal(result.ok,true);assert.equal(calls,2);
});
test('session keeps only valid official cookies, strips every browser storage origin, and rejects an empty result',()=>{
  const filtered=filterSession({cookies:[fixtureCookie,{...fixtureCookie,name:'thirdparty',domain:'evil.example'},
    {...fixtureCookie,name:'expired',expires:1},{...fixtureCookie,name:'insecure',secure:false},{...fixtureCookie,name:'shared',domain:'.iitb.ac.in'}],origins:[{origin:'https://sso.iitb.ac.in',localStorage:[{name:'password',value:'must-never-save'}]}]});
  assert.deepEqual(filtered.origins,[]);assert.equal(filtered.cookies.length,2);
  assert.equal(JSON.stringify(filtered).includes('must-never-save'),false);
  assert.throws(()=>filterSession({cookies:[{...fixtureCookie,domain:'.ac.in'}]}),/SESSION_REQUIRED/);
  assert.throws(()=>filterSession({cookies:[{...fixtureCookie,domain:'iitb.ac.in'}]}),/INVALID_SESSION/);
  assert.throws(()=>filterSession({cookies:[{...fixtureCookie,value:'header\ninjection'}]}),/INVALID_SESSION/);
});
test('DOM extraction preserves published times, full fixture facts and joining links without executing source scripts',()=>{
  const extracted=domCapture(article()+'<a class="next page-numbers" href="?paged=2">Next page</a>');
  assert.equal(extracted.posts[0].id,'post-900');assert.equal(extracted.posts[0].title,'Fixture & announcement');
  assert.equal(extracted.posts[0].published,'2026-10-10T18:00:00+05:30');
  assert.match(extracted.posts[0].text,/Date: 12 October 2026. Time: 8 PM./);
  assert.equal(extracted.posts[0].text.includes('notSourceFacts'),false);
  assert.equal(extracted.posts[0].links.some(link=>link.url.startsWith('javascript:')),false);
  assert.equal(extracted.next,BLOG+'?paged=2');
  const normalized=normalizePosts(extracted.posts);
  assert.equal(normalized[0].links.some(link=>link.url==='https://example.org/join/fixture'),true);
});
test('source rejects invalid timestamps, wrong IDs/URLs and unsafe links instead of sending fabricated facts',()=>{
  const post=domCapture(article()).posts[0];
  assert.throws(()=>normalizePosts([{...post,url:BLOG+'?p=901'}]),/SOURCE_POST_URL_MISMATCH/);
  assert.throws(()=>normalizePosts([{...post,published:'2026-02-30T00:00:00Z'}]),/INVALID_SOURCE_TIME/);
  assert.throws(()=>normalizePosts([{...post,links:[{text:'bad',url:'javascript:alert(1)'}]}]),/UNSAFE_SOURCE_LINK/);
  assert.throws(()=>normalizePosts([post,post]),/INVALID_SOURCE_POST_ID/);
  assert.throws(()=>normalizePosts([{...post,text:'x'.repeat(64001)}]),/INVALID_SOURCE_TEXT/);
  assert.equal(validIso('2026-10-10T18:00:00+05:30'),Date.parse('2026-10-10T18:00:00+05:30'));
  assert.equal(listingUrl(BLOG+'?paged=2'),true);assert.equal(listingUrl(BLOG+'?p=900'),false);
});
test('recent pagination is complete only after the cutoff or listing end; loops and cross-site next pages fail',async()=>{
  const now=Date.parse('2026-10-11T10:00:00Z');
  const page=fixturePage({[BLOG]:article(900)+'<a class="next" href="?paged=2">Next page</a>',[BLOG+'?paged=2']:article(901,'2026-08-01T10:00:00Z')});
  const snapshot=await collectSnapshot(page,{now});
  assert.equal(snapshot.complete,true);assert.equal(snapshot.posts.length,2);assert.equal(page.visits.length,2);
  const limited=fixturePage({[BLOG]:article()+'<a class="next" href="?paged=2">Next page</a>'});
  await assert.rejects(collectSnapshot(limited,{now,maxPages:1}),/INCOMPLETE_SOURCE/);
  const hostile=fixturePage({[BLOG]:article()+'<a class="next" href="https://evil.example/">Next page</a>'});
  await assert.rejects(collectSnapshot(hostile,{now}),/INVALID_SOURCE_PAGINATION/);assert.equal(hostile.visits.length,1);
  const login=fixturePage({[BLOG]:'<form>Official fixture login</form>'},{redirectTo:'https://sso.iitb.ac.in/login'});
  await assert.rejects(collectSnapshot(login,{now}),/IITB_RECONNECT_REQUIRED/);
});
test('checker network policy allows reads only; official SSO POST is available solely for manual login',async()=>{
  let handler;await installNetworkPolicy({route:async(pattern,fn)=>{assert.equal(pattern,'**/*');handler=fn;}});
  const decide=async(url,method='GET')=>{let result;await handler({request:()=>({url:()=>url,method:()=>method}),abort:async()=>{result='blocked';},continue:async()=>{result='allowed';}});return result;};
  assert.equal(await decide(BLOG),'allowed');assert.equal(await decide('https://evil.example/script.js'),'blocked');
  assert.equal(await decide('https://sso.iitb.ac.in/login','POST'),'blocked');assert.equal(await decide(BLOG,'POST'),'blocked');
  await installNetworkPolicy({route:async(pattern,fn)=>{handler=fn;}},{interactiveLogin:true});
  assert.equal(await decide('https://sso.iitb.ac.in/login','POST'),'allowed');assert.equal(await decide(BLOG,'POST'),'blocked');
});
test('manual check retrieves state privately, ingests complete fixture snapshot and refreshed filtered session, then closes browser',async()=>{
  const actions=[];let closed=false;
  const page=fixturePage({[BLOG]:article()});
  const context={route:async()=>{},newPage:async()=>page,storageState:async()=>({cookies:[fixtureCookie],origins:[]})};
  const browser={newContext:async(options)=>{assert.deepEqual(options.storageState.origins,[]);assert.equal(options.acceptDownloads,false);return context;},close:async()=>{closed=true;}};
  const result=await runSourceCheck({env:fixtureEnv,browserType:{launch:async()=>browser},call:async(config,action,payload)=>{
    actions.push(action);if(action==='get_session')return {ok:true,session:{cookies:[fixtureCookie],origins:[]},last_successful_check:null};
    assert.equal(action,'ingest_snapshot');assert.equal(payload.complete,true);assert.equal(payload.posts[0].id,'post-900');assert.deepEqual(payload.session.origins,[]);
    return {ok:true,pending_count:1};
  }});
  assert.equal(result.pending_count,1);assert.deepEqual(actions,['get_session','ingest_snapshot']);assert.equal(closed,true);
});
test('login control permits only the configured private Codespace origin and refuses unverified/public ports',async()=>{
  const env={CODESPACES:'true',CODESPACE_NAME:'fixture-owned-space'};
  assert.equal(allowedControlOrigin('https://fixture-owned-space-3000.app.github.dev',env),true);
  assert.equal(allowedControlOrigin('https://another-space-3000.app.github.dev',env),false);
  assert.equal(allowedControlOrigin('null',env),false);
  await assertPrivatePorts(env,async(file,args)=>{assert.equal(file,'gh');assert.equal(args.includes('sourcePort,visibility'),true);return {stdout:JSON.stringify([{sourcePort:3000,visibility:'private'},{sourcePort:6080,visibility:'private'}])};});
  await assert.rejects(assertPrivatePorts(env,async()=>({stdout:JSON.stringify([{sourcePort:3000,visibility:'private'},{sourcePort:6080,visibility:'public'}])})),/PRIVATE_PORTS_NOT_VERIFIED/);
});
