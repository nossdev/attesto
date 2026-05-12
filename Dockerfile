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

# Build-time version stamp. CI deploy/image workflows pass
# `--build-arg ATTESTO_VERSION=<git tag>`; local / un-tagged builds fall
# through to "dev". Read at startup by app/lib/version.ts and surfaced as the
# X-Attesto-Version header, in /health & /ready bodies, and via `attesto --version`.
# (The compiled binary reads it from the environment at runtime — hence ENV
# in the runtime stage, not a baked-in constant in the builder.)
ARG ATTESTO_VERSION=dev
ENV ATTESTO_VERSION=$ATTESTO_VERSION

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
