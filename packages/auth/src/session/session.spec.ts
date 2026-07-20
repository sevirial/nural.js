import { describe, it, expect, vi } from "vitest";
import * as crypto from "node:crypto";
import { z } from "zod";
import { createRedisSessionStore, hashToken } from "./redis-store";
import { createSessionManager, RefreshTokenReuseError } from "./session-manager";
import type { MinimalRedisClient } from "./types";

// ──────────────────────────────────────────────────────────────────────────
// FakeRedis — an in-memory keyspace whose `eval` faithfully mirrors the Lua
// scripts in redis-store.ts. It models string / hash / zset types with lazy
// TTL expiry driven by an injectable clock, and executes each of the store's
// five scripts (dispatched by the `-- @nuraljs:*` marker) against that
// keyspace — the same KEYS/ARGV the real client would receive. Mirror the Lua
// exactly when either side changes.
// ──────────────────────────────────────────────────────────────────────────
class FakeRedis implements MinimalRedisClient {
  private strings = new Map<string, { v: string; exp: number }>();
  private hashes = new Map<string, { v: Map<string, string>; exp: number }>();
  private zsets = new Map<string, { v: Map<string, number>; exp: number }>();

  constructor(private clock: () => number) {}

  // --- primitives (with lazy TTL) -----------------------------------------
  private live(exp: number): boolean {
    return exp > this.clock();
  }
  private get(k: string): string | false {
    const e = this.strings.get(k);
    if (!e) return false;
    if (!this.live(e.exp)) {
      this.strings.delete(k);
      return false;
    }
    return e.v;
  }
  private set(k: string, v: string, exSec?: number): void {
    this.strings.set(k, { v, exp: exSec ? this.clock() + exSec * 1000 : Infinity });
  }
  private hget(k: string, f: string): string | false {
    const e = this.hashes.get(k);
    if (!e || !this.live(e.exp)) {
      if (e) this.hashes.delete(k);
      return false;
    }
    return e.v.get(f) ?? false;
  }
  private hset(k: string, pairs: [string, string][]): void {
    let e = this.hashes.get(k);
    if (!e || !this.live(e.exp)) e = { v: new Map(), exp: Infinity };
    for (const [f, val] of pairs) e.v.set(f, val);
    this.hashes.set(k, e);
  }
  private del(k: string): void {
    this.strings.delete(k);
    this.hashes.delete(k);
    this.zsets.delete(k);
  }
  private expire(k: string, sec: number): void {
    const exp = this.clock() + sec * 1000;
    for (const m of [this.strings, this.hashes, this.zsets] as const) {
      const e = m.get(k) as { exp: number } | undefined;
      if (e) e.exp = exp;
    }
  }
  private zset(k: string): Map<string, number> {
    const e = this.zsets.get(k);
    if (!e || !this.live(e.exp)) {
      const fresh = { v: new Map<string, number>(), exp: Infinity };
      this.zsets.set(k, fresh);
      return fresh.v;
    }
    return e.v;
  }
  private zadd(k: string, score: number, member: string): void {
    this.zset(k).set(member, score);
  }
  private zremExpired(k: string, before: number): void {
    const z = this.zset(k);
    for (const [m, s] of z) if (s < before) z.delete(m);
  }
  private zrangeAsc(k: string, start: number, stop: number): string[] {
    const sorted = [...this.zset(k).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end);
  }
  private zrem(k: string, member: string): void {
    this.zset(k).delete(member);
  }

  // --- eval: dispatch on the script marker --------------------------------
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const KEYS = args.slice(0, numKeys).map(String);
    const ARGV = args.slice(numKeys).map(String);

    if (script.includes("@nuraljs:issue")) {
      const [familyId, userId, hash, ttl, nowMs, expiryMs, cap] = ARGV as string[];
      this.set(KEYS[0]!, familyId!, Number(ttl));
      this.hset(KEYS[1]!, [
        ["user", userId!],
        ["current", hash!],
        ["revoked", "0"],
      ]);
      this.expire(KEYS[1]!, Number(ttl));
      this.zremExpired(KEYS[2]!, Number(nowMs));
      this.zadd(KEYS[2]!, Number(expiryMs), familyId!);
      this.expire(KEYS[2]!, Number(ttl));
      const capN = Number(cap);
      if (capN > 0) {
        const n = this.zset(KEYS[2]!).size;
        if (n > capN) {
          for (const fid of this.zrangeAsc(KEYS[2]!, 0, n - capN - 1)) {
            const cur = this.hget(`family:${fid}`, "current");
            if (cur) this.del(`refresh:${cur}`);
            this.del(`family:${fid}`);
            this.zrem(KEYS[2]!, fid);
          }
        }
      }
      return "OK";
    }

    if (script.includes("@nuraljs:rotate")) {
      const [oldHash, newHash, ttl, expiryMs] = ARGV as string[];
      const familyId = this.get(KEYS[0]!);
      if (!familyId) return ["invalid"];
      const fkey = `family:${familyId}`;
      const revoked = this.hget(fkey, "revoked");
      if (!revoked) return ["invalid"];
      const user = this.hget(fkey, "user") || undefined;
      if (revoked === "1") return ["revoked", familyId, user];
      const current = this.hget(fkey, "current");
      if (current !== oldHash) {
        this.hset(fkey, [["revoked", "1"]]);
        if (current) this.del(`refresh:${current}`);
        return ["reuse", familyId, user];
      }
      this.set(`refresh:${newHash}`, familyId, Number(ttl));
      this.hset(fkey, [["current", newHash!]]);
      this.expire(fkey, Number(ttl));
      this.expire(KEYS[0]!, Number(ttl));
      this.zadd(`usessions:${user}`, Number(expiryMs), familyId);
      this.expire(`usessions:${user}`, Number(ttl));
      return ["ok", familyId, user];
    }

    if (script.includes("@nuraljs:lookup")) {
      const [hash] = ARGV as string[];
      const familyId = this.get(KEYS[0]!);
      if (!familyId) return [];
      const fkey = `family:${familyId}`;
      if (this.hget(fkey, "revoked") !== "0") return [];
      if (this.hget(fkey, "current") !== hash) return [];
      return [this.hget(fkey, "user") || "", familyId];
    }

    if (script.includes("@nuraljs:revokeAll")) {
      const fids = this.zrangeAsc(KEYS[0]!, 0, -1);
      for (const fid of fids) {
        const cur = this.hget(`family:${fid}`, "current");
        if (cur) this.del(`refresh:${cur}`);
        this.del(`family:${fid}`);
      }
      this.del(KEYS[0]!);
      return fids.length;
    }

    if (script.includes("@nuraljs:revoke")) {
      const familyId = this.get(KEYS[0]!);
      if (!familyId) return 0;
      const fkey = `family:${familyId}`;
      const user = this.hget(fkey, "user");
      const current = this.hget(fkey, "current");
      if (current) this.del(`refresh:${current}`);
      this.del(KEYS[0]!);
      this.del(fkey);
      if (user) this.zrem(`usessions:${user}`, familyId);
      return 1;
    }

    throw new Error("FakeRedis: unrecognised script");
  }

  // --- test introspection (GCs expired entries, like real Redis) ----------
  keys(): string[] {
    const out: string[] = [];
    for (const m of [this.strings, this.hashes, this.zsets] as const) {
      for (const [k, e] of m as Map<string, { exp: number }>) {
        if (this.live(e.exp)) out.push(k);
        else m.delete(k);
      }
    }
    return out;
  }
  stringValues(): string[] {
    return [...this.strings.entries()].filter(([, e]) => this.live(e.exp)).map(([, e]) => e.v);
  }
  sessionMembers(userId: string): string[] {
    return [...this.zset(`usessions:${userId}`).keys()];
  }
}

// A no-op signer so we can drive the session manager without real crypto.
const schema = z.object({ id: z.string() });
const fakeAuth = { sign: async (_p: z.infer<typeof schema>) => "access.jwt.token" };

describe("createRedisSessionStore + createSessionManager", () => {
  const setup = (opts?: { cap?: number }) => {
    let time = 1_000_000;
    const clock = () => time;
    const redis = new FakeRedis(clock);
    const store = createRedisSessionStore(redis, {
      now: clock,
      maxSessionsPerUser: opts?.cap ?? 0,
    });
    const sessions = createSessionManager<typeof schema>(fakeAuth, store, {
      refreshTtlSeconds: 100,
    });
    return { redis, store, sessions, advance: (ms: number) => (time += ms) };
  };

  it("issues and rotates atomically; the rotated chain stays valid", async () => {
    const { store, sessions } = setup();
    const { refreshToken: r0 } = await sessions.issue("user_1", { id: "user_1" });

    const rotated = await sessions.rotate(r0, { id: "user_1" });
    expect(rotated.refreshToken).not.toBe(r0);
    expect(rotated.accessToken).toBe("access.jwt.token");

    // Old token is no longer the family's current → not resolvable.
    expect(await store.lookup(r0)).toBeNull();
    // New token resolves to the same user.
    expect((await store.lookup(rotated.refreshToken))?.userId).toBe("user_1");

    // The chain continues to rotate.
    const again = await sessions.rotate(rotated.refreshToken, { id: "user_1" });
    expect((await store.lookup(again.refreshToken))?.userId).toBe("user_1");
  });

  it("persists only token hashes at rest — never the raw refresh token", async () => {
    const { redis, sessions } = setup();
    const { refreshToken: raw } = await sessions.issue("user_1", { id: "user_1" });

    const allKeys = redis.keys();
    const allVals = redis.stringValues();
    // The raw token appears in no key or value; its SHA-256 hash keys the entry.
    expect(allKeys.some((k) => k.includes(raw))).toBe(false);
    expect(allVals.includes(raw)).toBe(false);
    expect(allKeys).toContain(`refresh:${hashToken(raw)}`);
  });

  it("detects reuse of a rotated token → revokes the whole family + audits", async () => {
    const time = 2_000;
    const redis = new FakeRedis(() => time);
    const store = createRedisSessionStore(redis, { now: () => time });
    const onReuse = vi.fn();
    const sessions = createSessionManager<typeof schema>(fakeAuth, store, {
      refreshTtlSeconds: 100,
      onReuse,
    });

    const { refreshToken: r0 } = await sessions.issue("user_9", { id: "user_9" });
    const r1 = (await sessions.rotate(r0, { id: "user_9" })).refreshToken;

    // Replay the already-rotated r0 → reuse detected.
    await expect(sessions.rotate(r0, { id: "user_9" })).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
    expect(onReuse).toHaveBeenCalledTimes(1);
    expect(onReuse.mock.calls[0]![0]).toMatchObject({ type: "refresh_reuse", userId: "user_9" });

    // Family is dead: the previously-valid r1 no longer resolves and cannot rotate.
    expect(await store.lookup(r1)).toBeNull();
    await expect(sessions.rotate(r1, { id: "user_9" })).rejects.toThrow(/reuse|invalid|revoked/i);
  });

  it("prunes expired session members — no orphans left behind", async () => {
    const { redis, sessions, advance } = setup();
    await sessions.issue("user_ttl", { id: "user_ttl" });
    expect(redis.sessionMembers("user_ttl")).toHaveLength(1);

    // Let the refresh TTL (100s) lapse.
    advance(101_000);

    // A new issue prunes the stale member instead of leaving it orphaned.
    await sessions.issue("user_ttl", { id: "user_ttl" });
    expect(redis.sessionMembers("user_ttl")).toHaveLength(1);
    // And the expired refresh/family keys are gone (lazy TTL).
    expect(redis.keys().filter((k) => k.startsWith("family:"))).toHaveLength(1);
  });

  it("enforces the concurrent-session cap by evicting the oldest family", async () => {
    const { redis, store, sessions } = setup({ cap: 2 });
    const a = await sessions.issue("user_cap", { id: "user_cap" });
    const b = await sessions.issue("user_cap", { id: "user_cap" });
    const c = await sessions.issue("user_cap", { id: "user_cap" });

    // Cap = 2 → only two families survive.
    expect(redis.sessionMembers("user_cap")).toHaveLength(2);
    // The oldest (a) was evicted; its refresh token no longer resolves.
    expect(await store.lookup(a.refreshToken)).toBeNull();
    expect((await store.lookup(b.refreshToken))?.userId).toBe("user_cap");
    expect((await store.lookup(c.refreshToken))?.userId).toBe("user_cap");
  });

  it("revokes a single session and all sessions for a user", async () => {
    const { store, sessions } = setup();
    const one = await sessions.issue("user_r", { id: "user_r" });
    const two = await sessions.issue("user_r", { id: "user_r" });

    await sessions.revoke(one.refreshToken);
    expect(await store.lookup(one.refreshToken)).toBeNull();
    expect((await store.lookup(two.refreshToken))?.userId).toBe("user_r");

    await sessions.revokeAll("user_r");
    expect(await store.lookup(two.refreshToken)).toBeNull();
  });

  it("rejects an unknown/expired refresh token on rotate", async () => {
    const { sessions } = setup();
    await expect(sessions.rotate(crypto.randomUUID(), { id: "x" })).rejects.toThrow(
      /invalid or expired/i,
    );
  });
});
