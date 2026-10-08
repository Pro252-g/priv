# IEP Dish Counter — pilot

Arabic RTL Android camera interface and desktop reports, built with Node 24, SQLite and browser TensorFlow.js. Supports multiple restaurant catalogs and owner-isolated data; separate customer accounts are provisioned by an operator, not public registration.

## Run

```sh
npm ci --cache /workspace/priv/.local/npm-cache --ignore-scripts --no-audit --no-fund
npm test
```

Securely supply `IEP_ADMIN_PASSWORD` (12+ characters) and optionally `IEP_ADMIN_EMAIL`, then run `npm start`. No default password is provided. `IEP_DATA_DIR` defaults to `.local/data`. Passwords are hashed; bootstrap does not reset an existing password. Keep this directory and backups private. For mobile access deploy behind HTTPS and set `IEP_SECURE_COOKIE=true`; a phone cannot access this machine through its own localhost.

## Pilot workflow

Log in, create a restaurant, add dish names and several JPEG/PNG reference examples, then open the camera and grant permission. Mobile-moving mode uses explicit user confirmation for saved counts. Fixed-camera line crossing can count supported detections automatically once per track. Reports show saved records and export totals to CSV. Model loading is required for recognition and needs permitted TensorFlow model hosts. There are no paid cloud inference calls.

Automatic mobile physical-object deduplication is **not solved or validated**. Generic detection does not cover arbitrary restaurant plates; recognition matching is experimental. Occlusion, overlap and returning dishes can change track identity. Counts need comparison with independently annotated real footage before operational use. Reference photos are stored; continuous video is not recorded. See [deployment proposal](docs/DEPLOYMENT.md), [API](server/API.md), and tracker tests for the implemented boundaries.

No public deployment, restaurant dataset, Android device validation, or Hikvision integration is included yet. Tenant roles, subscriptions, configurable retention, managed PostgreSQL and image object storage are production follow-up work.
