# Local files, metadata removal and portal uploads

Seven MCP tools in the same server (`remote-browser`) handle local files by **artifact id**:

| Tool | What it does |
|---|---|
| `file_import` | Copies a file the user chose (inside `RBA_IMPORT_ROOTS`) into private plugin storage. Returns artifact id, display name, detected format and MIME (from content, not extension), size, SHA-256 and capabilities. No absolute paths in results. |
| `file_inspect` | One artifact (re-hashes the stored copy) or, without an id, the list. |
| `file_delete` | Deletes the plugin's copy (refused while in use). Not forensic erasure; does **not** delete anything already uploaded, nor your original. |
| `media_inspect` | Identifying metadata: categories, counts and field **names** by default. Values (e.g. GPS coordinates) only with `detailed: true`. |
| `media_sanitize` | Job. Writes a **new** artifact without the policy's metadata, verifies it, and keeps it only if the verdict is `verified_for_policy` or `partial`. |
| `media_verify` | Re-runs verification of a sanitized artifact against its source. |
| `portal_upload` | Job. Uploads one artifact to a portal in a fresh remote session (explicit proxy mode, optional saved account), with staged reporting and the portal's own confirmation. |

`browser_upload` still accepts `filePath` (from `data/uploads/` or `RBA_UPLOAD_ROOTS`) and now also `artifactId`.

## Setup

```bash
npm run doctor            # checks local tools; prints exact install lines
```

| Tool | Needed for | Status | Install |
|---|---|---|---|
| ffmpeg + ffprobe | audio/video removal and verification; image pixel verification | required | `brew install ffmpeg` / `sudo apt install ffmpeg` |
| poppler (pdfinfo, pdftotext, pdftoppm, pdfsig, pdfdetach) | PDF verification (independent of the writer) | required | `brew install poppler` / `sudo apt install poppler-utils` |
| exiftool | optional extra independent check for images | optional | `brew install exiftool` / `sudo apt install libimage-exiftool-perl` |
| qpdf | optional (not used yet) | optional | `brew install qpdf` / `sudo apt install qpdf` |
| `@cantoo/pdf-lib` 2.11.1 | PDF rewriting (npm dependency, maintained fork of pdf-lib) | installed by `npm install` | — |

Nothing is downloaded automatically and no cloud service processes files: everything runs locally. External tools run with an argument array (no shell), a minimal environment, a timeout (`RBA_MEDIA_TOOL_TIMEOUT_SECS`) and are killed on job cancellation; ffmpeg gets `-protocol_whitelist file` and an explicit demuxer so nothing is fetched or probed as a playlist.

`.env` settings (all optional):

```bash
RBA_IMPORT_ROOTS=~/Documents/to-upload      # folders file_import may read; empty = dashboard picker only
RBA_MAX_IMPORT_MB=200
RBA_MAX_IMAGE_MEGAPIXELS=100                 # checked from headers before any decode
RBA_MEDIA_TOOL_TIMEOUT_SECS=300
```

**Choosing a file without a path:** `npm run dashboard -- --open` → Files → choose a file → Import. This loopback page (token, CSRF, Origin and Host checks) is the explicit local selection; a webpage or email cannot trigger it, and `file_import` refuses anything outside `RBA_IMPORT_ROOTS` (symlinks are resolved first; FIFOs, devices and directories are refused).

## Supported formats and removal policies

Supported = inspection, removal **and** output verification implemented and tested in this release.

| Format | Policy | Removed | Kept (content / rendering) | Verification methods |
|---|---|---|---|---|
| JPEG | `image_metadata` | EXIF (GPS, make/model/serials, artist, copyright, software, dates, comments, maker notes, IFD1 thumbnail), XMP + extended XMP, IPTC/Photoshop (APP13), COM comments, MPF previews/depth index, FlashPix, other vendor APPn, JFIF/JFXX thumbnails — **also when these segments sit between scans or before EOI**; C2PA/JUMBF (APP11) only with `allowRemoveContentCredentials` | compressed image data byte-for-byte, ICC profile, APP14 Adobe colour transform, **orientation** (minimal EXIF with only 0x0112); bytes after EOI (e.g. motion-photo video) unless `removeTrailingData` — kept bytes are not inspected, so the verdict is then at most `partial` | own container parser; byte scan (signatures + source values); ffmpeg decoded-pixel hash (independent decoder); optional exiftool |
| PNG | `image_metadata` | tEXt, zTXt, iTXt (incl. XMP), eXIf, legacy exIf/zxIf, tIME, **unknown ancillary chunks** (named in the report; not needed for rendering); caBX (C2PA) only with `allowRemoveContentCredentials` | IDAT data, iCCP/sRGB/gAMA/cHRM, tRNS, pHYs, APNG chunks, orientation (minimal eXIf). Unknown **critical** chunks → refused | same as JPEG |
| WebP | `image_metadata` | EXIF, XMP and unknown chunks (VP8X flags updated); C2PA only with `allowRemoveContentCredentials` | image chunks, ICCP, ALPH, ANIM/ANMF, orientation (minimal EXIF) | same as JPEG (animated WebP: pixel check may be unavailable → `partial`) |
| PDF | `pdf_document_properties` | document info dictionary (all keys incl. custom), every XMP `/Metadata` stream, `/PieceInfo`, unreachable objects, **prior incremental revisions** (single uncompressed rewrite) | page content, annotations (incl. `/T` author names), embedded files, JavaScript, hidden layers, form values | Poppler (not the writer): properties/XMP/page count/sizes, text identical, rendering identical (first 20 pages at 36 dpi), embedded files kept; single revision; byte scan of raw and decoded streams (Latin-1, UTF-16BE, hex) |
| MP3 | `av_container_tags` | ID3 text frames, ID3v1, stream tags | audio frames, artwork (unmodified; **inspected** — identifying EXIF/GPS in the cover makes the verdict `partial`) | ffprobe + ffmpeg streamhash (**same engine** as the writer); byte scan; artwork through the image inspector |
| FLAC | `av_container_tags` | Vorbis comments | audio, artwork (unmodified; inspected as for MP3), STREAMINFO | ffprobe, streamhash (same engine); STREAMINFO MD5 equal; byte scan |
| WAV | `av_container_tags` | LIST-INFO, bext, iXML, id3 chunks | PCM data | ffprobe, streamhash (same engine); RIFF chunk walk; byte scan |
| M4A | `av_container_tags` | container/stream tags, creation times | audio, chapters with titles, language | as MP4; own fixture test (same pipeline as MP4) |
| MP4 / MOV | `av_container_tags` | global tags incl. GPS location (`©xyz`, ISO6709), make/model/software, artist, comment, dates; stream tags (handler names, encoder, creation_time) | every audio/video/subtitle stream byte-for-byte, language codes, dispositions, **rotation**, **chapters with titles** | ffprobe (tags, streams, chapters, rotation, duration), streamhash packet identity (same engine); byte scan for location keys and source values |

Explicit decisions (the tool refuses until set): **signed PDFs** → `allowInvalidateSignatures: true` (any rewrite invalidates signatures; signatures are detected via pdfsig, raw markers and the parsed object graph, and an inconclusive pdfsig also requires the decision); **C2PA content credentials** in images → `allowRemoveContentCredentials: true` (removal invalidates the provenance record); **data streams** in MP4/MOV (timecode, GoPro/drone telemetry which may contain GPS) → `dropDataStreams: true`; JPEG trailing data → `removeTrailingData: true` (kept by default because it is content). **Encrypted PDFs are refused.**

**Unsupported in this release** (reported as `unsupported`, never processed):

| Format | Why |
|---|---|
| TIFF | metadata lives inside the image IFD structure (often multi-page, private tags); safe rewriting needs ExifTool-class handling not implemented and verified here |
| MKV/WebM | attachments (fonts, images) and nested tags need their own policy and verification |
| DOCX / PPTX / XLSX | properties, comments, tracked changes, hidden sheets/slides and embedded objects need separate handling, and verifying output needs an independent Office renderer (LibreOffice is not available); not silently modified |

Tool strings that remain and are disclosed: muxers may write a short tool identifier ("Lavf…" in FLAC vendor strings / MP3 Xing headers) and the MOV muxer writes the codec vendor code "FFMP" in place of the source's. Embedded artwork is kept unmodified; it is inspected and any identifying metadata in it is listed as residual (clean the image separately and re-embed it if needed).

## Verdicts (exact meanings)

Every verification report has three separate lists:

- `residual`: **targeted** metadata of the policy that is still detectable by one of the listed methods (including a removed field's value found elsewhere in the file, outside the structures below).
- `retainedFindings`: **privacy-relevant information kept by design** in preserved structures. Examples:
  - PDF: annotation author names (`/T`), annotation comment text, filled form fields, embedded files, embedded JPEGs that still carry their own EXIF/XMP.
  - Audio/video: chapter titles, artwork images.
  - Images: any ICC profile that is not byte-identical (apart from its date and ID) to a known published profile (sRGB IEC61966-2.1, Display P3, Adobe RGB (1998) and other system profiles; see `src/files/icc-known.ts`). Its text tags, header device/creator/date fields, private tags and hidden bytes are listed, and a standard-sounding name is never trusted. A removed field's value that also appears in the ICC profile is listed too. Profiles that phones embed are only recognised once their exact bytes are in the list, so until then such photos report ICC findings.
  - None of these is deleted automatically: they are content or are needed for rendering.
- `inspectionGaps`: preserved structures that were **not inspected**, for example:
  - the contents of PDF embedded files, hidden layers or JavaScript
  - subtitle text
  - an ICC profile that could not be parsed, or ICC tags of unknown type
  - PDF streams the byte scan could not decode (size cap), and embedded artwork that could not be extracted or is in an unsupported format

Verdicts:

| Verdict | Meaning |
|---|---|
| `verified_for_policy` | The fields targeted by the named policy were not detected in the output by the listed methods, the content structure (pixels / pages+text+rendering / streams+packets) is intact, and the source is unchanged. It says **nothing** about `retainedFindings` or `inspectionGaps`, which may be non-empty. It is not a statement that the file contains no identifying information. |
| `partial` | Structure intact, but `residual` is non-empty (or a structural check could not be performed). |
| `failed` | Output unreadable, content changed, or source changed. The output is deleted, never promoted. |
| `unsupported` | No handler; nothing changed. |

Each result carries a one-line `summary` with exactly this wording, plus `methods`, `sameEngine` and `limitations`.

**Uploads under `requireSanitized`:**
1. The artifact must be a sanitized output with verdict `verified_for_policy`.
2. Its stored verification must come from the **current inspection policy version** (`image_metadata@2`, `pdf_document_properties@2`, `av_container_tags@2`). A verification made before policy versions existed, or under an older version, is refused with `needsDecision: reverify`: run `media_verify` again. It cannot be accepted instead of re-verifying. The one exception: if the source was deleted (so verification cannot be re-run), the stored report is *frozen* and that fact is listed as an inspection gap, which can be accepted as in step 3.
3. If the report lists any `retainedFindings` or `inspectionGaps`, the upload is refused (before any session starts) with `needsDecision: acceptRetainedFindings` and an `acceptanceDigest` (`acc1:<sha256>`). The refusal includes the policy, verdict, summary, residual list, findings and gaps. `media_sanitize` and `media_verify` return the same digest.
4. Show those to the user; upload only with `acceptRetainedFindings: "<acceptanceDigest>"` after they accept. The digest covers the artifact id and SHA-256, the source SHA-256, the policy and its version, the verdict, residual, findings, gaps and the id of that verification run. Any change (another artifact, a new sanitize or verify run, a policy version change) gives a different digest, and an old one is refused. `true` is refused with instructions. Each accepted upload is recorded in `file_acceptances`. The digest binds the decision to what was shown; it cannot prove that a person saw it.
5. The file is sent as `upload.<ext>` unless `uploadFileName` is given (the original file name can identify the user); the result reports the name used.

`browser_upload` with an `artifactId` applies the same gate (`requireSanitized`, `acceptRetainedFindings`, `uploadFileName`), locks the artifact while sending and re-checks its stored hash.

The `sanitization` block is also included in `needs_input` and upload results.

## portal_upload

1. **Without** `fileInputSelector` + `submitSelector`: opens the target, lists the file inputs and submit buttons it observed, returns `needs_input`. No file is selected.
2. **With** them: checks before any paid session (target origin allowed for the account or `RBA_ALLOWED_ORIGINS`; size ≤ `RBA_MAX_UPLOAD_MB`; `requireSanitized` → only a sanitized artifact `verified_for_policy`; no earlier upload of the same bytes to the same target unless `allowRepeat`), then: session (explicit `proxyMode`; `accountId` restores the saved login) → navigate → transfer bytes to the worker (size + SHA-256 verified) → select in the file input → one submit click (optional `dialog` policy) → read the confirmation (`selector`, `textContains`, optional `sizeSelector`/`sha256Selector` compared with the artifact) → close the session.
3. Stages reported separately: `transferredToWorker`, `selectedInBrowser` (selecting can already transmit on some pages), `sentToDestination`, `portalConfirmed`. Outcome: `portal_confirmed`, `sent_unconfirmed`, `outcome_unknown` (submit timed out: the page is inspected, nothing is retried, a repeat is refused), `needs_input`. The job status follows the outcome: only `portal_confirmed` (or `needs_input`) is `completed`; `sent_unconfirmed` is `completed_unconfirmed` (a click, a page load or a displayed filename is not a confirmation) and `outcome_unknown` is `outcome_unknown`. Each step (`session_ready`, `file_transferred`, `file_selected`, `form_submitted`, `confirmation_observed` / `confirmation_missing`) is recorded with its evidence in `job_status`.
4. Authorisation: the request authorises uploading that file. It does **not** authorise submitting an application, publishing, paying or accepting terms; stop and ask.

The worker's code passes the file to the browser from memory and writes no copy of its own; Chromium may page large blobs into its temporary profile directory, which is removed with the browser (remote: the container is destroyed when the session closes; local: the temporary run directory is removed when the worker process exits; if this computer crashes first, leftovers can remain under the data directory's `local-runs/`). Deleting the plugin's copy does not remove copies the portal already has.

## Usage examples (installed plugin, plain language)

- *"Import ~/Documents/to-upload/scan.pdf and tell me what identifying metadata it has."* → `file_import {path}` → `media_inspect {artifactId}`
- *"Remove its metadata and verify the cleaned copy."* → `media_sanitize {artifactId, waitSecs: 60}` → `media_verify {artifactId: <output>}`
- *"Show me the actual GPS values."* (only when you want them) → `media_inspect {artifactId, detailed: true}`
- *"Upload the cleaned copy to https://portal.example/upload."* → `portal_upload {artifactId, targetUrl, proxyMode: "direct"}` (returns `needs_input` with the controls) → confirm with you → `portal_upload {..., fileInputSelector, submitSelector, confirmation: {...}, requireSanitized: true}`
- *"Delete both copies from the plugin."* → `file_delete {artifactId, confirmArtifactId}` for each

## Cleanup and lifecycle

- Temp files live in `data/files/tmp/` and are removed on success, failure and cancellation; leftovers older than an hour are swept at MCP-server startup.
- An artifact used by a running sanitize or upload is locked; `file_delete` refuses while locked. Locks expire, and are released when a crashed job is recovered at startup (an interrupted upload after its submit is recorded as **outcome unknown**).
- Deleting a source freezes its sanitized outputs at their stored verdict (`media_verify` then reports that the source is gone). Sanitizing an already-sanitized output is allowed.
- Storage: `data/files/` (0700, files 0600, git-ignored). Deletion is an ordinary unlink; the database row keeps only a tombstone (id, hash, dates) and the original file name and stored report are cleared. Temp leftovers are swept at startup and at most every 10 minutes during sanitization.
- Import is validated, hashed, format-detected and copied from **one file descriptor** (O_NOFOLLOW, O_NONBLOCK).
  - **Identity check:** after opening, the descriptor must be the single-link file (same device/inode, link count 1) that an in-root path resolves to at that moment.
    - This detects a parent directory swapped to a symlink before the open (and swapped back), as well as hard links, and refuses the import.
    - The only way to satisfy it is for the file to actually be inside the root. On Linux the descriptor's own path (`/proc/self/fd`) is also checked.
  - **Snapshot check:** a second `fstat` after copying must show the same size, nanosecond mtime/ctime and identity, and the bytes read must equal the size. Otherwise the import is rejected as "changed while being imported". This *detects* ordinary concurrent writes; it is not a lock and does not prevent them.
  - **macOS limitation:** Node has no `openat`/`F_GETPATH`, so there the protection rests on the identity check, not on resolving the path relative to a directory descriptor. A change that leaves size, mtime and ctime identical (for example a writer that restores timestamps on a filesystem with coarse timestamps) is not detectable.
  - Private directory permissions are an additional safeguard, not a substitute for these checks.
- Resource bounds: images are refused above `RBA_MAX_IMAGE_MEGAPIXELS` before decoding; PDF stream decoding for the byte scan is capped (8 MB per stream, 64 MB total; skipped streams are reported); the revision scan is bounded; every external tool has a timeout. Files are read into memory up to `RBA_MAX_IMPORT_MB`; lower it on small machines.
- portal_upload records "possibly sent" **before** the file is selected; it is withdrawn only when the worker refused before selection (bad selector, not a file input, size or origin).
