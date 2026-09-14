"""OOXML text and cell extraction without executing formulas, links or macros."""
import io
import json
import posixpath
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def package(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    entries = archive.infolist()
    if len(entries) > 4096 or sum(x.file_size for x in entries) > 40_000_000:
        raise ValueError('extraction_limit')
    if len({x.filename for x in entries}) != len(entries):
        raise ValueError('ambiguous_package')
    if any(x.flag_bits & 1 or x.file_size > max(1, x.compress_size) * 500 for x in entries):
        raise ValueError('extraction_limit')
    if any(x.filename.lower().endswith('vbaproject.bin') for x in entries):
        raise ValueError('macros_not_supported')
    return archive


def xml(archive, name):
    raw = archive.read(name)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('unsafe_xml')
    return ET.fromstring(raw)


def word_text(node):
    if node.tag in [W+'t', W+'delText', W+'instrText']:
        return node.text or ''
    if node.tag == W+'tab':
        return '\t'
    if node.tag in [W+'br', W+'cr']:
        return '\n'
    text = ''.join(word_text(child) for child in node)
    if node.tag in [W+'del', W+'ins']:
        return '[' + ('DELETED' if node.tag == W+'del' else 'INSERTED') + ': ' + text + ']'
    return text


def docx(data):
    with package(data) as archive:
        names = archive.namelist()
        if 'word/document.xml' not in names:
            raise ValueError('invalid_document')
        parts = ['word/document.xml'] + sorted(name for name in names if
                name.startswith(('word/header', 'word/footer')) and name.endswith('.xml'))
        parts += [name for name in ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'] if name in names]
        lines = []
        for name in parts:
            root = xml(archive, name)
            if not root.tag.startswith(W):
                raise ValueError('unsupported_document_namespace')
            if any(True for _ in root.iter(W+'altChunk')):
                raise ValueError('unsupported_embedded_content')
            cells = {}
            for table_number, table in enumerate(root.iter(W+'tbl'), 1):
                for row_number, row in enumerate(table.findall(W+'tr'), 1):
                    for cell_number, cell in enumerate(row.findall(W+'tc'), 1):
                        for paragraph in cell.findall(W+'p'):
                            cells[paragraph] = f' table {table_number} row {row_number} cell {cell_number}'
            for number, paragraph in enumerate(root.iter(W+'p'), 1):
                text = word_text(paragraph)
                if text.strip():
                    lines.append(f'[{name} paragraph {number}{cells.get(paragraph, "")}] {text}')
        return {'content': '\n'.join(lines), 'representation': 'docx_paragraph_text',
                'coverage': 'main document, table cell paragraphs, headers, footers, notes and comments',
                'limitations': ['Page layout and images are not interpreted.',
                                'Tracked insertions/deletions are labelled where present; field results may be stale.'],
                'completeExtraction': not any(name.startswith(('word/media/', 'word/embeddings/')) for name in names)}


def xlsx(data):
    with package(data) as archive:
        names = archive.namelist()
        workbook = xml(archive, 'xl/workbook.xml')
        if workbook.tag != S+'workbook':
            raise ValueError('unsupported_document_namespace')
        props = workbook.find(S+'workbookPr')
        date_system = '1904' if props is not None and props.get('date1904') in ['1', 'true'] else '1900'
        shared = []
        if 'xl/sharedStrings.xml' in names:
            shared = [''.join(t.text or '' for t in x.iter(S+'t')) for x in xml(archive, 'xl/sharedStrings.xml').findall(S+'si')]
        formats, styles = {}, []
        if 'xl/styles.xml' in names:
            style_xml = xml(archive, 'xl/styles.xml')
            formats = {x.get('numFmtId'): x.get('formatCode') for x in style_xml.findall(S+'numFmts/'+S+'numFmt')}
            styles = [x.get('numFmtId') for x in style_xml.findall(S+'cellXfs/'+S+'xf')]
        relations = {x.get('Id'): x for x in xml(archive, 'xl/_rels/workbook.xml.rels')}
        lines = [f'[Workbook date system: {date_system}; formulas are not recalculated]']
        sheets = []
        for sheet in workbook.findall(S+'sheets/'+S+'sheet'):
            relation = relations[sheet.get(R+'id')]
            if relation.get('TargetMode') == 'External':
                raise ValueError('external_sheet_not_supported')
            path = posixpath.normpath(posixpath.join('xl', relation.get('Target', ''))).lstrip('/')
            if not path.startswith('xl/worksheets/'):
                raise ValueError('unsupported_sheet')
            name = sheet.get('name')
            sheets.append({'name': name, 'visibility': sheet.get('state', 'visible')})
            lines.append('[Sheet ' + json.dumps(sheets[-1], ensure_ascii=False) + ']')
            root = xml(archive, path)
            if root.tag != S+'worksheet':
                raise ValueError('unsupported_document_namespace')
            for row in root.findall(S+'sheetData/'+S+'row'):
                for cell in row.findall(S+'c'):
                    value = cell.findtext(S+'v')
                    kind = cell.get('t', 'n')
                    if kind == 's' and value is not None:
                        value = shared[int(value)]
                    elif kind == 'inlineStr':
                        value = ''.join(x.text or '' for x in cell.iter(S+'t'))
                    formula = cell.find(S+'f')
                    style = int(cell.get('s', '0'))
                    format_id = styles[style] if style < len(styles) else None
                    record = {'cell': cell.get('r'), 'type': kind, 'value': value,
                              'formula': None if formula is None else {'text': formula.text, **formula.attrib},
                              'rowHidden': row.get('hidden') in ['1', 'true'],
                              'numberFormatId': format_id, 'numberFormatCode': formats.get(format_id)}
                    lines.append(json.dumps(record, ensure_ascii=False))
            merges = [x.get('ref') for x in root.findall(S+'mergeCells/'+S+'mergeCell')]
            if merges:
                lines.append('[Merged ranges: ' + ', '.join(merges) + ']')
        return {'content': '\n'.join(lines), 'representation': 'xlsx_sheet_cell_records', 'sheets': sheets,
                'dateSystem': date_system, 'completeExtraction': True,
                'limitations': ['Formula values are stored caches, possibly stale; absent caches are null.',
                                'Numeric cells preserve raw values and format IDs; dates may be Excel serials.',
                                'Charts, images, formatting and external linked workbooks are not interpreted.']}
