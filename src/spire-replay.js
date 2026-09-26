import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Reserve before network I/O. A crash/timeout is uncertain and never causes a duplicate send. */
export function reserveSpireContribution(scope) {
  const path = join(dirname(scope.taskStorePath), 'spire-contributions.sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS spire_events (id TEXT PRIMARY KEY);');
    // Target is deliberately absent: changing endpoint/key cannot replay an acknowledged Slack event.
    const id = createHash('sha256').update(JSON.stringify([
      scope.actorId, scope.conversationId, scope.requestId])).digest('hex');
    return db.prepare('INSERT OR IGNORE INTO spire_events VALUES (?)').run(id).changes === 1;
  } finally { db.close(); }
}
