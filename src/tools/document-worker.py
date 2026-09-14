"""One framed request per isolated socket-activated service instance."""
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile

MAX_INPUT = 20_000_000
MAX_OUTPUT = 2_000_000
ERRORS = {'extraction_limit', 'invalid_document', 'ambiguous_package', 'macros_not_supported',
          'unsafe_xml', 'external_sheet_not_supported', 'unsupported_sheet', 'unsupported_format',
          'unsupported_document_namespace', 'unsupported_embedded_content'}


def command(args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=20, env={'PATH':'/usr/bin', 'LANG':'C.UTF-8', 'OMP_THREAD_LIMIT':'2'})


def pdf(data):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source, text = root/'input.pdf', root/'text.txt'
        source.write_bytes(data)
        info = subprocess.run(['/usr/bin/pdfinfo', str(source)], check=True, capture_output=True,
                              timeout=10, env={'PATH':'/usr/bin','LANG':'C.UTF-8'}).stdout.decode('utf8')
        match = re.search(r'^Pages:\s+(\d+)$', info, re.M)
        if not match or int(match[1]) > 100:
            raise ValueError('extraction_limit')
        count = int(match[1])
        images = subprocess.run(['/usr/bin/pdfimages','-list',str(source)],check=True,capture_output=True,
                                timeout=10,env={'PATH':'/usr/bin','LANG':'C.UTF-8'}).stdout.decode('utf8')
        image_pages = {int(value) for value in re.findall(r'^\s*(\d+)\s+\d+\s+',images,re.M)}
        command(['/usr/bin/pdftotext','-layout','-enc','UTF-8',str(source),str(text)])
        pages = text.read_text().split('\f')
        if pages and not pages[-1].strip():
            pages.pop()
        if len(pages) != count:
            raise ValueError('invalid_document')
        output, unread, ocr = [], [], []
        for number, content in enumerate(pages, 1):
            mode = 'digital text'
            if not content.strip() or number in image_pages:
                if len(ocr) >= 10:
                    unread.append(number)
                    output.append(f'[Page {number}: image content not read; OCR limit reached]\n{content.strip()}')
                    continue
                ocr.append(number)
                image = root/'page'
                command(['/usr/bin/pdftoppm','-f',str(number),'-l',str(number),'-singlefile','-scale-to','1600',
                         '-png',str(source),str(image)])
                command(['/usr/bin/tesseract',str(image)+'.png',str(image),'-l','eng'])
                recognized = image.with_suffix('.txt').read_text()
                content = (content.strip()+'\n[OCR layer; may duplicate digital text]\n'+recognized) if content.strip() else recognized
                mode = 'OCR with any digital layer, unverified transcription'
                image.with_suffix('.png').unlink()
                if not recognized.strip():
                    unread.append(number)
                    content += '\n[No readable image text established; page may be blank or unreadable.]'
            output.append(f'[Page {number}; {mode}]\n{content.strip()}')
        return {'content':'\n\n'.join(output), 'representation':'pdf_pages_with_optional_ocr', 'pageCount':count,
                'ocrPages':ocr, 'unreadPages':unread, 'completeExtraction':not unread,
                'limitations':['Embedded image pages receive OCR within the stated limit; diagrams are not visually interpreted.',
                               'Layout, handwriting and OCR require checking against the original.']}


def extract(data, mime):
    if mime == 'application/pdf':
        return pdf(data)
    spec = importlib.util.spec_from_file_location('office_text', Path(__file__).with_name('office-text.py'))
    office = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(office)
    if mime == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return office.docx(data)
    if mime == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return office.xlsx(data)
    raise ValueError('unsupported_format')


def read_exact(stream, count):
    value = stream.read(count)
    if len(value) != count:
        raise ValueError('invalid_document')
    return value


def main():
    import resource  # The socket worker is Linux-only; pure parsers are also tested on Windows.
    resource.setrlimit(resource.RLIMIT_FSIZE, (16_000_000,16_000_000))
    resource.setrlimit(resource.RLIMIT_CPU, (60,60))
    try:
        header_length = struct.unpack('!I',read_exact(sys.stdin.buffer,4))[0]
        if header_length > 4096:
            raise ValueError('extraction_limit')
        header = json.loads(read_exact(sys.stdin.buffer,header_length))
        size = header.get('size')
        if type(size) is not int or not 0 < size <= MAX_INPUT or set(header) != {'size','mime'}:
            raise ValueError('extraction_limit')
        data = read_exact(sys.stdin.buffer,size)
        result = extract(data,header['mime'])
        if len(result['content'].encode()) > MAX_OUTPUT:
            raise ValueError('extraction_limit')
        print(json.dumps({'state':'extracted',**result},ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error,ValueError) and str(error) in ERRORS else 'document_extraction_failed'
        print(json.dumps({'state':'unavailable','error':code}))


if __name__ == '__main__':
    main()
