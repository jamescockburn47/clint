// A fetch-shaped transport for remote MCP servers: public IPv4 only, DNS answer pinned for the connection, ports 80/443,
// no redirects followed (a 3xx comes back as a non-OK response). Reuses the web_fetch destination rules.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { publicDestination } from '../public-web-fetch.js';

const NULL_BODY = new Set([101, 204, 205, 304]);

export async function pinnedFetch(raw, { method = 'GET', headers = {}, body, signal } = {}, { resolve = lookup, request } = {}) {
  const { url, address } = await publicDestination(raw, resolve);
  signal?.throwIfAborted();
  const res = await new Promise((accept, reject) => {
    const send = request || (url.protocol === 'https:' ? https.request : http.request);
    const req = send(url, { method, headers, signal, agent: false,
      lookup: (_host, opts, callback) => callback(null, opts.all ? [{ address, family: 4 }] : address, 4) }, accept);
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) responseHeaders.append(name, String(item));
  }
  if (NULL_BODY.has(res.statusCode)) { res.resume(); return new Response(null, { status: res.statusCode, headers: responseHeaders }); }
  return new Response(Readable.toWeb(res), { status: res.statusCode, headers: responseHeaders });
}
