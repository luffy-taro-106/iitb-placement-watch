import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {bridgeCall,bridgeConfig} from '../checker/bridge.mjs';
import {BLOG,filterSession,listingUrl,sourceConfig,PolicyError} from '../checker/policy.mjs';
import {capturePage,installNetworkPolicy} from '../checker/extract.mjs';

export function allowedControlOrigin(origin,env=process.env,mode='codespace',port=3000) {
  const allowed=new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]);
  if (mode==='codespace' && env.CODESPACE_NAME && /^[a-z\d-]+$/i.test(env.CODESPACE_NAME)) {
    const domain=env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
    if (domain==='app.github.dev') allowed.add('https://'+env.CODESPACE_NAME+'-3000.'+domain);
  }
  return allowed.has(origin);
}
export async function assertPrivatePorts(env,run=promisify(execFile)) {
  if(env.CODESPACES!=='true'||!env.CODESPACE_NAME||!/^[a-z\d-]+$/i.test(env.CODESPACE_NAME))throw new PolicyError('PRIVATE_CODESPACE_DESKTOP_REQUIRED');
  let ports;
  try {const result=await run('gh',['codespace','ports','--codespace',env.CODESPACE_NAME,'--json','sourcePort,visibility'],{timeout:20000,maxBuffer:16000});ports=JSON.parse(result.stdout);}
  catch {throw new PolicyError('PRIVATE_PORTS_NOT_VERIFIED');}
  if(!Array.isArray(ports)||![3000,6080].every(port=>ports.some(item=>Number(item.sourcePort)===port&&item.visibility==='private')))throw new PolicyError('PRIVATE_PORTS_NOT_VERIFIED');
}
function html(token,{mode,configured,opened,saved,message=''}) {
  const local=mode==='local';
  let content;
  if (saved) content='<p>Your IITB session was saved to your private Google bridge. The temporary browser is closed. Google Apps Script performs the ongoing checks and reminders.</p>';
  else if (!configured) content=`<p>Enter the deployment URL and bridge secret from your own Google Apps Script setup. These are kept only in this program's memory. Enter your IITB username, password and OTP only on IITB's official page.</p><form action="/configure" method="post" autocomplete="off"><input type="hidden" name="token" value="${token}"><label>Google bridge URL<input name="bridge_url" type="url" maxlength="1000" required autocomplete="off"></label><label>Google bridge secret<input name="bridge_secret" type="password" minlength="32" maxlength="256" required autocomplete="off"></label><button>Open official IITB login</button></form>`;
  else {
    content=`<p>${local?'A fresh temporary Chromium window is open.':'Open the private remote desktop on port 6080.'} Sign in on IITB's official website with your username, password, CAPTCHA and phone OTP, and select Remember me. Return here once placement posts appear.</p><form action="/save-login" method="post"><input type="hidden" name="token" value="${token}"><button>Save login</button></form>`;
    if(!opened) content='<p>The official login window is opening. Reload this page in a moment.</p>';
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IITB login setup</title><style>body{font:18px/1.6 system-ui;background:#f3f6fc;color:#123;margin:50px auto;max-width:680px;padding:20px}button{background:#2563eb;color:white;padding:14px 22px;border:0;border-radius:10px;font:inherit}label{display:block;margin:20px 0}input:not([type=hidden]){display:block;width:95%;font:inherit;padding:10px;border:1px solid #abc;border-radius:8px}</style><h1>Save your official IITB login</h1>${content}<p>${message}</p><p>This saves only the restricted new IITB session. Passwords, OTPs and browser local storage are not exported. ${local?'You can close this page after saving.':'Stop the Codespace after saving.'}</p></html>`;
}
function reply(response,body,status=200) {
  if(response.headersSent || response.writableEnded)return;
  response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});response.end(body);
}
async function requestBody(request) {
  let body='',size=0;
  for await (const part of request) {size+=part.length;if(size>8192)throw new PolicyError('INVALID_CONTROL_REQUEST');body+=part.toString();}
  return new URLSearchParams(body);
}
function validToken(fields,token,names) {
  const supplied=fields.get('token') || '';
  return fields.getAll('token').length===1 && [...fields.keys()].every(name=>names.includes(name) && fields.getAll(name).length===1) &&
    /^[a-f\d]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
}
export async function startLoginHelper({env=process.env,mode='codespace',browserType=chromium,call=bridgeCall,listenPort=3000,verifyPorts=assertPrivatePorts}={}) {
  if(!['codespace','local'].includes(mode) || !Number.isInteger(listenPort) || listenPort<0 || listenPort>65535)throw new PolicyError('INVALID_HELPER_MODE');
  if(mode==='codespace') {
    if (env.CODESPACES!=='true' || !env.CODESPACE_NAME || !env.DISPLAY) throw new PolicyError('PRIVATE_CODESPACE_DESKTOP_REQUIRED');
    await verifyPorts(env);
  }
  sourceConfig(env);
  let config=(env.IITB_BRIDGE_URL || env.IITB_HMAC_SECRET || mode==='codespace')?bridgeConfig(env):null;
  let browser=null,context=null,page=null,server,port=listenPort,opened=false,saved=false,busy=false,closed=false,expiryTimer,privatePortTimer,completionTimer;
  const token=randomBytes(32).toString('hex');
  const view=message=>html(token,{mode,configured:!!config,opened,saved,message});
  const shutdown=()=>{
    if(closed)return;closed=true;config=null;
    clearTimeout(expiryTimer);clearInterval(privatePortTimer);clearTimeout(completionTimer);
    process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);
    server?.close();browser?.close().catch(()=>{});
  };
  async function openOfficialLogin() {
    // Always use Playwright's bundled Chromium and a fresh in-memory context.
    // No channel, persistent profile, existing storage state or local browser API is used.
    browser=await browserType.launch({headless:false,args:['--disable-breakpad','--disable-crash-reporter']});
    try {
      if(closed)throw new PolicyError('HELPER_EXPIRED');
      context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
      await installNetworkPolicy(context,{interactiveLogin:true});
      page=await context.newPage();await page.goto(BLOG,{waitUntil:'domcontentloaded',timeout:45000});
      if(closed)throw new PolicyError('HELPER_EXPIRED');opened=true;
    } catch(error) {await browser.close().catch(()=>{});browser=null;context=null;page=null;throw error;}
  }
  server=http.createServer(async(request,response)=>{
    try {
      const host=String(request.headers.host || ''),localHosts=['127.0.0.1:'+port,'localhost:'+port];
      const hosted=mode==='codespace' && host===env.CODESPACE_NAME+'-3000.app.github.dev';
      if(!localHosts.includes(host) && !hosted){reply(response,'Request rejected.',403);return;}
      if (request.method==='GET' && request.url==='/') {reply(response,view(''));return;}
      if (request.method!=='POST' || !['/configure','/save-login'].includes(request.url) || !allowedControlOrigin(request.headers.origin,env,mode,port) ||
        !String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {reply(response,'Request rejected.',403);return;}
      const fields=await requestBody(request),configure=request.url==='/configure';
      if (!validToken(fields,token,configure?['token','bridge_url','bridge_secret']:['token']) || busy || saved || closed || (configure && (mode!=='local' || config || opened))) {reply(response,'Request rejected.',403);return;}
      busy=true;
      if(configure) {
        const proposed=bridgeConfig({IITB_BRIDGE_URL:fields.get('bridge_url'),IITB_HMAC_SECRET:fields.get('bridge_secret')});
        await call(proposed,'status',{});
        if(closed)throw new PolicyError('HELPER_EXPIRED');
        await openOfficialLogin();config=proposed;
        reply(response,view('Official IITB login is open in the temporary browser.'));return;
      }
      if(!config || !opened || !page || !context)throw new PolicyError('OFFICIAL_LOGIN_REQUIRED');
      if(mode==='codespace')await verifyPorts(env);
      const verify=await page.goto(BLOG,{waitUntil:'domcontentloaded',timeout:45000});
      if (!verify?.ok() || !listingUrl(page.url())) throw new PolicyError('IITB_RECONNECT_REQUIRED');
      const listing=await page.evaluate(capturePage,{sourceUrl:page.url()});
      if (!listing.posts.length) throw new PolicyError('IITB_RECONNECT_REQUIRED');
      const session=filterSession(await context.storageState());
      await call(config,'save_session',{source_url:BLOG,session,verified_at:new Date().toISOString()});
      saved=true;config=null;reply(response,view('Login saved. Ongoing checks run in Google Apps Script.'));
      clearInterval(privatePortTimer);await browser.close().catch(()=>{});
      if(mode==='local'){completionTimer=setTimeout(shutdown,10000);completionTimer.unref();}
    } catch {reply(response,view('Setup could not be completed. Check the Google bridge details, or complete the official IITB sign-in and try again.'),400);}
    finally {busy=false;}
  });
  server.requestTimeout=30000;server.headersTimeout=30000;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,'127.0.0.1',()=>{server.removeListener('error',reject);port=server.address().port;resolve();});});
    expiryTimer=setTimeout(shutdown,30*60*1000);expiryTimer.unref();
    if(mode==='codespace'){privatePortTimer=setInterval(()=>verifyPorts(env).catch(shutdown),60000);privatePortTimer.unref();}
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
    if(config)await openOfficialLogin();
    return {server,get browser(){return browser;},shutdown,control_url:'http://127.0.0.1:'+port+'/'};
  } catch(error) {shutdown();throw error;}
}
if (import.meta.url===new URL(process.argv[1] || '', 'file:').href) {
  const mode=process.argv.slice(2).length===1 && process.argv[2]==='--local'?'local':process.argv.length===2?'codespace':null;
  startLoginHelper({mode}).then(helper=>console.log(mode==='local'?'Open '+helper.control_url+' for this one-time setup. IITB login uses a fresh temporary Chromium window.':'Official IITB login is open in the private remote desktop. Use port 3000 to save after sign-in.'))
    .catch(error=>{console.error(error instanceof PolicyError?error.code:'LOGIN_HELPER_FAILED');process.exitCode=1;});
}
