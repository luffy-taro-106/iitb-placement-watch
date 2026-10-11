/* Read the placement blog using only the session created in the hosted setup browser. */
var PLACEMENT_SOURCE_BLOG_ = 'https://campus.placements.iitb.ac.in/blog/placement/';
var PLACEMENT_SOURCE_HOSTS_ = ['campus.placements.iitb.ac.in', 'sso.iitb.ac.in'];
var PLACEMENT_SOURCE_UA_ = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
var PLACEMENT_SOURCE_ACCEPT_ = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
var PLACEMENT_SOURCE_MAX_BYTES_ = 1500000;
var PLACEMENT_SOURCE_TIME_MS_ = 5 * 60 * 1000;

function placementReconnectError_() {
  return new Error('IITB connection needs reconnection. Sign in again on the official IITB page in the hosted setup browser.');
}

function placementByteLength_(value) {
  var length = 0;
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    if (code < 128) length++;
    else if (code < 2048) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

/* Apps Script V8 does not provide the browser URL API. Resolve only HTTP(S) URLs here. */
function placementUrl_(value, base, officialOnly) {
  if (typeof value !== 'string' || !value || value.length > 12000 || /[\\\s\x00-\x1f\x7f]/.test(value)) throw new Error('The placement source returned an unsupported URL.');
  var absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (!absolute) {
    var parent = placementUrl_(base || PLACEMENT_SOURCE_BLOG_, null, false);
    if (value.indexOf('//') === 0) value = parent.protocol + ':' + value;
    else if (value.charAt(0) === '/') value = parent.origin + value;
    else if (value.charAt(0) === '?') value = parent.origin + parent.path + value;
    else if (value.charAt(0) === '#') value = parent.origin + parent.path + parent.query + value;
    else value = parent.origin + parent.path.slice(0, parent.path.lastIndexOf('/') + 1) + value;
  }
  var match = value.match(/^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i);
  if (!match || match[2].indexOf('@') !== -1) throw new Error('The placement source returned an unsupported URL.');
  var protocol = match[1].toLowerCase(), authority = match[2].toLowerCase();
  if (protocol === 'https') authority = authority.replace(/:443$/, '');
  if (protocol === 'http') authority = authority.replace(/:80$/, '');
  var pathParts = (match[3] || '/').split('/'), normalized = [];
  for (var i = 0; i < pathParts.length; i++) {
    if (pathParts[i] === '.') continue;
    if (pathParts[i] === '..') { if (normalized.length > 1) normalized.pop(); continue; }
    normalized.push(pathParts[i]);
  }
  var path = normalized.join('/') || '/', query = match[4] || '';
  if (path.charAt(0) !== '/') path = '/' + path;
  var origin = protocol + '://' + authority;
  if (officialOnly && (protocol !== 'https' || PLACEMENT_SOURCE_HOSTS_.indexOf(authority) === -1)) throw new Error('IITB returned a destination outside its supported official login hosts.');
  return {protocol:protocol, host:authority, origin:origin, path:path, query:query, href:origin + path + query};
}

function placementHeader_(headers, name) {
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name.toLowerCase()) return headers[keys[i]];
  return null;
}

function placementCookieDomain_(domain) {
  if (typeof domain !== 'string') return null;
  if (domain.toLowerCase() === '.iitb.ac.in') return 'iitb.ac.in';
  var normalized = domain.toLowerCase().replace(/^\./, '');
  return PLACEMENT_SOURCE_HOSTS_.indexOf(normalized) === -1 ? null : normalized;
}

function placementSessionCookies_(session) {
  if (!session || !Array.isArray(session.cookies) || !session.cookies.length || session.cookies.length > 64) throw placementReconnectError_();
  var now = Date.now() / 1000;
  var cookies = session.cookies.map(function(cookie) {
    if (!cookie || !placementCookieDomain_(cookie.domain) || typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~a-z\d-]{1,256}$/i.test(cookie.name) ||
        typeof cookie.value !== 'string' || cookie.value.length > 4096 || /[\x00-\x20\x7f;,]/.test(cookie.value) ||
        typeof cookie.path !== 'string' || cookie.path.charAt(0) !== '/' || /[\x00-\x20\x7f;]/.test(cookie.path) ||
        typeof cookie.expires !== 'number' || !isFinite(cookie.expires) || cookie.secure !== true || typeof cookie.httpOnly !== 'boolean') throw new Error('The stored IITB session is not valid. Reconnect in the hosted setup browser.');
    return {name:cookie.name, value:cookie.value, domain:cookie.domain.toLowerCase(), path:cookie.path, expires:cookie.expires,
      secure:cookie.secure, httpOnly:cookie.httpOnly, sameSite:['Strict','Lax','None'].indexOf(cookie.sameSite) === -1 ? 'Lax' : cookie.sameSite};
  }).filter(function(cookie) { return cookie.expires === -1 || cookie.expires > now; });
  if (!cookies.length) throw placementReconnectError_();
  return cookies;
}

function placementCookieHeader_(cookies, target) {
  var now = Date.now() / 1000;
  return cookies.filter(function(cookie) {
    var pathMatches = target.path === cookie.path || (target.path.indexOf(cookie.path) === 0 && (cookie.path.slice(-1) === '/' || target.path.charAt(cookie.path.length) === '/'));
    var domain = placementCookieDomain_(cookie.domain), domainMatches = domain === target.host || (cookie.domain === '.iitb.ac.in' && PLACEMENT_SOURCE_HOSTS_.indexOf(target.host) !== -1);
    return domainMatches && pathMatches && (cookie.expires === -1 || cookie.expires > now) && (!cookie.secure || target.protocol === 'https');
  }).sort(function(a,b) {return b.path.length - a.path.length;}).map(function(cookie) { return cookie.name + '=' + cookie.value; }).join('; ');
}

function placementSetCookies_(cookies, headers, target) {
  var header = placementHeader_(headers, 'set-cookie');
  var values = header === null ? [] : Array.isArray(header) ? header : [header];
  values.forEach(function(combined) {
    if (typeof combined !== 'string' || /[\r\n]/.test(combined)) return;
    combined.split(/,(?=\s*[!#$%&'*+.^_`|~a-z\d-]+=)/i).forEach(function(value) {
      var parts = value.split(';'), pair = parts.shift(), equal = pair.indexOf('=');
      if (equal <= 0) return;
      var name = pair.slice(0,equal).trim(), content = pair.slice(equal + 1).trim();
      if (!/^[!#$%&'*+.^_`|~a-z\d-]{1,256}$/i.test(name) || content.length > 4096 || /[\x00-\x20\x7f;,]/.test(content)) return;
      var cookie = {name:name, value:content, domain:target.host, path:target.path.slice(0,target.path.lastIndexOf('/')) || '/', expires:-1, secure:false, httpOnly:false, sameSite:'Lax'};
      var maxAge = null, domainSpecified = false;
      parts.forEach(function(part) {
        var at = part.indexOf('='), key = (at < 0 ? part : part.slice(0,at)).trim().toLowerCase(), entry = at < 0 ? '' : part.slice(at + 1).trim();
        if (key === 'domain') { cookie.domain = '.' + entry.toLowerCase().replace(/^\./,''); domainSpecified = true; }
        else if (key === 'path' && entry.charAt(0) === '/' && !/[\x00-\x20\x7f;]/.test(entry)) cookie.path = entry;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'expires' && isFinite(Date.parse(entry))) cookie.expires = Date.parse(entry) / 1000;
        else if (key === 'max-age' && /^-?\d+$/.test(entry)) maxAge = Number(entry);
        else if (key === 'samesite' && /^(Strict|Lax|None)$/i.test(entry)) cookie.sameSite = entry.charAt(0).toUpperCase() + entry.slice(1).toLowerCase();
      });
      if (!cookie.secure || (!placementCookieDomain_(cookie.domain)) || (placementCookieDomain_(cookie.domain) !== target.host && cookie.domain !== '.iitb.ac.in')) return;
      if (name.indexOf('__Secure-') === 0 && !cookie.secure) return;
      if (name.indexOf('__Host-') === 0 && (!cookie.secure || domainSpecified || cookie.path !== '/')) return;
      if (maxAge !== null) cookie.expires = Date.now() / 1000 + maxAge;
      var index = cookies.findIndex(function(prior) {return prior.name === cookie.name && placementCookieDomain_(prior.domain) === placementCookieDomain_(cookie.domain) && prior.path === cookie.path;});
      if (index >= 0) cookies.splice(index,1);
      if (cookie.expires === -1 || cookie.expires > Date.now() / 1000) cookies.push(cookie);
    });
  });
  if (cookies.length > 64) throw new Error('IITB returned too many session cookies. Reconnect in the hosted setup browser.');
}

function placementCheckTime_(startedAt) {
  if (Date.now() - startedAt > PLACEMENT_SOURCE_TIME_MS_) throw new Error('The placement read exceeded its time limit. Previous posts and successful-check time were preserved.');
}

function placementFetch_(url, cookies, startedAt) {
  var next = placementUrl_(url, PLACEMENT_SOURCE_BLOG_, true), visited = {};
  for (var redirects = 0; redirects <= 12; redirects++) {
    placementCheckTime_(startedAt);
    if (next.host === 'sso.iitb.ac.in' && next.path === '/login') throw placementReconnectError_();
    var headers = {'User-Agent':PLACEMENT_SOURCE_UA_, 'Accept':PLACEMENT_SOURCE_ACCEPT_, 'Accept-Language':'en-US,en;q=0.9',
      'Sec-Fetch-Mode':'navigate', 'Sec-Fetch-Dest':'document'};
    var cookieHeader = placementCookieHeader_(cookies,next);
    var requestIdentity = next.href + '|' + cookieHeader;
    if (visited[requestIdentity]) throw new Error('IITB sign-in redirects repeated. Reconnect in the hosted setup browser.');
    visited[requestIdentity] = true;
    if (cookieHeader) headers.Cookie = cookieHeader;
    var response;
    try { response = UrlFetchApp.fetch(next.href,{method:'get',headers:headers,followRedirects:false,muteHttpExceptions:true,validateHttpsCertificates:true}); }
    catch (error) { throw new Error('IITB could not be reached. Previous posts and successful-check time were preserved.'); }
    placementCheckTime_(startedAt);
    var status = response.getResponseCode(), responseHeaders = response.getAllHeaders();
    placementSetCookies_(cookies,responseHeaders,next);
    if ([301,302,303,307,308].indexOf(status) !== -1) {
      if (redirects === 12) throw new Error('IITB returned too many sign-in redirects. Reconnect in the hosted setup browser.');
      var location = placementHeader_(responseHeaders,'location');
      if (Array.isArray(location)) location = location[0];
      if (typeof location !== 'string' || !location) throw new Error('IITB returned an incomplete sign-in redirect.');
      next = placementUrl_(location,next.href,true);
      continue;
    }
    if (status === 401 || status === 403 || next.host !== 'campus.placements.iitb.ac.in' || next.path !== '/blog/placement/') throw placementReconnectError_();
    if (status !== 200) throw new Error('IITB returned HTTP ' + status + '. Previous posts and successful-check time were preserved.');
    var contentLength = placementHeader_(responseHeaders,'content-length');
    if (Array.isArray(contentLength)) contentLength = contentLength[0];
    if (contentLength !== null && Number(contentLength) > PLACEMENT_SOURCE_MAX_BYTES_) throw new Error('The placement source response exceeded its size limit.');
    var contentType = placementHeader_(responseHeaders,'content-type');
    if (Array.isArray(contentType)) contentType = contentType[0];
    if (contentType && !/^text\/html(?:\s*;|$)/i.test(contentType)) throw new Error('IITB returned an unsupported placement content type.');
    if (typeof response.getContent === 'function' && response.getContent().length > PLACEMENT_SOURCE_MAX_BYTES_) throw new Error('The placement source response exceeded its size limit.');
    var text = response.getContentText('UTF-8');
    if (placementByteLength_(text) > PLACEMENT_SOURCE_MAX_BYTES_) throw new Error('The placement source response exceeded its size limit.');
    return {text:text,url:next.href};
  }
  throw new Error('IITB returned too many sign-in redirects.');
}

function placementDecodeHtml_(value) {
  var entities = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',hellip:'…'};
  return value.replace(/&#(x[\da-f]+|\d+);/gi,function(_,number) {
    var code = number.charAt(0).toLowerCase() === 'x' ? parseInt(number.slice(1),16) : parseInt(number,10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|rsquo|lsquo|rdquo|ldquo|hellip);/g,function(_,name) {return entities[name];});
}

function placementAttributes_(value) {
  var attributes = {}, pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, match;
  while ((match = pattern.exec(value))) attributes[match[1].toLowerCase()] = placementDecodeHtml_(match[2] === undefined ? match[3] === undefined ? match[4] || '' : match[3] : match[2]);
  return attributes;
}

function placementPlainText_(value) {
  return placementDecodeHtml_(value.replace(/<!--[^]*?-->/g,'').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'')
    .replace(/<br\b[^>]*>/gi,'\n').replace(/<\/(?:p|div|li|h[1-6]|tr|section|blockquote)\s*>/gi,'\n').replace(/<li\b[^>]*>/gi,'\n')
    .replace(/<[^>]*>/g,' ')).replace(/\r\n?/g,'\n').replace(/[\t \f\v]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

function parsePlacementListing_(html, url) {
  var posts = [], articlePattern = /<article\b([^>]*)>([^]*?)<\/article\s*>/gi, article;
  while ((article = articlePattern.exec(html))) {
    var attributes = placementAttributes_(article[1]), id = attributes.id;
    if (!/^post-\d+$/.test(id || '')) continue;
    var body = article[2], heading = body.match(/<h[1-3]\b[^>]*>([^]*?)<\/h[1-3]\s*>/i), time = body.match(/<time\b([^>]*)>/i);
    var title = placementPlainText_(heading ? heading[1] : ''), published = time ? placementAttributes_(time[1]).datetime : '';
    if (!title || !published || !isFinite(Date.parse(published))) throw new Error('A placement post is missing its title or publication time. Previous posts were preserved.');
    var links = [], anchorPattern = /<a\b([^>]*)>([^]*?)<\/a\s*>/gi, anchor, canonical = null;
    while ((anchor = anchorPattern.exec(body))) {
      var href = placementAttributes_(anchor[1]).href;
      if (!href) continue;
      try {
        var link = placementUrl_(href,url,false);
        links.push({text:placementPlainText_(anchor[2]),url:link.href});
        if (link.origin === 'https://campus.placements.iitb.ac.in' && link.path === '/blog/placement/' && new RegExp('(?:^\\?|&)p=' + id.slice(5) + '(?:&|$)').test(link.query)) canonical = link.href;
      } catch (error) { /* Non-HTTP links are not navigation or meeting links. */ }
    }
    var text = placementPlainText_(body);
    if (title.length > 1000 || text.length > 64000 || links.length > 100) throw new Error('A placement post exceeded its supported size. Previous posts were preserved.');
    posts.push({id:id,title:title,url:canonical || PLACEMENT_SOURCE_BLOG_ + '?p=' + id.slice(5),published:new Date(published).toISOString(),text:text,links:links});
  }
  if (!posts.length) throw placementReconnectError_();
  var next = null, nextPattern = /<a\b([^>]*)>([^]*?)<\/a\s*>/gi, candidate;
  while ((candidate = nextPattern.exec(html))) {
    var candidateAttrs = placementAttributes_(candidate[1]);
    if (!/\bnext\b/.test(candidateAttrs['class'] || '') && !/\bnext\b/.test(candidateAttrs.rel || '') && placementPlainText_(candidate[2]).toLowerCase() !== 'next page') continue;
    if (!candidateAttrs.href) throw new Error('The placement page returned an incomplete next-page link.');
    var destination = placementUrl_(candidateAttrs.href,url,true), pageNumber = destination.query.match(/^\?paged=(\d+)$/);
    if (destination.origin !== 'https://campus.placements.iitb.ac.in' || destination.path !== '/blog/placement/' || !pageNumber || Number(pageNumber[1]) < 2 || Number(pageNumber[1]) > 100000) throw new Error('The placement page returned an unsupported next-page link.');
    if (next && next !== destination.href) throw new Error('The placement page returned conflicting next-page links.');
    next = destination.href;
  }
  return {posts:posts,next:next};
}

function readPlacementSource_() {
  var startedAt = Date.now(), session = loadSession_(), cookies = placementSessionCookies_(session);
  var priorTime = getLastPlacementCheck_(), priorMilliseconds = priorTime ? Date.parse(priorTime) : NaN;
  var threshold = startedAt - 30 * 24 * 60 * 60 * 1000;
  if (isFinite(priorMilliseconds)) threshold = Math.min(threshold,priorMilliseconds);
  var posts = [], ids = {}, pages = {}, url = PLACEMENT_SOURCE_BLOG_;
  for (var page = 0; url && page < 25; page++) {
    placementCheckTime_(startedAt);
    if (pages[url]) throw new Error('Placement pagination repeated. Previous posts and successful-check time were preserved.');
    pages[url] = true;
    var response = placementFetch_(url,cookies,startedAt), listing = parsePlacementListing_(response.text,response.url), oldest = Infinity;
    listing.posts.forEach(function(post) {
      if (ids[post.id]) throw new Error('A placement post repeated across pages. Previous posts were preserved.');
      ids[post.id] = true; posts.push(post); oldest = Math.min(oldest,Date.parse(post.published));
    });
    if (posts.length > 500 || placementByteLength_(JSON.stringify(posts)) > PLACEMENT_SOURCE_MAX_BYTES_) throw new Error('The placement snapshot exceeded its supported size. Previous posts were preserved.');
    url = oldest <= threshold ? null : listing.next;
  }
  if (url) throw new Error('Placement pagination exceeded 25 pages. Previous posts and successful-check time were preserved.');
  placementCheckTime_(startedAt);
  var observedAt = new Date(Date.now()).toISOString();
  var snapshot = {source_url:PLACEMENT_SOURCE_BLOG_,observed_at:observedAt,complete:true,posts:posts};
  if (placementByteLength_(JSON.stringify(snapshot)) > PLACEMENT_SOURCE_MAX_BYTES_) throw new Error('The placement snapshot exceeded its supported size. Previous posts were preserved.');
  saveSession_({cookies:cookies,origins:[]},observedAt);
  return snapshot;
}
