import {googleFetch} from './google-fetch.mjs';
window.addEventListener('message',async event=>{
  if (event.source!==window.parent || event.origin!==location.origin || event.data?.type!=='placement-google-request' || event.ports.length!==1) return;
  const port=event.ports[0];let request=event.data;
  try { port.postMessage({ok:true,...await googleFetch(request.url,request.body,globalThis.fetch,{timeoutMs:request.timeout_ms})}); }
  catch { port.postMessage({ok:false}); }
  finally { request.body='';request=null;port.close(); }
});
