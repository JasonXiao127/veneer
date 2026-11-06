import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restInScope } from "../src/qbProxy.js";

describe("restInScope", () => {
  it("allows plain qB endpoints", () => {
    assert.equal(restInScope("app/version"), true);
    assert.equal(restInScope("torrents/info"), true);
    assert.equal(restInScope("sync/maindata"), true);
    assert.equal(restInScope("rss/items"), true);
  });
  it("allows percent-encoded segments", () => {
    assert.equal(restInScope("torrents/%2F"), true);
  });
  it("rejects dot-segments (path escape via fetch normalization)", () => {
    assert.equal(restInScope("../etc"), false);
    assert.equal(restInScope("a/../b"), false);
    assert.equal(restInScope("a/./b"), false);
    assert.equal(restInScope("."), false);
    assert.equal(restInScope(".."), false);
  });
  it("rejects encoded dot-segments, including double-encoded", () => {
    assert.equal(restInScope("%2e%2e/secret"), false);
    assert.equal(restInScope("a/%2E/b"), false);
    assert.equal(restInScope("%252e%252e/secret"), false);
  });
  it("rejects backslashes, null bytes and illegal chars", () => {
    assert.equal(restInScope("foo\\bar"), false);
    assert.equal(restInScope("foo%00bar"), false);
    assert.equal(restInScope("foo bar"), false);
    assert.equal(restInScope("foo?bar"), false);
  });
});
