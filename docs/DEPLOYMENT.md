# Deployment proposal for IEP

This is a pilot, not a validated production counting system. No subscription or public deployment has been created.

## Initial Android pilot
Run the Node 24 service behind an HTTPS reverse proxy on a small VPS/container host with a persistent volume for `IEP_DATA_DIR`. Camera access requires HTTPS (localhost exception does not apply to a phone visiting another machine). Set `IEP_ADMIN_EMAIL` and securely inject `IEP_ADMIN_PASSWORD` for initial provisioning. Set `IEP_SECURE_COOKIE=true` in HTTPS deployments and `HOST=0.0.0.0` inside a container. Keep the Node port private; expose only HTTPS via the proxy. Persist and back up the entire data directory; SQLite must use a local disk, not a shared multi-instance filesystem. Use one service replica. Test backup restoration before customer use. Run `python3 scripts/download-models.py` before building the Docker image. The Dockerfile includes verified local model assets. Container build validation remains incomplete; prior dependency-fetch attempts stalled in the container network.

For pilot use SQLite reduces costs; for commercial deployment migrate to managed PostgreSQL and private S3-compatible image storage, introduce tenant roles/invitations, audit logs, retention policies and upload quotas. These are planned work, not current capabilities. Do not put credentials in Git or send them in chat.

Hosting suggestion: a small VPS or container service with persistent storage, HTTPS, and automated backups for the pilot; managed PostgreSQL and object storage when multiple customers start. Exact costs depend on country, image retention, camera count and selected provider; obtain a live quote before purchasing. Camera inference runs locally in the browser and consumes device battery, rather than paying a cloud API per frame. No public hosting tool is available in this task.

## Recognition and mobile counting
Reference matching uses MobileNet embeddings; generic COCO-SSD provides only its supported object categories (including bowls, not a universal plate detector). This cannot identify every restaurant dish out of the box. Add several real examples per dish and validate on held-out footage under actual lighting. Close-looking dishes need a dedicated trained detector/classifier. Do not equate similarity score with measured accuracy.

Moving-phone mode is recognition plus explicit user confirmation. Fixed-camera mode uses tracked line crossings. The software cannot guarantee physical dish identity after occlusion, disappearance or camera movement. Measure false positives, missed dishes, double counts and identity switches against independently annotated footage before accepting automatic counts. The full automatically deduplicated moving-camera requirement remains research/validation work.

Model downloads use TensorFlow-hosted endpoints: storage.googleapis.com and tfhub.dev; redirects may require www.kaggle.com or kaggle.com. Model download access now works. The setup script verifies upstream artifact integrity and saves models locally. Chromium successfully loaded both real models and ran synthetic-frame inference; restaurant recognition accuracy remains untested. Local JS packages are installed. Browser model downloads do not upload camera video. Reference image upload is intentional and stored server-side.

## Hikvision NVR follow-up
Check the exact NVR and camera model/manual for RTSP stream export and supported ONVIF profile. Browser JavaScript cannot directly read RTSP. An authenticated edge connector on the restaurant LAN should pull RTSP, run detection/tracking there, and send count events and selected snapshots over HTTPS. Alternatively a gateway can convert video to WebRTC/HLS, with HLS latency considered. Do not expose NVR ports on the public Internet.

Typical Hikvision RTSP channel paths are `/Streaming/Channels/101` (channel 1 main) and `/Streaming/Channels/102` (substream), but verify against the actual model and firmware. Credentials must be stored on the edge securely; they are not yet needed for the mobile pilot. Supported camera selection should require documented RTSP/ONVIF, stable frame rate and resolution, fixed mounting, useful field of view, suitable lighting and a LAN edge device. Camera model compatibility and NVR integration have not yet been tested; no live web research tool was available.
