import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {BLOG,SSO_COOKIE_URL,PERMISSIONS,ConnectorError,validateConfig,canonical,signedRequest,bridgeCall,verifyBlog,toSession,connect,revokePermissions} from '../core.mjs';
import {validTransportRequest,googleFetch} from '../google-fetch.mjs';

const NOW=Date.parse('2026-10-12T12:00:00Z');
const KEY='synthetic-test-key-never-used-with-a-provider';
const BRIDGE_URL='https://script.google.com/macros/s/SYNTHETIC_TEST_DEPLOYMENT/exec';
const RESULT_URL='https://script.googleusercontent.com/macros/echo?synthetic=test';
const HTML='<!doctype html><html><body><article id="post-900"><h2>Synthetic fixture notice</h2><time datetime="2026-10-12T12:00:00Z"></time><p>Fixture text only.</p></article></body></html>';
const parseHtml=html=>new DOMParser().parseFromString(html,'text/html');
const config=()=>({bridge_url:BRIDGE_URL,hmac_secret:KEY});
function response(text,{url=RESULT_URL,status=200,type='application/json'}={}) {
  const value=new Response(text,{status,headers:{'content-type':type}});
  Object.defineProperty(value,'url',{value:url});return value;
}
function cookie(extra={}) {
  return {name:'fixture_session',value:'synthetic',domain:'campus.placements.iitb.ac.in',path:'/',hostOnly:true,httpOnly:true,
    secure:true,session:true,sameSite:'lax',storeId:'0',...extra};
}
function groups(campus=[],sso=[]) {return [{url:BLOG,cookies:campus},{url:SSO_COOKIE_URL,cookies:sso}];}
function fixture({grant=true,bridgeOk=true,blogOk=true,rows=[cookie()],revoke=true,saveOk=true,incognito=false}={}) {
  const events=[],bodies=[],raw=[];let active=false;
  const chromeImpl={extension:{inIncognitoContext:incognito},permissions:{
    request:async request=>{events.push('permissions');assert.deepEqual(request,{permissions:['cookies'],origins:[...PERMISSIONS.origins]});active=grant;return grant;},
    remove:async()=>{events.push('revoke');if(revoke)active=false;return revoke;},
    getAll:async()=>({permissions:active?['cookies']:[],origins:active?[...PERMISSIONS.origins]:[]})
  },cookies:{getAll:async details=>{
    assert.deepEqual(details,{url:details.url,secure:true});assert.ok([BLOG,SSO_COOKIE_URL].includes(details.url));
    events.push(details.url===BLOG?'campus-cookies':'sso-cookies');
    const copies=details.url===BLOG?rows.map(item=>({...item})):[];raw.push(...copies);return copies;
  }}};
  const fetchImpl=async(url,options)=>{
    if(url===BLOG){events.push('blog');assert.equal(options.credentials,'include');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.redirect,'error');
      return response(blogOk?HTML:'<!doctype html><h1>Sign in</h1>',{url:BLOG,status:blogOk?200:401,type:'text/html'});}
    assert.equal(url,BRIDGE_URL);assert.equal(options.credentials,'omit');
    const body=JSON.parse(options.body);bodies.push(body);events.push(body.action);
    assert.equal(body.signature,createHmac('sha256',KEY).update(canonical(body.action,body.nonce,body.issued_at,body.payload)).digest('hex'));
    return response(JSON.stringify({ok:body.action==='status'?bridgeOk:saveOk,private_metadata:'not returned to UI'}));
  };
  return {events,bodies,raw,deps:{chromeImpl,fetchImpl,cryptoImpl:webcrypto,now:()=>NOW,parseHtml}};
}

test('HMAC envelope matches the deployed canonical protocol and URL validation rejects arbitrary destinations',async()=>{
  const envelope=await signedRequest('status',{},KEY,{cryptoImpl:webcrypto,now:()=>NOW});
  assert.match(envelope.nonce,/^[a-f\d]{32}$/);assert.equal(envelope.issued_at,NOW/1000);
  assert.equal(envelope.signature,createHmac('sha256',KEY).update(JSON.stringify(['status',envelope.nonce,envelope.issued_at,{}])).digest('hex'));
  assert.deepEqual(validateConfig(config()),config());
  for(const url of ['http://script.google.com/macros/s/test/exec','https://evil.invalid/exec',BRIDGE_URL+'?key=x',BRIDGE_URL+'#x','https://script.google.com@evil.invalid/exec'])
    assert.throws(()=>validateConfig({bridge_url:url,hmac_secret:KEY}),ConnectorError);
  assert.throws(()=>canonical('get_session',envelope.nonce,envelope.issued_at,{}),ConnectorError);
});

test('only URL-matching Secure official cookies map to the empty-origin session with proper scope and deduplication',()=>{
  const parent=cookie({name:'fixture_shared',domain:'.iitb.ac.in',hostOnly:false,sameSite:'no_restriction'});
  const sso=cookie({domain:'.sso.iitb.ac.in',hostOnly:false,name:'fixture_remember',sameSite:'strict',session:false,expirationDate:NOW/1000+60});
  const expired=cookie({name:'expired_fixture',session:false,expirationDate:NOW/1000-1});
  const ignored=cookie({secure:false});
  const session=toSession(groups([cookie(),parent,expired,ignored],[parent,sso]),NOW);
  assert.equal(session.cookies.length,3);assert.deepEqual(session.origins,[]);
  assert.deepEqual(session.cookies.map(item=>item.sameSite),['Lax','None','Strict']);
  assert.deepEqual(session.cookies.map(item=>item.domain),['campus.placements.iitb.ac.in','.iitb.ac.in','.sso.iitb.ac.in']);
  assert.equal(session.cookies[0].expires,-1);assert.equal(session.cookies[2].expires,NOW/1000+60);
  assert.ok(session.cookies.every(item=>!Object.hasOwn(item,'storeId')&&!Object.hasOwn(item,'hostOnly')));
});

test('unsafe, partitioned, oversized, mismatched-path, and changed cookie snapshots are rejected',()=>{
  for(const bad of [
    {partitionKey:{topLevelSite:'https://iitb.ac.in'}},{path:'/unrelated'}, {name:'bad;name'}, {value:'with space'},
    {value:'x'.repeat(4097)}, {path:'/'+ 'x'.repeat(1024)}, {sameSite:'unknown'}, {hostOnly:true,domain:'.iitb.ac.in'},
    {httpOnly:'true'}, {session:false,expirationDate:undefined}
  ]) assert.throws(()=>toSession(groups([cookie(bad)]),NOW),ConnectorError);
  assert.throws(()=>toSession(groups(Array.from({length:65},(_,index)=>cookie({name:'fixture_'+index}))),NOW),error=>error.code==='SESSION_TOO_LARGE');
  assert.throws(()=>toSession(groups([cookie({domain:'.iitb.ac.in',hostOnly:false})],[cookie({domain:'.iitb.ac.in',hostOnly:false,value:'changed'})]),NOW),error=>error.code==='SESSION_CHANGED');
  assert.throws(()=>toSession(groups([cookie({domain:'iitb.ac.in',hostOnly:true})]),NOW),error=>error.code==='SESSION_REQUIRED');
});

test('blog gate requires a fresh fixed-URL HTML 200 containing parsed announcement articles',async()=>{
  for(const item of [
    {text:HTML,url:'https://sso.iitb.ac.in/login'}, {text:HTML,url:BLOG,status:401},
    {text:'<h1>Login</h1>',url:BLOG}, {text:'<article id="post-fake"><h2>Fixture</h2></article>',url:BLOG},
    {text:HTML,url:BLOG,type:'text/plain'}
  ]) await assert.rejects(verifyBlog({fetchImpl:async()=>response(item.text,{url:item.url,status:item.status||200,type:item.type||'text/html'}),parseHtml}),error=>error.code==='BLOG_NOT_ACCESSIBLE');
  await assert.rejects(verifyBlog({fetchImpl:async()=>response('x'.repeat(2000001),{url:BLOG,type:'text/html'}),parseHtml}),error=>error.code==='BLOG_NOT_ACCESSIBLE');
  assert.deepEqual(await verifyBlog({fetchImpl:async()=>response(HTML,{url:BLOG,type:'text/html'}),parseHtml}),{verified:true});
});

test('Connect grants from the gesture, verifies private bridge then blog before cookie reads, saves only a candidate, and revokes',async()=>{
  const f=fixture(),input=config();const pending=connect(input,f.deps);
  assert.deepEqual(f.events,['permissions']);
  const result=await pending;
  assert.deepEqual(f.events,['permissions','status','blog','campus-cookies','sso-cookies','save_session','revoke']);
  assert.deepEqual(result,{saved:true,source_verified_in_chrome:true,cloud_verified:false,cookie_count:1,permissions_revoked:true});
  assert.deepEqual(Object.keys(f.bodies[1].payload),['source_url','session','verified_at']);
  assert.equal(f.bodies[1].payload.source_url,BLOG);assert.deepEqual(f.bodies[1].payload.session.origins,[]);
  assert.equal(input.hmac_secret,'');assert.ok(f.raw.every(item=>item.value===''));
  assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal(Object.hasOwn(result,'private_metadata'),false);
});

test('permission denial or failed bridge/blog validation reads no cookies, sends no session, and still revokes',async()=>{
  for(const options of [{grant:false},{bridgeOk:false},{blogOk:false},{incognito:true}]) {
    const f=fixture(options);await assert.rejects(connect(config(),f.deps),ConnectorError);
    assert.equal(f.events.at(-1),'revoke');assert.equal(f.events.includes('campus-cookies'),false);assert.equal(f.events.includes('save_session'),false);
  }
});

test('failed save wipes cookie values and revokes; failed revocation explicitly requires removing the extension',async()=>{
  const failed=fixture({saveOk:false});await assert.rejects(connect(config(),failed.deps),error=>error.code==='BRIDGE_REJECTED');
  assert.ok(failed.raw.every(item=>item.value===''));assert.equal(failed.events.at(-1),'revoke');
  const unsafe=fixture({revoke:false});await assert.rejects(connect(config(),unsafe.deps),error=>error.code==='REMOVE_EXTENSION_REQUIRED');
  const f=fixture();assert.equal(await revokePermissions(f.deps.chromeImpl),true);
});

test('bridge replies require authenticated success and expected Google final response URL without exposing provider errors',async()=>{
  const common={cryptoImpl:webcrypto,now:()=>NOW};
  for(const item of [
    {text:'{"ok":false,"error":"private provider exception"}'}, {text:'not JSON'},
    {text:'{"ok":true}',url:'https://evil.invalid/macros/echo'}, {text:'{"ok":true}',url:'https://script.googleusercontent.com/unexpected'},
    {text:'x'.repeat(1500001)}
  ]) await assert.rejects(bridgeCall(config(),'status',{}, {...common,fetchImpl:async()=>response(item.text,{url:item.url||RESULT_URL})}),error=>error instanceof ConnectorError&&!error.message.includes('private provider'));
  assert.deepEqual(await bridgeCall(config(),'status',{}, {...common,fetchImpl:async()=>response('{"ok":true,"email":"synthetic@example.invalid"}')}),{ok:true});
});

test('Google-only transport validates signed envelopes, omits Chrome credentials, and rejects arbitrary requests',async()=>{
  const body=JSON.stringify(await signedRequest('status',{},KEY,{cryptoImpl:webcrypto,now:()=>NOW}));
  assert.equal(validTransportRequest(BRIDGE_URL,body),true);assert.equal(validTransportRequest(BLOG,body),false);
  assert.equal(validTransportRequest(BRIDGE_URL,'{}'),false);assert.equal(validTransportRequest(BRIDGE_URL,body.replace('status','get_session')),false);
  await assert.rejects(googleFetch(BLOG,body,async()=>assert.fail('must never fetch')),ConnectorError);
  const reply=await googleFetch(BRIDGE_URL,body,async(url,options)=>{
    assert.equal(url,BRIDGE_URL);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'follow');assert.equal(options.body,body);
    return response('{"ok":true}');
  });assert.equal(reply.url,RESULT_URL);assert.equal(reply.text,'{"ok":true}');
  await assert.rejects(googleFetch(BRIDGE_URL,body,async()=>response('{"ok":true}',{url:BLOG})),ConnectorError);
});

test('manifest has no automatic browser access and local transport CSP permits only Google connections',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.optional_permissions,['cookies']);assert.deepEqual(manifest.optional_host_permissions,[...PERMISSIONS.origins]);
  for(const forbidden of ['permissions','host_permissions','background','content_scripts','externally_connectable','web_accessible_resources']) assert.equal(Object.hasOwn(manifest,forbidden),false);
  assert.equal(manifest.incognito,'not_allowed');
  const transport=await readFile(new URL('../google-transport.html',import.meta.url),'utf8');
  const csp=new DOMParser().parseFromString(transport,'text/html').querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.match(csp,/connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com;/);
  assert.equal(csp.includes('iitb'),false);
});
