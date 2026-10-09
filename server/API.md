# IEP API
All API responses JSON except CSV/image. Same-origin cookies; mutating requests must have matching Origin if supplied. Password login required. No public registration.
- GET /api/health → {ok:true}
- POST /api/login {email,password} → {user:{id,email,name}} sets HttpOnly SameSite=Lax session cookie. Bootstrap email IEP_ADMIN_EMAIL (default admin@iep.local), password mandatory IEP_ADMIN_PASSWORD (at least 12 characters). IEP_DATA_DIR overrides SQLite directory. Set IEP_SECURE_COOKIE=true behind HTTPS.
- POST /api/logout → {ok:true}; GET /api/me → {user}
- GET /api/restaurants → {restaurants:[{id,name,created_at}]}; POST {name} same path → {restaurant}
- GET /api/dishes?restaurantId=ID → {dishes:[{id,restaurant_id,name,created_at,samples:[{id,url,created_at}]}]}
- POST /api/dishes {restaurantId,name} → {dish}; DELETE /api/dishes/ID → {ok:true}
- POST /api/dishes/ID/samples {image:"data:image/jpeg;base64,..."} (PNG also supported, max 2 MiB decoded) → {sample:{id,url,created_at}}
- DELETE /api/samples/ID → {ok:true}; image URLs require authentication.
- POST /api/events {restaurantId,events:[{dishId,sessionId,trackId,crossingId,camera,occurredAt,confidence,mode,image}]} → {inserted,duplicates}. Identical tenant/session/track/crossing keys counted once; only confirmed line crossing should be sent. Max 200 events. confidence 0..1. mode manual or automatic (default automatic), returned in report events. ISO occurredAt; camera defaults Mobile.
- GET /api/reports?restaurantId=ID&from=ISO&to=ISO → {totals:[{dishId,dishName,count}],events:[{id,dish_id,dish_name,camera,occurred_at,confidence}],total}. Returns latest 1000 events and totals over complete selected period.
- GET /api/reports.csv same query → UTF-8 CSV.
All tenant data belongs to authenticated owner. Unauthorized tenant IDs return 404. Errors {error:string}.

## Separate customer accounts
The prototype has owner accounts only; it has no staff roles or user administration screen. Each separately provisioned owner sees only their restaurants and data.
Start the server once to initialize its database, then securely supply `IEP_NEW_OWNER_EMAIL` and `IEP_NEW_OWNER_PASSWORD` through environment settings (never commit values) and run `node server/provision.mjs` against the same `IEP_DATA_DIR`. This creates an account without modifying existing accounts and refuses duplicate emails. Remove the provisioning password binding after use. The CLI does not print credentials. Restart is unnecessary. Existing bootstrap accounts retain their original password; changing bootstrap environment values does not reset them.

Optional event `image` is a JPEG or PNG data URL, up to 512 KiB decoded; total API body max 3 MiB. Reports include nullable `snapshot_url`. GET that URL requires its owning account. Snapshot storage is opt-in per client event and is persisted in SQLite.

## Video experiments
- POST `/api/experiments` `{restaurantId,name,videoName,durationSec}` → `{experiment}`. Stores metadata only; video remains on the client device.
- GET `/api/experiments?restaurantId=ID` → `{experiments}`; GET `/api/experiments/ID` → `{experiment}`. Entries include parsed `summary`, status, video_name and duration_sec.
- POST `/api/experiments/ID` `{status:"running"|"completed"|"failed",summary:{...}}` updates metadata, bounded summary.
- Events can include `experimentId,mediaTimeSec`; media time must fit experiment duration. GET reports with `experimentId=ID` selects that experiment. **Default reports and reconciliation exclude all experimental events.** Deduplication namespaces experimental sessions by experiment ID; still use a fresh session ID for each independent run.

## POS reconciliation
POST `/api/pos` `{restaurantId,businessDate:"YYYY-MM-DD",revision:"unique-id",items:[{dishId,sold,cancelled,complimentary,waste}]}`. All quantities nonnegative integers; cancelled cannot exceed sold. Expected output = sold − cancelled + complimentary + waste. A revision replaces the complete day's expectation, preserving earlier revisions in audit storage. Repeating the identical revision/payload is idempotent; reusing it for different data gives 409. Replaying an old revision never makes it current again. No POS provider connection is implied.
GET `/api/reconciliation?restaurantId=ID&businessDate=YYYY-MM-DD` → `{businessDate,timeZone:"Africa/Cairo",revision,rows:[{dishId,dishName,automatic,manual,observed,expectedOut,difference,pos}],coverage:{sessions,gaps,warnings,complete:false,note}}`. Difference is observed minus expected. Missing expectations are null rather than invented zeros. Live automatic and manual counts are separate. Calendar grouping uses Africa/Cairo, including daylight saving.

## Monitoring
POST `/api/monitor/start` `{restaurantId,camera,sessionId}` → `{monitor}`. Session ID retry is idempotent, cannot rebind a different restaurant/camera.
POST `/api/monitor/ID/heartbeat` `{}` every 15 seconds and POST `/api/monitor/ID/end` `{reason:"user_stopped"}`.
GET `/api/monitor?restaurantId=ID` → `{monitors,heartbeatIntervalSec:15,staleAfterSec:45}`. Monitors have server timestamps started_at,last_heartbeat,ended_at, status active/stale/ended and gaps. A heartbeat gap begins 45 seconds after last heartbeat, is returned as ongoing when stale, and is persisted when resumed or ended. This works after server restart. Gap cause is unknown; server does not infer electricity or network failure. Heartbeat coverage does not prove accurate recognition or continuous full-day coverage. Reconciliation reports incomplete coverage explicitly.

Fixed model assets are served from `.local/models/{mobilenet,detector}/` under `/models/`. Override root with `IEP_MODELS_DIR`; only model.json and expected shard filenames are exposed.

GET `/api/pos?restaurantId=ID&businessDate=YYYY-MM-DD` returns immutable `revisions` newest first, each including items, created_at, and active flag, for audit review.

Heartbeat body optionally `{status:"running"|"stalled"}`. A client-reported stalled video is recorded as an ongoing `video_stalled` gap and monitor status `stalled`, despite reachable heartbeats. Returning to running or ending persists that interval. Cause video_stalled is the browser report, not independent diagnosis. Missing heartbeats remain unknown. End reasons are bounded strings such as camera_ended/source_stalled/model_failed.
