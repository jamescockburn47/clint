// Client for the local prompt-injection classifier (clint-injection-guard on this host). A small encoder model: it scores
// text, it does not generate. Its verdict is used only to RESTRICT what Clint may do next, never to permit anything.
// If the service cannot be reached the verdict is 'unscanned', which restricts exactly as 'flagged' does.
export const GUARD_URL = 'http://127.0.0.1:8106/classify';
const MAX_CHARS = 400000; // beyond this the text is not sent: it reads as unscanned, never as clean
const MAX_TEXTS = 256;

// Invisible carriers: Unicode tags, variation selectors, zero-width, bidi and other format controls, ANSI escapes,
// C0/C1 controls (newline and tab kept).
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\uFE00-\uFE0F\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu;
/** What the model is shown: third-party text without invisible carriers. */
export const visible = text => String(text ?? '').replace(INVISIBLE, '');
/** What the scanner is shown: tag characters read as the ASCII they hide, so hidden instructions are scanned too. */
export const scannable = text => String(text ?? '').replace(/[\u{E0020}-\u{E007E}]/gu, ch => String.fromCharCode(ch.codePointAt(0) - 0xE0000));

/** { state: 'clean' | 'flagged' | 'unscanned', score, flags } for a list of untrusted texts. */
export async function scanUntrusted(texts, { fetchImpl = (...args) => fetch(...args), timeoutMs = 45000 } = {}) {
  // Positions are kept: flags[i] answers texts[i]. Empty texts are clean and are not sent.
  const all = texts.map(text => String(text ?? ''));
  const items = all.filter(Boolean);
  if (!items.length) return { state: 'clean', score: 0, flags: all.map(() => false) };
  if (items.length > MAX_TEXTS || items.some(text => text.length > MAX_CHARS)) {
    return { state: 'unscanned', score: null, error: 'guard_input_too_large' };
  }
  try {
    const res = await fetchImpl(GUARD_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: items }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { state: 'unscanned', score: null, error: `guard_http_${res.status}` };
    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    if (results.length !== items.length || results.some(r => typeof r?.flagged !== 'boolean')) return { state: 'unscanned', score: null, error: 'guard_bad_answer' };
    const score = Math.max(...results.map(r => Number(r.score) || 0));
    let next = 0;
    const flags = all.map(text => (text ? results[next++].flagged : false));
    return { state: results.some(r => r.flagged) ? 'flagged' : 'clean', score, flags };
  } catch (err) {
    return { state: 'unscanned', score: null, error: err?.name === 'TimeoutError' ? 'guard_timeout' : 'guard_unreachable' };
  }
}
