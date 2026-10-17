/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
// Optional web lookup (off by default: "web": { "enabled": true } in ~/.ember/config.json).
// Plain HTTP fetches, no tracking, each lookup is approved by the user.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Ember/0.2 (+https://llyverse.org)';

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|pre|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseDuckDuckGo(html, max = 8) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const hits = [...html.matchAll(re)];
  hits.forEach((m, i) => {
    if (out.length >= max) return;
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    const tail = html.slice(m.index + m[0].length, hits[i + 1]?.index ?? html.length);
    const sn = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    out.push({ title: htmlToText(m[2]), url, snippet: htmlToText(sn?.[1] || '') });
  });
  return out;
}

export async function webSearch(query, { fetchImpl = fetch, base = 'https://html.duckduckgo.com/html/' } = {}) {
  const r = await fetchImpl(`${base}?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`search failed: HTTP ${r.status}`);
  const results = parseDuckDuckGo(await r.text());
  return results.length ? results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n') : 'No results.';
}

export async function webFetch(url, { fetchImpl = fetch, maxChars = 12000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed');
  const host = new URL(url).hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1)/.test(host)) throw new Error('Private/local addresses are blocked');
  const r = await fetchImpl(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') || '';
  const body = await r.text();
  const text = /html/.test(type) ? htmlToText(body) : body;
  return text.length > maxChars ? text.slice(0, maxChars) + `\n… [truncated, ${text.length - maxChars} more chars]` : text;
}

export function webTools() {
  const def = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  return [
    {
      def: def('web_search', 'Search the web (DuckDuckGo) for docs, error messages or package info. Returns titles, URLs and snippets.', { query: { type: 'string' } }, ['query']),
      approval: (a) => `Search the web for "${a.query}"?`,
      run: (_ctx, a) => webSearch(String(a.query || ''))
    },
    {
      def: def('web_fetch', 'Fetch a web page (e.g. documentation) and return its text.', { url: { type: 'string' } }, ['url']),
      approval: (a) => `Fetch ${a.url}?`,
      run: (_ctx, a) => webFetch(String(a.url || ''))
    }
  ];
}
