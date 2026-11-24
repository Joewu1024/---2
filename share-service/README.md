# Persistent product shares

**Source prepared; not deployed or enabled by this directory.** No Cloudflare resource IDs or credentials are included. The current GitHub Pages workbench must keep its existing sharing path until this service has been provisioned, deployed, and verified with a real create/read operation. A build or a successful `/health` response alone does not prove persistence.

This Worker replaces data-filled URLs with immutable snapshots under `/s/<random-id>`. It stores metadata in D1 and the selected products' JSON, rendered HTML, and downloaded model images in R2. The short URL renders HTML directly without redirects, remote scripts, browser storage, or a login requirement for recipients. Existing long-form `share.html#d=...` URLs remain a separate compatible reader.

## Deploying

1. Use an already authorized Cloudflare account or the native Sites registration workflow. This source does not sign in, create an account, accept terms, or claim that infrastructure exists.
2. Provision one D1 database and one private R2 bucket. Apply `migrations/0001.sql` once before serving requests. For Wrangler, copy `wrangler.example.toml` to ignored `wrangler.toml` and fill in the actual D1 ID and actual database/bucket names. Use `wrangler d1 migrations apply <real-database-name> --remote`, then `wrangler deploy`. These mutations require the account's authorization.
3. Bind D1 as `DB` and R2 as `BUCKET`. A native Sites Worker build can use the same module at `dist/server/index.js` and a real `.openai/hosting.json` with its returned `project_id`, `d1: "DB"`, and `r2: "BUCKET"`; do not invent a project ID or add `static` to that Worker manifest.
4. Set `PUBLIC_BASE_URL` to the final HTTPS service URL if its canonical address or path differs from the incoming origin. `ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS workbench origins. The existing `https://joewu1024.github.io` origin and the Worker's own origin are allowed by default. This is CORS policy, not the write authorization.
5. Verify a new writer, a new share, the returned page and its images from a fresh browser context. Repeat with JavaScript disabled. Only then configure the workbench's persistent-share client to use that live service address and publish its integration.

The Wrangler example is a template, not a working deployment manifest. There are no npm runtime dependencies. The Worker uses Web Crypto, Fetch, D1 and R2 APIs. Run local tests with a Node version that supplies `node:sqlite` (for example Node 24):

```text
node --test share-service/test/worker.test.mjs
```

## API contract

All JSON writes require `Content-Type: application/json` and an allowed `Origin`. The browser supplies Origin automatically. `OPTIONS` accepts only allowed origins. No cookies or Cloudflare owner credentials belong in the workbench bundle.

- `POST /api/writers`, body `{}` → `201 {"token":"<22 base64url chars>.<43 base64url chars>"}`. The 256-bit secret is returned once; D1 keeps only its SHA-256 hash. The client stores this device's token privately, not in the shared URL. Registration is automatic and has daily global and IP quotas.
- `POST /api/shares`, `Authorization: Bearer <token>`, body `{v:1, requestId:<8–80 ASCII letters/digits/-/_>, products:[...]}`. Use one UUID per generation and preserve it for retries of that request. A newly committed snapshot returns `201 {id,url,persisted:true,productCount,imagesArchived,imageFailures}`. Replaying the same writer/request/content returns `200` with the same URL; changing that content returns `409`. An in-flight duplicate returns `409 SHARE_PENDING`. A failed generation needs a fresh request ID.
- `GET /s/<id>` and `HEAD /s/<id>` → public HTML for a committed snapshot. Pending, failed or unknown IDs do not reveal partial content. HTML errors contain an explanation instead of an empty page. There is no expiry field or age-based read check.
- `GET /s/<id>/images/<sha256>` and `HEAD` → a stored image from that exact share. It never fetches the original CDN during viewing and cannot read a different share's bucket prefix.
- `GET /health` → `{ok:true, storage:"configured"}` only when both bindings are present. This checks configuration, not an actual write.

Errors return `{error:{code,message}}` with a suitable HTTP status (`400/401/403/409/413/415/429/503`). A `429` includes `Retry-After`; clients must avoid automatic retry loops. Do not silently present a long URL as a successful saved short URL.

Products use only `id`, `model`, `itemChinese`, `modelChinese`, `category`, `invitation`, `target`, `shopee`, `shopeeUrl`, and `badges:[{kind,icon,text}]`. Unknown source fields, buyer notes and unselected records are discarded by the server allowlist. String values, including empty, whitespace-only, English, mixed-language and buyer-edited values, are kept exactly in the stored manifest; sharing does not trigger translation. HTML is escaped, and unsafe links are rendered as text.

`imagesArchived` counts products whose non-whitespace `model` source was saved; the same successfully saved image used by two products counts as two. `imageFailures` contains `{index,message}` for every nonempty source that could not be saved (zero-based product index). Thus `imagesArchived + imageFailures.length` equals the number of nonempty model sources. Image failures appear as explicit placeholders/warnings in the page. The API never claims an inaccessible external image was archived.

## Limits and authorization boundary

Defaults are 200 products, a 2 MiB JSON body, 20,000 characters per ordinary field, 8 MiB per image and 32 MiB unique image bytes per share. Trusted, exact HTTPS Shopee CDN host names are listed in `worker.mjs`. Every redirect is manual and revalidated; arbitrary host names, IP literals, credentials, non-HTTPS sources and SVG are rejected. Raster images must pass both media-type and byte-signature validation. New countries/CDNs require a deliberate allowlist update. Each remote request has a deadline of at most 12 seconds across redirects, and total image preparation has a 45-second wall-clock budget (`MAX_IMAGE_ARCHIVE_MS`, up to 60 seconds). Duplicate successful and failed sources are reused within the generation. Products not archived within the budget are explicitly recorded as image failures, while their text fields remain stored.

Remote image fetches, including every redirect hop, have a separate budget of 24 per generation (`MAX_REMOTE_IMAGE_FETCHES`, capped at 32). Remaining remote sources receive explicit failures instead of silently exceeding the runtime's external subrequest limit. The product limit is not a promise that 200 distinct images can be downloaded in one request. Test the selected account's CPU, storage and subrequest allowances before enabling the service. Current [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) distinguish Free and Paid CPU/subrequest allowances; local Node timings cannot establish deployed Worker capacity.

Daily default quotas (UTC days): writer registrations 10 per IP / 200 global; share generations 50 per writer / 50 per IP / 200 global; 1 GiB reserved stored bytes global per day. A separate lifetime reservation quota defaults to 8 GiB (`GLOBAL_BYTES_TOTAL_LIMIT`). Daily and lifetime bytes are reserved in one atomic D1 batch. Exhausting capacity rejects new generation with an explicit storage-limit error; it does not expire or delete older ready snapshots. The authorized owner may adjust capacity after reviewing usage and the account's cost policy. This is bounded storage, not an unlimited or unconditionally free service. Exact environment variable names are documented in `wrangler.example.toml`. Quota triggers abort the whole reservation batch on overflow, including concurrent requests. A share's writer/request ID is unique. IDs use 128 random bits (22 base64url characters), contain no business data, and do not grant write access.

Anonymous registration intentionally permits public users with available quota to obtain a limited writer account. Capabilities protect existing ownership, and global/IP/writer quotas bound abuse; this does **not** authenticate a person as a company buyer. If only identified employees may publish, replace anonymous registration with a real login or owner-issued invitations before exposing that restricted policy. CORS or a browser-visible fixed key cannot enforce employee membership.

There is no public edit, overwrite or deletion endpoint for saved snapshots. Bucket objects are written under the newly reserved random share ID; the HTML pointer becomes readable only after storage succeeds and the D1 status commits. Failure cleanup deletes only objects created under that request's new ID after D1 has explicitly confirmed its failed status and ownership. A lost commit acknowledgement cannot trigger deletion of a ready snapshot: ready status returns the persisted result after verifying its HTML; an unreadable or uncertain commit state retains the objects. Orphaned objects may therefore require later authorized inspection instead of unsafe automatic deletion. Quota reservations may consume part of the day's allowance after a failure, deliberately preferring a bounded service to automatic retries that bypass limits.

## Retention

Ready snapshots have no automatic expiration. Do not configure a bucket lifecycle rule that expires the `shares/` prefix. Availability still depends on maintaining the account, D1 database, bucket, Worker, domain and billing; no provider can be truthfully described as unconditionally permanent. Keep recoverable backups of D1 and R2 through the account's authorized operations. The selected-product manifest and the already rendered HTML are both preserved in each share prefix so content remains recoverable independently of a particular viewer implementation.
