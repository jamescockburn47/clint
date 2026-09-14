# Bounded Google document reading

The v9 candidate adds PDF, DOCX, XLSX and Google Sheets reads. Google Sheets exports
XLSX so every tab is represented. Google Docs/Slides and UTF-8 reads retain their
existing path. File modifiedTime is checked before/after extraction and required for
continuation; responses preserve source metadata, extraction limitations and nextOffset.

Binary bytes go over `/run/clint-extractor.sock` to a separate socket-activated
DynamicUser service. Only root and the `clint-extract` group can connect; the private
Slack service receives that supplementary group. No paths, shell commands, Google
tokens or source credentials enter the worker. Its empty root contains read-only
system tools, private temporary storage and no Clint archive/account state. Network
creation is denied. Root control installation is separate and reviewable.

Limits: 20 MB input, 40 MB expanded OOXML, 4096 ZIP entries, 2 MB extracted UTF-8,
100 PDF pages, OCR of at most 10 pages, one active worker, 256 MB RAM, no swap, two
CPU cores, 120 seconds total and bounded subprocess deadlines. Oversize/unsupported/
malformed content returns an explicit failure. PDF pages with embedded images receive
OCR, including scans that also contain a digital header/footer. OCR text is unverified;
images/diagrams are not visually understood. Unread pages are named.

DOCX exposes paragraph and table-cell coordinates, headers/footers/notes/comments and
labelled tracked edits. Unsupported OOXML namespaces and imported altChunk content
fail explicitly. XLSX preserves sheet visibility, cell addresses, raw values, formula
text and cached values, including null when no cached answer exists. It never executes
formulas, external links or macros. Dates may remain Excel serials with date system
and number-format metadata. These are source representations, not verified legal facts.

Canonical `npm run verify` runs parser fixtures through Node and Python. On Windows,
only the Poppler/OCR integration is skipped; the staged EVO run exercises it. Separate
actual socket probes verify Word, PDF and spreadsheet contents in the installed sandbox.
Installed Ubuntu package versions are recorded in the extraction install receipt.
