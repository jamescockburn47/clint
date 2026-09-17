/** Small Markdown subset -> native Slack rich text; unknown syntax remains visible.
 * Text elements never execute Slack mention markup. Only explicit HTTP(S) links
 * become link elements. No model rewrite, content filtering or raw JSON execution.
 */
const literal = text => ({ type: 'text', text });
const section = elements => ({ type: 'rich_text_section', elements });

export function inline(text) {
  const out = [], pattern = /((?<!`)`(?!`)[^`\n]+`(?!`)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(literal(text.slice(last, match.index)));
    const value = match[0];
    if (value.startsWith('[')) {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(value);
      out.push({ type: 'link', text: link[1], url: link[2] });
    } else {
      const marker = value.startsWith('**') ? 2 : 1;
      out.push({ ...literal(value.slice(marker, -marker)), style: { [value[0] === '`' ? 'code' : 'bold']: true } });
    }
    last = match.index + value.length;
  }
  if (last < text.length) out.push(literal(text.slice(last)));
  return out.length ? out : [literal(' ')];
}

function pieces(text, limit = 2500) {
  const chunks = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

function cells(line) {
  // Tables with code/escaped pipes stay verbatim rather than risk moving data.
  if (!line.trim().startsWith('|') || !line.trim().endsWith('|') || /\\\||`/.test(line)) return null;
  return line.trim().slice(1, -1).split('|').map(cell => cell.trim());
}

function tableAt(lines, start) {
  const header = cells(lines[start]), separator = cells(lines[start + 1] || '');
  if (!header || header.length < 2 || !separator || separator.length !== header.length ||
      !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  const rows = [header]; let end = start + 2;
  while (end < lines.length && lines[end].trim().startsWith('|')) {
    const row = cells(lines[end]);
    if (!row || row.length !== header.length) return null;
    rows.push(row); end++;
  }
  return { rows, end, separator, source: lines.slice(start, end).join('\n') };
}

export function formatReply(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n'), blocks = [];
  let elements = [], characters = 0, tables = 0;
  const flush = () => {
    if (elements.length) blocks.push({ type: 'rich_text', elements });
    elements = []; characters = 0;
  };
  const add = (element, length) => {
    if (elements.length && (characters + length > 2500 || elements.length >= 40)) flush();
    elements.push(element); characters += length;
  };
  const prose = (value, type = 'rich_text_section', bold = false) => {
    for (const chunk of pieces(value)) {
      const content = type === 'rich_text_preformatted' ? [literal(chunk)] : inline(chunk);
      if (bold) for (const item of content) item.style = { ...item.style, bold: true };
      add({ type, elements: content }, chunk.length);
    }
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^\s*```[\w+-]*\s*$/.test(line) && lines.slice(i + 1).some(value => /^\s*```\s*$/.test(value))) {
      const body = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      prose(body.join('\n') || ' ', 'rich_text_preformatted'); continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      if (tables === 0 && table.rows.length <= 100 && table.rows[0].length <= 20 &&
          table.rows.every(row => row.every(cell => cell.length <= 2000)) &&
          table.rows.flat().reduce((size, cell) => size + (cell.length || 1), 0) <= 10000) {
        flush(); tables++;
        blocks.push({ type: 'table', rows: table.rows.map((row, index) => row.map(cell => ({
          type: 'rich_text', elements: [section(index === 0 ?
            [{ ...literal(cell || ' '), style: { bold: true } }] : inline(cell))],
        }))), column_settings: table.separator.map(cell => ({ is_wrapped: true,
          align: cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left' })) });
      } else prose(table.source, 'rich_text_preformatted');
      i = table.end; continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { prose(heading[1] + '\n', 'rich_text_section', true); i++; continue; }
    const list = /^(\s*)([-*+] |\d+[.)] )(.+)$/.exec(line);
    if (list && line.length <= 2500) {
      const ordered = /^\d/.test(list[2]);
      const item = { type: 'rich_text_list', style: ordered ? 'ordered' : 'bullet',
        indent: Math.min(4, Math.floor(list[1].length / 2)), elements: [section(inline(list[3]))] };
      if (ordered) item.offset = Math.max(0, Number.parseInt(list[2], 10) - 1);
      add(item, line.length); i++; continue;
    }
    if (line.startsWith('> ')) { prose(line.slice(2) + '\n', 'rich_text_quote'); i++; continue; }
    prose(line + (i < lines.length - 1 ? '\n' : '')); i++;
  }
  flush();
  // Pathological thousands-of-lines input still arrives intact within Slack's 50 blocks.
  if (blocks.length > 50) return pieces(text).map(chunk => ({ type: 'rich_text',
    elements: [section([literal(chunk)])] }));
  return blocks;
}
