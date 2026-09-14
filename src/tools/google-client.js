import config from '../config.js';

// Fixed Google endpoints. No caller-supplied URL, HTTP method, cookies or redirect forwarding.
export function createGoogleReader({ core = config, fetchFn = fetch, now = Date.now } = {}) {
  let token = null;
  let expires = 0;
  async function consume(response, limit = 2_000_000) {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 ? 'google_reauthorization_required'
        : response.status === 403 ? 'google_permission_or_api_access_denied' : 'google_service_unavailable');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('google_response_too_large');
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  async function accessToken() {
    if (token && now() < expires) return token;
    if (!core.googleClientId || !core.googleClientSecret || !core.googleRefreshToken) {
      throw new Error('google_not_configured');
    }
    const response = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ client_id: core.googleClientId, client_secret: core.googleClientSecret,
        refresh_token: core.googleRefreshToken, grant_type: 'refresh_token' }),
    });
    const data = JSON.parse((await consume(response, 16000)).toString('utf8'));
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) {
      throw new Error('google_invalid_token_response');
    }
    token = data.access_token;
    expires = now() + Math.max(0, data.expires_in - 60) * 1000;
    return token;
  }
  return async (path, params = {}, { text = false, binary = false } = {}) => {
    if (!/^\/(?:calendar\/v3|drive\/v3)\//.test(path) || /[?#]/.test(path)) {
      throw new Error('google_invalid_api_path');
    }
    const url = new URL('https://www.googleapis.com' + path);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetchFn(url, { method: 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + await accessToken() }, signal: AbortSignal.timeout(15000) });
    if (response.status === 401) { token = null; expires = 0; }
    const body = await consume(response, binary ? 20_000_000 : 2_000_000);
    return binary ? body : text ? body.toString('utf8') : JSON.parse(body.toString('utf8'));
  };
}

const ERRORS = new Set(['google_not_configured', 'google_reauthorization_required',
  'google_permission_or_api_access_denied', 'google_service_unavailable', 'google_response_too_large',
  'google_invalid_token_response', 'google_invalid_api_path']);
export const googleError = error => ERRORS.has(error?.message) ? error.message : 'google_read_failed';
