import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./Source.gs',import.meta.url),'utf8');
const BLOG='https://campus.placements.iitb.ac.in/blog/placement/';
const CAMPUS='campus.placements.iitb.ac.in', SSO='sso.iitb.ac.in';
const NOW=Date.parse('2026-10-11T06:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const cookie = (name,domain=CAMPUS,path='/',expires=-1) => ({name,value:'fixture-'+name,domain,path,expires,secure:true,httpOnly:true,sameSite:'Lax'});
function response(text='',status=200,headers={}) {
  return {getResponseCode:()=>status,getAllHeaders:()=>headers,getContentText:()=>text,getContent:()=>Buffer.from(text,'utf8')};
}
function article(id=1,date='2026-10-10T20:00:00+05:30',text='<p>Meeting: 11 October 2026<br>Time: 8 PM IST</p>') {
  return `<article class="post" id="post-${id}"><h2><a href="?p=${id}">Session &amp; preparation</a></h2><time datetime="${date}">10 October</time><div>${text}<p><a href="https://teams.microsoft.com/meet/123?p=abc&amp;q=def">Join meeting</a></p></div></article>`;
}
const next = page => `<a class="next page-numbers" href="?paged=${page}">Next page</a>`;
function harness({session={cookies:[cookie('campus'),cookie('sso',SSO)],origins:[]},lastCheck=null,fetch}={}) {
  let now=NOW, saved=[];
  const requests=[];
  class ClockDate extends Date {constructor(...args) {super(...(args.length?args:[now]));} static now() {return now;} }
  const context=vm.createContext({Date:ClockDate,UrlFetchApp:{fetch(url,options) {
    requests.push({url,options:plain(options)});
    if (!fetch) throw new Error('Unexpected fixture request');
    return fetch(url,options,{advance:ms=>{now+=ms;},requests});
  }},loadSession_:()=>plain(session),getLastPlacementCheck_:()=>lastCheck,
  saveSession_:(value,verifiedAt)=>saved.push({session:plain(value),verifiedAt}),URL:undefined});
  vm.runInContext(source,context,{filename:'Source.gs'});
  return {context,requests,saved,session,run:()=>context.readPlacementSource_(),advance:ms=>{now+=ms;}};
}

// Full text retains meeting lines, decodes entities and keeps provider joining links.
{
  const {context}=harness();
  const listing=plain(context.parsePlacementListing_(article(297,undefined,'<p>Meeting: 11 October 2026<br>Time: 8 PM IST</p><script>SECRET</script><p>Venue: Hall&nbsp;2</p><a href="javascript:bad()">bad</a>')+next(2),BLOG));
  assert.equal(listing.posts[0].id,'post-297');
  assert.equal(listing.posts[0].title,'Session & preparation');
  assert.equal(listing.posts[0].published,'2026-10-10T14:30:00.000Z');
  assert.equal(listing.posts[0].url,BLOG+'?p=297');
  assert.match(listing.posts[0].text,/Meeting: 11 October 2026\nTime: 8 PM IST/);
  assert.match(listing.posts[0].text,/Venue: Hall 2/);
  assert.doesNotMatch(listing.posts[0].text,/SECRET/);
  assert.equal(listing.posts[0].links.at(-1).url,'https://teams.microsoft.com/meet/123?p=abc&q=def');
  assert.equal(listing.next,BLOG+'?paged=2');
  assert.equal(context.placementByteLength_('aअ😀'),8);
}

// Cookie matching respects domain, path boundaries, expiry and longer-path precedence.
{
  const {context}=harness();
  const jar=[cookie('wide','.iitb.ac.in'),cookie('sso',SSO),cookie('base',CAMPUS,'/blog'),cookie('deep',CAMPUS,'/blog/placement/'),cookie('expired',CAMPUS,'/',NOW/1000-1)];
  const campus=context.placementUrl_(BLOG,null,true);
  assert.equal(context.placementCookieHeader_(jar,campus),'deep=fixture-deep; base=fixture-base; wide=fixture-wide');
  assert.equal(context.placementCookieHeader_(jar,context.placementUrl_('https://'+SSO+'/authorize',null,true)),'wide=fixture-wide; sso=fixture-sso');
  assert.equal(context.placementCookieHeader_(jar,context.placementUrl_('https://'+CAMPUS+'/blogger',null,true)),'wide=fixture-wide');
  assert.throws(()=>context.placementSessionCookies_({cookies:[cookie('bare','iitb.ac.in')]}),/not valid/);
  assert.throws(()=>context.placementSessionCookies_({cookies:[{...cookie('insecure'),secure:false}]}),/not valid/);
}

// Set-Cookie supports repeated headers and combined strings without splitting an Expires date.
{
  const {context}=harness();
  const jar=[cookie('remove')];
  const target=context.placementUrl_(BLOG,null,true);
  context.placementSetCookies_(jar,{'Set-Cookie':[
    'fresh=value; Path=/blog/placement/; Secure; HttpOnly; Expires=Wed, 11 Nov 2026 12:00:00 GMT',
    'remove=gone; Path=/; Secure; Max-Age=0, shared=yes; Domain=iitb.ac.in; Path=/; Secure; HttpOnly',
    'bad=leak; Domain=evil.example; Secure, other=sso; Domain=sso.iitb.ac.in; Secure',
    '__Host-bad=value; Domain=campus.placements.iitb.ac.in; Path=/; Secure',
    'insecure=value; Path=/'
  ]},target);
  assert.deepEqual(jar.map(c=>c.name),['fresh','shared']);
  assert.equal(jar[0].expires,Date.parse('2026-11-11T12:00:00Z')/1000);
  assert.equal(jar[1].domain,'.iitb.ac.in');
  assert.equal(jar[0].httpOnly,true);
  context.placementSetCookies_(jar,{'set-cookie':'fresh=replaced; Path=/blog/placement/; Secure; Max-Age=20'},target);
  assert.equal(jar.filter(c=>c.name==='fresh').length,1);
  assert.equal(jar.find(c=>c.name==='fresh').expires,NOW/1000+20);
}

// Remembered SSO may refresh campus access through its official callback, then read pagination.
{
  const auth='https://'+SSO+'/authorize?client_id=placementserver&state=fixture';
  const callback='https://'+CAMPUS+'/placement-redirects-here?code=fixture&state=fixture';
  let blogRequests=0;
  const h=harness({fetch(url,options) {
    assert.equal(options.method,'get'); assert.equal(options.followRedirects,false);
    assert.equal(options.muteHttpExceptions,true); assert.equal(options.validateHttpsCertificates,true);
    assert.equal(options.headers['Sec-Fetch-Mode'],'navigate');assert.equal(options.headers['Sec-Fetch-Dest'],'document');
    assert.match(options.headers.Accept,/text\/html/);assert.match(options.headers['User-Agent'],/Mozilla/);
    if (url===BLOG && ++blogRequests===1) return response('',302,{Location:auth});
    if (url===auth) {assert.equal(options.headers.Cookie,'sso=fixture-sso');return response('',302,{Location:callback});}
    if (url===callback) {assert.doesNotMatch(options.headers.Cookie,/sso=/);return response('',302,{Location:BLOG,'Set-Cookie':'campus=fresh; Path=/; Secure; HttpOnly'});}
    if (url===BLOG) {assert.equal(options.headers.Cookie,'campus=fresh');return response(article(297)+next(2),200,{'Content-Type':'text/html; charset=UTF-8'});}
    assert.equal(url,BLOG+'?paged=2');return response(article(291,'2026-08-01T08:00:00+05:30')+next(3));
  }});
  const snapshot=plain(h.run());
  assert.equal(snapshot.complete,true);assert.equal(snapshot.posts.length,2);
  assert.equal(snapshot.observed_at,new Date(NOW).toISOString());assert.equal(snapshot.source_url,BLOG);
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].session.cookies.find(c=>c.name==='campus').value,'fresh');
  assert.deepEqual(h.saved[0].session.origins,[]);assert.equal(h.requests.length,5);
  assert.equal(h.session.cookies[0].value,'fixture-campus');
}

// A failure after receiving a replacement cookie must not persist it or advance history.
{
  const h=harness({lastCheck:'2026-09-01T00:00:00Z',fetch(url) {
    if (url===BLOG) return response(article(1)+next(2),200,{'Set-Cookie':'campus=uncommitted; Path=/; Secure; HttpOnly'});
    return response('<form action="https://sso.iitb.ac.in/login">Login</form>');
  }});
  assert.throws(()=>h.run(),/reconnection/);assert.equal(h.saved.length,0);
  assert.equal(h.session.cookies[0].value,'fixture-campus');
}

// Stop before requesting the login screen; never submit credentials, CAPTCHA or OTP.
{
  const h=harness({fetch:()=>response('',302,{Location:'https://'+SSO+'/login?next=fixture'})});
  assert.throws(()=>h.run(),/reconnection/);assert.equal(h.requests.length,1);assert.equal(h.saved.length,0);
}

// Cross-origin redirects, insecure destinations and URL credentials cannot produce requests.
for (const destination of ['https://evil.example/blog/placement/','http://'+CAMPUS+'/blog/placement/','https://user:pass@'+SSO+'/authorize','https://'+CAMPUS+'.evil.example/blog/placement/','https://127.0.0.1/blog/placement/']) {
  const h=harness({fetch:()=>response('',302,{location:destination})});
  assert.throws(()=>h.run(),/unsupported|outside/);assert.equal(h.requests.length,1);assert.equal(h.saved.length,0);
}

// Invalid pagination is not silently reported as a complete snapshot.
for (const href of ['https://evil.example/?paged=2','https://'+SSO+'/?paged=2','/private?paged=2','?paged=2&url=https://evil.example','?paged=1']) {
  const h=harness({fetch:()=>response(article(1)+`<a class="next" href="${href}">Next page</a>`)});
  assert.throws(()=>h.run(),/unsupported|outside/);assert.equal(h.requests.length,1);assert.equal(h.saved.length,0);
}

// A 30-day overlap remains, and a longer outage extends the traversal to the last success.
for (const [lastCheck,expectedPages] of [[null,1],['2026-10-10T00:00:00Z',1],['2026-07-01T00:00:00Z',2]]) {
  const h=harness({lastCheck,fetch(url) {return url===BLOG?response(article(1,'2026-09-01T00:00:00Z')+next(2)):response(article(2,'2026-06-01T00:00:00Z')+next(3));}});
  assert.equal(h.run().posts.length,expectedPages);assert.equal(h.requests.length,expectedPages);assert.equal(h.saved.length,1);
}

// Repeated pagination and duplicate posts both preserve the previous successful state.
{
  const h=harness({fetch(url) {return response(article(url===BLOG?1:2)+next(2));}});
  assert.throws(()=>h.run(),/pagination repeated/);assert.equal(h.requests.length,2);assert.equal(h.saved.length,0);
  const duplicate=harness({fetch:url=>response(article(1)+(url===BLOG?next(2):''))});
  assert.throws(()=>duplicate.run(),/post repeated/);assert.equal(duplicate.saved.length,0);
}

// Exhausting the pagination bound is a failed read, with no partial session save.
{
  const h=harness({fetch(url) {const page=url===BLOG?1:Number(url.match(/paged=(\d+)/)[1]);return response(article(page)+next(page+1));}});
  assert.throws(()=>h.run(),/25 pages/);assert.equal(h.requests.length,25);assert.equal(h.saved.length,0);
}

// Size and wall-time limits fail before any session or successful-check write.
{
  const oversized=harness({fetch:()=>response('x'.repeat(1500001))});
  assert.throws(()=>oversized.run(),/size limit/);assert.equal(oversized.saved.length,0);
  const declared=harness({fetch:()=>response(article(1),200,{'Content-Length':'1500001'})});
  assert.throws(()=>declared.run(),/size limit/);assert.equal(declared.saved.length,0);
  const longPost=harness({fetch:()=>response(article(1,undefined,'x'.repeat(64001)))});
  assert.throws(()=>longPost.run(),/supported size/);assert.equal(longPost.saved.length,0);
  const snapshot=harness({fetch(url) {const offset=url===BLOG?0:30;return response(Array.from({length:30},(_,i)=>article(offset+i+1,undefined,'x'.repeat(30000))).join('')+(url===BLOG?next(2):''));}});
  assert.throws(()=>snapshot.run(),/snapshot exceeded/);assert.equal(snapshot.saved.length,0);
  const elapsed=harness({fetch:(url,options,{advance})=>{advance(301000);return response(article(1));}});
  assert.throws(()=>elapsed.run(),/time limit/);assert.equal(elapsed.saved.length,0);
  const wrongType=harness({fetch:()=>response(article(1),200,{'Content-Type':'application/json'})});
  assert.throws(()=>wrongType.run(),/content type/);assert.equal(wrongType.saved.length,0);
}

// Unusable sessions fail before network access.
for (const session of [null,{cookies:[]},{cookies:[cookie('expired',CAMPUS,'/',NOW/1000-10)]},{cookies:[cookie('foreign','evil.example')]}]) {
  const h=harness({session});assert.throws(()=>h.run(),/reconnect|not valid/i);assert.equal(h.requests.length,0);assert.equal(h.saved.length,0);
}

console.log('Placement source tests passed: parsing, session scoping, redirects, pagination, rollback and limits.');
