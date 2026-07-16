import { buildRateLimitKey, getRedis } from "./redis"

const reserveScript = `
local reservation_id = ARGV[1]
local persisted = tonumber(ARGV[2])
local reservation = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local accounted = tonumber(redis.call("GET", KEYS[1]) or "0")

if persisted > accounted then
  accounted = persisted
  redis.call("SET", KEYS[1], accounted, "EX", ttl)
end

if redis.call("HGET", KEYS[2], reservation_id) then
  return {1, accounted}
end

if accounted + reservation > limit then
  return {0, accounted}
end

local updated = accounted + reservation
redis.call("SET", KEYS[1], updated, "EX", ttl)
redis.call("HSET", KEYS[2], reservation_id, reservation)
redis.call("EXPIRE", KEYS[2], ttl)
return {1, updated}
`

const settleScript = `
local reservation_id = ARGV[1]
local actual = math.max(0, tonumber(ARGV[2]))
local ttl = tonumber(ARGV[3])
local reserved = redis.call("HGET", KEYS[2], reservation_id)

if not reserved then
  return tonumber(redis.call("GET", KEYS[1]) or "0")
end

local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local updated = math.max(0, current - tonumber(reserved) + actual)
redis.call("SET", KEYS[1], updated, "EX", ttl)
redis.call("HDEL", KEYS[2], reservation_id)
if redis.call("HLEN", KEYS[2]) == 0 then
  redis.call("DEL", KEYS[2])
else
  redis.call("EXPIRE", KEYS[2], ttl)
end
return updated
`

interface QuotaRedis {
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>
}

export function freeAutoReservationUpperBound(maxTokensPerRequest: number, weeklyLimit: number) {
  return Math.min(Math.ceil(maxTokensPerRequest), Math.ceil(weeklyLimit))
}

export async function reserveFreeAutoQuota(
  input: {
    workspaceID: string
    modelID: string
    weekStart: Date
    persistedUsage: number
    reservation: number
    weeklyLimit: number
    ttlSeconds: number
  },
  client: QuotaRedis = getRedis() as QuotaRedis,
  keyBuilder: typeof buildRateLimitKey = buildRateLimitKey,
) {
  const accountedKey = keyBuilder(
    "free-auto-weekly-pending",
    Bun.hash(`${input.workspaceID}:${input.modelID}`).toString(16),
    input.weekStart.toISOString().slice(0, 10),
  )
  const reservationsKey = `${accountedKey}:reservations`
  const reservationID = crypto.randomUUID()
  const ttl = Math.max(60, Math.ceil(input.ttlSeconds))
  const result = (await client.eval(
    reserveScript,
    [accountedKey, reservationsKey],
    [reservationID, input.persistedUsage, input.reservation, input.weeklyLimit, ttl],
  )) as [number, number]
  if (Number(result[0]) !== 1) return

  const state: { settle?: Promise<void> } = {}
  return {
    reservation: input.reservation,
    settle(actualUsage = input.reservation) {
      if (state.settle) return state.settle
      state.settle = client
        .eval(settleScript, [accountedKey, reservationsKey], [reservationID, actualUsage, ttl])
        .then(() => undefined)
      return state.settle
    },
  }
}
