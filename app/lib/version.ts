/**
 * Build/release version of the running Attesto binary.
 *
 * Stamped at image-build time: on a `v*` tag push the CI deploy workflows pass
 * `--build-arg ATTESTO_VERSION=<git tag>` to `fly deploy` (and to the GHCR
 * image build); the Dockerfile turns that ARG into an `ENV ATTESTO_VERSION`;
 * this module reads it once at startup. A `workflow_dispatch` (manual) run of
 * those workflows stamps the branch name instead of a tag (`main`, …) — still
 * a meaningful breadcrumb. A build with no build arg at all — local `deno run`,
 * a hand-run `docker build` / `fly deploy` off a laptop — reports `"dev"`.
 *
 * Surfaced as the `X-Attesto-Version` response header on every HTTP response,
 * as `X-Attesto-Version` on outbound webhook POSTs, in the `/health` and
 * `/ready` bodies, and via `attesto --version`.
 *
 * INFORMATIONAL ONLY. Integrators must not branch on it — the HTTP API is
 * versioned by URL path (`/v1/...`) and the webhook payload contract is
 * stable. This value changes on every deploy; treat it as a debugging /
 * support breadcrumb, not a contract.
 */
export const VERSION: string = Deno.env.get("ATTESTO_VERSION") ?? "dev";

/** Response + outbound-delivery header carrying {@link VERSION}. */
export const ATTESTO_VERSION_HEADER = "X-Attesto-Version";
