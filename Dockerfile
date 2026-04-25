# syntax=docker/dockerfile:1.7

# ───── Builder ────────────────────────────────────────────────────────────────
FROM denoland/deno:2.7.12 AS builder
WORKDIR /app

COPY deno.json deno.lock* ./
COPY src ./src
COPY migrations ./migrations
COPY drizzle.config.ts ./

RUN deno cache src/main.ts

RUN deno compile \
      --allow-net --allow-env --allow-read \
      --include migrations \
      --include src/services/apple/roots \
      --output /app/attesto \
      src/main.ts

# ───── Runtime ───────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -r attesto && useradd -r -g attesto attesto

COPY --from=builder /app/attesto /usr/local/bin/attesto

USER attesto
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/attesto"]
