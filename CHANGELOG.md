# Changelog

## v0.1.1 (2026-11-06)

Catches the release up to `main` (v0.1.0 tagged the initial commit only).

### Hardening (from 88d7e0b, previously unreleased)
- qB proxy: auth-fault classification (5xx/redirect/4xx no longer burn the anti-ban brake), 25 MB request / 50 MB response caps, SID rotation, redirect rewriting, connection draining.
- Session: in-flight login race guard, config-fault vs bad-password distinction, version-probe retry, sliding cookies on 403/5xx paths.
- Rules: fail-safe loads (corrupt shape enforces nothing), strict POST validation, batched `setShareLimits`, abort after 3 consecutive failures.
- Frontend: sync guards, version-aware stop/start verbs, dialog/drawer hardening.

### Added in this release
- Backend unit tests (38 tests, `node --import tsx --test`): login brake, origin check, proxy path scope, SID extraction, version compare, rule matching/compliance/validation, session store.
- CI workflow (`.github/workflows/ci.yml`): backend typecheck + tests + build, frontend typecheck + build, high-level audit gate.
- Dependency fix: `@fastify/static` 8.3.0 → 10.1.10 (high path-traversal/route-guard advisories resolved); `fast-uri` patched via audit fix. Verified: typecheck, tests, build, and static serving smoke test pass. `npm audit --omit=dev` clean on both packages.

## v0.1.0 (2026-10-23)
- Initial release: Veneer qBittorrent WebUI overlay (Fastify backend, React frontend). Backend tsc and frontend Vite build verified.
