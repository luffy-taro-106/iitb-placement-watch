import test from 'node:test';
import assert from 'node:assert/strict';
import {readHttpSnapshot} from '../http-source.mjs';
import {runLocalCheck} from '../local-check.mjs';
import {BLOG} from '../policy.mjs';
const fixture=()=>({cookies:[{name:'sso',value:'synthetic-session',domain:'sso.iitb.ac.in',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'Lax'}],origins:[]});
const article=(id,date='2026-10-25')=>'<article id="post-'+id+'"><header><time datetime="'+date+'T00:00:00+05:30">Published</time><h2><a href="?p='+id+'">Fixture announcement</a></h2></header><p>Deadline: 26 October 2026, 11:59 PM</p></article>';
const html=text=>new Response(text,{headers:{'content-type':'text/html'}});
test('HTTP checker renews only through official GET links and retains exact deployed text parsing',async()=>{
 const seen=[];
 const snapshot=await readHttpSnapshot(fixture(),{fetchImpl:async(url,options)=>{
  seen.push({url,method:options.method,cookie:options.headers.Cookie});
  if(seen.length===1)return new Response(null,{status:302,headers:{location:'https://sso.iitb.ac.in/authorize'}});
  if(url.includes('sso.iitb.ac.in'))return html('<h1>Sign in required</h1>');
  if(url===BLOG)return html(article(1,'2026-09-01'));
  assert.equal(url,BLOG+'authplacement/');
  return new Response(null,{status:302,headers:{location:BLOG,'set-cookie':'campus=synthetic-renewal; Path=/; Secure; HttpOnly'}});
 }});
 assert.equal(snapshot.complete,true);assert.ok(snapshot.session.cookies.some(c=>c.name==='campus'));assert.ok(seen.every(r=>r.method==='GET'));
 assert.equal(seen.find(r=>r.url.includes('sso.iitb.ac.in')).cookie,'sso=synthetic-session');
 assert.equal(seen[0].cookie,undefined);
});
test('A complete HTTP snapshot follows all observed pages, retains line breaks and safely saves rotated Secure cookies',async()=>{
 const calls=[];const snapshot=await readHttpSnapshot(fixture(),{fetchImpl:async(url,options)=>{
  calls.push(url);assert.equal(options.redirect,'manual');
  if(url===BLOG)return html(article(1)+'<a class="next" href="?paged=2">Next page</a>');
  assert.equal(url,BLOG+'?paged=2');return html(article(2,'2026-09-01'));
 }});
 assert.equal(snapshot.posts.length,2);assert.equal(calls.length,2);assert.match(snapshot.posts[0].text,/\n/);assert.equal(snapshot.complete,true);assert.deepEqual(snapshot.session.origins,[]);
});
test('Cross-host redirects and incomplete pagination never yield an ingestible snapshot',async()=>{
 let requests=0;
 await assert.rejects(readHttpSnapshot(fixture(),{fetchImpl:async()=>{requests++;return new Response(null,{status:302,headers:{location:'https://example.test/collect'}});}}),e=>e.code==='UNSUPPORTED_SOURCE_REDIRECT');
 assert.equal(requests,1);
 await assert.rejects(readHttpSnapshot(fixture(),{maxPages:1,fetchImpl:async()=>html(article(1)+'<a class="next" href="?paged=2">Next page</a>')}),e=>e.code==='INCOMPLETE_SOURCE');
});
test('Local checker ingests only a complete successful read and wipes its in-memory session values',async()=>{
 const saved=fixture(),snapshot={source_url:BLOG,complete:true,posts:[{id:'post-1'}],observed_at:new Date().toISOString(),session:fixture()},calls=[];
 const result=await runLocalCheck({config:{},call:async(_config,action,payload)=>{calls.push(action);if(action==='get_session')return {session:saved};if(action==='configure_source')return {ok:true,mode:'local_https',local_source_fresh:true};assert.equal(action,'ingest_local_snapshot');assert.equal(payload.complete,true);return {pending_count:0,meeting_count:1,delivery_count:1,needs_attention:false};},read:async()=>snapshot});
 assert.deepEqual(calls,['get_session','ingest_local_snapshot','configure_source']);assert.equal(result.ok,true);assert.equal(saved.cookies[0].value,'');assert.equal(snapshot.session.cookies[0].value,'');
 let ingested=false;
 await assert.rejects(runLocalCheck({config:{},call:async(_c,a)=>{if(a!=='get_session')ingested=true;return {session:fixture()};},read:async()=>{throw new Error('Fixture read failed');}}));assert.equal(ingested,false);
});
