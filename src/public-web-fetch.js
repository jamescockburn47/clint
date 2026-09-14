import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import http from 'node:http';
import https from 'node:https';

/** Only public IPv4 is supported. DNS answers are pinned for the connection, including redirects. */
export function publicIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function publicDestination(raw, resolve = lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('web_destination_denied');
  const answers = await resolve(url.hostname, { all: true, verbatim: true });
  // A mixed public/private answer is rejected, not selected optimistically.
  if (!answers.length || answers.some(a => a.family === 4 && !publicIPv4(a.address))) {
    throw new Error('web_destination_denied');
  }
  const chosen = answers.find(a => a.family === 4 && publicIPv4(a.address));
  if (!chosen) throw new Error('web_destination_denied');
  return { url, address: chosen.address };
}

export async function fetchPublicText(raw, { resolve = lookup, request, timeoutMs = 15000,
  maxBytes = 512000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = new Promise((_, reject) => controller.signal.addEventListener('abort',
    () => reject(new Error('web_fetch_timeout')), { once: true }));
  const operation = async () => {
    let next = raw;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const { url, address } = await publicDestination(next, resolve);
      controller.signal.throwIfAborted();
      const response = await new Promise((accept, reject) => {
        const send = request || (url.protocol === 'https:' ? https.request : http.request);
        const req = send(url, { method: 'GET', signal: controller.signal, agent: false,
          lookup: (_host, opts, callback) => callback(null,
            opts.all ? [{ address, family: 4 }] : address, 4),
          headers: { 'User-Agent': 'Clint/1.0', Accept: 'text/html,text/plain,application/json' },
        }, accept);
        req.on('error', reject); req.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location) throw new Error('web_redirect_missing_location');
        next = new URL(response.headers.location, url).href;
        continue;
      }
      const parts = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); throw new Error('web_response_too_large'); }
        parts.push(chunk);
      }
      return { status: response.statusCode, contentType: response.headers['content-type'] || '',
        text: Buffer.concat(parts).toString('utf8') };
    }
    throw new Error('web_redirect_limit');
  };
  try { return await Promise.race([operation(), abort]); }
  finally { clearTimeout(timer); controller.abort(); }
}
