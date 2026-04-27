# syntax=docker/dockerfile:1.7

# ───── Builder ────────────────────────────────────────────────────────────────
FROM denoland/deno:2.7.12 AS builder
WORKDIR /app

COPY deno.json deno.lock* ./
COPY app ./app
COPY migrations ./migrations
COPY drizzle.config.ts ./

RUN deno cache app/main.ts

RUN deno compile \
      --allow-net --allow-env --allow-read \
      --include migrations \
      --include app/services/apple/roots \
      --output /app/attesto \
      app/main.ts

# ───── Runtime ───────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -r attesto && useradd -r -g attesto attesto

COPY --from=builder /app/attesto /usr/local/bin/attesto

# Drizzle's migrator does fs.readdirSync on migrationsFolder. While
# `deno compile --include migrations` embeds the SQL files in the
# binary, Drizzle's directory enumeration goes through Node's fs
# polyfill and is safer against real on-disk files. Belt-and-suspenders
# alongside the import.meta.url-based resolution in app/db/migrate.ts.
COPY --from=builder /app/migrations /app/migrations
WORKDIR /app

USER attesto
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/attesto"]
