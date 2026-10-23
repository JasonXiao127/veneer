import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { loadEnv, DEFAULT_SESSION_SECRET } from "./env.js";
import { SessionStore } from "./sessionStore.js";
import { registerSessionRoutes } from "./session.js";
import { registerQbProxy } from "./qbProxy.js";
import { registerRulesRoutes, startRulesTicker } from "./rules.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.logLevel }, trustProxy: env.trustProxy });

  // Fail closed on the public placeholder BEFORE binding the socket: a
  // post-listen exit(1) flaps the port and misleads logs. Also catches an
  // empty SESSION_SECRET (normalized to the placeholder in loadEnv).
  if (env.sessionSecret === DEFAULT_SESSION_SECRET) {
    app.log.error(
      "SESSION_SECRET is unset or the public default — refusing to boot. Generate one with `openssl rand -hex 32` and set it in .env.",
    );
    process.exit(1);
  }
  if (env.sessionSecret.length < 16) {
    app.log.warn("SESSION_SECRET is shorter than 16 characters — use `openssl rand -hex 32`.");
  }

  const rawPort = (process.env.PORT ?? "").trim();
  // Compare the literal string: "8081.0"/"08081" parse to 8081 but produce an
  // invalid compose port mapping, so they must warn too.
  if (rawPort !== "" && rawPort !== String(env.port)) {
    app.log.warn(`PORT=${rawPort} is invalid; listening on ${env.port} instead. Compose maps the raw value — fix PORT to avoid an unreachable container.`);
  }

  const sessions = new SessionStore(env.sessionTtlMs);
  // Reap cadence scales with TTL so short TTLs don't linger ~1h past expiry.
  const pruneMs = Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.floor(env.sessionTtlMs / 4)));
  setInterval(() => sessions.prune(), pruneMs).unref();

  await app.register(cookie, { secret: env.sessionSecret });
  await registerSessionRoutes(app, env, sessions);
  await registerQbProxy(app, env, sessions);
  await registerRulesRoutes(app, env, sessions);
  startRulesTicker(app, env, sessions);

  app.get("/api/health", async () => ({ ok: true }));

  // Exact "/api" (no trailing slash) is API too — otherwise the SPA fallback
  // answers a JSON probe with 200 text/html.
  const isApiRequest = (url: string): boolean => {
    const path = url.split("?")[0];
    return path === "/api" || path.startsWith("/api/");
  };

  // Serve frontend build if present (prod single-image); dev mode has no dist — skip silently
  const candidates = [
    path.resolve(process.cwd(), "..", "frontend", "dist"),
    path.resolve(process.cwd(), "frontend", "dist"),
    path.resolve(process.cwd(), "dist", "frontend"),
  ];
  const distDir = candidates.find((d) => fs.existsSync(d));
  if (distDir) {
    await app.register(fastifyStatic, { root: distDir, prefix: "/" });
    app.setNotFoundHandler(async (req, reply) => {
      if (isApiRequest(req.url)) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(async (req, reply) => {
      if (isApiRequest(req.url)) return reply.code(404).send({ error: "Not found" });
      return reply.code(200).send({ name: "veneer backend (frontend not built)" });
    });
  }

  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`veneer listening on ${env.host}:${env.port}`);
    if (!env.cookieSecure) {
      app.log.warn("COOKIE_SECURE=false: veneer_sid is served without the Secure flag. Only use plain HTTP on trusted networks; terminate TLS at a reverse proxy otherwise.");
    }
    if (!env.trustProxy) {
      app.log.warn("TRUST_PROXY=false: client IPs are socket addresses. Behind a reverse proxy set TRUST_PROXY=1 or the login brake keys on the proxy IP (one user can block everyone). NEVER enable on a directly exposed socket (XFF spoofing bypasses the brake).");
    }
    if (env.host === "127.0.0.1" || env.host === "::1" || env.host === "localhost") {
      app.log.warn(`HOST=${env.host} binds loopback inside the container/netns; Docker-published ports will be unreachable. Use 0.0.0.0 behind a published port.`);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main().catch((err) => {
  // Any boot-time throw (bad config, port in use) must exit non-zero with a
  // readable message rather than an unhandled rejection trace.
  console.error(err);
  process.exit(1);
});
