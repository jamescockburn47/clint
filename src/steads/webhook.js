// src/steads/webhook.js — handler for POST /api/steads-event. The Steads
// ledgers (Moorstead / Saltstead / Marsstead) POST notable events here,
// HMAC-signed (x-steads-signature) with the shared STEADS_WEBHOOK_SECRET.
// Notable events DM James immediately; all are buffered for the daily digest.
// Mirrors src/lqcouncil/sentry-webhook.js. Deployed to clawd-admin:
// src/steads/webhook.js.
import { createHmac, timingSafeEqual } from 'node:crypto';
import logger from '../logger.js';
import store from './store.js';
import { isMuted } from './state.js';
import { isNotable, formatEvent } from './curate.js';

export function verifySteadsSignature(rawBody, signature, secret) {
  if (!secret || !signature || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function handleSteadsEvent({ rawBody, signature, sendProactiveMessage }) {
  const { default: config } = await import('../config.js');
  if (!config.steadsEnabled) return { status: 200, body: { ok: true, disabled: true } };
  const secret = config.steadsWebhookSecret || '';
  if (!secret) return { status: 503, body: { error: 'STEADS_WEBHOOK_SECRET unset' } };
  if (!verifySteadsSignature(rawBody, signature, secret)) {
    logger.warn({ sigPresent: !!signature }, 'steads-event: signature verification failed');
    return { status: 401, body: { error: 'invalid signature' } };
  }
  let evt;
  try { evt = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid JSON body' } }; }
  if (!evt || typeof evt !== 'object' || !evt.type) return { status: 400, body: { error: 'no event type' } };

  store.recordEvent(evt);

  if (isNotable(evt) && !isMuted() && typeof sendProactiveMessage === 'function') {
    const jid = (config.steadsJid || config.ownerJid || '').trim();
    if (jid) {
      try {
        await sendProactiveMessage(jid, formatEvent(evt));
      } catch (err) {
        logger.error({ err: err.message }, 'steads-event: delivery failed');
        return { status: 500, body: { error: 'delivery failed' } };
      }
    }
  }
  return { status: 202, body: { ok: true } };
}
