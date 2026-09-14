import importlib.util
import io
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile
import zlib

source = Path(__file__).parents[1]/'src/tools'
spec = importlib.util.spec_from_file_location('worker', source/'document-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for name, value in files.items():
            zip_file.writestr(name, value)
    return output.getvalue()


def document_fixture():
    return archive({'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                    '<w:p><w:r><w:t>Payment due on 18 October.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Invoice total 123.45</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                    '<w:p><w:del><w:r><w:delText>30 days</w:delText></w:r></w:del><w:ins><w:r><w:t>14 days</w:t></w:r></w:ins></w:p>'
                    '</w:body></w:document>',
                    'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Draft only</w:t></w:r></w:p></w:hdr>'})


def spreadsheet_fixture():
    namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    return archive({'xl/workbook.xml': f'<workbook xmlns="{namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Costs" r:id="r1"/><sheet name="Hidden assumptions" state="hidden" r:id="r2"/></sheets></workbook>',
                    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
                    'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1"><v>123.45</v></c><c r="C1"><f>B1*2</f><v>246.9</v></c><c r="D1"><f>B1*3</f></c></row></sheetData></worksheet>',
                    'xl/worksheets/sheet2.xml':f'<worksheet xmlns="{namespace}"><sheetData><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Provisional</t></is></c></row></sheetData></worksheet>'})


def pdf_bytes(objects):
    result = b'%PDF-1.4\n'
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += str(number).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
    xref = len(result)
    result += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    result += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return result + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


def stream(data, extra=b''):
    return b'<< /Length '+str(len(data)).encode()+b' '+extra+b' >>\nstream\n'+data+b'\nendstream'


def pdf_fixture():
    return pdf_bytes([b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                      b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                      b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
                      stream(b'BT /F1 24 Tf 35 100 Td (Invoice total 123.45) Tj ET')])


def scan_fixture(mixed_page=False):
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary)
        (path/'input.pdf').write_bytes(pdf_fixture())
        subprocess.run(['pdftoppm','-singlefile','-r','100',str(path/'input.pdf'),str(path/'image')],check=True,capture_output=True)
        ppm = (path/'image.ppm').read_bytes()
        match = re.match(rb'P6\s+(\d+)\s+(\d+)\s+255\s', ppm)
        assert match, 'invalid_ppm_fixture'
        width,height = int(match[1]),int(match[2])
        image = stream(zlib.compress(ppm[match.end():]),f'/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'.encode())
        scan = pdf_bytes([b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                          b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /I 4 0 R >> >> /Contents 5 0 R >>',
                          image,stream(b'q 600 0 0 200 0 0 cm /I Do Q')])

        mixed = pdf_bytes([b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                           b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /I 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',
                           image,stream(b'q 600 0 0 200 0 0 cm /I Do Q BT /F1 10 Tf 35 20 Td (BATES 0001) Tj ET'),
                           b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'])

        return mixed if mixed_page else scan


class ExtractionTests(unittest.TestCase):
    def test_word_table_header_and_tracked_changes(self):
        result = worker.extract(document_fixture(), DOCX)
        for value in ['Payment due on 18 October.', 'Invoice total 123.45', '[DELETED: 30 days]', '[INSERTED: 14 days]', 'Draft only']:
            self.assertIn(value, result['content'])
        self.assertIn('word/document.xml paragraph 2', result['content'])
        self.assertIn('table 1 row 1 cell 1', result['content'])

    def test_all_sheets_hidden_rows_formula_cache_and_missing_values(self):
        result = worker.extract(spreadsheet_fixture(), XLSX)
        self.assertEqual(len(result['sheets']), 2)
        self.assertEqual(result['dateSystem'], '1904')
        for value in ['"cell": "C1"', '"value": "246.9"', '"cell": "D1"', '"value": null', '"rowHidden": true', 'Provisional']:
            self.assertIn(value, result['content'])

    def test_invalid_and_bomb_are_rejected(self):
        with self.assertRaises(zipfile.BadZipFile):worker.extract(b'invalid bytes', DOCX)
        with self.assertRaisesRegex(ValueError, 'extraction_limit'):
            worker.extract(archive({'word/document.xml':'x'*1_000_000}), DOCX)
        with self.assertRaisesRegex(ValueError, 'unsafe_xml'):
            worker.extract(archive({'word/document.xml':'<!DOCTYPE x [<!ENTITY y "secret">]><x/>'}), DOCX)
        with self.assertRaisesRegex(ValueError, 'unsupported_document_namespace'):
            worker.extract(archive({'word/document.xml':'<document xmlns="http://purl.oclc.org/ooxml/wordprocessingml/main"><p>Important</p></document>'}), DOCX)
        with self.assertRaisesRegex(ValueError, 'unsupported_embedded_content'):
            worker.extract(archive({'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:altChunk/></w:body></w:document>'}), DOCX)

    @unittest.skipUnless(shutil.which('pdftotext'), 'Poppler integration runs on EVO')
    def test_pdf_page_and_actual_scan_ocr(self):
        result = worker.extract(pdf_fixture(), 'application/pdf')
        self.assertIn('[Page 1; digital text]', result['content'])
        self.assertIn('Invoice total 123.45', result['content'])
        for mixed_page in [False, True]:
            result = worker.extract(scan_fixture(mixed_page), 'application/pdf')
            self.assertEqual(result['ocrPages'], [1])
            self.assertIn('123.45', result['content'])
            self.assertIn('unverified transcription', result['content'])
            if mixed_page:
                self.assertIn('BATES 0001', result['content'])



if __name__ == '__main__':unittest.main()
