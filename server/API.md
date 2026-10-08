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
