# Manual Subtitle Upload — Design

**Date:** 2026-06-14
**Status:** Approved (Approach A)

## Goal

Let a user upload a ready-made Hebrew subtitle file (`.srt`) from their device for a
specific title. The uploaded file is stored on the server and then surfaced by the
Stremio addon in the player, exactly like an AI-generated translation — no AI
translation step involved.

## Decisions (from brainstorming)

1. **Language:** Hebrew only (`heb`) — matches the rest of the addon, no manifest change.
2. **Content identification:** Reuse the existing TMDB search flow (search → pick
   title → for series pick season/episode). The `imdbId` is resolved automatically.
3. **File format:** SRT only. VTT and other formats are rejected with a clear message.

## Approach A — Upload as a pseudo-provider `"upload"`

The cache, library, and Stremio handler already support **multiple sources per
title**, keyed by a provider *string*. We introduce `"upload"` as a provider string
(NOT a real provider object — there is nothing to search or download). The existing
serving/library/cache-rebuild code treats it uniformly, so the new file shows up in
Stremio automatically.

### Components & changes

- **`subtitleCache.js`**
  - Add `"upload"` to `KNOWN_PROVIDERS` so `rebuildFromDisk`, disk-scan fallback, and
    `containsKnownProviderSuffix` recognize `<title>_heb_upload.srt`.

- **`index.js`**
  - Raise the JSON body limit (`express.json({ limit: '5mb' })`) so SRT payloads sent
    as a JSON string field aren't truncated (default ~100 kb).
  - Add constants `UPLOAD_PROVIDER = 'upload'` and a Hebrew display name
    `'העלאה ידנית'`.
  - New endpoint **`POST /api/upload`** (see contract below).
  - In the Stremio subtitles handler, show a friendly track name for the upload
    provider (`עברית (הועלה ידנית)`) instead of the raw `(upload)` tag.

- **`public/index.html`**
  - In the source-picker modal, add an "Upload your own file" button at the top
    (before the provider list).
  - A hidden `<input type="file" accept=".srt">`; clicking the button opens it.
  - On file select: validate extension `.srt` and size (≤ 5 MB) client-side, read the
    file as text, `POST /api/upload` with `pendingCtx` metadata, toast the result, and
    refresh the library list.

### `POST /api/upload` contract

Request (JSON):
```json
{
  "imdbId": "tt1234567",
  "type": "movie | tv | series",
  "title": "Movie Title",
  "poster": "https://...",   // optional
  "year": "2021",            // optional
  "season": "1",             // series only
  "episode": "5",            // series only
  "srt": "1\n00:00:01,000 --> 00:00:03,000\nשלום\n\n..."
}
```

Server behavior:
1. Validate `imdbId` and non-empty `srt` string → 400 on missing.
2. Strip a leading BOM. Reject content starting with `WEBVTT` → 400 (`SRT only`).
3. `srtParser.validate(content)` → 400 if no valid blocks.
4. Normalize via `srtParser.parse` → `srtParser.build` (clean indices + line endings).
5. `contentId` = `imdbId` for movies, `imdbId:season:episode` for series.
6. `cache.setCached(contentId, 'heb', normalized, contentId, 'upload')`.
7. Upsert one library row keyed by `libraryKey(contentId, 'upload')`.

Response: `{ "status": "done", "filename": "...", "provider": "upload", "blocks": N }`.

### Data flow

```
Browser (file) ──POST /api/upload──> validate+normalize ──> cache.setCached(...,'upload')
                                                          └─> library.json upsert
Stremio player ──subtitles handler──> listVariantsForContent(id) ──> serves _heb_upload.srt
```

## Error handling

- Missing imdbId / srt → 400 with Hebrew message.
- VTT or non-SRT content → 400 "קובץ VTT אינו נתמך — העלה קובץ SRT".
- Unparseable SRT → 400 "קובץ כתוביות לא תקין".
- Client-side: wrong extension or > 5 MB → toast, no request sent.

## Edge cases & limitations

- **Encoding:** Read as UTF-8 (BOM stripped). Legacy Windows-1255 (Hebrew ANSI)
  files are out of scope — they would store mojibake. Documented limitation.
- **Re-upload:** Overwrites the single `upload` variant for that content (one manual
  track per title). Acceptable for v1.
- **Series:** Requires season+episode (already provided by the existing flow).

## Testing

- `test-upload.js` (node script, matching existing test style): start the server or
  call the handler logic to POST a small SRT, assert it is cached, listed as a
  variant, and that an invalid/VTT payload is rejected.

## Out of scope (YAGNI)

- Multi-language uploads, VTT/ASS ingestion, charset auto-detection, uploading an
  English source to be translated, multiple manual variants per title.
