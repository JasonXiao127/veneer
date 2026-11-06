import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSid, isTimeoutError } from "../src/qbClient.js";
import { isWebApiV5Plus } from "../src/env.js";

describe("extractSid", () => {
  it("prefers SID and QBT_SID cookies", () => {
    assert.deepEqual(extractSid(["SID=abc; Path=/"]), { name: "SID", value: "abc" });
    assert.deepEqual(extractSid(["QBT_SID_8080=xyz; Path=/"]), { name: "QBT_SID_8080", value: "xyz" });
  });
  it("de-prioritizes foreign session cookies", () => {
    const sid = extractSid(["PHPSESSID=foreign; Path=/", "CUSTOM_SID=real; Path=/"]);
    assert.deepEqual(sid, { name: "CUSTOM_SID", value: "real" });
    // no fallback by default: foreign-only yields undefined
    assert.equal(extractSid(["PHPSESSID=foreign; Path=/"]), undefined);
    // login path allows fallback
    assert.deepEqual(extractSid(["PHPSESSID=foreign; Path=/"], true), {
      name: "PHPSESSID",
      value: "foreign",
    });
  });
  it("rotation paths never fall back to stray cookies", () => {
    assert.equal(extractSid(["other=value; Path=/"]), undefined);
    assert.equal(extractSid([]), undefined);
  });
});

describe("isTimeoutError", () => {
  it("detects TimeoutError and AbortError", () => {
    assert.equal(isTimeoutError(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
    assert.equal(isTimeoutError(Object.assign(new Error("a"), { name: "AbortError" })), true);
    assert.equal(isTimeoutError(new Error("boom")), false);
    assert.equal(isTimeoutError("nope"), false);
  });
});

describe("isWebApiV5Plus", () => {
  it("uses integer compare (2.9 < 2.11)", () => {
    assert.equal(isWebApiV5Plus("2.11.4"), true);
    assert.equal(isWebApiV5Plus("2.11"), true);
    assert.equal(isWebApiV5Plus("2.10"), false);
    assert.equal(isWebApiV5Plus("2.9.3"), false);
    assert.equal(isWebApiV5Plus("2.0"), false);
    assert.equal(isWebApiV5Plus("garbage"), false);
    assert.equal(isWebApiV5Plus(""), false);
  });
});
