# دليل تنفيذ IEP: الكلود وجهاز المطعم

هذا دليل تركيب للملفات الموجودة بالمستودع. نجح بناء صورتي Node وCaddy وتشغيل Compose بمستخدم غير جذر، وHTTPS بشهادة محلية موثوقة، ودخول وصنف وحدث وصورة خاصة ونسخة احتياطية متحققة. لم تُشترَ استضافة أو نطاق أو معدات؛ شهادة عامة وAndroid وNVR فعلي تحتاج اختبار الموقع. لا تستخدم نطاق iep.example.com كنطاق حقيقي. [دليل الاختبار](review-evidence/deployment-2026-10-09.json).

## 1. ما يُركَّب وأين

| المكان | المكونات | وظيفة الاتصال |
|---|---|---|
| خادم Ubuntu 24.04 عام | Docker Engine، Compose ≥2.30، API Node 24، Caddy | موقع HTTPS واحد للموبايل والكمبيوتر، قاعدة بيانات وصور خاصة |
| المطعم | NVR PoE، كاميرتان ثابتتان، جهاز Ubuntu 24.04 | جهاز التحليل يقرأ RTSP محليًا ويرسل أحداثًا وصور تسجيل إلى الكلود |
| Android | Chrome حديث ورابط HTTPS | تجربة الكاميرا بإذن المستخدم؛ الهاتف المتحرك لا يثبت هوية الطبق طوال اليوم |

البدء المقترح للكلود: 2 vCPU و4GB RAM وSSD 80GB مع مراقبة نمو الصور ونسخ خارجية. هذا حجم تجربة، لا تعهد بسعة كل العملاء. لجهاز المطعم نقترح Intel Core i5-1235U أو جهاز مكافئ، RAM 16GB، SSD 512GB، منفذ Ethernet وUbuntu 24.04. N100 مع16GB بديل اقتصادي يحتاج قياسًا ميدانيًا قبل شرائه لنفس الحمل. ابدأ بمعالجة5 إطارات/ث لكل كاميرا وبحد4 أجسام في الإطار.

القياس المسجل في `docs/review-evidence/edge-capacity-2026-10-09.json` على بيئة تطوير مشتركة: متوسط114.56ms لخط معالجة واحد، و147.27/163.41ms لخطين متزامنين،20 إطارًا لكل خط. يشمل التحليل والمراجع والتتبع وصور التسجيل؛ لا يثبت فك بث NVR أو أداء الأجهزة المقترحة أو تشغيل24 ساعة أو دقة أطباق المطعم.

## 2. المعدات والتوصيل

قائمة شراء مبدئية للمراجعة مع المورد: Hikvision DS-7604NXI-K1/4P، وكاميرتان ثابتتان من عائلة DS-2CD2346G2-I(U) أو بديل مطابق. صفحات الشركة المقترحة:

- https://www.hikvision.com/en/products/IP-Products/Network-Video-Recorders/Pro-Series/ds-7604nxi-k1-4p/
- https://www.hikvision.com/en/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/ds-2cd2346g2-i-u-/

تعذر فتح صفحات الشركة من هذه البيئة بسبب حجب403؛ لم نثبت توافر SKU أو توافقه أو مواصفاته الحالية. قبل الدفع اطلب ورقة البيانات الرسمية للنسخة المعروضة وإثبات PoE لأربع قنوات، ميزانية PoE مناسبة للكاميرتين، RTSP مع H.264 للـmain/sub streams، ONVIF Profile S/T حسب الجهاز، توافق firmware، ومنفذ LAN الذي يصل منه جهاز التحليل إلى كل قناة. جرّب البث فعليًا مع المورد؛ اسم العلامة وحده لا يضمن ذلك.

وصّل الكاميرات إلى PoE NVR، ومنفذ LAN للـNVR وجهاز التحليل إلى سويتش/راوتر المطعم. بعض شبكات PoE الداخلية معزولة: القراءة تكون عبر عنوان NVR وقنواته، أو عبر توجيه محلي مصرح به. لا تفتح RTSP أو ONVIF للإنترنت. خصص DHCP reservations أو عناوين ثابتة غير متعارضة. UPS يغذي NVR والجهاز والسويتش والراوتر؛ اختره من استهلاك الأجهزة المقاس ومدة الاحتفاظ المطلوبة، وليس VA وحده. فعّل NTP على NVR والكاميرات وUbuntu، وفحص `timedatectl status` يجب أن يظهر مزامنة الساعة؛ تحفظ الأحداث UTC ويجمع يوم العمل بتوقيت Africa/Cairo.

ثبت كاميرا فوق كل ممر تسليم، بزاوية تمنع حجب الأطباق، إضاءة مستقرة وخلفية واضحة. اجعل الطعام والمشروبات في ممرين مستقلين متى أمكن. أمثلة Hikvision المعتادة، بعد التحقق من firmware والقناة:

```text
rtsp://USER:PASSWORD@NVR_LAN_IP:554/Streaming/Channels/101
rtsp://USER:PASSWORD@NVR_LAN_IP:554/Streaming/Channels/102
rtsp://USER:PASSWORD@NVR_LAN_IP:554/Streaming/Channels/201
rtsp://USER:PASSWORD@NVR_LAN_IP:554/Streaming/Channels/202
```

101/201 عادة البث الرئيسي للقناتين1/2، و102/202 الفرعي. اختر H.264 مبدئيًا، substream مناسبًا بحجم640×360 أو ما يدعمه الجهاز واختبر التفاصيل اللازمة للتصنيف. لا تتجاهل فقد تفاصيل الطعام مقابل تخفيف الحمل. أنشئ حساب كاميرا للقراءة فقط؛ خزّن الرابط المشفر محليًا ولا ترسله إلى لوحة المصادر أو screenshots. رموز كلمة المرور الخاصة تحتاج percent-encoding داخل URL.

## 3. تجهيز الكلود

هذه الخطوات على Ubuntu24.04 جديد، بحساب يستطيع sudo. جهز أدوات النظام ثم نسخة المشروع:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git python3 python3-venv
sudo install -d -m 755 -o "$USER" /opt/iep
git clone --branch iep-pilot https://github.com/Pro252-g/priv.git /opt/iep/app
git -C /opt/iep/app rev-parse HEAD
```

المستودع خاص؛ يحتاج حساب GitHub مصرحًا أو مفتاح deploy للقراءة. لا تضع token في رابط الأمر. يمكن تنزيل archive موثوق من فرع التسليم عبر GitHub ونقله إلى المسار نفسه بدل clone. سجل SHA النسخة المستخدمة، واستعمل النسخة نفسها على الكلود والجهاز. `main` ليس فرع التسليم الحالي.

ثبّت Docker Engine وCompose plugin من تعليمات Docker الرسمية لـUbuntu، وليس حزمة غير معروفة:
https://docs.docker.com/engine/install/ubuntu/

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker version
sudo docker compose version
```

هذا مسارUbuntu24.04/noble فقط. تأكد من Compose≥2.30 قبل متابعة env_file raw. ليست أوامر شغلتها على VPS عام هنا؛ صورة التطبيق وCaddy يفحصان داخل بيئة التطوير، وتهيئة خادم جديد تحتاج وصول الإدارة.

```bash
cd /opt/iep/app
python3 scripts/download-models.py
sudo docker run --rm -v "$PWD:/app:ro" -w /app node:24-bookworm-slim node deploy/verify-model-assets.mjs .local/models
sudo python3 deploy/prepare-cloud-env.py --directory /etc/iep
```

الأداة الأخيرة تطلب اسم النطاق والبريد وكلمة مالك مخفية، وتحفظ `cloud.env` و`api.env` بصلاحية600. لا تعرض محتواهما أو تنشرهما. أمر التحقق يستعمل Node24 داخل حاوية؛ لا يلزم تثبيته على خادم الموقع خارج Docker. صورة التطبيق تعيد التحقق أيضًا. تنزيل النماذج يتحقق من MD5 upstream وSHA256 محلي؛ لا تتجاوز فشل التحقق.

اجعل DNS A/AAAA يطابق الخادم. احذف AAAA غير العامل. افتح inbound80/443، وقيد SSH على وصول الإدارة؛ لا تنشر3000 أو قواعد البيانات. تحتاج Caddy اتصال outbound لإصدار وتجديد شهادة ACME. تأكد أن الشبكة172.30.55.0/24 لا تتعارض مع VPN أو LAN؛ إن عدلتها عدّل عنواني API/proxy في `cloud.env` معًا. الثقة في forwarded IP محصورة بعنوان proxy الداخلي.

```bash
cd /opt/iep/app
sudo docker compose --env-file /etc/iep/cloud.env -f deploy/compose.yml config --quiet
sudo docker compose --env-file /etc/iep/cloud.env -f deploy/compose.yml build
sudo docker compose --env-file /etc/iep/cloud.env -f deploy/compose.yml up -d api proxy
sudo docker compose --env-file /etc/iep/cloud.env -f deploy/compose.yml ps
```

النتيجة المطلوبة: API وproxy في حالةhealthy، ومستخدم الحاويات UID1000، ونظام ملفات التطبيق read-only. البيانات والصور وشهادات TLS في volumes منفصلة. لا تستخدم `down -v` في التشغيل لأنه يحذف البيانات. إذا فشل npm بـEAI_AGAIN أصلح DNS وخروج Docker إلى registry، ثم أعد البناء؛ لا تعطل TLS ولا تعدل lockfile كحل شبكي. في بيئة تطوير وراء وكيل TLS موثوق قد تحتاج proxy build args وشهادة المؤسسة عبر BuildKit secret network_ca؛ ذلك لا يضع الشهادة أو proxy credentials داخل الصورة. Ubuntu العام المباشر لا يحتاج شهادة بيئة Codex.

من جهاز آخر اختبر الرابط الحقيقي:

```bash
curl --fail --show-error https://YOUR_REAL_DOMAIN/api/health
curl -I http://YOUR_REAL_DOMAIN/
curl -I https://YOUR_REAL_DOMAIN/
```

متوقع health JSON ناجح، وتحويل HTTP إلى HTTPS، وشهادة صالحة للاسم دون `-k`. ادخل بحساب المالك من HTTPS، أنشئ المطعم والأصناف ثم جرّب صورة مرجعية. الصورة المرجعية يجب أن تكونready؛ pending/missing يتطلب إعادة إرسال/مراجعة التخزين. الصلاحيات تحدد ما يراه المستخدم؛ حسابات العملاء محصورة بمطاعمهم.

## 4. إعداد API والمصدر

من لوحة الربط سجل مصدرين، مثل `pass-food-01` و`pass-drinks-01`، بنوعrtsp، في المطعم الصحيح. احتفظ بالـrestaurantId العددي وid العددي لكل سجل مصدر وsourceId النصي الثابت. sourceId ثابت لكل كاميرا؛ sessionId ينشئه العامل لكل دورة تشغيل ولا تستعمله كمعرف كاميرا.

أنشئ integration key مخصصًا لهذا المطعم بصلاحيات `catalog.read` و`events.write` و`monitor.read` و`monitor.write` ومدة مناسبة مثل30 يومًا. المفتاح يظهر مرة واحدة؛ خزّنه في env المحلي، لا في JSON أو git. واجهة REST المقابلة:

```text
POST /api/integration-keys
{label,restaurantIds:[rid],scopes:[...],validDays:30}
Authorization: Bearer iep_...
```

التفاصيل النهائية بالـ`/api/openapi` و`server/API.md`. المفتاح المنتهي يعطي401/403؛ جدد ثم حدّث env وأعد تشغيل العامل. تغيير المطعم أو sourceId يتطلب إعادة مطابقة config مع السجل، لا نسخ config جهاز آخر دون مراجعة.

## 5. تجهيز جهاز التحليل

ضع نفس الإصدار في `/opt/iep/app` على جهاز Ubuntu. نفذ:

```bash
cd /opt/iep/app
sudo sh deploy/install-edge.sh
python3 -m venv .local/edge-model-export-venv
.local/edge-model-export-venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1
.local/edge-model-export-venv/bin/pip install onnx==1.17.0
.local/edge-model-export-venv/bin/python scripts/setup-edge-models.py --output .local/edge-models
sudo install -d -m 755 /opt/iep/models
sudo cp .local/edge-models/*.onnx .local/edge-models/manifest.json /opt/iep/models/
sudo install -m 600 -o iep-edge -g iep-edge deploy/edge.json.example /etc/iep/edge-food.json
sudo install -m 600 -o root -g root deploy/edge.env.example /etc/iep/edge-food.env
sudoedit /etc/iep/edge-food.json /etc/iep/edge-food.env
```

يمكن تجهيز النماذج على جهاز منفصل ونقل ملفات ONNX وmanifest والتحقق من بصماتها، لتجنب تثبيت PyTorch على جهاز التشغيل. العامل نفسه يستخدم dependencies المثبتة في `edge/.venv` فقط. YOLOX Apache-2.0 وMobileNet torchvision BSD-3-Clause؛ manifest يحفظ المصادر والتراخيص والبصمات. detectorSHA المثبت `427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7`، embeddingSHA `e58c623b9269fd171e6cc35ec401e0a72c69b1baad2e2e21c06b444c902fd5a9`. راجع manifest الفعلي للإصدار بدل نسخ hash لنموذج آخر.

في JSON عدّل baseUrl إلى HTTPS الحقيقي، restaurantId، source.id، sourceId، مساري النموذجين وبصمتيهما. `preprocess:imagenet-rgb` و`featureOutput:true` للـembedding المصدر هنا. في env اكتب `IEP_API_KEY=` والمفتاح، و`IEP_SOURCE_URL=` والرابط الكامل حسب صيغة systemd EnvironmentFile؛ هذه ليست shell script فلا تستخدم `source` عليها. حافظ على env root600 وJSON iep-edge600 ودليل `/etc/iep` root:iep-edge750. كرر باسمdrinks، بمصدر مختلف وstateDir مختلف مثل `/var/lib/iep-edge/pass-drinks-01`.

المعايرة الافتراضية `calibrated:false` تتعمد منع العد التشغيلي قبل المراجعة. طابق roi/line/targetFps/maxObjects حرفيًا مع config سجل المصدر بالكلود. النموذج المخصص يحتاجmodelProfileId وبصمة وفئات مطابقين. لا تغيّر calibrated إلىtrue لتجاوز فشل: راجع لقطة حقيقية، اضبط خط عبور واتجاهًا، ثم نفذ تجربة موثقة وعدًا يدويًا مقارنًا.

نموذج COCO العام لا يحتوي فئةplate شاملة لكل أطباق المطعم؛ لا تتوقع أن المراجع وحدها تكشف طبقًا لم يكتشفه detector. اختبر أو درب detector خاصًا وصدرONNX بعقد worker الموثق وفئات محددة قبل بيع ضمان التعرف. التعرف بالصور المرجعية تجريبي، وتعارض الفئات ينتج مجهولًا؛ المجهول لا يصبح تلقائيًا عدد طبق صحيح.

شغّل check مع EnvironmentFile عبر systemd حتى لا تظهر الأسرار في سطر أوامر:

```bash
sudo systemd-run --wait --pipe --collect --unit=iep-edge-check-food --property=User=iep-edge --property=Group=iep-edge --property=EnvironmentFile=/etc/iep/edge-food.env /opt/iep/app/edge/.venv/bin/python /opt/iep/app/edge/worker.py check --config /etc/iep/edge-food.json
sudo systemd-run --wait --pipe --collect --unit=iep-edge-diagnose-food --property=User=iep-edge --property=Group=iep-edge --property=EnvironmentFile=/etc/iep/edge-food.env /opt/iep/app/edge/.venv/bin/python /opt/iep/app/edge/worker.py diagnose --config /etc/iep/edge-food.json
```

check يفحص storage/model/LAN/cloud/auth/catalog/calibration/source/frame/inference؛ المطلوبok:true بعد معايرة صحيحة، وframe_decoded مع أبعاد وصحة النموذج. قبل المعايرة يظهرcalibration_required وهذا ليس إذنًا للعد. diagnose يقرأ الصحة المحلية وقد يحتاج أول تشغيل لتكوين state.

```bash
sudo systemctl enable --now iep-edge@food iep-edge@drinks
sudo systemctl status iep-edge@food iep-edge@drinks
sudo journalctl -u iep-edge@food --since '10 minutes ago'
```

مصدر واحد له منتج واحد فقط: العامل يمسكlease سحابيًا لمدة45 ثانية ويجدده كل15 ثانية، مع قفل محلي. انقطاع الإنترنت لأكثر من نحو44 ثانية يوقف التحليل لحماية المصدر من العد على جهازين ويسجل فجوة تغطية؛ الأحداث المعلقة السابقة تظل قابلة للإرسال بعد العودة. لا يوجد وعد بعدّ غير محدود دون إنترنت أو تعويض تلقائي من NVR. وقت البث الحي هو وقت استلام الإطار على الجهاز UTC، وليس وقت التقاط NVR الأصلي؛ لذلك NTP ضروري.

العامل لا يفتح منفذًا للمطعم؛ يحتاجLANRTSP554/TCP وcloudHTTPS443 فقط. health.json وqueue.sqlite والصور فيstateDir بصلاحيات خاصة. إعادة التشغيل تستعيد الإرسال من الطابور دون تغيير payload؛ لا تمسح state لحل امتلاء أو401. `retry-blocked` إجراء بعد إصلاح سبب الرفض وليس لإخفاء أخطاء المطعم/المصدر. ملفات الفيديو المحفوظة تحتاجexperimentId ومسارًا وبصمة وstartTime صريحًا وتبقى منفصلة عن أعداد التشغيل؛ لا تعني استرجاع كل تاريخ NVR تلقائيًا.

## 6. النسخ والاستعادة

```bash
sudo docker compose --env-file /etc/iep/cloud.env -f /opt/iep/app/deploy/compose.yml run --rm -e IEP_BACKUP_ID=acceptance-check backup
sudo docker compose --env-file /etc/iep/cloud.env -f /opt/iep/app/deploy/compose.yml run --rm backup node /app/scripts/backup-data.mjs --verify /backups/acceptance-check
sudo install -m 644 /opt/iep/app/deploy/iep-cloud-backup.service /etc/systemd/system/
sudo install -m 644 /opt/iep/app/deploy/iep-cloud-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iep-cloud-backup.timer
```

متوقعverified:true وcomplete:true؛ نقص الصور يفشل برمز2 فلا تعتبره نسخة ناجحة. المؤقت03:15 بتوقيت القاهرة. النسخ داخل نفس الخادم ليست حماية من فقده: انقل نسخة مشفرة خارج الخادم واعتمد احتفاظًا ومساحة ومسؤولًا محددين. احفظ secrets وقواعد المعايرة وmanifest منفصلًا وبشكل خاص؛ أداة dataset لا تحفظها تلقائيًا.

اختبار الاستعادة يكون إلى مسارات جديدة تمامًا، مثال داخل حاوية backup:

```bash
sudo docker compose --env-file /etc/iep/cloud.env -f /opt/iep/app/deploy/compose.yml run --rm backup node /app/scripts/backup-data.mjs --restore /backups/acceptance-check --data-dir /backups/restore-drill/data --media-dir /backups/restore-drill/media
```

هذا اختبار استعادة إلىvolume النسخ، لا تحويل إنتاج. الأداة ترفض مسارات موجودة. افحص قاعدة وصور الاختبار ثم خطط تحويلvolumes جديدة وقت صيانة، أوقفAPI واحفظ القديم دون حذف، واختبرURL/صور/أعداد بعد التحويل. لا تستعملallow-incomplete أوتحذفvolumes القديمة في الاستعادة الروتينية. جرّب أيضًا انقطاع الكهرباء والإنترنت وعودة الإرسال قبل قبول التشغيل.

## 7. تشخيص الربط وشرط التسليم

| الفحص | المتوقع | عند الفشل |
|---|---|---|
| DNS/TLS + curl health من جهاز المطعم | JSON ناجح وشهادة صحيحة | DNS/AAAA/firewall/ساعة/Caddy؛ لا تستخدم-k كحل |
| cloud/auth/catalog فيcheck | كلok:true | URL، صلاحيات المفتاح، انتهاءه، restaurantId |
| source/frame فيcheck | frame_decoded وأبعاد حقيقية | LAN/VLAN/NVR channel/H264/RTSP account؛ لا ترسل الرابط السري في التذكرة |
| model/inference | hash صحيح وتحليل مكتمل | الملف أوformat أوpreprocess؛ لا تبدلhash فقط لقبولملف مختلف |
| calibration | approved ومطابقة سجل المصدر | ROI/خط/اتجاه/profile ثم إعادة تحقق |
| صحةالمصدر بالويب | آخرنبضة حديثة وfps/frameAge معقولان | systemd، مصدرمتوقف، clock، LAN؛ healthbasic لا يثبتالإطارات |
| queueDepth وoldestQueueAge | تنخفض بعدعودةالإنترنت | auth/رفضpayload/قرص؛ لا تمسحqueue.sqlite |
| الصور | ready ويمكن فتحالصورةالمصرح بها | pending/missing/corrupt: تخزين/إعادةإرسال، ليسنجاححفظالصورة |
| مقارنةPOS | إدخال يدوي/CSV صحيح وتقرير يومالقاهرة | الإجماليقبلالإلغاء−الإلغاء+مجاني+هالكخرجعبرالممر؛ راجعالإلغاءبعدالتسليم |

اختبار القبول يتطلب فيديو وصورًا فعلية للمطعم مع حقيقة أرضية مستقلة: أكثر من طبق، حجب، رجوع، قرب الخط، صنف مجهول، كاميرا متوقفة، انقطاع الشبكة، تبديل التاريخ، إعادة التشغيل واستعادة نسخة. سجل النتائج الصحيحة والعد الزائد والعد المفقود حسب صنف، وفترات التغطية الناقصة، وقارن POS دون تفسير فرق الأعداد تلقائيًا كسرقة. وجود HTTP200 أو نموذج يعمل لا يثبت صحة التعداد. لا نعتمد وعد هوية واحدة بعد خروج الطبق وعودته أو عبر كاميرات مختلفة دون دليل ومعايرة نظام مناسبة.

بالهاتف: افتح رابط HTTPS ثم اسمح بالكاميرا بضغطة المستخدم؛ الوضع المتحرك يعرض تعرفًا وملاحظات وتأكيد عد يدوي. الوضع الثابت يعد عبور خط ضمن شروط التتبع. رفع صور للتحليل يُظهر محتواها ولا يكتب أعداد تشغيل تلقائيًا، وتجربة الفيديو تبقى معزولة. راجع صلاحيات الحساب قبل تسليم كل عميل، واجعل قرار النشر الإنتاجي بعد استكمال البناء وTLS واختبار الموقع الفعلي.

## 8. تحديث النسخة والعودة واختبارات التطوير

قبل التحديث خذ نسخة متحققة وسجل SHA الحالي وإعدادات النموذج والمعايرة. أوقف خدمات edge، ثم API في وقت صيانة؛ لا تطبق تحديث زاوية أو نموذج أثناء تشغيل تجربة. جهز إصدارًا موثوقًا منفصلًا، وابنِ الصور وافحصها قبل التحويل. شغل check ثم الخدمات وحدثًا تجريبيًا ولقطة ومراجعة تقرير. ترحيل الهوية والمراجع إضافي؛ الرجوع لإصدار أقدم قد لا يفهم البيانات الجديدة، لذلك لا تستبدل الصورة القديمة فوق DB الجديدة دون خطة توافق أو استعادة DB+media المتحققة. احتفظ بالنسخة والإعدادات القديمة حتى النجاح.

على بيئة التطوير، بعد تجهيز Node/Chromium/FFmpeg وvenv وفق دليل النماذج:

```bash
npm test
npm run test:browser
npm run test:models
npm run test:edge
node scripts/edge-integration-check.mjs .local/edge-models/dog.jpg
.local/edge-venv/bin/python scripts/rtsp-smoke.py --image .local/edge-models/dog.jpg --output .local/rtsp-check.json
node scripts/deployment-smoke.mjs
```

آخر ثلاثة اختبارات اختيارية تحتاج الصورة العامة الأصلية ونماذج ONNX، وDocker للـRTSP/النشر وFFmpeg. اختبار النشر يفترض صور iep-api:local وiep-proxy:local مبنية، ويستخدم مشروعًا مؤقتًا على loopback وشهادة Caddy محلية متحققًا منها؛ ينظف volumes مشروع الاختبار فقط. لا يرسل فيديو العميل ولا ينشر رابطًا عامًا. قارن الأدلة في docs/review-evidence، ولا تعتبر اختبارات عامة أو اصطناعية دقة مطعم.
