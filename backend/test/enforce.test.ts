import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { enforceSession, type Rule } from "../src/rules.js";

// Regression test for qB 5.3+: setShareLimits 400s without shareLimitsMode.
// Stubs the two endpoints enforceSession touches and captures the POST body.
describe("enforceSession setShareLimits params", () => {
  it("sends shareLimitAction=Default and shareLimitsMode=Default", async () => {
    let posted = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/api/v2/torrents/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              hash: "ABC123",
              tracker: "https://tracker.example.com/announce",
              private: false,
              ratio_limit: -2,
              seeding_time_limit: -2,
              inactive_seeding_time_limit: -2,
            },
          ])
        );
        return;
      }
      if (req.url === "/api/v2/torrents/setShareLimits" && req.method === "POST") {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
          posted = raw;
          res.writeHead(200);
          res.end("");
        });
        return;
      }
      res.writeHead(404);
      res.end("");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const rules: Rule[] = [
        {
          id: "pub",
          label: "Public",
          match: { kind: "public" },
          ratioLimit: 0.5,
          seedingTimeLimit: 1440,
          inactiveSeedingTimeLimit: 1440,
          enabled: true,
        },
      ];
      const result = await enforceSession({
        qbUrl: `http://127.0.0.1:${port}`,
        sid: { name: "SID", value: "x" },
        rules,
      });
      assert.equal(result.matched, 1);
      assert.equal(result.applied, 1);
      assert.equal(result.failed, 0);
      const body = new URLSearchParams(posted);
      assert.equal(body.get("shareLimitAction"), "Default");
      assert.equal(body.get("shareLimitsMode"), "Default");
      assert.equal(body.get("ratioLimit"), "0.5");
    } finally {
      server.close();
    }
  });
});
