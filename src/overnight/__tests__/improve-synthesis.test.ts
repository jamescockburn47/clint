import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesiseFinalCandidates,
  parseSynthesisResponse,
  parseSynthesisResponseWithRejections,
  type SynthesisSource,
} from '../improve-synthesis.js';
import type { EvoChatClient } from '../probe-patterns.js';
import type { CandidateObservation, PatternObservation, DriftObservation } from '../probe-observations.js';
import type { PatternCluster } from '../improve-grooming.js';

const SAMPLE_RESPONSE = `[
  {"id": "c1", "title": "Cap cortex gather timeout at 15s", "category": "performance", "scope": "src/cortex-cache.js:gather", "evidence_refs": ["pattern:cortex_slow", "quality_failure:slow_cortex"], "predicted_benefit": "planning p95 down from 87s to 20s"},
  {"id": "c2", "title": "Add needsPlan drift detector", "category": "quality", "scope": "src/reasoning-trace.js", "evidence_refs": ["pattern:low_tool_usage", "drift:low_tool_usage"], "predicted_benefit": "catch classifier drift early"}
]`;

describe('overnight/improve-synthesis.parseSynthesisResponse', () => {
  it('parses a valid response into FinalCandidate records', () => {
    const result = parseSynthesisResponse(SAMPLE_RESPONSE);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, 'c1');
    assert.equal(result[0]!.title, 'Cap cortex gather timeout at 15s');
    assert.equal(result[0]!.category, 'performance');
    assert.deepEqual(result[0]!.evidence_refs, ['pattern:cortex_slow', 'quality_failure:slow_cortex']);
  });

  it('assigns a synthetic id when the response omits one', () => {
    const resp = `[{"title": "fix cortex", "category": "performance", "scope": "src/cortex-cache.js", "evidence_refs": ["pattern:x", "drift:y"], "predicted_benefit": "faster"}]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.ok(result[0]!.id.length > 0);
  });

  it('rejects candidates with fewer than 2 evidence_refs (spec §4.4 step 3)', () => {
    const resp = `[
      {"id": "ok", "title": "valid", "category": "x", "scope": "src/request-id.js", "evidence_refs": ["a", "b"], "predicted_benefit": "p"},
      {"id": "bad", "title": "weak evidence", "category": "x", "scope": "src/z.js", "evidence_refs": ["a"], "predicted_benefit": "p"}
    ]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'ok');
  });

  it('rejects candidates with mission-regression titles', () => {
    const resp = `[
      {"id": "bad", "title": "Simpler cortex by removing memory retrieval", "category": "performance", "scope": "src/cortex-cache.js", "evidence_refs": ["a", "b"], "predicted_benefit": "faster"},
      {"id": "ok", "title": "Cap cortex timeout", "category": "performance", "scope": "src/cortex-cache.js", "evidence_refs": ["a", "b"], "predicted_benefit": "faster"}
    ]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'ok');
  });

  it('returns empty array on non-JSON input', () => {
    assert.deepEqual(parseSynthesisResponse('hello world'), []);
  });
});

describe('overnight/improve-synthesis.parseSynthesisResponseWithRejections', () => {
  it('reports parsedCount=-1 when the response has no JSON array', () => {
    const out = parseSynthesisResponseWithRejections('The candidates are A, B, C.');
    assert.equal(out.parsedCount, -1);
    assert.deepEqual(out.candidates, []);
    assert.deepEqual(out.rejections, []);
  });

  it('returns per-candidate rejection reasons with titles preserved', () => {
    const resp = `[
      {"id": "weak", "title": "thin evidence", "category": "x", "scope": "src/request-id.js", "evidence_refs": ["a"], "predicted_benefit": "p"},
      {"id": "ok", "title": "valid fix", "category": "x", "scope": "src/request-id.js", "evidence_refs": ["a", "b"], "predicted_benefit": "p"},
      {"id": "noscope", "title": "missing scope", "evidence_refs": ["a", "b"]},
      "not-an-object"
    ]`;
    const out = parseSynthesisResponseWithRejections(resp);
    assert.equal(out.parsedCount, 4);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0]!.id, 'ok');
    assert.equal(out.rejections.length, 3);
    const byReason = new Map(out.rejections.map((r) => [r.reason, r]));
    assert.equal(byReason.get('insufficient-evidence-refs')!.title, 'thin evidence');
    assert.equal(byReason.get('missing-title-or-scope')!.title, 'missing scope');
    assert.equal(byReason.get('not-object')!.title, null);
  });
});

describe('overnight/improve-synthesis.synthesiseFinalCandidates', () => {
  function makeClient(response: string | null): EvoChatClient {
    return {
      chat: async () => response,
    };
  }

  function makeGroomed(): SynthesisSource {
    const patterns: PatternObservation[] = [
      {
        kind: 'pattern',
        date: '2026-04-11',
        observation: 'cortex p95 exceeds planning budget',
        evidence_refs: ['trace:a', 'trace:b'],
        weight: 4,
      },
    ];
    const clusters: PatternCluster[] = [
      { keyword: 'cortex', patterns, totalWeight: 4 },
    ];
    const candidates: CandidateObservation[] = [
      {
        kind: 'candidate',
        date: '2026-04-10',
        title: 'timeout cortex',
        category: 'performance',
        predicted_benefit: 'faster',
        scope: 'src/cortex-cache.js',
        rough_cost: 'small',
        evidence_refs: ['pattern:cortex_slow'],
        weight: 4,
      },
    ];
    return {
      candidates,
      patternClusters: clusters,
      worseDriftAlerts: [],
    };
  }

  it('calls EVO with a synthesis prompt and returns parsed candidates', async () => {
    let capturedSystem = '';
    const client: EvoChatClient = {
      chat: async (system) => {
        capturedSystem = system;
        return SAMPLE_RESPONSE;
      },
    };
    const result = await synthesiseFinalCandidates({
      client,
      source: makeGroomed(),
    });
    assert.ok(capturedSystem.length > 0);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.diagnostics.keptCount, 2);
    assert.equal(result.diagnostics.parsedCount, 2);
    assert.ok(result.diagnostics.rawResponseBytes! > 0);
  });

  it('returns empty candidates and empty diagnostics when EVO returns null', async () => {
    const result = await synthesiseFinalCandidates({
      client: makeClient(null),
      source: makeGroomed(),
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.diagnostics.rawResponseBytes, null);
    assert.equal(result.diagnostics.keptCount, 0);
  });

  it('returns empty candidates when source has nothing to synthesise from', async () => {
    const result = await synthesiseFinalCandidates({
      client: makeClient(SAMPLE_RESPONSE),
      source: { candidates: [], patternClusters: [], worseDriftAlerts: [] },
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.diagnostics.rawResponseBytes, null);
  });

  it('captures rejection reasons in diagnostics when candidates fail validation', async () => {
    const response = `[
      {"id": "weak", "title": "thin evidence", "category": "x", "scope": "src/request-id.js", "evidence_refs": ["a"], "predicted_benefit": "p"},
      {"id": "mission", "title": "Simpler cortex by removing memory retrieval", "category": "x", "scope": "src/request-id.js", "evidence_refs": ["a", "b"], "predicted_benefit": "p"}
    ]`;
    const result = await synthesiseFinalCandidates({
      client: makeClient(response),
      source: makeGroomed(),
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.diagnostics.parsedCount, 2);
    assert.equal(result.diagnostics.rejections.length, 2);
    const reasons = result.diagnostics.rejections.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ['insufficient-evidence-refs', 'mission-regression']);
  });

  it('prioritises worse drift alerts by injecting them into the prompt', async () => {
    let capturedUser = '';
    const client: EvoChatClient = {
      chat: async (_, user) => {
        capturedUser = user;
        return SAMPLE_RESPONSE;
      },
    };
    const drift: DriftObservation = {
      kind: 'drift',
      date: '2026-04-11',
      original_timestamp: '2026-04-11T10:00:00Z',
      input_hash: 'sha256:xyz',
      diff_summary: '+50 chars',
      judged: 'worse',
      reason: 'response lost citation to memory',
      evidence_refs: ['sha256:xyz'],
      weight: 5,
    };
    await synthesiseFinalCandidates({
      client,
      source: { ...makeGroomed(), worseDriftAlerts: [drift] },
    });
    assert.match(capturedUser, /DRIFT|WORSE|lost citation/);
  });
});
