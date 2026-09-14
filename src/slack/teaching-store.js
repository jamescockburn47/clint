import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const terms = text => [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || []))].slice(0, 24);
const match = text => terms(text).map(term => `"${term}"`).join(' OR ');

/** Literal source records. No model output, confidence or synthesized facts are persisted. */
export class TeachingStore {
  constructor(directory, { now = Date.now } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.now = now;
    const path = join(directory, 'teachings.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS teachings (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, source_event TEXT NOT NULL, source_ts TEXT NOT NULL,
        thread TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, raw_text TEXT NOT NULL,
        raw_sha TEXT NOT NULL, created INTEGER NOT NULL, retired_ts TEXT, retired_by TEXT, retired_cutoff TEXT,
        UNIQUE(namespace,source_event));
      CREATE TABLE IF NOT EXISTS teaching_actions (
        namespace TEXT NOT NULL, event TEXT NOT NULL, source_ts TEXT NOT NULL, action TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(namespace,event));
      CREATE TABLE IF NOT EXISTS owner_episodes (
        namespace TEXT NOT NULL, event TEXT NOT NULL, source_ts TEXT NOT NULL, thread TEXT NOT NULL,
        raw_text TEXT NOT NULL, preceding_exchange TEXT NOT NULL, PRIMARY KEY(namespace,event));
      CREATE TABLE IF NOT EXISTS response_contexts (
        namespace TEXT NOT NULL, event TEXT NOT NULL, cutoff TEXT NOT NULL, PRIMARY KEY(namespace,event));
      CREATE VIRTUAL TABLE IF NOT EXISTS teaching_fts USING fts5(id UNINDEXED, namespace UNINDEXED, text);
      CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(event UNINDEXED, namespace UNINDEXED, text);`);
  }
  transact(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  act(namespace, event, action, operation) {
    return this.transact(() => {
      const previous = this.db.prepare('SELECT result FROM teaching_actions WHERE namespace=? AND event=?')
        .get(namespace, event.id);
      if (previous) return JSON.parse(previous.result);
      const result = operation();
      this.db.prepare('INSERT INTO teaching_actions VALUES(?,?,?,?,?)')
        .run(namespace, event.id, event.ts, action, JSON.stringify(result));
      return result;
    });
  }
  save(namespace, event, kind, rawText) {
    return this.act(namespace, event, 'save', () => {
      const id = 'T' + hash(namespace + '\0' + event.id).slice(0, 16);
      this.db.prepare(`INSERT INTO teachings(id,namespace,source_event,source_ts,thread,owner,kind,raw_text,raw_sha,created)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, namespace, event.id, event.ts, event.thread, event.owner,
        kind, rawText, hash(rawText), this.now());
      this.db.prepare('INSERT INTO teaching_fts VALUES(?,?,?)').run(id, namespace, rawText);
      return { state: 'saved', id, kind, text: rawText, sourceTs: event.ts };
    });
  }
  retire(namespace, event, id, historyBarrier = '') {
    return this.act(namespace, event, 'retire', () => {
      const previous = this.get(namespace, id);
      if (!previous) return { state: 'not_found', id };
      if (previous.retired_ts) return { state: 'already_retired', id };
      const millis = this.now();
      const processed = String(Math.floor(millis / 1000)).padStart(10, '0') + '.' + String(millis % 1000 * 1000).padStart(6, '0');
      const latest = this.db.prepare('SELECT max(source_ts) AS stamp FROM owner_episodes WHERE namespace=?').get(namespace).stamp || '';
      const cutoff = [processed, latest, event.ts, historyBarrier].sort().at(-1);
      this.db.prepare('UPDATE teachings SET retired_ts=?,retired_by=?,retired_cutoff=? WHERE namespace=? AND id=?')
        .run(event.ts, event.id, cutoff, namespace, id);
      this.db.prepare('DELETE FROM teaching_fts WHERE namespace=? AND id=?').run(namespace, id);
      return { state: 'retired', id, sourceTs: event.ts, contextCutoff: cutoff };
    });
  }
  get(namespace, id) {
    return this.db.prepare('SELECT * FROM teachings WHERE namespace=? AND id=?').get(namespace, id) || null;
  }
  cutoff(namespace) {
    return this.db.prepare('SELECT max(retired_cutoff) AS cutoff FROM teachings WHERE namespace=?')
      .get(namespace).cutoff || '';
  }
  responseCutoff(namespace, event) {
    return this.db.prepare('SELECT cutoff FROM response_contexts WHERE namespace=? AND event=?').get(namespace, event)?.cutoff ?? null;
  }
  markResponse(namespace, event) {
    this.db.prepare('INSERT OR REPLACE INTO response_contexts VALUES(?,?,?)').run(namespace, event, this.cutoff(namespace));
  }
  list(namespace, page = 1) {
    const records = this.db.prepare('SELECT * FROM teachings WHERE namespace=? AND retired_ts IS NULL ORDER BY source_ts DESC LIMIT 3 OFFSET ?')
      .all(namespace, (page - 1) * 2);
    return { records: records.slice(0, 2), nextPage: records.length > 2 ? page + 1 : null };
  }
  active(namespace, query) {
    const expression = match(query);
    const relevant = expression ? this.db.prepare(`SELECT t.* FROM teaching_fts f JOIN teachings t ON t.id=f.id
      WHERE teaching_fts MATCH ? AND t.namespace=? AND t.retired_ts IS NULL ORDER BY rank LIMIT 20`)
      .all(expression, namespace) : [];
    const recent = this.db.prepare('SELECT * FROM teachings WHERE namespace=? AND retired_ts IS NULL ORDER BY source_ts DESC LIMIT 10').all(namespace);
    return [...new Map([...relevant, ...recent].map(row => [row.id, row])).values()];
  }
  recordEpisode(namespace, event, preceding) {
    this.transact(() => {
      if (this.db.prepare('SELECT event FROM owner_episodes WHERE namespace=? AND event=?').get(namespace, event.id)) return;
      this.db.prepare('INSERT INTO owner_episodes VALUES(?,?,?,?,?,?)')
        .run(namespace, event.id, event.ts, event.thread, event.text, JSON.stringify(preceding));
      this.db.prepare('INSERT INTO episode_fts VALUES(?,?,?)').run(event.id, namespace, event.text);
    });
  }
  episodes(namespace, event) {
    const expression = match(event.text);
    const cutoff = this.cutoff(namespace);
    const relevant = expression ? this.db.prepare(`SELECT e.* FROM episode_fts f JOIN owner_episodes e
      ON e.event=f.event AND e.namespace=f.namespace WHERE episode_fts MATCH ? AND e.namespace=?
      AND e.source_ts>? AND e.source_ts<? ORDER BY rank LIMIT 4`).all(expression, namespace, cutoff, event.ts) : [];
    const recent = this.db.prepare(`SELECT * FROM owner_episodes WHERE namespace=? AND source_ts>? AND source_ts<?
      ORDER BY source_ts DESC LIMIT 2`).all(namespace, cutoff, event.ts);
    return [...new Map([...relevant, ...recent].map(row => [row.event, row])).values()];
  }
  close() { this.db.close(); }
}
