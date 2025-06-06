ARG NODE_VERSION=20.11.1
ARG PNPM_VERSION=8.15.4
ARG TS_VERSION=5.3.3

# Builder stage
FROM node:${NODE_VERSION} AS build

WORKDIR /usr/src/app

RUN npm install -g typescript@${TS_VERSION}
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@${PNPM_VERSION}
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=pnpm-lock.yaml,target=pnpm-lock.yaml \
    --mount=type=bind,source=patches,target=patches \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build
RUN pnpm prune --prod

# Runner stage
FROM node:${NODE_VERSION}-slim AS final

COPY package.json .
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist

ENV NODE_ENV=production
ENV TZ=Europe/Budapest
ENV HTTPS_METHOD=local-ip.medicmobile.org
ENV DOWNLOAD_DIR=/data/downloads
ENV TORRENT_DIR=/data/torrentfiles
ENV MAX_CONNS_PER_TORRENT=50
ENV DOWNLOAD_SPEED_MBPS=20
ENV UPLOAD_SPEED_MBPS=1
ENV SEED_TIME_HOURS=48
ENV TORRENT_TIMEOUT_SECONDS=5

VOLUME /data

RUN mkdir -p /data
RUN chown -R node /data

USER node

EXPOSE 58827
EXPOSE 58828

CMD ["npm", "start"]