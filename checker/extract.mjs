import {BLOG,listingUrl,normalizePosts,PolicyError} from './policy.mjs';

// This function runs against the current official page DOM, with no external requests or clicks.
export function capturePage({sourceUrl=BLOG}={}) {
  const text=value=>(value || '').replace(/\s+/g,' ').trim();
  const posts=[];
  for (const article of document.querySelectorAll('article[id]')) {
    if (!/^post-[1-9]\d{0,14}$/.test(article.id)) continue;
    const links=[];
    for (const anchor of article.querySelectorAll('a[href]')) {
      try {const url=new URL(anchor.getAttribute('href'),sourceUrl);
        if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) links.push({text:text(anchor.textContent),url:url.href});
      } catch {}
    }
    const permalink=links.find(link=>{const url=new URL(link.url),base=new URL(sourceUrl);return url.origin===base.origin&&url.pathname===base.pathname&&url.searchParams.get('p')===article.id.slice(5);});
    const clone=article.cloneNode(true);for (const item of clone.querySelectorAll('script,style')) item.remove();
    posts.push({id:article.id,title:text(article.querySelector('h1,h2,h3')?.textContent),url:permalink?.url || '',
      published:article.querySelector('time[datetime]')?.getAttribute('datetime') || '',text:text(clone.textContent),links});
  }
  let next=null;
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!anchor.classList.contains('next') && text(anchor.textContent).toLowerCase()!=='next page') continue;
    try {next=new URL(anchor.getAttribute('href'),sourceUrl).href;} catch {}
    if (next) break;
  }
  return {posts,next};
}
export async function installNetworkPolicy(context,{interactiveLogin=false}={}) {
  await context.route('**/*',async route=>{
    const request=route.request();let url;try {url=new URL(request.url());}catch {await route.abort('blockedbyclient');return;}
    const allowed=url.protocol==='https:' && !url.username && !url.password && ['https://campus.placements.iitb.ac.in','https://sso.iitb.ac.in'].includes(url.origin);
    const readOnly=['GET','HEAD'].includes(request.method());
    if (!allowed || (!readOnly && !(interactiveLogin && url.origin==='https://sso.iitb.ac.in'))) await route.abort('blockedbyclient');
    else await route.continue();
  });
}
export async function collectSnapshot(page,{lastSuccessfulCheck=null,now=Date.now(),maxPages=25}={}) {
  const oldLimit=now-30*86400000,previous=Date.parse(lastSuccessfulCheck);
  const threshold=Number.isFinite(previous)?Math.min(oldLimit,previous):oldLimit;
  const visited=new Set(),posts=new Map();let url=BLOG;
  for (let count=0;url&&count<maxPages;count++) {
    if (!listingUrl(url) || visited.has(url)) throw new PolicyError('INVALID_SOURCE_PAGINATION');
    visited.add(url);
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    if (!response?.ok() || !listingUrl(page.url())) throw new PolicyError('IITB_RECONNECT_REQUIRED');
    try {await page.locator('article[id^="post-"]').first().waitFor({state:'attached',timeout:10000});}
    catch {throw new PolicyError('IITB_RECONNECT_REQUIRED');}
    const listing=await page.evaluate(capturePage,{sourceUrl:page.url()});
    const normalized=normalizePosts(listing.posts);
    for (const post of normalized) {
      if (posts.has(post.id) && JSON.stringify(posts.get(post.id))!==JSON.stringify(post)) throw new PolicyError('SOURCE_CHANGED_DURING_READ');
      posts.set(post.id,post);
    }
    if (posts.size>500) throw new PolicyError('SOURCE_TOO_LARGE');
    if (listing.next && !listingUrl(listing.next)) throw new PolicyError('INVALID_SOURCE_PAGINATION');
    const oldest=Math.min(...normalized.map(post=>Date.parse(post.published)));
    url=oldest<=threshold?null:listing.next;
  }
  if (url) throw new PolicyError('INCOMPLETE_SOURCE');
  if (!posts.size) throw new PolicyError('INCOMPLETE_SOURCE');
  return {source_url:BLOG,posts:[...posts.values()],complete:true,observed_at:new Date(now).toISOString()};
}
