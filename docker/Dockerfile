# One Dockerfile for both apps: docker build --build-arg APP=tickvana|nuvenna -f docker/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts
RUN pnpm install --frozen-lockfile && pnpm build
ARG APP
# Copies the app with its production dependencies only, workspace packages included.
RUN pnpm --filter @tvn/${APP} deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
# The built web app, served by the same process as the API.
ENV WEB_ROOT=/app/dist/web
WORKDIR /app
COPY --from=build --chown=node:node /out .
# Attachments live here. Created before VOLUME so a fresh volume belongs to node.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
ARG APP
ENV APP=${APP}
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/${APP}/api/health" || exit 1
CMD ["node", "dist/index.js"]
