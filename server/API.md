# IEP API 0.4.0

Runtime source of truth: authenticated `GET /api/openapi`. [OpenAPI snapshot](../docs/openapi.json), [Arabic integration contract](../docs/INTEGRATION_GUIDE.md), [installation and acceptance guide](../docs/EXECUTION_GUIDE.md).

## Authentication and validation

Browser sessions use HttpOnly/SameSite=Lax cookies; service calls use `Authorization: Bearer <INTEGRATION_KEY>` over HTTPS. `IEP_ADMIN_PASSWORD` requires at least12 characters. `IEP_ADMIN_EMAIL` defaults toadmin@iep.local. Changing bootstrap values does not reset existing passwords. Use `server/provision.mjs` with private IEP_NEW_OWNER_EMAIL/IEP_NEW_OWNER_PASSWORD bindings for a new tenant.

Tenant ownership, actual resource restaurant, staff assignments, capabilities and integration-key scopes apply together. A caller-supplied restaurantId cannot override an existing resource's scope. Changing user role/restaurants or disabling it revokes earlier sessions and keys. Keys cannot manage identities or approve days. Engineers cannot accessPOS.

Mutation bodies and nested event/POS rows must be JSON objects. Timestamps require valid ISO strings with explicit timezone, Z oroffset, and normalize toUTC; null, numbers, invalid dates and timezoneless strings return400. Bodies are bounded to3MiB. Origin must match when supplied; no unrestricted CORS.

Set IEP_SECURE_COOKIE=true behindHTTPS. IEP_TRUSTED_PROXY_IPS is a comma-separated list of exact peerIP addresses, notCIDR. Untrusted peers cannot choose an address throughX-Forwarded-For. Trusted chains resolve from the nearest hop to the first untrusted hop. Client and account login rate limits both apply.

Errors: `{error:string}` with400 validation,401 auth,403 capability,404 missing/out-of-scope,409 immutable payload or state conflict,413 size,429 login limit. Public GET `/api/health` is API liveness, not source/model health.

## Catalog, reference images and models

| Route | Capability and contract |
|---|---|
| GET/POST `/api/restaurants` | catalog.read / restaurants.write; list assigned orcreate name |
| GET `/api/dishes?restaurantId=ID` | catalog.read; active items, references, media status and persistent ambiguity warnings |
| POST `/api/dishes` | catalog.write; restaurantId,name,kind=dish/drink/object/person,recognitionMode=reference/detector,detectorClasses |
| POST `/api/dishes/ID` | Partial catalog update; cannot move restaurant |
| DELETE `/api/dishes/ID` | Archive without deleting history |
| GET `/api/recognition/classes` | catalog.read; COCO80 plus tenant custom labels |
| GET `/api/model-profiles` or `/api/model-profiles/ID` | catalog.read; paginated list orspecific profile |
| POST `/api/model-profiles` | integrations.manage; name,modelSha25664hex,version,classes:[{name,label}],1..256labels |
| POST `/api/dishes/ID/samples` | catalog.write; JPEG/PNG dataURL≤2MiB decoded,variantLabel≤100 |
| GET/DELETE `/api/samples/ID` | Protected image / audited reference deletion |

COCO does not containplate. Profile registration does not train or modify browser COCO; matching ONNX weights and ordered labels must be installed and verified onedge. detectorClasses accepts tenant vocabulary, up to256 selections. Reference variants share dishId; duplicate dish+imageSHA256+variant uploads deduplicate.

New images are private filesystem files; SQLite stores image_key/media_status. Catalog never returnsBLOBs. Image routes require actual restaurant access. Legacy BLOB migration takes a verified DB backup first and preserves originalBLOBs on failedwrites. Status isready/pending/missing/corrupt/legacy/none. Reference create/delete audit includes actor/key/hash/variant/restaurant. Backups require bothDB and media; S3/MinIO adapter is not implemented.

## Sources, leases and diagnostics

| Route | Capability and contract |
|---|---|
| GET `/api/sources?restaurantId=ID` | monitor.read; registry/config/sanitized health |
| POST `/api/sources` | integrations.manage; restaurantId,sourceId,name,kind,config |
| GET/POST `/api/sources/ID` | monitor.read / integrations.manage; read orupdate name/enabled/config |
| POST `/api/sources/ID/lease` | monitor.write; bootId,ttlSec(default45,30..60); returnsleaseId/expiresAt/serverTime |
| GET/POST `/api/sources/ID/health` | monitor.read/write; sequenced health |
| GET/POST `/api/sources/ID/gaps` | monitor.read/write; paginated immutable gaps |

sourceId matches `[A-Za-z0-9][A-Za-z0-9_.-]{0,179}` and is unique pertenant. kind=rtsp/usb/browser/file. Config accepts only normalizedroi[x,y,w,h], line{orientation,position,direction}, targetFps.1..30,maxObjects1..40 and optional tenant-ownedmodelProfileId. URLs/passwords remain in private edge configuration; they are forbidden in APIconfig. Worker calibration/modelSHA256/labels must match registry.

An active lease rejects a different bootId409. The same boot renews its interval; renewal afterexpiry creates a new leaseId rather than extending an expired window retroactively. Live rtsp/usb known andunknown events require sourceId/sourceLeaseId and occurredAt inside the storedinterval. Previously queued valid-window events can upload later. Worker stops counting when lease expires, normally45 seconds after failedrenewal. NTP and one producer perphysical source are required. Browser and fileexperiments are exempt inthisversion.

Health body `{status,bootId,sequence,observedAt,metrics,errorCode}`. Status starting/running/stalled/offline/error. Only nonnegative fps/frameAgeSec/queueDepth/oldestQueueAgeSec/freeDiskBytes/inferenceMs metrics; queueDepth/freeDiskBytes are integers. No rawmessage/exception/config fields. Codes none/decoder_unavailable/source_unreachable/auth_failed/inference_failed/storage_full/upload_failed/calibration_required. Sequence increases perboot; identicalretry idempotent, stale/changed409. GET addsreceivedAt/ageSec/stale after45 seconds. Telemetry doesnot prove complete oraccurate counts.

Gap body `{gapId,startAt,endAt,cause,recoverable}` with explicittimezoneISO, end>start and strictboolean. Causes power_loss/source_unreachable/video_stalled/upload_failed/inference_failed/process_restart/unknown. Samepayload retry deduplicates, changedpayload409. Gaps join dailyreconciliation; recoverable doesnot mean backfill completed.

## Crossing events, review and historical integrity

POST `/api/events` `{restaurantId,events:[{dishId,sessionId,trackId,crossingId,camera,occurredAt,confidence,mode,image?,sourceId?,sourceLeaseId?,experimentId?,mediaTimeSec?}]}`. Max200events. confidence0..1; automatic uses events.write, manual uses events.manual. camera defaultsMobile. JPEG/PNG snapshot≤512KiB. Experiment media position0..duration+1, withmatchingexperimentId. Dish must belong torestaurant. New events at/afterarchive409; originalprearchive retries remainpossible.

Typed identity includes owner,restaurant,explicitlive/experimentnamespace,experimentId andoriginalsession/track/crossing. User-chosen sessionstrings cannotcollide with experimentnamespace. Known andunknown shareonecrossing registry and produceoneevent irrespective ofarrivalorder ormanualconfirmation. Stable retry returnsinserted/duplicates; changed item/time/camera/confidence/mode/source/lease/media-position409. Unknown reason/time/source/lease changes likewise409.

Image repair keeps originalpayload andbytes. mediaPending>0 meansmetadata accepted but image needsretry; do notacknowledge anothercount. Different imagebytes409. Missing evidence doesnoterase event. GET `/api/events/ID/snapshot` requiresreports.read andactualrestaurant access.

POST `/api/unknown-events` max100, events.write, sameidentity/time plusreason withoutdish/confidence. Unresolved rows excludeconfirmed totals. POST `/api/unknown-events/ID/resolve` `{action:confirm|exclude,dishId?,reason}` needsday.approve; identicalresolution idempotent, conflict409. Confirm reuses existingcrossing event and rejects dish archived atcrossingtime. Excluded crossings cannot silently become known.

POST `/api/events/ID/corrections` `{action:void|reclassify,dishId?,reason}` preserves originals and applies latest correction; GET returns history. Replacementname is captured andarchivepolicy is consistent. New liveevent/unknown/correction invalidates approvedday; experiments stayisolated.

Migration preserves numericIDs/media. Older review doublecounts become auditedduplicate aliases, notdeletedrecords; countview excludes aliases and affectedapproveddays become needs_review. New eventnames are snapshots. Names changed beforemigration cannotbe reconstructed; currentavailable names backfill those legacyrows. Totals remainone row perdishId: singlehistoricalname, otherwisecurrentname plushistoricalNames list. Eventrows usecapturednames.

## Bounded historical reads

| Route | Filters and cursor |
|---|---|
| `/api/reports` | restaurantId,businessDate orfromDate/toDate orfrom/to, optionalexperimentId; limit1..200 +bothbeforeOccurredAt/beforeId |
| `/api/unknown-events` | restaurantId, optionalexperimentId,businessDate/fromDate/toDate,state=unresolved/resolved/all; limit1..200 default100,beforeId |
| `/api/experiments` | restaurantId,businessDate oncreation; limit1..100 default50,beforeId |
| `/api/monitor` | restaurantId,businessDate onintervaloverlap; limit1..200 default100,beforeId |
| `/api/model-profiles` | limit1..100 default50,beforeId |
| `/api/sources/ID/gaps` | limit1..200 default100,beforeId |

Paged responses havehasMore/nextBeforeId; reports usesnextCursor{beforeOccurredAt,beforeId}. Reporttotals cover thecompleteperiod; no paginationparameters preserves latest1000events compatibility. reports.csv exports aggregatecounts. Cairo/DST-aware dayinterval is[from,to); SQLdayfilters precedelimits. Reconciliationreturns up to1000monitors withsessionsTruncated/warning whenneeded; paginatedmonitor exposesremaininghistory. Latearrivals canrequire reloadingexportperiod anddeduplicatingIDs.

## Experiments, POS, governance and operation

POST `/api/experiments` `{restaurantId,name,videoName,durationSec0..86400}` storesmetadata only. GET `/api/experiments/ID` parses summary. POSTsamepath `{status:running|completed|failed,summary:object}` allows up to256KiB encodedJSON.

File runs atomicallyclaim summary.edgeBinding `{fileSha256,fingerprint,experimentId,catalogFingerprint?}`, with64lowercasehex hashes. Currentworker suppliescatalogFingerprint; legacyAPIbindings mayomitit. Concurrentdifferent firstclaims409; later differentfile/config/catalog409. Replacing summary cannotdelete binding. A different analysis requiresnewexperiment. Provenance includesactualcatalog/referencecontentidentities andconfig/model manifests. Default reports andPOS excludeexperiment events. Still-image duration0 ispresenceonly, withoutoperationalevents. AutomaticNVRhistory backfill isnotimplemented.

POST `/api/pos` `{restaurantId,businessDate,revision,items:[{dishId,sold,cancelled,complimentary,waste}]}` replaces complete day'sexpectations while preserving revisions. Max500rows; integer0..1000000; cancelled≤sold. Expected=sold−cancelled+complimentary+waste under agreedexitsemantics. Same revision/dataidempotent, changeddata409, replayoldrevision doesnotmakeitcurrent. Object/person excluded fromnewPOS unlesshistoricalPOS alreadyreferencedthem. Approvedday requiresmanagerreopen. GET lists revisions.

GET `/api/reconciliation` returnsobserved−expected, manual/automatic separately, revision/review andcoverage{sessions,gaps,warnings,unresolvedUnknown,sessionsTruncated,complete:false}. Missing expectation isnull, notzero. Coverage anddifferences do notproveabsenceofloss orresponsibility.

POST `/api/monitor/start` `{restaurantId,sourceId,camera,sessionId}`, heartbeat `{status:running|stalled}` every15 seconds, `/end` withboundedreason. Sameidentity retry cannotrebind. New source sessionclosespreviousone andbounds gap. stale45 seconds; gapsunknown orclientreportedvideo_stalled. Noautomatic inferenceofpowerfailure.

GET `/api/access`, GET/POST `/api/users`, POST `/api/users/ID`, GET/POST `/api/integration-keys`, POST `/api/integration-keys/ID/revoke` enforce owner/manager/daily_operator/engineer/viewer roles. Keytoken isshownonce; listingsshowmetadataonly. GET `/api/audit` returnsscoped changes withkeyId whereapplicable, nosecrets.

GET `/api/risks?restaurantId=ID` andPOST `/api/risks/ID` handle probability/impact1..5,status,mitigation,assignee,notes. Acceptance/closure needsday.approve andnamedresponsible/evidence. GET/POST `/api/day-reviews` require currentPOSrevision,reason,acknowledgeIncomplete=true forapproval. This locksPOS butdoesnotcertifyvisionaccuracy.

GET `/api/model-info` returnsmodel downloadprovenance. GET `/api/capacity` separates DB/mediafree space andNVRvideo. Private storage cannot resolveunderpublicassets; publicsymlinks cannotexpose DB/media. Backup/restore handlesboth DB andmedia. Permanent4xx retainoriginalevidence forreview; 5xx/network retryoriginalidentities withboundedbackoff. No silentlydroppedqueue orclaimofunseen output.

Edge RTSP/USB/file runtime is implemented. SpecificPOSprovider integration, ONVIF/NVRrecording retrieval/backfill, restaurantmodel training andfieldaccuracy/fullshift acceptance remainseparate work.
