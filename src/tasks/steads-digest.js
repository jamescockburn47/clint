// src/tasks/steads-digest.js — the Steads daily digest: routine activity across
// Moorstead / Saltstead / Marsstead rolled up once a day at DIGEST_HOUR London.
// Mirrors tasks/moorstead-digest.js. Deployed to clawd-admin: src/tasks/steads-digest.js.
import config from '../config.js';
import logger from '../logger.js';
import store from '../steads/store.js';
import { composeDigest } from '../steads/curate.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STATE_FILE = join('data', 'steads-digest-state.json');
const DIGEST_HOUR = 20; // 20:00 London

const londonDate = (ts) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); }
  catch (err) { logger.warn({ err: err.message }, 'steads digest state save failed'); }
}

let lastDigestDate = loadState().lastDigestDate || null;

export async function checkSteadsDigest(sendFn, todayStr, hours) {
  if (!config.steadsEnabled || !sendFn) return;
  if (lastDigestDate === todayStr) return;
  if (hours < DIGEST_HOUR || hours > DIGEST_HOUR + 1) return;

  lastDigestDate = todayStr;
  saveState({ lastDigestDate });

  const events = store.recentEvents().filter((e) => londonDate(e.ts) === todayStr);
  const digest = composeDigest(events);
  if (!digest) return;

  try { await sendFn(digest); logger.info('steads digest sent'); }
  catch (err) { logger.error({ err: err.message }, 'steads digest failed'); }
}

export function getLastSteadsDigestDate() { return lastDigestDate; }
