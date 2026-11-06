import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  trackerDomainMinimal,
  siteOfTracker,
  kindOfTorrent,
  ruleFor,
  complianceOf,
  validatePostedRule,
  loadRules,
  saveRules,
  type Rule,
} from "../src/rules.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mkRule = (over: Partial<Rule> & { id: string }): Rule => ({
  label: over.id,
  match: {},
  ratioLimit: -2,
  seedingTimeLimit: -2,
  inactiveSeedingTimeLimit: -2,
  enabled: true,
  ...over,
});

describe("trackerDomainMinimal", () => {
  it("lowercases and strips trailing dots", () => {
    assert.equal(trackerDomainMinimal("Tracker.Example.COM..."), "example.com");
  });
  it("keeps last two labels", () => {
    assert.equal(trackerDomainMinimal("tracker.a.example.com"), "example.com");
  });
  it("handles co.uk second-level suffixes", () => {
    assert.equal(trackerDomainMinimal("tracker.a.co.uk"), "a.co.uk");
  });
  it("returns IPs and ports as-is", () => {
    assert.equal(trackerDomainMinimal("192.168.1.1"), "192.168.1.1");
    assert.equal(trackerDomainMinimal("[::1]:8080"), "[::1]:8080");
  });
  it("returns empty for empty input", () => {
    assert.equal(trackerDomainMinimal(""), "");
  });
});

describe("siteOfTracker", () => {
  it("extracts registrable domain from announce URL", () => {
    assert.equal(siteOfTracker("https://tracker.example.com:443/announce?passkey=abc"), "example.com");
  });
  it("returns unknown for empty/invalid", () => {
    assert.equal(siteOfTracker(""), "unknown");
    assert.equal(siteOfTracker("not a url"), "unknown");
    assert.equal(siteOfTracker(undefined), "unknown");
  });
});

describe("kindOfTorrent", () => {
  it("respects explicit privacy flags", () => {
    assert.equal(kindOfTorrent({ private: true }), "private");
    assert.equal(kindOfTorrent({ private: false }), "public");
    assert.equal(kindOfTorrent({ isPrivate: true }), "private");
  });
  it("promotes credentialed trackers to private, never guesses public", () => {
    assert.equal(kindOfTorrent({ tracker: "https://t.example.com/announce?passkey=xyz" }), "private");
    assert.equal(kindOfTorrent({ tracker: "https://t.example.com/announce" }), "unknown");
    assert.equal(kindOfTorrent({}), "unknown");
  });
});

describe("ruleFor", () => {
  const siteRule = mkRule({ id: "site", match: { site: "example.com", kind: "private" }, ratioLimit: 1 });
  const kindRule = mkRule({ id: "kind", match: { kind: "private" }, ratioLimit: 2 });
  const global = mkRule({ id: "global", match: {}, ratioLimit: 3 });

  it("prefers site-exact over kind over global", () => {
    const rules = [global, kindRule, siteRule];
    assert.equal(ruleFor(rules, "private", "example.com")?.id, "site");
    assert.equal(ruleFor(rules, "private", "other.com")?.id, "kind");
    assert.equal(ruleFor(rules, "public", "other.com")?.id, "global");
  });
  it("ignores disabled rules and never matches unknown sites to site rules", () => {
    const disabled = mkRule({ id: "d", match: { site: "example.com" }, enabled: false });
    assert.equal(ruleFor([disabled, global], "private", "example.com")?.id, "global");
    // "unknown" sentinel must not match a site rule
    const siteOnly = mkRule({ id: "s", match: { site: "example.com" } });
    assert.equal(ruleFor([siteOnly], "private", "unknown"), undefined);
  });
  it("kind rule requires matching kind", () => {
    assert.equal(ruleFor([kindRule], "public", "other.com"), undefined);
  });
});

describe("complianceOf", () => {
  it("reports compliant when all dims match (epsilon for floats)", () => {
    const rule = mkRule({ id: "r", ratioLimit: 1.0, seedingTimeLimit: 60, inactiveSeedingTimeLimit: 30 });
    const c = complianceOf({ ratio_limit: 1.0, seeding_time_limit: 60, inactive_seeding_time_limit: 30 }, rule);
    assert.deepEqual(c, { ratioOk: true, timeOk: true, inactiveOk: true });
  });
  it("reports drift and treats -2 strictly", () => {
    const rule = mkRule({ id: "r", ratioLimit: -2, seedingTimeLimit: 60, inactiveSeedingTimeLimit: -2 });
    const c = complianceOf({ ratio_limit: -1, seeding_time_limit: 60, inactive_seeding_time_limit: -2 }, rule);
    assert.equal(c.ratioOk, false);
    assert.equal(c.timeOk, true);
    assert.equal(c.inactiveOk, true);
  });
  it("treats missing values as compliant (partial qB responses)", () => {
    const rule = mkRule({ id: "r", ratioLimit: 5, seedingTimeLimit: 5, inactiveSeedingTimeLimit: 5 });
    const c = complianceOf({}, rule);
    assert.deepEqual(c, { ratioOk: true, timeOk: true, inactiveOk: true });
  });
  it("no rule means compliant", () => {
    assert.deepEqual(complianceOf({ ratio_limit: 0 }, undefined), {
      ratioOk: true,
      timeOk: true,
      inactiveOk: true,
    });
  });
});

describe("validatePostedRule", () => {
  it("accepts a valid rule and normalizes site", () => {
    const v = validatePostedRule({
      label: "Example",
      match: { site: "Tracker.Example.com.", kind: "private" },
      ratioLimit: 1,
      seedingTimeLimit: 60,
      inactiveSeedingTimeLimit: 30,
    });
    assert.equal(v.error, undefined);
    assert.equal(v.rule?.match.site, "example.com");
  });
  it("rejects bad labels, kinds, sites and limits", () => {
    assert.ok(validatePostedRule({ label: "", match: {}, ratioLimit: -2, seedingTimeLimit: -2, inactiveSeedingTimeLimit: -2 }).error);
    assert.ok(
      validatePostedRule({ label: "x", match: { kind: "weird" }, ratioLimit: -2, seedingTimeLimit: -2, inactiveSeedingTimeLimit: -2 }).error
    );
    assert.ok(
      validatePostedRule({ label: "x", match: { site: "unknown" }, ratioLimit: -2, seedingTimeLimit: -2, inactiveSeedingTimeLimit: -2 }).error
    );
    assert.ok(
      validatePostedRule({ label: "x", match: {}, ratioLimit: -3, seedingTimeLimit: -2, inactiveSeedingTimeLimit: -2 }).error
    );
    assert.ok(
      validatePostedRule({ label: "x", match: {}, ratioLimit: -2, seedingTimeLimit: 1.5, inactiveSeedingTimeLimit: -2 }).error
    );
  });
});

describe("loadRules/saveRules roundtrip", () => {
  it("persists and reloads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-rules-"));
    const file = path.join(dir, "rules.json");
    const rules = [mkRule({ id: "a", label: "A" }), mkRule({ id: "b", label: "B" })];
    saveRules(file, rules);
    const loaded = loadRules(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, "a");
  });
  it("missing file seeds defaults; corrupt shape enforces nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veneer-rules-"));
    const seeded = loadRules(path.join(dir, "nope.json"));
    assert.ok(seeded.length >= 2);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ rules: "nope" }));
    assert.deepEqual(loadRules(bad), []);
  });
});
