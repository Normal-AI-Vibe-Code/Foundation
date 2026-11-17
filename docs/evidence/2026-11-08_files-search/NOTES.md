# Files: search inside documents, paste, folders, one upload tray (2026-11-08)

Josh asked to "improve searching and adding of files". Branch `feat/files-search`.

## What changed

**Search inside documents (server).** PDF, Word, PowerPoint, Excel and OpenDocument files are read after their upload has answered: `filetext.ts` queues them for a worker thread (`extract-worker.ts`), one at a time, each with a 45 s limit and a 768 MB heap. `extract.ts` does the reading: unpdf 1.9.1 (PDF.js's serverless build: no `eval` or `new Function` in it; opened with no fonts, no XFA, no scripting) for PDF, and a small built-in zip reader plus XML text runs for docx/pptx/xlsx and odt/ods/odp. Only named XML parts are inflated, so a `.docm`'s `vbaProject.bin` is never read. Text is kept by sha256 (`file_text`), so the same bytes on another board are searchable at once and never read twice; documents uploaded before this are read in the background at boot (`reindexFilesIfNeeded` → `backfillFileText`). `read_file` returns a document's text (jumping the queue). Snippets come from FTS5 `snippet()` with control-character markers, then «» once the text's own «» are made plain.

**Adding files (client).** Paste onto the board (under the pointer, in the section there); drop whole folders on a section (walked, laid out as a group in path order under a note naming it); one queue (three at a time) and one glass upload tray. ⌘K and the search pane share `lib/snippet.ts`, which brings a match deep in a one-line snippet forward.

**Already true, checked:** uploads were already content-addressed (one copy of the bytes per sha256 on disk; the same bytes to the same board return the same file). Archive-never-delete is unchanged (no code path removes bytes). A viewer's upload is refused by the HTTP write gate (`gateWrites` in index.ts); the client now also says View only before making any card.

## How it was checked

- `apps/server/test/files-text.test.ts` (9): each format's text from hand-made fixtures (`apps/server/test/fixtures/docs/make.mjs` builds them; no third-party files checked in), macros untouched, upload → searchable with «marked» snippets, dedupe by content, `read_file`, a broken PDF found by name and not retried, the boot backfill skipping archived files, snippet markers.
- `apps/server/test/files-text-limits.test.ts` (1): with a 1 ms limit every document is stopped (worker ended), marked failed, still found by name, and the queue goes on.
- `apps/client/test/snippet.test.ts` (4).
- `apps/client/e2e/files.spec.ts` (4), real Chromium against its own server and data:
  - `01_pasted-under-pointer_night.png`: a PNG pasted with the pointer in the section lands floating under it and uploads (`/files/f_…`).
  - `02_folder-drop-tray-at-work_night.png`, `02b_tray-at-work_night.png`: a folder (3 PNGs, a STEP, a PDF and a Word file in subfolders, plus `.DS_Store` and `node_modules`, which are left out) dropped on the section; the upload throttled to 900 KB/s over CDP so the tray is seen at work, never more than three sending.
  - `03_tray-all-added_night.png`, `04_folder-laid-out_night.png`: *6 added*, then the tray goes by itself; the cards are in path order (`CAD/`, `Docs/`, then `front 2`, `front 10`, `side`) after the folder's note.
  - `05_cmdk-inside-documents_{day,night}.png`, `06_search-pane-inside-documents_{day,night}.png`: "osterlund" (page two of the PDF), "zephyrine" (the Word file) and "torque" (both) found, the match marked.
  - A viewer (set by an admin through `/api/boards/:id/people`) pastes: nothing is added, a View only toast; their direct upload gets 403.
- `design_adding-files_{day,night}.png`: `#/design` → Adding files: the tray sending, folded, done and failed, and the snippet rows, in both themes.

## The rest of the suite

`npm test` (server 114 of 120, the rest skipped; client 73) and `npm run typecheck` pass. The full e2e (`E2E_CLIENT_PORT=18451 …`): 35 passed, 2 skipped, 1 failed: `perf.spec.ts` pan p95 50 ms against a 34 ms budget. It fails the same way on `main` (a0b359b) on this machine at the same time (pan p95 50 ms, drag 49.9 ms), with other sessions running; not from this work. `wires.test.ts` "avoiding stays fast" (a 400 ms timing check) failed once in a loaded full run and passes alone.

## Not done / seen

- The folder in the e2e is a stand-in `FileSystemEntry` tree (a page can't make a real directory entry); the app's own walking code reads it, in batches. A real folder dragged from Explorer or Finder wasn't tried by hand.
- The PDF card is blank in headless Chromium (no PDF viewer there); unchanged by this work. The STEP in the e2e is a header only, so its card honestly says OpenCascade couldn't read it.
- No OCR: a scanned PDF is found by its name. Legacy `.doc/.ppt/.xls` aren't read.
- Day screenshots of the board itself cover search; the tray's day look is on `#/design`.
