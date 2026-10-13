import {createHmac,randomBytes} from 'node:crypto';
import {PolicyError} from './policy.mjs';
const ACTIONS=new Set(['get_session','save_session','install_monitor','ingest_snapshot','status','connection_diagnostics','configure_notifications','resend_announcement','configure_whatsapp','whatsapp_status']);
export function bridgeConfig(env=process.env) {
  let url;try {url=new URL(env.IITB_BRIDGE_URL);}catch {throw new PolicyError('BRIDGE_CONFIGURATION_REQUIRED');}
  if (url.origin!=='https://script.google.com' || !/^\/macros\/s\/[a-z\d_-]+\/exec$/i.test(url.pathname) || url.username || url.password || url.search || url.hash ||
    typeof env.IITB_HMAC_SECRET!=='string' || env.IITB_HMAC_SECRET.length<32 || env.IITB_HMAC_SECRET.length>256) throw new PolicyError('INVALID_BRIDGE_CONFIGURATION');
  return {url:url.href,secret:env.IITB_HMAC_SECRET};
}
export function canonical(action,nonce,issued_at,payload) {
  if (!ACTIONS.has(action) || !/^[a-f\d]{32}$/.test(nonce) || !Number.isSafeInteger(issued_at) || !payload || typeof payload!=='object' || Array.isArray(payload)) throw new PolicyError('INVALID_BRIDGE_REQUEST');
  return JSON.stringify([action,nonce,issued_at,payload]);
}
export function signedRequest(action,payload,secret,{nonce=randomBytes(16).toString('hex'),issued_at=Math.floor(Date.now()/1000)}={}) {
  const signature=createHmac('sha256',secret).update(canonical(action,nonce,issued_at,payload),'utf8').digest('hex');
  return {action,nonce,issued_at,payload,signature};
}
export async function bridgeCall(config,action,payload={},fetchImpl=fetch) {
  const body=JSON.stringify(signedRequest(action,payload,config.secret));
  if (Buffer.byteLength(body,'utf8')>1500000) throw new PolicyError('BRIDGE_PAYLOAD_TOO_LARGE');
  let response;const signal=AbortSignal.timeout(90000);
  try {
    response=await fetchImpl(config.url,{method:'POST',headers:{'content-type':'application/json'},body,redirect:'manual',signal});
    for(let count=0;[301,302,303].includes(response.status);count++) {
      if(count>=3)throw new PolicyError('INVALID_BRIDGE_REDIRECT');
      const location=new URL(response.headers.get('location'));
      if(location.origin!=='https://script.googleusercontent.com'||location.username||location.password)throw new PolicyError('INVALID_BRIDGE_REDIRECT');
      await response.body?.cancel();
      response=await fetchImpl(location.href,{method:'GET',redirect:'manual',signal});
    }
    if([307,308].includes(response.status))throw new PolicyError('INVALID_BRIDGE_REDIRECT');
  }
  catch {throw new PolicyError('BRIDGE_UNREACHABLE');}
  let result;
  try {
    if (!response.body) throw new Error();
    const reader=response.body.getReader(),parts=[];let size=0;
    try {
      for (;;) {
        const chunk=await reader.read();if(chunk.done)break;
        size+=chunk.value.byteLength;
        if(size>1500000){await reader.cancel();throw new Error();}
        parts.push(chunk.value);
      }
    } finally {reader.releaseLock();}
    result=JSON.parse(Buffer.concat(parts,size).toString('utf8'));
  }
  catch {throw new PolicyError('INVALID_BRIDGE_RESPONSE');}
  if (!response.ok || result?.ok!==true) throw new PolicyError('BRIDGE_REQUEST_REJECTED');
  return result;
}
