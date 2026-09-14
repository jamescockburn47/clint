/** Read immutable conversation lines and resolve every model selection against them. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryCandidate } from './consolidate-validate.js';
import { readSourceLine, groundCandidate, type SourceMessage } from './grounded-memory.js';

export const MIN_CONVERSATION_CHARS = 1;
export const MIN_LOG_LINES = 1;
const BATCH_CHARS = 12000;

export interface ExtractClient {
  extractCandidates(conversation: string, source: string): Promise<{ candidates: unknown[] }>;
}
export interface ConsolidateExtractorOptions { client: ExtractClient; logDir: string }
export interface ExtractError { file: string; reason: string }
/** A single selection or line that could not be grounded. The rest of the file still counts. */
export interface ExtractRejection { file: string; line?: number; reason: string }
export interface ExtractResult {
  filesProcessed: number;
  candidates: MemoryCandidate[];
  /** File- or service-level failures: the source could not be processed at all. */
  errors: ExtractError[];
  /** Per-item rejections: one bad selection or torn line never discards a file. */
  rejections: ExtractRejection[];
  rejected: number;
}

export class ConsolidateExtractor {
  constructor(private readonly opts: ConsolidateExtractorOptions) {}

  /** Process bounded source batches. Failure differs from an explicitly empty result. */
  async extractForDate(date: string): Promise<ExtractResult> {
    const result: ExtractResult = { filesProcessed: 0, candidates: [], errors: [], rejections: [], rejected: 0 };
    let files: string[];
    try { files = await readdir(this.opts.logDir); }
    catch (err) {
      result.errors.push({ file: date, reason: (err as NodeJS.ErrnoException).code ?? 'log_read_failed' });
      return result;
    }
    const seen = new Set<string>();
    const reject = (file: string, reason: string, line?: number) => {
      result.rejected++;
      result.rejections.push(line === undefined ? { file, reason } : { file, line, reason });
    };
    for (const file of files.filter(f => f.startsWith(date) && f.endsWith('.jsonl')).sort()) {
      try {
        const lines = (await readFile(join(this.opts.logDir, file), 'utf8')).split('\n');
        const messages: SourceMessage[] = [];
        let unreadable = 0;
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]!;
          if (!raw.trim()) continue;
          try { messages.push(readSourceLine(raw, file, i + 1)); }
          catch { unreadable++; reject(file, 'unreadable_line', i + 1); }
        }
        if (!messages.length && unreadable) throw new Error('no_readable_lines');
        const batches: SourceMessage[][] = [];
        let batch: SourceMessage[] = [];
        let chars = 0;
        for (const m of messages) {
          if (m.isBot || !m.text.trim()) continue;
          if (m.text.length > 2000) { reject(file, 'statement_too_long', m.line); continue; }
          const size = JSON.stringify(m).length;
          if (chars + size > BATCH_CHARS && batch.length) { batches.push(batch); batch = []; chars = 0; }
          batch.push(m); chars += size;
        }
        if (batch.length) batches.push(batch);
        for (const records of batches) {
          const response = await this.opts.client.extractCandidates(JSON.stringify(records), file);
          if (!response || !Array.isArray(response.candidates)) throw new Error('extractor_invalid_contract');
          for (const raw of response.candidates) {
            try {
              const c = groundCandidate(raw, records);
              const key = c.sources[0]!.hash;
              if (!seen.has(key)) { result.candidates.push(c); seen.add(key); }
            } catch (err) {
              reject(file, (err as Error).message);
            }
          }
        }
        result.filesProcessed++;
      } catch (err) {
        result.errors.push({ file, reason: (err as Error).message });
      }
    }
    return result;
  }
}
