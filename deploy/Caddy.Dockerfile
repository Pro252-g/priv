FROM caddy:2.10.2-alpine
RUN setcap -r /usr/bin/caddy \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R 1000:1000 /data /config \
    && chmod 700 /data /config
COPY --chown=1000:1000 Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
