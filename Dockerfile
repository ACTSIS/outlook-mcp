# Production image for the authenticated intranet MCP HTTP server
# (`node bin/m365-mcp.js http`). The local stdio entry points stay untouched:
# this image only serves the remote, token-exchange-based MCP listener.
#
# No credentials, tokens, keys, or .env files are baked into the image; see
# .dockerignore for the build-context whitelist and compose.yaml for the
# runtime-only configuration contract.
FROM node:22.22.1-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Install exactly the locked production dependency set. `--ignore-scripts`
# blocks dependency lifecycle scripts; no dev tooling is shipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# The runtime module graph only. Tests, packaging tooling, docs, and every
# local credential file are excluded by the explicit COPY list plus the
# `.dockerignore` whitelist.
COPY config.js index.js outlook-auth-server.js ./
COPY bin/m365-mcp.js bin/m365-mcp.js
COPY auth auth
COPY calendar calendar
COPY email email
COPY folder folder
COPY onedrive onedrive
COPY power-automate power-automate
COPY remote remote
COPY rules rules
COPY runtime runtime
COPY signature signature
COPY sites sites
COPY teams teams
COPY utils utils

# Dedicated directory for the durable encrypted bridge credential store
# (compose.yaml mounts a Compose-project-scoped named volume here and sets
# MCP_HTTP_BRIDGE_STORE_DIR to this path). Created EMPTY and owned by the
# runtime user: no bridge-store.bin, key, token, or credential of any kind
# is generated during the build. On the first mount of an empty named
# volume Docker copies the image directory content and owner into the
# volume, so the store stays owned by uid 1000 with mode 0700.
RUN mkdir -p /app/data/oauth \
    && chown node:node /app/data/oauth \
    && chmod 0700 /app/data/oauth

# Unprivileged runtime user (uid 1000 from the base image). TLS PEMs are
# provided at runtime through a read-only volume mount and must be readable by
# this uid; unreadable certificates fail startup with a clear error.
USER node

# The listener inside the container is a direct TLS endpoint on 8443
# (compose.yaml publishes it to the host loopback by default).
EXPOSE 8443

CMD ["node", "bin/m365-mcp.js", "http"]
