const EVIDENCE_TOOLS = new Set(['system_status', 'knowledge_status', 'knowledge_search', 'knowledge_read', 'repository_status']);
const EVIDENCE_LIMIT = 24000;
const PARSE_LIMIT = 256000;
const DEFAULT_LIMIT = 1500;
const unavailable = reason => JSON.stringify({ state: 'evidence_unavailable', reason, records: [] });

/** Evidence is an atomic structured payload, never a character prefix. */
export function boundToolResult(name, result) {
  if (!EVIDENCE_TOOLS.has(name)) {
    return result.length > DEFAULT_LIMIT ? result.slice(0, DEFAULT_LIMIT) + '\n[...truncated]' : result;
  }
  if (typeof result !== 'string' || result.length > PARSE_LIMIT) return unavailable('evidence_result_too_large');
  let data;
  try { data = JSON.parse(result); }
  catch { return unavailable('invalid_evidence_result'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable('invalid_evidence_result');
  if (result.length <= EVIDENCE_LIMIT) return result;
  // Search can omit whole lower-ranked records, explicitly retaining their IDs.
  // A single-record read must instead fail intact if it exceeds the budget.
  if (name === 'knowledge_search' && Array.isArray(data.records)) {
    const omittedRecordIds = [];
    while (data.records.length) {
      const omitted = data.records.pop();
      omittedRecordIds.unshift(typeof omitted?.id === 'string' && omitted.id.length <= 200 ? omitted.id : null);
      const packed = JSON.stringify({ ...data, omittedRecordIds,
        budgetNotice: 'Whole records omitted for size; use knowledge_read for the listed IDs. No included record was shortened.' });
      if (packed.length <= EVIDENCE_LIMIT) return packed;
    }
  }
  return unavailable('evidence_result_too_large');
}
