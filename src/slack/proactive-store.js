import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** Separate state from authentic owner messages. No fabricated Slack inbox events. */
export class ProactiveStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'proactive.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,date TEXT NOT NULL,kind TEXT NOT NULL,
      scope TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      report TEXT,reply_ts TEXT,updated INTEGER NOT NULL,error TEXT);`);
  }
  recover(now) {
    this.db.prepare("UPDATE jobs SET state='pending',updated=? WHERE state='running'").run(now);
    this.db.prepare("UPDATE jobs SET state='uncertain',error='restart_during_send',updated=? WHERE state='sending'").run(now);
  }
  get(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  giveBackAttempt(id) { this.db.prepare('UPDATE jobs SET attempts=max(0,attempts-1) WHERE id=?').run(id); }
  ensure(date, kind, scope, now) {
    const id = `${date}:${kind}`;
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,date,kind,scope,state,updated) VALUES(?,?,?,?,'pending',?)")
      .run(id, date, kind, scope, now);
    return this.get(id);
  }
  update(id, state, now, { report, error = null, replyTs = null } = {}) {
    const encoded = report === undefined ? null : JSON.stringify(report);
    if (encoded && encoded.length > 64000) throw new Error('proactive_report_too_large');
    this.db.prepare(`UPDATE jobs SET state=?,updated=?,error=?,report=coalesce(?,report),
      reply_ts=coalesce(?,reply_ts),attempts=attempts+? WHERE id=?`)
      .run(state, now, error, encoded, replyTs, state === 'running' ? 1 : 0, id);
  }
  recent(scope) {
    return this.db.prepare('SELECT date,kind,state,attempts,updated,error,report,reply_ts FROM jobs WHERE scope=? ORDER BY date DESC,kind LIMIT 6')
      .all(scope).map(({ report, ...row }) => ({ ...row, report: report ? JSON.parse(report) : null }));
  }
  close() { this.db.close(); }
}
