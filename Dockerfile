# Task Inbox — production image.
#
# One stage, because there is nothing to build: no bundler, no transpiler, no
# TypeScript. The whole app is the source you can read in src/ and public/.
#
# The same image runs on Railway today and on a Raspberry Pi later — node:22
# publishes arm64 alongside amd64, so `docker build` on the Pi needs no changes.

FROM node:22-alpine

# tini is a 1-file init. Without it Node runs as PID 1, where Linux ignores the
# default SIGTERM handler — so `docker stop` would wait its full timeout and
# then kill the process, cutting off the Mongo connection mid-flight instead of
# letting index.js close it cleanly.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first, as their own layer. They change far less often than the
# source, so an edit to a route reuses the cached npm install instead of
# re-downloading everything.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile says — unlike `npm install`, which
# may quietly resolve a newer version and give you an image that differs from
# what you tested. --omit=dev leaves out anything only the tests need.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Run as a non-root user. The node image ships one; if the container is ever
# escaped, the attacker lands as `node` rather than as root.
USER node

ENV NODE_ENV=production
# The platform overrides PORT; this is the fallback for a plain `docker run`.
ENV PORT=3200
EXPOSE 3200

# Docker's own check, for when this runs somewhere without a platform probe
# (the Pi, via compose). /healthz pings Mongo, so an app that is up but cannot
# reach its database correctly reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
