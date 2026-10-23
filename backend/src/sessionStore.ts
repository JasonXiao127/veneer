import { randomUUID } from "node:crypto";
import type { QbSid } from "./qbClient.js";

export interface VeneerSession {
  qbSid: QbSid;
  webapiVersion: string;
  isV5: boolean;
  lastUsed: number;
}

/** In-memory Map<veneerId, session>. Fine for v1 single-instance. */
export class SessionStore {
  private map = new Map<string, VeneerSession>();
  constructor(private ttlMs: number) {}

  create(s: Omit<VeneerSession, "lastUsed">): string {
    // Cap at creation time too: prune() runs as rarely as hourly at long
    // TTLs, and a credentialed flood could otherwise grow the map unbounded
    // between runs. Evicts oldest-created (LRU order maintained by get()).
    if (this.map.size >= 10_000) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    const id = randomUUID();
    this.map.set(id, { ...s, lastUsed: Date.now() });
    return id;
  }

  get(id: string | undefined): VeneerSession | undefined {
    if (!id) return undefined;
    const s = this.map.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastUsed > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    s.lastUsed = Date.now();
    // Re-insert so Map order is recency order — the 10k overflow eviction in
    // prune() then evicts least-recently-used, not oldest-created.
    this.map.delete(id);
    this.map.set(id, s);
    return s;
  }

  delete(id: string | undefined): void {
    if (id) this.map.delete(id);
  }

  updateSid(id: string, sid: QbSid): void {
    const s = this.map.get(id);
    if (s) {
      s.qbSid = sid;
      s.lastUsed = Date.now();
      // Keep iteration order = recency so overflow eviction stays LRU.
      this.map.delete(id);
      this.map.set(id, s);
    }
  }

  prune(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.map) {
      if (now - v.lastUsed > this.ttlMs) {
        this.map.delete(k);
        n++;
      }
    }
    // hard cap at 10k entries to bound memory
    if (this.map.size > 10_000) {
      const overflow = this.map.size - 10_000;
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= overflow) break;
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Read-only snapshot of live entries for background jobs (rules ticker).
   * Does not slide TTL or reorder. Call prune() first to drop expired ones.
   */
  entries(): Array<{ id: string; session: VeneerSession }> {
    // Clone each session (including qbSid) so background jobs cannot mutate
    // live TTL/SID state through the "read-only" snapshot.
    return [...this.map.entries()].map(([id, session]) => ({
      id,
      session: { ...session, qbSid: { ...session.qbSid } },
    }));
  }
}
