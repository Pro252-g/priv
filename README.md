# IEP Dish Counter — pilot

Arabic RTL Android camera interface and desktop reports, built with Node 24, SQLite and browser TensorFlow.js. Supports multiple restaurant catalogs and owner-isolated data; separate customer accounts are provisioned by an operator, not public registration.

## Run

```sh
npm ci --cache /workspace/priv/.local/npm-cache --ignore-scripts --no-audit --no-fund
python3 scripts/download-models.py
npm test
```

Securely supply `IEP_ADMIN_PASSWORD` (12+ characters) and optionally `IEP_ADMIN_EMAIL`, then run `npm start`. No default password is provided. `IEP_DATA_DIR` defaults to `.local/data`. Passwords are hashed; bootstrap does not reset an existing password. Keep this directory and backups private. For mobile access deploy behind HTTPS and set `IEP_SECURE_COOKIE=true`; a phone cannot access this machine through its own localhost.

## Pilot workflow

Log in, create a restaurant, add dish names and several JPEG/PNG reference examples, then open the camera and grant permission. Mobile-moving mode uses explicit user confirmation for saved counts. Fixed-camera line crossing can count supported detections automatically once per track. Reports show saved records and export totals to CSV. Local model files must be prepared with the download script; browser inference then loads them from the same application server. There are no paid cloud inference calls.

Use «تجارب الفيديو» to select a recorded video and run sequential analysis. Each experiment is separate from live reports and stores relative video timestamps. Use «مطابقة المبيعات» to enter gross quantities before cancellation or import a mapped CSV, review it, and save the full daily revision. Differences are review signals, not proof of theft. Browser event outbox persists pending submissions across reload; monitoring records interrupted coverage. See [operations guide](docs/OPERATIONS.md).

Automatic mobile physical-object deduplication is **not solved or validated**. Generic detection does not cover arbitrary restaurant plates; recognition matching is experimental. Occlusion, overlap and returning dishes can change track identity. Counts need comparison with independently annotated real footage before operational use. Reference photos are stored; continuous video is not recorded. See [deployment proposal](docs/DEPLOYMENT.md), [API](server/API.md), and tracker tests for the implemented boundaries.

No public deployment, restaurant dataset, Android device validation, or Hikvision integration is included yet. Tenant roles, subscriptions, configurable retention, managed PostgreSQL and image object storage are production follow-up work.
