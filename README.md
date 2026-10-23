# Veneer — modern WebUI overlay for qBittorrent

Separate UI on `:8081` proxying to native qB WebUI API v2. Login passthrough, React.

## Quick start

```bash
cp .env.example .env
# required: put a unique secret in .env (openssl rand -hex 32)
docker compose up --build
# open http://localhost:8081, log in with qB creds
```

Dev (needs qB at `QB_URL` and a session secret):

```bash
npm run install:all
QB_URL=http://localhost:8080 PORT=8081 SESSION_SECRET="$(openssl rand -hex 32)" npm run dev:backend
npm run dev:frontend   # http://localhost:5173, /api proxied to $PORT (default 8081)
```

## Notes

- qB 5.x uses `torrents/stop|start` + `stopped=true`; older uses `pause|resume` + `paused=true`. Detected via `app/webapiVersion` at login (integer compare, `isWebApiV5Plus` backend / `isV5Plus` frontend).
- qB 5.2+: session cookie is `QBT_SID_<port>` and login answers 204 empty (older: `SID` + 200 `Ok.`). Both accepted; the cookie name is stored per session.
- Main view is driven by `sync/maindata?rid=` deltas merged per-hash; `transfer/info` is not polled.
- Mutations are `application/x-www-form-urlencoded`, never JSON. `torrents/delete` requires explicit `deleteFiles`.
- Login rate-limited (4/min) plus a 3-failures-per-10min brake per IP — qB bans the container IP after 5 fails, locking out everyone.
- Behind a reverse proxy: set `TRUST_PROXY=true` **and** have the proxy overwrite `X-Forwarded-Host` (or set `PUBLIC_ORIGIN` to the browser-facing URL) so the login origin check works. Never forward a client-supplied `X-Forwarded-Host`.
- Views: Torrents (site grouping, bulk actions), Search (plugins + results), RSS (feeds + auto-download rules), Logs (main + peer bans), Rules (per-site seed enforcement, auto-applied every `RULES_INTERVAL_MIN` while sessions are active).
- Seed rules: `{ match by site/private/public, ratioLimit, seedingTimeLimit, inactiveSeedingTimeLimit }` enforced via `setShareLimits` (qB 5.2+ also gets `shareLimitAction`).

## Configuration

| Var | Default | Notes |
|---|---|---|
| `QB_URL` | `http://localhost:8080` | qB WebUI origin (compose sets `http://qbittorrent:8080`) |
| `PORT` / `HOST` | `8081` / `0.0.0.0` | Keep compose `ports` in sync with `PORT` |
| `SESSION_SECRET` | (required) | Cookie signing key; placeholder/empty refuses to boot |
| `LOG_LEVEL` | `info` | Fastify log level (invalid values fall back to `info`) |
| `TRUST_PROXY` | `false` | Only `true` behind a real reverse proxy |
| `COOKIE_SECURE` | `false` | Set `true` when serving HTTPS |
| `PUBLIC_ORIGIN` | (empty) | Browser-facing URL when a proxy rewrites `Host`, e.g. `https://veneer.example.com` |
| `VENEER_COOKIE` | `veneer_sid` | Session cookie name |
| `SESSION_TTL_HOURS` | `24` | Sliding session TTL (1–720) |
| `RULES_FILE` | `./data/rules.json` | Seed-rule store (JSON; mounted at `./veneer-data` in compose) |
| `RULES_INTERVAL_MIN` | `5` | Auto-enforce cadence in minutes (`0` disables) |

## qBittorrent hardening (recommended)

- In qB settings → WebUI, add the veneer container to the IP whitelist/bypass-auth list (or raise MaxAuthenticationFailures), so a ban can never lock out all users.
- Only set `TRUST_PROXY=true` when Veneer actually sits behind a reverse proxy; otherwise per-IP limits misbehave.
- Serve Veneer over HTTPS (or trusted LAN only): `COOKIE_SECURE=false` leaves the session cookie sniffable on plain HTTP.
