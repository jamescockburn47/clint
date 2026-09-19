import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/);
const schemas = {
  task_save: z.object({ title: z.string().min(1).max(200), details: z.string().max(12000) }).strict(),
  task_list: z.object({}).strict(),
  task_read: z.object({ id }).strict(),
  task_set_status: z.object({ id, status: z.enum(['queued', 'completed', 'cancelled']) }).strict(),
};
const digest = text => createHash('sha256').update(text).digest('hex');

/** Acknowledged writes are committed; replay never repeats or silently changes an action. */
export function taskAction(path, scope, name, raw, now = () => new Date().toISOString()) {
  const input = schemas[name]?.parse(raw);
  if (!input || !scope.requestId || !scope.actorId || !scope.conversationId) throw Error('task_invalid_request');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`CREATE TABLE IF NOT EXISTS owner_tasks (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation TEXT NOT NULL,
      title TEXT NOT NULL, details TEXT NOT NULL, original_request TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_task_events (
      event_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result TEXT NOT NULL);`);
    if (name === 'task_list') return { tasks: db.prepare(
      'SELECT id,title,status,created_at,updated_at FROM owner_tasks WHERE owner=? AND conversation=? ORDER BY created_at DESC LIMIT 100'
    ).all(scope.actorId, scope.conversationId), limit: 100 };
    if (name === 'task_read') {
      const task = db.prepare('SELECT * FROM owner_tasks WHERE id=? AND owner=? AND conversation=?')
        .get(input.id, scope.actorId, scope.conversationId);
      if (!task) throw Error('task_not_found_in_scope');
      return { task };
    }
    const key = digest(JSON.stringify([scope.actorId, scope.conversationId, scope.requestId, name]));
    const hash = digest(JSON.stringify(input));
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM owner_task_events WHERE event_key=?').get(key);
      if (prior) {
        if (prior.input_hash !== hash) throw Error('task_replay_conflict');
        db.exec('COMMIT');
        return JSON.parse(prior.result);
      }
      const timestamp = now();
      const taskId = name === 'task_save' ? key.slice(0, 24) : input.id;
      if (name === 'task_save') db.prepare('INSERT INTO owner_tasks VALUES (?,?,?,?,?,?,?,?,?)').run(
        taskId, scope.actorId, scope.conversationId, input.title, input.details,
        scope.originalRequest || '', 'queued', timestamp, timestamp);
      else {
        const result = db.prepare('UPDATE owner_tasks SET status=?,updated_at=? WHERE id=? AND owner=? AND conversation=?')
          .run(input.status, timestamp, taskId, scope.actorId, scope.conversationId);
        if (result.changes !== 1) throw Error('task_not_found_in_scope');
      }
      const task = { ...db.prepare('SELECT * FROM owner_tasks WHERE id=?').get(taskId) };
      const result = { state: 'recorded', task,
        execution: 'This records a task or its user-reported status; it does not execute or verify the underlying work.' };
      db.prepare('INSERT INTO owner_task_events VALUES (?,?,?)').run(key, hash, JSON.stringify(result));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}
