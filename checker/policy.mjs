export const BLOG = 'https://campus.placements.iitb.ac.in/blog/placement/';
export const SSO = 'https://sso.iitb.ac.in';
const CAMPUS = new URL(BLOG).origin;
const COOKIE_DOMAINS = new Set(['campus.placements.iitb.ac.in','.campus.placements.iitb.ac.in','sso.iitb.ac.in','.sso.iitb.ac.in','.iitb.ac.in']);

export class PolicyError extends Error {
  constructor(code) {super(code);this.code=code;}
}
export function sourceConfig(env=process.env) {
  const blog=env.IITB_BLOG_URL || BLOG, sso=env.IITB_SSO_ORIGIN || SSO;
  if (blog!==BLOG || sso!==SSO) throw new PolicyError('UNSUPPORTED_SOURCE_CONFIGURATION');
  return {blog,sso};
}
export function allowedSourceUrl(value) {
  let url;try {url=new URL(value);}catch {return false;}
  return url.protocol==='https:' && !url.username && !url.password && [CAMPUS,SSO].includes(url.origin);
}
export function listingUrl(value) {
  if (!allowedSourceUrl(value)) return false;
  const url=new URL(value),base=new URL(BLOG);
  if (url.origin!==base.origin || url.pathname!==base.pathname || url.hash) return false;
  const query=[...url.searchParams];
  return query.length===0 || (query.length===1 && query[0][0]==='paged' && /^[1-9]\d{0,3}$/.test(query[0][1]));
}
export function filterSession(state,now=Date.now()) {
  if (!state || !Array.isArray(state.cookies) || state.cookies.length>128) throw new PolicyError('INVALID_SESSION');
  const cookies=[];
  for (const cookie of state.cookies) {
    if (cookie?.domain?.toLowerCase?.()==='iitb.ac.in') throw new PolicyError('INVALID_SESSION');
    if (cookie?.secure===false) continue;
    if (!cookie || typeof cookie.domain!=='string' || !COOKIE_DOMAINS.has(cookie.domain.toLowerCase())) continue;
    if (typeof cookie.name!=='string' || !cookie.name || cookie.name.length>256 || /[\s;=\u0000-\u001f\u007f]/.test(cookie.name) ||
      typeof cookie.value!=='string' || cookie.value.length>8192 || /[\u0000-\u001f\u007f;]/.test(cookie.value) ||
      typeof cookie.path!=='string' || !cookie.path.startsWith('/') || cookie.path.length>1024 || /[\u0000-\u001f\u007f]/.test(cookie.path) ||
      !Number.isFinite(cookie.expires) || typeof cookie.secure!=='boolean' || typeof cookie.httpOnly!=='boolean' ||
      !['Strict','Lax','None'].includes(cookie.sameSite)) throw new PolicyError('INVALID_SESSION');
    if (cookie.expires!==-1 && cookie.expires*1000<=now) continue;
    cookies.push({name:cookie.name,value:cookie.value,domain:cookie.domain.toLowerCase(),path:cookie.path,expires:cookie.expires,
      httpOnly:cookie.httpOnly,secure:cookie.secure,sameSite:cookie.sameSite});
  }
  if (!cookies.length) throw new PolicyError('SESSION_REQUIRED');
  return {cookies,origins:[]};
}
export function normalizedText(value,limit,required=true) {
  if (typeof value!=='string' || value.length>limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new PolicyError('INVALID_SOURCE_TEXT');
  const text=value.replace(/\s+/g,' ').trim();
  if (required && !text) throw new PolicyError('EMPTY_SOURCE_TEXT');
  return text;
}
export function safeLink(value) {
  if (typeof value!=='string' || value.length>4096 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new PolicyError('INVALID_SOURCE_LINK');
  let url;try {url=new URL(value);}catch {throw new PolicyError('INVALID_SOURCE_LINK');}
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new PolicyError('UNSAFE_SOURCE_LINK');
  return url.href;
}
export function validIso(value) {
  const match=typeof value==='string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  const time=Date.parse(value);
  if (!match || !Number.isFinite(time)) throw new PolicyError('INVALID_SOURCE_TIME');
  const offset=match[8]==='Z'?0:(match[9]==='-'?-1:1)*(Number(match[10])*60+Number(match[11]));
  const local=new Date(time+offset*60000);
  if (local.getUTCFullYear()!==Number(match[1]) || local.getUTCMonth()+1!==Number(match[2]) || local.getUTCDate()!==Number(match[3]) ||
    local.getUTCHours()!==Number(match[4]) || local.getUTCMinutes()!==Number(match[5]) || local.getUTCSeconds()!==Number(match[6])) throw new PolicyError('INVALID_SOURCE_TIME');
  return time;
}
export function normalizePosts(posts) {
  if (!Array.isArray(posts) || !posts.length || posts.length>500) throw new PolicyError('INCOMPLETE_SOURCE');
  const ids=new Set();
  return posts.map(post=>{
    if (!post || typeof post.id!=='string' || !/^post-[1-9]\d{0,14}$/.test(post.id) || ids.has(post.id)) throw new PolicyError('INVALID_SOURCE_POST_ID');
    ids.add(post.id);
    const url=new URL(safeLink(post.url)),base=new URL(BLOG);
    if (url.origin!==base.origin || url.pathname!==base.pathname || url.hash || [...url.searchParams].length!==1 || url.searchParams.get('p')!==post.id.slice(5)) throw new PolicyError('SOURCE_POST_URL_MISMATCH');
    validIso(post.published);
    if (!Array.isArray(post.links) || post.links.length>100) throw new PolicyError('INVALID_SOURCE_LINKS');
    return {id:post.id,title:normalizedText(post.title,1000),url:url.href,published:post.published,text:normalizedText(post.text,64000),
      links:post.links.map(link=>({text:normalizedText(link?.text,1000,false),url:safeLink(link?.url)}))};
  });
}
