/** One nightly command, independent of the WhatsApp socket and in-process timers. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { runLearningWorker } from './learning-worker.js';
import { checkConsolidateShadow } from './consolidate-shadow-task.js';
import { createImprovementReview } from './improve-task.js';
import { checkReport } from './report-task.js';
import { learnReportStyle } from './learn-report-style.js';
import config from '../config.js';
import { checkProbe } from './probe-task.js';
import { checkOvernightResearch } from '../tasks/overnight-research.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric',
  month: '2-digit', day: '2-digit' }).format(new Date());
const dir = join(root, 'data', 'overnight');
const yesterday = new Date(date + 'T12:00:00Z');
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
try {
  const status = await runLearningWorker({ date, overnightDir: dir,
    consolidate: () => checkConsolidateShadow(date, 2, 30),
    explore: async () => { await checkProbe(date, 3, 15); await checkOvernightResearch(date, 3, 45); },
    adapt: () => learnReportStyle({ date, logDate: yesterday.toISOString().slice(0, 10),
      logDir: join(root, 'data', 'conversation-logs'), dataDir: join(root, 'data'), overnightDir: dir,
      ownerJids: [config.ownerJid, config.ownerLid].filter(Boolean) }),
    review: () => createImprovementReview(date, dir),
    report: () => checkReport(date, 6, 50),
  });
  console.log(JSON.stringify({ task: 'nightly-learning', date, status }));
  process.exitCode = status === 'failed' ? 1 : 0;
} catch (err) {
  console.error(JSON.stringify({ task: 'nightly-learning', date, status: 'failed', error: (err as Error).message }));
  process.exitCode = 1;
}
