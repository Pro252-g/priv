# Recorded-video pilot, cashier comparison, and continuity

## Source of truth
Camera recognition is an observation with errors. A difference against cashier quantities is a review signal, never evidence assigning theft or blame. Matching by daily totals cannot identify which order was missing. Validate scene coverage, refunds, complimentary items, waste, returned plates, delayed orders, time boundary and model errors before investigating a discrepancy.

The current pilot imports summary expected quantities. Automated POS integration needs the POS name/export specification or read-only API access. The preferred future integration receives stable order and line IDs, item codes, quantities, status changes, restaurant and timestamp; it deduplicates by source ID, maps cashier item codes to the catalog, and matches dispatch windows. Do not read customer payment/card data for dish counting.

## Power and interrupted monitoring
SQLite and uploaded sample/snapshot files are on persistent storage. An abrupt outage cannot generate records during the outage. A monitoring heartbeat helps discover unexpected silence; its last received timestamp is an approximate bound, not the exact outage time or proof that electricity was the cause. Frozen video, disconnected camera, hidden browser tabs, model failures and service restarts must not appear as verified zero exits. Daily comparison reports indicate incomplete/unverified coverage.

Browser pending records use durable browser storage scoped to the signed-in owner; resend retains the original event identity so server deduplication prevents repeated counts. Storage eviction, cleared browser data, private browsing and unpowered disks can still cause loss. Pending records are not evidence that unseen exits were recorded. The final edge service should persist events locally before transmission and restart under an OS service manager.

Deploy UPS capacity for the camera(s), NVR, edge computer and relevant network switch/router; test runtime under the actual load. NVR recording and an indexed last-processed stream time would permit backfill only when footage exists; automatic NVR reconnect/backfill is not implemented in this pilot. Backfill must use immutable camera/time/object event keys and a reviewed overlap policy to avoid duplicates after restart. Unrecorded footage is irrecoverable.

Maintain off-device backups, access control and restore drills. Do not copy only a live SQLite main file while its WAL has pending writes. Use SQLite's online backup API or stop the service and copy its complete data directory. Restrict access to images and set customer retention and disk quotas before commercial rollout.

## Video experiments
Recorded files are processed locally by the browser. Formats depend on browser support; MP4 H.264 is a practical first choice. Each new analysis is isolated from real operation and POS reconciliation. Experimental events preserve media position; the current date of analysis must not be represented as the real footage capture time. Keep the original file to inspect detections.

A file upload does not train a detector. Generic model support is limited; cups and wine glasses are experimental detections, not proof of drink contents. Real dish classification must be evaluated on unseen restaurant footage. Synthetic model tests show the computation executes, not restaurant accuracy.

Test 1, 2, and 4 simultaneous elements, trays, hands, overlap, speed, returns, low light and recording interruptions against independent human annotations. Count errors and classification errors separately. Choose a documented acceptance threshold before acceptance. Large gaps or ambiguous source footage make an end-of-day report inconclusive.

## Executed pilot checks
Ten Node tests passed, including experiment/live separation, customer isolation, POS revision replay, and monitor gap persistence across service restart. Chromium loaded the real local MobileNet and COCO models and executed inference on a synthetic frame; this does not measure accuracy.

`scripts/browser-workflow-check.mjs` exercises MP4 input, four crossings with an explicit synthetic detector, experiment/live separation, POS entry/CSV mapping, and durable outbox resend after reload. It does not pretend its synthetic detections validate restaurant recognition. It requires optional Playwright, a Chromium executable, and an MP4 fixture at `.local/video-fixture.mp4`. Set `IEP_PLAYWRIGHT_PATH` to Playwright's absolute index.mjs and optionally `IEP_CHROMIUM_PATH`. Generate the fixture with FFmpeg: `ffmpeg -f lavfi -i color=c=white:s=320x240:r=10 -t 1.2 -c:v libx264 -pix_fmt yuv420p .local/video-fixture.mp4`. Then run `node scripts/browser-workflow-check.mjs`.

Manual observed events must be additional physical exits missed by automatic counting, not a second confirmation of already-counted exits. Currently there is no event correction ledger; manually double-counted exits can inflate reconciliation. A full customer rollout needs reviewed event corrections and unknown-crossing records.
