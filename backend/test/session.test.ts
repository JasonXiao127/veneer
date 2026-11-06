import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  failBlocked,
  failRecord,
  loginSameOrigin,
  _clearLoginBrakeForTests,
} from "../src/session.js";
import { SessionStore } from "../src/sessionStore.js";
import type { Env } from "../src/env.js";

const baseEnv: Env = {
  qbUrl: "http://localhost:8080",
  port: 8081,
  host: "0.0.0.0",
  sessionSecret: "test-secret-1234567890",
  logLevel: "silent",
  trustProxy: false,
  cookieSecure: false,
  veneerCookie: "veneer_sid",
  sessionTtlMs: 24 * 3600 * 1000,
  rulesFile: "./data/rules.json",
  rulesIntervalMin: 5,
  publicOrigin: "",
};

function fakeReq(opts: { origin?: string; referer?: string; host?: string; xfh?: string }): any {
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  if (opts.host) headers.host = opts.host;
  if (opts.xfh) headers["x-forwarded-host"] = opts.xfh;
  return { headers, ip: "1.2.3.4" };
}

describe("login brake", () => {
  beforeEach(() => _clearLoginBrakeForTests());

  it("allows fresh IPs and blocks after 3 failures", () => {
    const ip = "9.9.9.9";
    assert.equal(failBlocked(ip), false);
    failRecord(ip, false);
    assert.equal(failBlocked(ip), false);
    failRecord(ip, false);
    assert.equal(failBlocked(ip), false);
    failRecord(ip, false);
    assert.equal(failBlocked(ip), true);
  });

  it("success clears failures", () => {
    const ip = "10.0.0.1";
    failRecord(ip, false);
    failRecord(ip, false);
    failRecord(ip, true);
    assert.equal(failBlocked(ip), false);
  });
});

describe("loginSameOrigin", () => {
  it("allows requests without Origin/Referer (curl, tests)", () => {
    assert.equal(loginSameOrigin(fakeReq({ host: "example.com" }), baseEnv), true);
  });
  it("allows same-host origin, rejects cross-site", () => {
    assert.equal(
      loginSameOrigin(fakeReq({ origin: "http://example.com:8081", host: "example.com:8081" }), baseEnv),
      true
    );
    assert.equal(
      loginSameOrigin(fakeReq({ origin: "https://evil.com", host: "example.com:8081" }), baseEnv),
      false
    );
  });
  it("PUBLIC_ORIGIN is authoritative when set", () => {
    const env = { ...baseEnv, publicOrigin: "https://veneer.example.com" };
    assert.equal(
      loginSameOrigin(fakeReq({ origin: "https://veneer.example.com", host: "other.internal" }), env),
      true
    );
    assert.equal(
      loginSameOrigin(fakeReq({ origin: "https://other.internal", host: "other.internal" }), env),
      false
    );
  });
  it("trustProxy consults X-Forwarded-Host", () => {
    const env = { ...baseEnv, trustProxy: true };
    assert.equal(
      loginSameOrigin(
        fakeReq({ origin: "https://veneer.example.com", host: "127.0.0.1:8081", xfh: "veneer.example.com" }),
        env
      ),
      true
    );
  });
});

describe("SessionStore", () => {
  it("creates, slides TTL on get, and expires", () => {
    const store = new SessionStore(50);
    const id = store.create({ qbSid: { name: "SID", value: "v" }, webapiVersion: "2.11", isV5: true });
    assert.ok(store.get(id));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(store.get(id), undefined);
        resolve();
      }, 70);
    });
  });
  it("caps at 10k entries", () => {
    const store = new SessionStore(3600 * 1000);
    for (let i = 0; i < 10_005; i++) {
      store.create({ qbSid: { name: "SID", value: String(i) }, webapiVersion: "2.11", isV5: true });
    }
    assert.ok(store.size <= 10_001);
  });
});
