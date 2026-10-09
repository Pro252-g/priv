# IEP — دليل الربط وتعاقد API

**الإصدار0.4.0 — 2026-10-09.** خطوات الأجهزة والشبكة والتنزيل والنشر والخدمة في [دليل التنفيذ](EXECUTION_GUIDE.md)، وحالة القبول وأدلتها في [مراجعة المشروع](PROJECT_REVIEW.md). هذا الملف يشرح البيانات المتبادلة وتشخيص كل اتصال، ولا يعني اعتماد دقة مطعم أو توافق كل موديلات Hikvision.

## 1. مسار الربط

`كاميرا/NVR داخل المطعم → RTSP على الشبكة المحلية → جهاز edge → HTTPS → Cloud API → قاعدة ولقطات خاصة → متصفح المدير`.

عامل `edge/worker.py` منفذ لقراءة RTSP/USB/ملف، وتحليل ONNX وتتبع العبور وطابور دائم. الفيديو الأصلي يبقى علىNVR؛ الكلود يستقبل النتائج واللقطات فقط. لا تفتح منافذNVR للإنترنت؛ العامل يبدأ اتصالHTTPS خارجيًا. RTSP لا يفتح مباشرة داخل Android Chrome.

تحليل ملف مسجل ممكن كتجربة منفصلة، لكنه ليس استرجاعًا آليًا لعد اليومية. تنزيل التسجيل التاريخي منNVR/ONVIF وربط تداخله مع أحداث سابقة غير منفذين. تغيير معرفات التشغيل ثم إعادة فيديو قديم إلى عد حي قد يضاعف العدد.

## 2. الدخول والمفاتيح

المتصفح يستخدم جلسة HttpOnly/SameSite. الموصل يستخدم `Authorization: Bearer <INTEGRATION_KEY>` عبرHTTPS. أنشئ مفتاحًا من شاشة الربط أو POST `/api/integration-keys` بحساب مخول:

```json
{"label":"Restaurant 1 edge","restaurantIds":[1],"scopes":["catalog.read","events.write","monitor.read","monitor.write"],"validDays":30}
```

تحليل ملف يحتاج أيضًا `experiments.run`. موصلPOS له مفتاح منفصل بصلاحيات `pos.read,pos.write`. لا تعط الكاميرا صلاحية اعتماد مدير أو إدارة مستخدمين. قيمة المفتاح تظهر مرة واحدة وتحفظ في ملف خاص علىedge، ولا توضع فيGit أوLog أو صفحة عامة.

كل طلب يتحقق من دور المستخدم ونطاق المفتاح والمطعم الفعلي للمورد؛ restaurantId إضافي لا يغير نطاق مورد موجود. تعديل المستخدم أو تعطيله يبطل مفاتيحه وجلساته السابقة. حدود الدخول مستقلة حسب العميل والحساب. خلفHTTPS اضبط `IEP_SECURE_COOKIE=true` و`IEP_TRUSTED_PROXY_IPS` بعناوينIP الدقيقة للproxy المقابل للخادم فقط؛ الافتراضي لا يثق فيX-Forwarded-For، ولا يقبلCIDR.

## 3. سجل المصدر والمعايرة والنموذج

POST `/api/sources` يحتاج `integrations.manage`؛ مصدر واحد لكل كاميرا فعلية:

```json
{
 "restaurantId":1,"sourceId":"plates-window","name":"نافذة الأطباق","kind":"rtsp",
 "config":{"roi":[0,0,1,1],"line":{"orientation":"horizontal","position":0.5,"direction":"down"},"targetFps":5,"maxObjects":4}
}
```

GET `/api/sources?restaurantId=1` يحتاج `monitor.read` ويعرض المعايرة والصحة. POST `/api/sources/{id}` يعدلname/enabled/config فقط. sourceId ثابت وفريد للعميل، وحروفه أرقام أو أحرف لاتينية أو`.`/`_`/`-`. kind هوrtsp/usb/browser/file. العنوان وكلمات سر الكاميرا محليًا علىedge فقط؛ config لا يقبلURL أوpassword.

ROI هو `[x,y,width,height]` بين0و1. اتجاه الخط يتفق معorientation ومع العامل، والمعايرة الجديدة تحتاج إعادة اختبار. نموذج المطعم المخصص يسجل كmetadata عبر POST `/api/model-profiles`:

```json
{"name":"Restaurant detector","version":"1","modelSha256":"64 lowercase hex characters","classes":[{"name":"plate","label":"طبق"}]}
```

المفتاح هنا مثال وصفي؛ أرسلSHA256 فعليًا من64 حرفًا سداسيًا. GET `/api/model-profiles/{id}` يعيد الوصف، والمصدر يضعID فيconfig.modelProfileId. ترتيبlabels وبصمةweights علىedge يجب أن يطابقا الوصف. التسجيل لا يرفعweights ولا يدرب نموذجًا ولا يضيفplate إلىCOCO في المتصفح. COCO يحتوي80 فئة ولا يحتويplate؛ الكتالوج يقبل فئات العميل المسجلة ويحتفظ بتحذيرات التعارض بعدreload.

## 4. عامل واحد لكل كاميرا وحدود الانقطاع

قبل عد حي منRTSP/USB يطلب العامل POST `/api/sources/{id}/lease` بمفتاح `monitor.write`:

```json
{"bootId":"unique-worker-boot","ttlSec":45}
```

الرد `{leaseId,expiresAt,serverTime}`. التجديد كل15 ثانية وTTL المقبول30–60 ثانية. عامل آخر يرجع409 ما دام الحجز فعالًا. الحجز الجديد بعد انتهاء القديم لهleaseId وفترة جديدان، دون سد فجوة بأثر رجعي.

**العد يتوقف عند انتهاء الحجز دون اتصال ناجح، عادة بعد45 ثانية.** بذلك لا يعد عامل منفصل عن الشبكة وعامل بديل نفس الكاميرا. طابور الأحداث التي التقطت خلال فترة صالحة يظل قابلًا للرفع لاحقًا؛ لا توجد مطالبة بأن النظام عد ما خرج خلال فجوة جديدة. NTP مطلوب علىedge والخادم، والعامل يحسب مهلة محلية محافظة منserverTime/expiresAt. UPS وبدايةservice تلقائية مطلوبان للتركيب.

كل حدث حي معروف/مجهول منRTSP/USB يحملsourceId المسجل وsourceLeaseId، وoccurredAt داخل تلك الفترة. تجارب الملفات وbrowser الحالية مستثناة من الحجز؛ browser ليست عامل إنتاج ثابتًا. فيديوNVR يسمح بمراجعة الفجوة أو تجربة ملف لاحقة، دونbackfill آلي لليومية.

## 5. تسجيل العبور ومنع التكرار

POST `/api/events` حتى200 حدث:

```json
{"restaurantId":1,"events":[{"dishId":42,"sessionId":"edge-source-boot","trackId":"17","crossingId":"1","camera":"نافذة الأطباق","sourceId":"plates-window","sourceLeaseId":19,"occurredAt":"2026-10-09T10:00:00.123Z","confidence":0.93,"mode":"automatic"}]}
```

occurredAt نصISO معtimezone صريح، Z أوoffset. null/رقم/وقت بلاtimezone/تاريخ غير صالح يرجع400. الصفوفJSON objects، لاarrays أوnull. confidence رقم0..1؛ manual يحتاج `events.manual` ولا يمنحه مفتاحedge.

ثبتsession/track/crossing قبل حفظ الحدث في الطابور. هوية العبور تضم العميل والمطعم وnamespace حي/تجربة ومعرف التجربة ثم هذه المعرفات؛ session نصهexperiment: لا يتصادم مع تجربة. المعروف والمجهول يشتركان في هوية واحدة؛ وصولهما بأي ترتيب أو تأكيد المجهول يظل عدًا واحدًا. الردinserted/duplicates. تغيير الصنف أو الوقت أو الكاميرا أو الثقة أوmode أو المصدر أوlease لنفس الهوية يرجع409.

POST `/api/unknown-events` بنفس الهوية والوقت والمصدر والحجز، معreason، دونdishId/confidence، حتى100 حدث. المجهول لا يدخل مجموع صنف حتى حسمه. `/api/unknown-events/{id}/resolve` يحتاجday.approve: confirm معdishId أوexclude معreason. الحسم المتعارض409، والصنف المؤرشف قبل العبور يرفض. تصحيح حدث مؤكد عبر `/api/events/{id}/corrections`، وليس بمفتاح الكاميرا.

## 6. الصور والمراجع والتاريخ

image dataURL منJPEG/PNG، حتى512KiB للحدث و2MiB للمرجع، وجسمHTTP كله3MiB. قد يبلغ حد الحجم قبل عدد الأحداث؛ يرسلedge طلبًا صغيرًا. القاعدة تحفظimage_key/media_status، والبايتات فيfilesystem خاص. استدعاءurl/snapshot_url محمي؛ image_key ليس رابطًا عامًا.

mediaPending>0 يعنيmetadata سُجلت لكن الصورة تحتاج إعادة إرسال. احتفظ ببايتات الأصل وأعد نفسpayload والهوية والصورة، دون زيادة العدد ثانية. اختلاف محتوى الصورة409؛ فقدها لا يلغي العدد. إضافة/حذف المرجع يسجلactor/key/hash/variantLabel فيaudit.

الأحداث الجديدة تحفظ اسم الصنف وقت العبور. الأسماء القديمة التي تغيرت قبل الترحيل لا يمكن استرجاعها. totals تحتفظ بصف واحد لكلdishId: اسم تاريخي إذا كانت الفترة بنسخة واحدة، وإلا الاسم الحالي معhistoricalNames لكل النسخ. CSV مجاميع أصناف، وليس تصدير كل اللقطات.

## 7. تشخيص كل ربط والفجوات

POST `/api/sources/{id}/health` بمفتاحmonitor.write:

```json
{"status":"running","bootId":"worker-boot","sequence":18,"observedAt":"2026-10-09T10:00:00.000Z","metrics":{"fps":5,"frameAgeSec":0.1,"queueDepth":0,"oldestQueueAgeSec":0,"freeDiskBytes":1000000000,"inferenceMs":120},"errorCode":"none"}
```

status هوstarting/running/stalled/offline/error. metrics الستة فقط، أرقام غير سالبة؛ queue/disk أعداد صحيحة. لا ترسلException/message/rawconfig. الأكواد none/decoder_unavailable/source_unreachable/auth_failed/inference_failed/storage_full/upload_failed/calibration_required. sequence متزايد لكلboot؛ التكرار المطابق آمن، المتغير/الأقدم409. GET يعيدreceivedAt وageSec وstale بعد45 ثانية. observedAt وقت العامل، receivedAt وقت الخادم؛ الصحة لا تثبت دقة العد.

POST `/api/sources/{id}/gaps` يحمل `{gapId,startAt,endAt,cause,recoverable}`؛ cause هوpower_loss/source_unreachable/video_stalled/upload_failed/inference_failed/process_restart/unknown. endAt>startAt وrecoverable boolean. تكرار الأصل آمن وتغييره409؛ recoverable إمكانية مراجعة وليس وعدًا بأن العدد استعيد. الفجوات تظهر في المطابقة اليومية.

monitor/start ثمheartbeat/end يسجل تاريخ التغطية: `{restaurantId,sourceId,camera,sessionId}` ثم `{status:"running"|"stalled"}` كل15 ثانية. stale45 ثانية يولدunknown، وstalled يولدvideo_stalled؛ لا يستنتج الخادم سبب الكهرباء. GET `/api/health` العام يثبت استجابةAPI فقط. فحص كل ربط يحتاج حالة المصدر، وإطارًا حديثًا، واستدلالًا، ورفع حدث، واستدعاء لقطته.

## 8. التاريخ الطويل وتجربة ملف

| القراءة | الفلاتر والصفحات |
|---|---|
| reports | businessDate أوfromDate/toDate أوfrom/to؛ limit1–200، وكلاbeforeOccurredAt/beforeId منnextCursor |
| unknown-events | limit1–200 افتراضي100، beforeId، businessDate أوfromDate/toDate، state=unresolved/resolved/all |
| experiments | limit1–100 افتراضي50، beforeId، businessDate حسب إنشاء التجربة |
| monitor | limit1–200 افتراضي100، beforeId، businessDate حسب تقاطع التشغيل مع اليوم |
| source gaps/model-profiles | beforeId؛ gaps حد200، profiles حد100 |

كلها تحتاج نطاق المطعم حيث ينطبق، وقد يحددexperimentId تجربة منفصلة. الردhasMore/nextBeforeId؛ reports يستخدمnextCursor أيضًا. totals للفترة كلها، دون معاملات الصفحات يعود حد توافق1000 حدث. فلترة اليوم فيSQL قبلlimit. المطابقة تحذرsessionsTruncated لو تجاوزت الجلسات1000؛ صفحاتmonitor تعرض باقي التاريخ. تاريخ اليومAfrica/Cairo وحدود `[from,to)` تشملDST. وصول بيانات متأخرة قد يتطلب تحديث الفترة وإزالة تكرارID.

summary حتى256KiB. عاملfile يربط التجربة بأولedgeBinding `{fileSha256,fingerprint,experimentId,catalogFingerprint}`؛ hashes64hex. تغيير ملف/إعداد/كتالوج409 حتى مع طلبين متزامنين. استبدالsummary لا يمسحbinding؛ الاختبار المختلف يحتاج تجربة جديدة. provenance يتضمن صور المراجع وبصماتها والكتالوج والإعدادات الفعلية، لاIDs فقط. أحداث التجارب خارج اليومية وPOS دائمًا. الصورة الثابتةduration0 تحفظ ملخص وجود عناصر ولا تسجل خروج طلب.

## 9. POS ومعاني المطابقة

موصل مورد الكاشير المحدد غير منفذ؛ الواجهة تقبلCSV أو كتابة، والAPI يقبلsnapshot يوم كامل:

```json
{"restaurantId":1,"businessDate":"2026-10-09","revision":"cashier-day-0001","items":[{"dishId":42,"sold":100,"cancelled":3,"complimentary":2,"waste":1}]}
```

POST `/api/pos`. المتوقع=sold−cancelled+complimentary+waste. sold وحدات طلب قبل إلغاء لم يخرج؛ cancelled جزء منها لم يعبر؛ مجاني/هالك وحدات إضافية عبرت ولم تدخلsold. إلغاء بعد خروج طبق أو هالك داخل المطبخ لا يخصم من عبور. الكمبو والوحدات والمرتجعات تحتاج جدولcashierCode→dishId وسياسة مشتركة، لا مجرد عدد الطلبات.

حتى500 صف، أعداد صحيحة0..1000000 وcancelled≤sold. نفسrevision والبيانات آمن؛ تغييره409. إعادة قديم لا تجعله الحالي، واليوم المعتمد يحتاج إعادة فتح مدير. صف غائب يعني توقعnull لا صفرًا. الأشخاص والأشياء العامة خارجPOS الجديد. `/api/reconciliation` يعيدمرصود−متوقع والتغطية والفجوات والمجهولات؛ coverage.complete=false لأن النبضات لا تثبت الدقة. الفارق حالة مراجعة وليس دليل إدانة.

## 10. retries وقبول الربط

الأخطاءJSON `{error:string}`:400 مدخل،401 دخول/مفتاح،403 صلاحية،404 مورد غائب/خارج النطاق،409 تعارض هوية/حجز/binding/مراجعة،413 حجم،429 حماية دخول. لا يوجدCORS عام.

الانقطاع/مهلة/5xx: تراجع زمني وإعادة الأصل من طابور دائم. 400/401/403/404/409/413 لا تتكرر بلا حد؛ يحتفظ الطابور بالأصل للمراجعة. عند حجز منتهٍ أو مفتاح مفقود تتوقف المعالجة. طابور المتصفح1000 سجل/64MiB، وحدودedge في ملفstorage؛ امتلاء القرص لا يبرر إسقاطًا صامتًا.

اختبر مصدرين وعاملين متنافسين، وقطعنترنت>45 ثانية ثم رفع الطابور، وتوقف الكاميرا وامتلاء التخزين، ومعروف/مجهول بأي ترتيب، وحدود حي/تجربة، ومفتاحًا ملغى/منتهيًا ومطعمًا ممنوعًا، ولقطةpending، ومراجعةPOS وbackup/restore. الربط الفعلي بـHikvision والسرعة ودقة أصناف المطعم ووردية كاملة تحتاج قبولًا ميدانيًا؛ الاختبارات الاصطناعية لا تعوضه.

المرجع القابل للتنزيل [OpenAPI](openapi.json)، والمرجع البرمجي [server/API.md](../server/API.md). المصدر الفعلي بعد النشر `GET /api/openapi`.
