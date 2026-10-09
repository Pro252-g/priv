FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=network_ca \
    if [ -f /run/secrets/network_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/network_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /data /media /backups \
    && chown node:node /data /media /backups \
    && chmod 700 /data /media /backups
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/backup-data.mjs ./scripts/backup-data.mjs
COPY --chown=node:node deploy/cloud-backup.sh ./deploy/cloud-backup.sh
COPY --chown=node:node deploy/verify-model-assets.mjs ./deploy/verify-model-assets.mjs
COPY --chown=node:node .local/models ./.local/models
RUN node deploy/verify-model-assets.mjs /app/.local/models
ENV HOST=0.0.0.0 PORT=3000 IEP_DATA_DIR=/data IEP_MEDIA_DIR=/media IEP_MODELS_DIR=/app/.local/models IEP_SECURE_COOKIE=true
USER node
VOLUME ["/data", "/media", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
