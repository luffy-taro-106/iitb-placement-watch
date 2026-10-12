import {ConnectorError} from './core.mjs';
export function createGoogleTransport(frame) {
  const ready=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new ConnectorError('BRIDGE_UNAVAILABLE')),10000);
    const finish=()=>{clearTimeout(timeout);resolve();};
    if (frame.contentDocument?.readyState==='complete' && frame.contentDocument.URL===new URL('google-transport.html',import.meta.url).href) finish();
    else {frame.addEventListener('load',finish,{once:true});frame.addEventListener('error',()=>{clearTimeout(timeout);reject(new ConnectorError('BRIDGE_UNAVAILABLE'));},{once:true});}
  });
  return {ready,fetch:async(url,options)=>{
    await ready;
    return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const timeoutMs=options.timeoutMs || 90000;
      const fail=()=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',fail);channel.port1.close();reject(new ConnectorError('BRIDGE_UNAVAILABLE'));};
      const timeout=setTimeout(fail,timeoutMs);
      options.signal?.addEventListener('abort',fail,{once:true});
      if (options.signal?.aborted) {fail();return;}
      channel.port1.onmessage=event=>{
        clearTimeout(timeout);channel.port1.close();
        options.signal?.removeEventListener('abort',fail);
        const response=event.data;
        if (!response?.ok || typeof response.text!=='string' || response.text.length>16384) {reject(new ConnectorError('BRIDGE_UNAVAILABLE'));return;}
        const bytes=new TextEncoder().encode(response.text);
        resolve({ok:true,status:response.status,url:response.url,headers:new Headers({'content-length':String(bytes.byteLength)}),
          body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})});
      };
      // The fixed frame is an extension-owned, non-web-accessible page. No content script or external listener exists.
      frame.contentWindow.postMessage({type:'placement-google-request',url,body:options.body,timeout_ms:timeoutMs},location.origin,[channel.port2]);
    });
  }};
}
