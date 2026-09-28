# Build with Bun (matches local tooling), run on Node so node:sqlite is used.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:24-slim
WORKDIR /app
COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build /app/build ./build
COPY package.json ./
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/start.sh ./start.sh
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/votes.sqlite
EXPOSE 8080
CMD ["./start.sh"]
