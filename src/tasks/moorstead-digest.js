// Task: Moorstead daily digest — routine activity rolled up once a day.
import config from '../config.js';
import logger from '../logger.js';
import store from '../moorstead/store.js';
import { composeDigest } from '../moorstead/curate.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STATE_FILE = join('data', 'moorstead-digest-state.json');
const DIGEST_HOUR = 20; // 20:00 London

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); }
  catch (err) { logger.warn({ err: err.message }, 'moorstead digest state save failed'); }
}

let lastDigestDate = loadState().lastDigestDate || null;

/**
 * Send the Moorstead daily digest at DIGEST_HOUR (London).
 * @param {Function} sendFn - single-arg WhatsApp send (owner-bound by scheduler)
 * @param {string} todayStr - YYYY-MM-DD
 * @param {number} hours - London hour
 * @param {number} minutes - London minute
 */
export async function checkMoorsteadDigest(sendFn, todayStr, hours, minutes) {
  if (!config.moorsteadEnabled || !sendFn) return;
  if (lastDigestDate === todayStr) return;
  if (hours < DIGEST_HOUR || hours > DIGEST_HOUR + 1) return;

  lastDigestDate = todayStr;
  saveState({ lastDigestDate });

  const startOfDay = new Date(todayStr + 'T00:00:00Z').getTime();
  const digest = composeDigest(store.recentEvents({ sinceTs: startOfDay }));
  if (!digest) return;

  try { await sendFn(digest); logger.info('moorstead digest sent'); }
  catch (err) { logger.error({ err: err.message }, 'moorstead digest failed'); }
}

export function getLastMoorsteadDigestDate() { return lastDigestDate; }
