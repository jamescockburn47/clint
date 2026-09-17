import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** Private durable inbox/outbox; production entry must hold the OS flock before opening. */
export class SlackStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'slack.sqlite'));
    chmodSync(join(directory, 'slack.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, team TEXT NOT NULL, channel TEXT NOT NULL, owner TEXT NOT NULL,
        ts TEXT NOT NULL, thread TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', answer TEXT, reply_ts TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, error TEXT,
        UNIQUE(team,channel,ts));`);
  }
  recover() {
    // A model request is repeatable; a send of unknown outcome must not be repeated.
    this.db.exec("UPDATE events SET state='queued' WHERE state='generating';");
    this.db.exec("UPDATE events SET state='uncertain', error='restart_during_send' WHERE state='sending';");
  }
  enqueue(event, now) {
    if (this.db.prepare('SELECT id FROM events WHERE id=? OR (team=? AND channel=? AND ts=?)')
      .get(event.id, event.team, event.channel, event.ts)) return 'duplicate';
    const count = this.db.prepare('SELECT count(*) AS n FROM events WHERE created>=?').get(now - 86400000).n;
    if (count >= 100) return 'rate_limited';
    this.db.prepare(`INSERT INTO events(id,team,channel,owner,ts,thread,text,created)
      VALUES(?,?,?,?,?,?,?,?)`).run(event.id, event.team, event.channel, event.owner,
      event.ts, event.thread, event.text, now);
    return 'queued';
  }
  next() {
    return this.db.prepare("SELECT * FROM events WHERE state IN ('queued','ready') ORDER BY ts LIMIT 1").get();
  }
  /** Thread replies recall their thread; a top-level message recalls the channel's recent exchanges. */
  history(event, allActors = false) {
    const root = event.thread === event.ts;
    return this.db.prepare(`SELECT text,answer,ts,owner FROM events WHERE team=? AND channel=?
      AND (?=1 OR owner=?) AND (?=1 OR thread=?) AND state='sent' AND ts<? ORDER BY ts DESC LIMIT 10`)
      .all(event.team, event.channel, allActors ? 1 : 0, event.owner, root ? 1 : 0, event.thread, event.ts).reverse();
  }
  contextBarrier(event) {
    return this.db.prepare('SELECT max(ts) AS stamp FROM events WHERE team=? AND channel=? AND owner=?')
      .get(event.team, event.channel, event.owner).stamp || event.ts;
  }
  setState(id, state, error = null) {
    this.db.prepare('UPDATE events SET state=?,error=? WHERE id=?').run(state, error, id);
  }
  generating(id) {
    this.db.prepare("UPDATE events SET state='generating',attempts=attempts+1 WHERE id=?").run(id);
  }
  /** Give back an attempt that never reached a model: the core was unavailable. */
  requeue(id, error = null) {
    this.db.prepare("UPDATE events SET state='queued',attempts=max(attempts-1,0),error=? WHERE id=?").run(error, id);
  }
  ready(id, answer) {
    this.db.prepare("UPDATE events SET state='ready',answer=? WHERE id=?").run(answer, id);
  }
  sent(id, replyTs) {
    this.db.prepare("UPDATE events SET state='sent',reply_ts=? WHERE id=?").run(replyTs, id);
  }
  counts() {
    return this.db.prepare('SELECT state,count(*) AS count FROM events GROUP BY state').all();
  }
  recentStatements(config, now) {
    const rows = this.db.prepare(`SELECT id,text,owner,ts FROM events WHERE team=? AND channel=? AND owner=?
      AND created>=? ORDER BY ts DESC LIMIT 20`).all(config.teamId, config.channelId, config.ownerId, now - 48 * 3600000);
    const selected = [];
    let size = 0;
    for (const row of rows) {
      size += JSON.stringify(row).length;
      if (size > 16000) break;
      selected.unshift({ ...row, timestamp: new Date(Number(row.ts) * 1000).toISOString() });
    }
    return selected;
  }
  close() { this.db.close(); }
}
