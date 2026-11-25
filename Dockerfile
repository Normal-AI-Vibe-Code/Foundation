# A hosted Foundation: the server and the web client in one image (docs/hosting.md).
#
#   docker build -t foundation .
#
# The server is the same bundle the desktop app carries (scripts/desktop-server.mjs), on the same pinned
# Node, and it serves the built web client itself (FOUNDATION_CLIENT_DIR), so one program answers at one
# address. Everything that must be kept lives under /foundation (a volume): data/ (SQLite, the file
# archive, secret.key) and work/. Nothing is kept in the image.

# Node 22.22.0: `node:sqlite` with FTS5 (22.16+), the version scripts/desktop-server.mjs pins
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /src
# the workspaces' manifests first, so dependencies are a layer of their own
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY apps/extension/package.json apps/extension/
COPY apps/slack-agent/package.json apps/slack-agent/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund
COPY . .
# the web client, for the server's own origin (no VITE_FOUNDATION_SERVER: pages and API are one address)
RUN npm run build -w @foundation/client
# the server as two files and the starter characters
RUN node scripts/desktop-server.mjs --bundle-to /out/server

FROM node:22.22.0-bookworm-slim
# what agents and file reading shell out to; tini reaps the server's children and passes signals on
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/client/dist /app/client
# the server reads its version from the package.json one folder up from its bundle (clientversion.ts)
COPY --from=build /src/apps/server/package.json /app/package.json
COPY --from=build /src/docs/plan.json /app/docs/plan.json
COPY scripts/hosted-backup.mjs /app/backup.mjs
RUN mkdir -p /foundation /backups && chown -R node:node /foundation /backups
USER node
ENV NODE_ENV=production \
    FOUNDATION_ROOT=/foundation \
    FOUNDATION_HOST=0.0.0.0 \
    FOUNDATION_PORT=4410 \
    FOUNDATION_CLIENT_DIR=/app/client \
    FOUNDATION_PLAN_FILE=/app/docs/plan.json
VOLUME ["/foundation"]
EXPOSE 4410
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4410/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "--no-warnings", "/app/server/index.mjs"]
