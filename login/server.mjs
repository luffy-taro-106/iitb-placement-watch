import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {bridgeCall,bridgeConfig} from '../checker/bridge.mjs';
import {BLOG,filterSession,listingUrl,sourceConfig,PolicyError} from '../checker/policy.mjs';
import {capturePage,installNetworkPolicy} from '../checker/extract.mjs';

export function allowedControlOrigin(origin,env=process.env) {
  const allowed=new Set(['http://127.0.0.1:3000','http://localhost:3000']);
  if (env.CODESPACE_NAME && /^[a-z\d-]+$/i.test(env.CODESPACE_NAME)) {
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
function html(token,message='') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IITB login setup</title><style>body{font:18px/1.6 system-ui;background:#f3f6fc;color:#123;margin:50px auto;max-width:680px;padding:20px}button{background:#2563eb;color:white;padding:14px 22px;border:0;border-radius:10px;font:inherit}</style><h1>Save your official IITB login</h1><p>Open the private remote desktop on port 6080. Sign in on IITB's official website with your username, password, CAPTCHA and phone OTP, and select Remember me. Return here once placement posts appear.</p><form action="/save-login" method="post"><input type="hidden" name="token" value="${token}"><button>Save login</button></form><p>${message}</p><p>This button saves only the restricted hosted IITB session to your private Google bridge. Your password and OTP are not copied. Stop the Codespace after saving.</p></html>`;
}
function reply(response,body,status=200) {
  response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});response.end(body);
}
async function requestBody(request) {
  let body='';for await (const part of request) {body+=part.toString();if(body.length>4096)throw new PolicyError('INVALID_CONTROL_REQUEST');}return new URLSearchParams(body);
}
export async function startLoginHelper({env=process.env,browserType=chromium,call=bridgeCall}={}) {
  if (env.CODESPACES!=='true' || !env.CODESPACE_NAME || !env.DISPLAY) throw new PolicyError('PRIVATE_CODESPACE_DESKTOP_REQUIRED');
  await assertPrivatePorts(env);
  sourceConfig(env);const config=bridgeConfig(env);
  const browser=await browserType.launch({headless:false,args:['--disable-breakpad','--disable-crash-reporter']});
  try {
  const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
  await installNetworkPolicy(context,{interactiveLogin:true});
  const page=await context.newPage();await page.goto(BLOG,{waitUntil:'domcontentloaded',timeout:45000});
  const token=randomBytes(32).toString('hex');let saved=false,busy=false;
  const server=http.createServer(async(request,response)=>{
    try {
      if (request.method==='GET' && request.url==='/') {reply(response,html(token,saved?'Login saved. Stop this Codespace now.':''));return;}
      if (request.method!=='POST' || request.url!=='/save-login' || !allowedControlOrigin(request.headers.origin,env) ||
        !String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {reply(response,'Request rejected.',403);return;}
      const supplied=(await requestBody(request)).get('token') || '';
      if (!/^[a-f\d]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token)) || busy || saved) {reply(response,'Request rejected.',403);return;}
      busy=true;
      await assertPrivatePorts(env);
      const verify=await page.goto(BLOG,{waitUntil:'domcontentloaded',timeout:45000});
      if (!verify?.ok() || !listingUrl(page.url())) throw new PolicyError('IITB_RECONNECT_REQUIRED');
      const listing=await page.evaluate(capturePage,{sourceUrl:page.url()});
      if (!listing.posts.length) throw new PolicyError('IITB_RECONNECT_REQUIRED');
      const session=filterSession(await context.storageState());
      await call(config,'save_session',{source_url:BLOG,session,verified_at:new Date().toISOString()});
      saved=true;reply(response,html(token,'Login saved to your private Google bridge. Stop this Codespace now.'));
      await browser.close().catch(()=>{});
    } catch {reply(response,html(token,'Login could not be saved. Complete the official IITB sign-in and try again.'),400);}
    finally {busy=false;}
  });
  server.requestTimeout=30000;server.headersTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3000,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  let expiryTimer,privatePortTimer;
  const shutdown=()=>{clearTimeout(expiryTimer);clearInterval(privatePortTimer);server.close();browser.close().catch(()=>{});};
  expiryTimer=setTimeout(shutdown,30*60*1000);
  privatePortTimer=setInterval(()=>assertPrivatePorts(env).catch(shutdown),60000);
  expiryTimer.unref();privatePortTimer.unref();
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  return {server,browser,shutdown};
  } catch(error) {await browser.close().catch(()=>{});throw error;}
}
if (import.meta.url===new URL(process.argv[1] || '', 'file:').href) {
  startLoginHelper().then(()=>console.log('Official IITB login is open in the private remote desktop. Use port 3000 to save after sign-in.'))
    .catch(error=>{console.error(error instanceof PolicyError?error.code:'LOGIN_HELPER_FAILED');process.exitCode=1;});
}
