/// <reference types="node" />
import logger from '../logger.js';
import { parseXlsx } from './xlsx-parser.js';
import { extractMethodology } from './methodology-extractor.js';
import { ContributionStore } from './contribution-store.js';
import { BurstGrouper, type ClosedBurst } from './burst-grouper.js';
import {
  detectContribution,
  type ContributionDetectionInput,
} from './contribution-detector.js';
import type {
  BurstMessage,
  ContributionEntry,
  ContributionKind,
  DocumentExcerpt,
  XlsxStructure,
} from './types.js';
import { createHash } from 'node:crypto';

/**
 * Orchestrator for the SOVREN contribution pipeline.
 *
 * Three entry points:
 *
 * 1. `ingestXlsx` — called from `document-handler.js` when an xlsx arrives.
 * 2. `ingestDocument` — called from `document-handler.js` after PDF/DOCX text
 *    extraction has already produced text content.
 * 3. `recordTextMessage` — called from `message-handler.js` for plain-text
 *    messages from registered contributors. Routes through the burst grouper.
 *
 * Each ingest pipeline:
 *   - parses (or accepts pre-parsed) the input
 *   - calls the methodology extractor (EVO 30B, single call)
 *   - persists to the store
 *   - returns a brief summary the caller can inject into the chat reply
 *
 * The orchestrator does NOT send WhatsApp messages itself. Reply generation
 * stays in `message-handler.js` and `claude.js`.
 */

export interface IngestSummary {
  ok: boolean;
  entry: ContributionEntry | null;
  error: string | null;
  /** A short human-readable summary the caller can inject into the chat reply. */
  reply: string;
}

const store = new ContributionStore();

/**
 * Burst grouper instance — singleton for the process. Flushes any closed burst
 * by calling `processBurst` below, which writes a burst-typed contribution.
 */
const burstGrouper = new BurstGrouper(async (burst) => {
  await processBurst(burst);
});

/** Public accessor for the store (used by retroactive seeding scripts). */
export function getContributionStore(): ContributionStore {
  return store;
}

/** Public accessor for the burst grouper (used by tests and shutdown hooks). */
export function getBurstGrouper(): BurstGrouper {
  return burstGrouper;
}

/**
 * Detect whether a message is a SOVREN contribution. Wraps the detector so
 * callers don't need to import multiple modules.
 */
export function isContribution(input: ContributionDetectionInput) {
  return detectContribution(input);
}

/**
 * Ingest an xlsx file. Returns an `IngestSummary` whose `reply` field is a
 * short text the caller should inject into the chat acknowledgement.
 */
export async function ingestXlsx(args: {
  buffer: Buffer;
  fileName: string;
  contributorName: string;
  contributorSlug: string;
  coverText?: string;
  existingMethodology?: string | null;
  receivedAt?: string;
}): Promise<IngestSummary> {
  const receivedAt = args.receivedAt ?? new Date().toISOString();
  let structure: XlsxStructure;
  try {
    structure = await parseXlsx(args.buffer, args.fileName);
  } catch (err) {
    logger.warn({ err: (err as Error).message, fileName: args.fileName }, 'xlsx parse failed');
    return {
      ok: false,
      entry: null,
      error: `xlsx_parse_failed: ${(err as Error).message}`,
      reply: `I received \`${args.fileName}\` but couldn't parse it as a valid xlsx. Could you re-export and resend?`,
    };
  }

  const extraction = await extractMethodology({
    contributorName: args.contributorName,
    contributorSlug: args.contributorSlug,
    receivedAt,
    sourceKind: 'xlsx',
    sourceFiles: [{ fileName: args.fileName, fileHash: structure.fileHash }],
    xlsxStructure: structure,
    existingMethodology: args.existingMethodology ?? null,
  });

  const entry = await store.addContribution({
    contributor: args.contributorName,
    contributorSlug: args.contributorSlug,
    receivedAt,
    kind: 'xlsx',
    shortDescription:
      extraction.methodology?.shortDescription ??
      `${args.contributorName} spreadsheet contribution: ${args.fileName}`,
    coverText: args.coverText,
    xlsxStructure: structure,
    xlsxBuffer: args.buffer,
    methodology: extraction.methodology,
    extractionError: extraction.error,
    rawModelOutput: extraction.rawModelOutput,
  });

  logger.info(
    {
      contributor: args.contributorName,
      fileName: args.fileName,
      sheets: structure.sheetCount,
      cells: structure.sheets.reduce((n, s) => n + s.cells.length, 0),
      methodologyOk: extraction.ok,
    },
    'sovren contribution ingested (xlsx)',
  );

  return {
    ok: true,
    entry,
    error: extraction.error,
    reply: buildXlsxReply(entry, structure, extraction.ok),
  };
}

/**
 * Ingest a generic text-based document (PDF, DOCX, plain text). The caller is
 * expected to have already extracted text content via the existing
 * `document-handler.js` pipeline; this function only adds the contribution
 * layer above it.
 */
export async function ingestDocument(args: {
  buffer: Buffer | null;
  fileName: string;
  mimetype: string;
  text: string;
  pageCount?: number | null;
  contributorName: string;
  contributorSlug: string;
  coverText?: string;
  existingMethodology?: string | null;
  receivedAt?: string;
}): Promise<IngestSummary> {
  const receivedAt = args.receivedAt ?? new Date().toISOString();
  const fileHash = createHash('sha256').update(args.buffer ?? args.text).digest('hex');

  const excerpt: DocumentExcerpt = {
    fileName: args.fileName,
    fileHash,
    mimetype: args.mimetype,
    text: args.text,
    charCount: args.text.length,
    pageCount: args.pageCount ?? null,
    parsedAt: new Date().toISOString(),
  };

  const kind: ContributionKind = inferKindFromMime(args.mimetype);

  const extraction = await extractMethodology({
    contributorName: args.contributorName,
    contributorSlug: args.contributorSlug,
    receivedAt,
    sourceKind: kind,
    sourceFiles: [{ fileName: args.fileName, fileHash }],
    documentExcerpt: excerpt,
    existingMethodology: args.existingMethodology ?? null,
  });

  const entry = await store.addContribution({
    contributor: args.contributorName,
    contributorSlug: args.contributorSlug,
    receivedAt,
    kind,
    shortDescription:
      extraction.methodology?.shortDescription ??
      `${args.contributorName} ${kind} contribution: ${args.fileName}`,
    coverText: args.coverText,
    documentExcerpt: excerpt,
    documentBuffer: args.buffer ?? undefined,
    methodology: extraction.methodology,
    extractionError: extraction.error,
    rawModelOutput: extraction.rawModelOutput,
  });

  logger.info(
    {
      contributor: args.contributorName,
      fileName: args.fileName,
      kind,
      chars: args.text.length,
      methodologyOk: extraction.ok,
    },
    'sovren contribution ingested (document)',
  );

  return {
    ok: true,
    entry,
    error: extraction.error,
    reply: buildDocumentReply(entry, excerpt, extraction.ok),
  };
}

/**
 * Record a plain-text message from a registered contributor. Routes through
 * the burst grouper so that multi-message contributions are coalesced into a
 * single store entry rather than fragmented.
 */
export function recordTextMessage(args: {
  contributorSlug: string;
  contributorName: string;
  chatJid: string;
  timestamp: number;
  text: string;
  attachment?: { fileName: string; mimetype: string; captured: boolean } | null;
}): void {
  burstGrouper.record({
    contributorSlug: args.contributorSlug,
    chatJid: args.chatJid,
    timestamp: args.timestamp,
    senderName: args.contributorName,
    text: args.text,
    attachment: args.attachment ?? null,
  });
}

/**
 * Process a closed burst — runs methodology extraction over the joined text
 * of the burst, then writes a single contribution entry.
 */
async function processBurst(burst: ClosedBurst): Promise<void> {
  const messages: BurstMessage[] = burst.messages;
  const joined = messages
    .map((m) => `[${m.timestamp}] ${m.senderName}: ${m.text || '[attachment]'}`)
    .join('\n');

  // Skip empty bursts (e.g. attachment-only with no captured content).
  const meaningful = messages.filter((m) => m.text && m.text.trim().length > 5);
  if (meaningful.length === 0) {
    logger.info(
      { contributor: burst.contributorSlug, chat: burst.chatJid, messages: messages.length },
      'sovren burst skipped — no meaningful text content',
    );
    return;
  }

  const contributorName =
    messages[messages.length - 1]?.senderName ?? burst.contributorSlug;

  const extraction = await extractMethodology({
    contributorName,
    contributorSlug: burst.contributorSlug,
    receivedAt: burst.firstSeenAt,
    sourceKind: 'burst',
    sourceFiles: [],
    burstMessages: messages,
  });

  await store.addContribution({
    contributor: contributorName,
    contributorSlug: burst.contributorSlug,
    receivedAt: burst.firstSeenAt,
    kind: 'burst',
    shortDescription:
      extraction.methodology?.shortDescription ??
      `${contributorName} text burst (${messages.length} messages)`,
    coverText: joined,
    burstMessages: messages,
    methodology: extraction.methodology,
    extractionError: extraction.error,
    rawModelOutput: extraction.rawModelOutput,
  });

  logger.info(
    {
      contributor: contributorName,
      messages: messages.length,
      methodologyOk: extraction.ok,
    },
    'sovren contribution ingested (burst)',
  );
}

function inferKindFromMime(mime: string): ContributionKind {
  if (mime === 'application/pdf') return 'pdf';
  if (
    mime ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (mime.startsWith('image/')) return 'image';
  return 'text';
}

function buildXlsxReply(
  entry: ContributionEntry,
  structure: XlsxStructure,
  methodologyOk: boolean,
): string {
  const cellCount = structure.sheets.reduce((n, s) => n + s.cells.length, 0);
  const sheetNames = structure.sheets.map((s) => s.name).join(', ');
  const base = `Got the spreadsheet \`${structure.fileName}\` — parsed ${structure.sheetCount} sheet(s) (${sheetNames}), ${cellCount} non-empty cells. Stored under \`${entry.id}\` in the SOVREN contribution index.`;
  if (methodologyOk) {
    return `${base}\n\nMethodology extracted to \`methodology.json\` — variables, formulas, anchors, conflicts and open questions are now in the project mirror and will sync on the next project_sync.`;
  }
  return `${base}\n\nStructural parse complete. Methodology extraction failed and will need a re-run; the raw structural JSON is the canonical record either way.`;
}

function buildDocumentReply(
  entry: ContributionEntry,
  excerpt: DocumentExcerpt,
  methodologyOk: boolean,
): string {
  const base = `Got \`${excerpt.fileName}\` (${excerpt.charCount.toLocaleString()} chars). Stored under \`${entry.id}\` in the SOVREN contribution index.`;
  if (methodologyOk) {
    return `${base}\n\nMethodology extracted and saved alongside the document.`;
  }
  return `${base}\n\nText captured. Methodology extraction failed and will need a re-run.`;
}
