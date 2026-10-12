import {boundedText,finalBridgeUrl,ConnectorError} from './core.mjs';
const encoder=new TextEncoder();
export function validTransportRequest(url,body) {
  try {
    const target=new URL(url);
    if (target.origin!=='https://script.google.com' || !/^\/macros\/s\/[a-z\d_-]+\/exec$/i.test(target.pathname) || target.username || target.password || target.search || target.hash ||
        typeof body!=='string' || encoder.encode(body).byteLength>1500000) return false;
    const request=JSON.parse(body);
    return request && ['status','save_session'].includes(request.action) && /^[a-f\d]{32}$/.test(request.nonce) && Number.isSafeInteger(request.issued_at) &&
      request.payload && typeof request.payload==='object' && !Array.isArray(request.payload) && /^[a-f\d]{64}$/.test(request.signature);
  } catch { return false; }
}
export async function googleFetch(url,body,fetchImpl=globalThis.fetch) {
  if (!validTransportRequest(url,body)) throw new ConnectorError('BRIDGE_UNAVAILABLE');
  try {
    // google-transport.html adds a Google-only CSP: a redirected POST cannot be sent to IITB or any other origin.
    const response=await fetchImpl(url,{
      method:'POST',headers:{'content-type':'application/json'},body,credentials:'omit',redirect:'follow',cache:'no-store',
      referrerPolicy:'no-referrer',signal:AbortSignal.timeout(90000)
    });
    if (!response.ok || !finalBridgeUrl(response.url,url)) throw new ConnectorError('BRIDGE_UNAVAILABLE');
    return {status:response.status,url:response.url,text:await boundedText(response,1500000,'BRIDGE_UNAVAILABLE')};
  } catch { throw new ConnectorError('BRIDGE_UNAVAILABLE'); }
}
