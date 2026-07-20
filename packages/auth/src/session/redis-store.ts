import * as crypto from "node:crypto";
import type {
  MinimalRedisClient,
  RedisSessionStoreOptions,
  RotateResult,
  SessionRecord,
  SessionStore,
} from "./types";

// ──────────────────────────────────────────────────────────────────────────
// Key layout (Sprint 3 — store-shape break, see handoff)
//
//   refresh:{sha256(token)}   → familyId              (string, EX ttl)
//   family:{familyId}         → HASH { user, current, revoked }  (EX ttl, sliding)
//   usessions:{userId}        → ZSET member=familyId score=expiryMs
//
// Only the SHA-256 *hash* of a refresh token is ever sent to Redis — the raw
// token stays in the caller's cookie/response and never touches the store.
//
// The family's `current` field is the single source of truth for rotation:
// replaying a token whose hash is present but no longer `current` is proof that
// an already-rotated token leaked → the whole family is revoked (reuse
// detection). Old (consumed) token hashes are retained until their own TTL
// lapses so replay stays detectable for the token lifetime.
//
// Members of `usessions:{userId}` carry an expiry score; every mutation prunes
// members whose score is in the past, so the set never accumulates orphans the
// way a plain SET (whose members outlive the expired `refresh:` keys) does.
//
// Cluster note: the scripts derive `family:`/`refresh:` keys from values read at
// runtime, so they are single-node (non-cluster) unless hash-tagged. Documented.
// ──────────────────────────────────────────────────────────────────────────

/** SHA-256(token) as lowercase hex — the at-rest identifier for a refresh token. */
const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const ISSUE = `
-- @nuraljs:issue
-- KEYS: refresh:{hash}, family:{familyId}, usessions:{userId}
-- ARGV: familyId, userId, hash, ttl, nowMs, expiryMs, cap
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('HSET', KEYS[2], 'user', ARGV[2], 'current', ARGV[3], 'revoked', '0')
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[5])
redis.call('ZADD', KEYS[3], ARGV[6], ARGV[1])
redis.call('EXPIRE', KEYS[3], ARGV[4])
local cap = tonumber(ARGV[7])
if cap and cap > 0 then
  local n = redis.call('ZCARD', KEYS[3])
  if n > cap then
    local victims = redis.call('ZRANGE', KEYS[3], 0, n - cap - 1)
    for _, fid in ipairs(victims) do
      local fk = 'family:' .. fid
      local cur = redis.call('HGET', fk, 'current')
      if cur then redis.call('DEL', 'refresh:' .. cur) end
      redis.call('DEL', fk)
      redis.call('ZREM', KEYS[3], fid)
    end
  end
end
return 'OK'
`;

const ROTATE = `
-- @nuraljs:rotate
-- KEYS: refresh:{oldHash}
-- ARGV: oldHash, newHash, ttl, expiryMs
local familyId = redis.call('GET', KEYS[1])
if not familyId then return {'invalid'} end
local fkey = 'family:' .. familyId
local revoked = redis.call('HGET', fkey, 'revoked')
if not revoked then return {'invalid'} end
local user = redis.call('HGET', fkey, 'user')
if revoked == '1' then return {'revoked', familyId, user} end
local current = redis.call('HGET', fkey, 'current')
if current ~= ARGV[1] then
  -- an already-rotated token is being replayed → compromise: kill the family
  redis.call('HSET', fkey, 'revoked', '1')
  if current then redis.call('DEL', 'refresh:' .. current) end
  return {'reuse', familyId, user}
end
redis.call('SET', 'refresh:' .. ARGV[2], familyId, 'EX', ARGV[3])
redis.call('HSET', fkey, 'current', ARGV[2])
redis.call('EXPIRE', fkey, ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', 'usessions:' .. user, ARGV[4], familyId)
redis.call('EXPIRE', 'usessions:' .. user, ARGV[3])
return {'ok', familyId, user}
`;

const LOOKUP = `
-- @nuraljs:lookup
-- KEYS: refresh:{hash}
-- ARGV: hash
local familyId = redis.call('GET', KEYS[1])
if not familyId then return {} end
local fkey = 'family:' .. familyId
local revoked = redis.call('HGET', fkey, 'revoked')
if revoked ~= '0' then return {} end
local current = redis.call('HGET', fkey, 'current')
if current ~= ARGV[1] then return {} end
local user = redis.call('HGET', fkey, 'user')
return {user, familyId}
`;

const REVOKE = `
-- @nuraljs:revoke
-- KEYS: refresh:{hash}
local familyId = redis.call('GET', KEYS[1])
if not familyId then return 0 end
local fkey = 'family:' .. familyId
local user = redis.call('HGET', fkey, 'user')
local current = redis.call('HGET', fkey, 'current')
if current then redis.call('DEL', 'refresh:' .. current) end
redis.call('DEL', KEYS[1])
redis.call('DEL', fkey)
if user then redis.call('ZREM', 'usessions:' .. user, familyId) end
return 1
`;

const REVOKE_ALL = `
-- @nuraljs:revokeAll
-- KEYS: usessions:{userId}
local fids = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, fid in ipairs(fids) do
  local fk = 'family:' .. fid
  local cur = redis.call('HGET', fk, 'current')
  if cur then redis.call('DEL', 'refresh:' .. cur) end
  redis.call('DEL', fk)
end
redis.call('DEL', KEYS[1])
return #fids
`;

/** Coerce a Lua string-reply element to a JS string (Redis returns strings/false). */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Creates a Redis-backed refresh-session store.
 *
 * Every mutation is a single atomic Lua script; refresh tokens are stored as
 * SHA-256 hashes; token families enable rotation-reuse detection; per-user
 * session sets prune expired members and honour an optional cap.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * const redis = new Redis();
 * const store = createRedisSessionStore(redis, { maxSessionsPerUser: 5 });
 * const sessions = createSessionManager(auth, store);
 * ```
 */
export function createRedisSessionStore(
  redisClient: MinimalRedisClient,
  options: RedisSessionStoreOptions = {},
): SessionStore {
  const cap = options.maxSessionsPerUser ?? 0;
  const now = options.now ?? Date.now;

  return {
    issue: async (token, userId, ttl) => {
      const familyId = crypto.randomUUID();
      const hash = hashToken(token);
      const nowMs = now();
      const expiryMs = nowMs + ttl * 1000;
      await redisClient.eval(
        ISSUE,
        3,
        `refresh:${hash}`,
        `family:${familyId}`,
        `usessions:${userId}`,
        familyId,
        userId,
        hash,
        ttl,
        nowMs,
        expiryMs,
        cap,
      );
      return { familyId };
    },

    rotate: async (oldToken, newToken, ttl): Promise<RotateResult> => {
      const oldHash = hashToken(oldToken);
      const newHash = hashToken(newToken);
      const expiryMs = now() + ttl * 1000;
      const reply = (await redisClient.eval(
        ROTATE,
        1,
        `refresh:${oldHash}`,
        oldHash,
        newHash,
        ttl,
        expiryMs,
      )) as unknown[];
      const status = str(reply?.[0]) as RotateResult["status"] | undefined;
      switch (status) {
        case "ok":
        case "reuse":
        case "revoked":
          return { status, familyId: str(reply[1]), userId: str(reply[2]) };
        default:
          return { status: "invalid" };
      }
    },

    lookup: async (token): Promise<SessionRecord | null> => {
      const hash = hashToken(token);
      const reply = (await redisClient.eval(LOOKUP, 1, `refresh:${hash}`, hash)) as unknown[];
      const userId = str(reply?.[0]);
      const familyId = str(reply?.[1]);
      if (!userId || !familyId) return null;
      return { userId, familyId };
    },

    revoke: async (token) => {
      const hash = hashToken(token);
      await redisClient.eval(REVOKE, 1, `refresh:${hash}`);
    },

    revokeAllForUser: async (userId) => {
      await redisClient.eval(REVOKE_ALL, 1, `usessions:${userId}`);
    },
  };
}

/** Exposed for tests / custom stores that want the same at-rest hashing. */
export { hashToken };
