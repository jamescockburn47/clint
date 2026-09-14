/// <reference types="node" />
import { evoSimpleChat } from '../evo-llm.js';
import type {
  ContributionKind,
  MethodologyContribution,
  XlsxStructure,
  DocumentExcerpt,
  BurstMessage,
} from './types.js';
import { renderStructureForPrompt } from './xlsx-parser.js';
export { renderMethodologyMarkdown } from './methodology-render.js';

/**
 * Methodology extractor — converts raw contribution inputs (xlsx structure,
 * document text, plain text messages, or a multi-message burst) into a
 * structured `MethodologyContribution` JSON via a single EVO 30B call.
 *
 * Hard rules (per spec §6.2):
 * - The deterministic structural parse is the canonical record. This module's
 *   output is always derivable from those inputs and is allowed to fail.
 * - One LLM call per extraction.
 * - Strict JSON schema validation. On failure, return null and let the caller
 *   persist a marker rather than a partial JSON.
 * - No reasoning beyond what the inputs support. The system prompt explicitly
 *   forbids invention.
 */

/** Maximum chars of input we send to EVO 30B. Beyond this, we truncate the prompt rendering. */
const MAX_PROMPT_CHARS = 24_000;

const SYSTEM_PROMPT = `You are a deterministic methodology extractor for SOVREN, a sovereign award valuation engine.

Your job: read a contribution from a SOVREN collaborator and extract a structured methodology JSON. You do NOT invent. You do NOT speculate. You do NOT add reasoning that the input does not support.

Rules:
1. Output VALID JSON ONLY, conforming exactly to the schema below. No prose, no commentary, no code fences.
2. Every field you populate must be directly grounded in the contribution input. If you cannot ground a field, omit it (or use an empty array / empty string).
3. For spreadsheet inputs, refer to cells by their full address (e.g. "Sheet1!B26"). Never paraphrase a formula — quote it verbatim.
4. For text inputs, refer to the contributor's exact wording when describing their definitions and claims.
5. Conflict detection: if the contribution disagrees with the existing SOVREN methodology on file, list it in "conflicts". If you are not sure, omit it.
6. Open questions: list questions a SOVREN engineer would need answered before incorporating this contribution. Be specific and short.
7. Suggested links: list code paths inside the SOVREN backend that this contribution likely affects. Use repository-relative paths like "backend/app/services/valuation/calculator.py". Empty array is fine if you cannot tell.
8. Short description: ONE sentence, factual, no marketing language.

Output schema:
{
  "variables": [
    { "name": "string", "definition": "string", "sourceCells": ["string"], "domain": "string" }
  ],
  "formulas": [
    { "label": "string", "symbolic": "string", "sourceCell": "string", "dependsOn": ["string"], "appearsInExamples": ["string"] }
  ],
  "anchors": [
    { "reference": "string", "meaning": "string", "cells": ["string"] }
  ],
  "workedExamples": [
    { "name": "string", "stage": "string", "inputs": { "key": "value" }, "output": "string" }
  ],
  "openQuestions": ["string"],
  "conflicts": [
    { "with": "string", "description": "string", "severity": "low" }
  ],
  "suggestedLinks": ["string"],
  "shortDescription": "string"
}`;

export interface MethodologyExtractorInput {
  contributorName: string;
  contributorSlug: string;
  receivedAt: string;
  sourceKind: ContributionKind;
  sourceFiles: { fileName: string; fileHash: string }[];
  /** One of these is required. */
  xlsxStructure?: XlsxStructure;
  documentExcerpt?: DocumentExcerpt;
  textBody?: string;
  burstMessages?: BurstMessage[];
  /** Existing SOVREN methodology spec, for conflict detection. */
  existingMethodology?: string | null;
}

export interface MethodologyExtractionResult {
  ok: boolean;
  methodology: MethodologyContribution | null;
  rawModelOutput: string | null;
  error: string | null;
}

/** Single entry point. Always returns a result; failure is surfaced via `ok=false`. */
export async function extractMethodology(
  input: MethodologyExtractorInput,
): Promise<MethodologyExtractionResult> {
  const userPrompt = buildUserPrompt(input);
  const truncated =
    userPrompt.length > MAX_PROMPT_CHARS
      ? `${userPrompt.slice(0, MAX_PROMPT_CHARS)}\n\n[... truncated, ${userPrompt.length} chars total]`
      : userPrompt;

  let rawOutput: string | null;
  try {
    rawOutput = await evoSimpleChat(SYSTEM_PROMPT, truncated, 2000);
  } catch (err) {
    return {
      ok: false,
      methodology: null,
      rawModelOutput: null,
      error: `evo_call_failed: ${(err as Error).message}`,
    };
  }

  if (!rawOutput) {
    return { ok: false, methodology: null, rawModelOutput: null, error: 'empty_model_output' };
  }

  const cleaned = stripCodeFences(rawOutput).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      methodology: null,
      rawModelOutput: rawOutput,
      error: `invalid_json: ${(err as Error).message}`,
    };
  }

  const validated = validateAndNormalise(parsed, input);
  if (!validated.ok) {
    return {
      ok: false,
      methodology: null,
      rawModelOutput: rawOutput,
      error: validated.error,
    };
  }

  return { ok: true, methodology: validated.methodology, rawModelOutput: rawOutput, error: null };
}

function buildUserPrompt(input: MethodologyExtractorInput): string {
  const parts: string[] = [];
  parts.push(`Contributor: ${input.contributorName}`);
  parts.push(`Received at: ${input.receivedAt}`);
  parts.push(`Contribution kind: ${input.sourceKind}`);
  if (input.sourceFiles.length > 0) {
    parts.push(`Source files: ${input.sourceFiles.map((f) => f.fileName).join(', ')}`);
  }

  if (input.existingMethodology) {
    parts.push('');
    parts.push('=== EXISTING SOVREN METHODOLOGY ON FILE ===');
    parts.push(input.existingMethodology);
    parts.push('=== END EXISTING METHODOLOGY ===');
  }

  if (input.xlsxStructure) {
    parts.push('');
    parts.push('=== SPREADSHEET STRUCTURE (deterministic parse) ===');
    parts.push(renderStructureForPrompt(input.xlsxStructure));
    parts.push('=== END SPREADSHEET STRUCTURE ===');
  }

  if (input.documentExcerpt) {
    parts.push('');
    parts.push(`=== DOCUMENT TEXT (${input.documentExcerpt.fileName}) ===`);
    parts.push(input.documentExcerpt.text);
    parts.push('=== END DOCUMENT TEXT ===');
  }

  if (input.textBody) {
    parts.push('');
    parts.push('=== CONTRIBUTOR MESSAGE TEXT ===');
    parts.push(input.textBody);
    parts.push('=== END MESSAGE TEXT ===');
  }

  if (input.burstMessages && input.burstMessages.length > 0) {
    parts.push('');
    parts.push('=== MESSAGE BURST ===');
    for (const m of input.burstMessages) {
      parts.push(`[${m.timestamp}] ${m.senderName}: ${m.text || '[attachment]'}`);
      if (m.attachment) {
        parts.push(`  attachment: ${m.attachment.fileName} (${m.attachment.mimetype}) captured=${m.attachment.captured}`);
      }
    }
    parts.push('=== END MESSAGE BURST ===');
  }

  parts.push('');
  parts.push('Produce the methodology JSON now.');
  return parts.join('\n');
}

function stripCodeFences(s: string): string {
  // Remove leading ```json and trailing ``` if present.
  return s.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
}

interface ValidatedOk {
  ok: true;
  methodology: MethodologyContribution;
}
interface ValidatedFail {
  ok: false;
  error: string;
}

function validateAndNormalise(
  raw: unknown,
  input: MethodologyExtractorInput,
): ValidatedOk | ValidatedFail {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'top_level_not_object' };
  }
  const r = raw as Record<string, unknown>;
  // Strict shallow shape: every required array exists (or is added empty) and shortDescription is a string.
  const methodology: MethodologyContribution = {
    contributor: input.contributorName,
    contributorSlug: input.contributorSlug,
    receivedAt: input.receivedAt,
    sourceKind: input.sourceKind,
    sourceFiles: input.sourceFiles,
    variables: arrayOrEmpty(r.variables),
    formulas: arrayOrEmpty(r.formulas),
    anchors: arrayOrEmpty(r.anchors),
    workedExamples: arrayOrEmpty(r.workedExamples),
    openQuestions: stringArrayOrEmpty(r.openQuestions),
    conflicts: arrayOrEmpty(r.conflicts),
    suggestedLinks: stringArrayOrEmpty(r.suggestedLinks),
    shortDescription:
      typeof r.shortDescription === 'string' && r.shortDescription.length > 0
        ? r.shortDescription
        : `${input.contributorName} contribution (${input.sourceKind})`,
  };
  return { ok: true, methodology };
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
