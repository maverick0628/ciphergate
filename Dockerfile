FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
# alpine is musl, so better-sqlite3 has no usable prebuild and node-gyp compiles
# it from source. node-gyp defaults to `make -j<nproc>`, and the build host
# this image is built on has 4 cores, ~3 GiB available and a 4 GiB swap that sits
# permanently full. Four parallel g++ jobs is the memory spike that can OOM at the
# wrong instant and panic the kernel (mm/usercopy.c BUG under 6.12.33) — which
# would take the whole homelab down, mid-build, including this gateway.
#
# Serial compilation costs a couple of minutes and removes that risk.
ENV JOBS=1
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ ./src/
# `npm run build` is `tsc && node scripts/copy-ui-assets.mjs` — tsc does not emit
# non-TypeScript files, so the UI's html/css/js are copied into dist by that
# script. Without this COPY the build context lacks it and the build dies with
# MODULE_NOT_FOUND, which neither a local build nor CI reproduces because both
# have the whole repo on disk.
COPY scripts/copy-ui-assets.mjs ./scripts/
RUN npm run build

FROM node:22-alpine
# openssl generates the browser UI's self-signed certificate on first start.
# Node cannot sign an X.509 without a third-party library, and adding one to
# reach five runtime dependencies for this is a worse trade than a 1MB image
# package. Without it the UI falls back to plain HTTP with a warning.
RUN apk add --no-cache openssl
RUN addgroup -S gateway && adduser -S gateway -G gateway
WORKDIR /opt/ciphergate
COPY --from=builder /app/dist ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# Placeholder watchdog inventory baked into the image so a clean checkout builds.
# It probes nothing real — bind-mount your own watchdog.targets.json over it
# (the compose files do) or point WATCHDOG_TARGETS elsewhere. Compose can bind-mount an
# edited copy over it without a rebuild.
COPY watchdog.targets.example.json ./watchdog.targets.json
# Put the package bins on PATH so `docker exec ciphergate gateway ...`,
# `gateway-proxy ...`, `gateway-watchdog`, and `gateway-backup` work as documented. The compiled
# entries carry a `#!/usr/bin/env node` shebang; mark them executable and symlink.
RUN chmod +x cli.js proxy-cli.js watchdog-cli.js backup-cli.js \
 && ln -sf /opt/ciphergate/cli.js /usr/local/bin/gateway \
 && ln -sf /opt/ciphergate/proxy-cli.js /usr/local/bin/gateway-proxy \
 && ln -sf /opt/ciphergate/watchdog-cli.js /usr/local/bin/gateway-watchdog \
 && ln -sf /opt/ciphergate/backup-cli.js /usr/local/bin/gateway-backup
# /data holds runtime state (gateway db/keyfile, or the watchdog state file). Own
# it as the gateway user so a fresh *named* volume inherits writable ownership
# (bind mounts keep the host's ownership and are unaffected).
RUN mkdir -p /data && chown gateway:gateway /data
USER gateway
# 8400 = REST API (server.js); 8401 = streamable-http MCP transport (mcp-server.js, MCP_TRANSPORT=http)
# 8405 = browser UI (server.js, GATEWAY_UI_ENABLED), HTTPS with a generated cert
EXPOSE 8400 8401 8405
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8400/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
