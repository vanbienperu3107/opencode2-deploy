// Gắn hook prompt/context của OpenCode vào logic recall. Không import SDK, nên test được trực tiếp.
// Định danh request: sessionID từ event + thứ tự prompt trong session. Prompt mới thay entry cũ của cùng session.
// Khối memory do plugin tạo luôn bắt đầu bằng BLOCK_MARK. Chỉ các khối đó được thay/xóa; phần tử khác của system không bị đụng.
import {
  CONTEXT_WAIT_MS,
  buildQuery,
  PENDING_TTL_MS,
  RECALL_TIMEOUT_MS,
  loadConfig,
  renderBlock,
  runRecall,
  withTimeout,
  type FetchLike,
  type RecallResult,
} from "./core.ts"
import { extractQuery, makeLogger, shortId } from "./log.ts"

export const BLOCK_MARK = "[hindsight-recall:block]"
export const MAX_TRACKED_SESSIONS = 100

export interface Deps {
  env: Record<string, string | undefined>
  fetchImpl: FetchLike
  contextWaitMs?: number
  recallTimeoutMs?: number
  logMaxBytes?: number
}

export interface HookRegistrar {
  session: { hook(name: string, fn: (event: any) => any): any }
}

type Entry = {
  promise: Promise<RecallResult>
  startedAt: number
  request: number
  recallCalls: number
  contextCalls: number
  recallMs?: number
  resolved?: RecallResult
}

export type InsertAction = "inserted" | "replaced" | "kept" | "deduplicated" | "removed" | "none"

export function sessionKey(event: any): string {
  return typeof event?.sessionID === "string" && event.sessionID ? event.sessionID : ""
}

function isOwnBlock(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.text === "string" && v.text.startsWith(BLOCK_MARK)
}

// Đặt đúng MỘT khối của plugin trong system.
// - text = null: xóa mọi khối của plugin.
// - Đã có khối: thay khối đầu tiên, xóa các khối trùng sau nó.
// - Chưa có: thêm một khối vào cuối.
// Không đổi bất kỳ phần tử nào khác của system.
export function applyBlock(system: any, text: string | null): { action: InsertAction; blocks: number } {
  if (!Array.isArray(system)) return { action: "none", blocks: 0 }
  const idx: number[] = []
  system.forEach((v: any, i: number) => {
    if (isOwnBlock(v)) idx.push(i)
  })
  if (text === null) {
    if (idx.length === 0) return { action: "none", blocks: 0 }
    for (let k = idx.length - 1; k >= 0; k--) system.splice(idx[k], 1)
    return { action: "removed", blocks: 0 }
  }
  if (idx.length === 0) {
    system.push({ type: "text", text })
    return { action: "inserted", blocks: 1 }
  }
  const first = idx[0]
  let action: InsertAction = system[first].text === text ? "kept" : "replaced"
  for (let k = idx.length - 1; k >= 1; k--) system.splice(idx[k], 1)
  system[first] = { type: "text", text }
  if (idx.length > 1) action = "deduplicated"
  return { action, blocks: 1 }
}

export async function attach(ctx: HookRegistrar, deps: Deps): Promise<boolean> {
  const log = makeLogger(deps.env.HINDSIGHT_RECALL_LOG, deps.logMaxBytes)
  const cfg = loadConfig(deps.env)
  if (!cfg) {
    log({ event: "disabled", reason: "config_missing" })
    return false
  }
  const contextWaitMs = deps.contextWaitMs ?? CONTEXT_WAIT_MS
  const recallTimeoutMs = deps.recallTimeoutMs ?? RECALL_TIMEOUT_MS
  const pending = new Map<string, Entry>()
  // Câu hỏi gần nhất của mỗi session (chỉ dùng để ghép query cho câu tiếp nối; không chứa memory).
  const lastPrompt = new Map<string, string>()
  let seq = 0
  log({ event: "loaded", total_chars: cfg.budget.totalChars, item_chars: cfg.budget.itemChars })

  // Dọn entry hết hạn và giới hạn số session theo dõi.
  const sweep = (now: number) => {
    for (const [k, v] of pending) if (now - v.startedAt > PENDING_TTL_MS) pending.delete(k)
    while (pending.size > MAX_TRACKED_SESSIONS) {
      let oldestKey: string | undefined
      let oldest = Infinity
      for (const [k, v] of pending) {
        if (v.startedAt < oldest) {
          oldest = v.startedAt
          oldestKey = k
        }
      }
      if (oldestKey === undefined) break
      pending.delete(oldestKey)
    }
  }

  await ctx.session.hook("prompt", (event: any) => {
    try {
      sweep(Date.now())
      const sid = sessionKey(event)
      const request = ++seq
      if (!sid) {
        log({ event: "recall", status: "skipped", reason: "no_session", request })
        return
      }
      const raw = extractQuery(event)
      if (!raw) {
        pending.delete(sid)
        log({ event: "recall", status: "skipped", reason: "no_query", session: shortId(sid), request })
        return
      }
      const query = buildQuery(raw, lastPrompt.get(sid))
      lastPrompt.delete(sid)
      lastPrompt.set(sid, raw)
      while (lastPrompt.size > MAX_TRACKED_SESSIONS) lastPrompt.delete(lastPrompt.keys().next().value as string)
      const startedAt = Date.now()
      const entry: Entry = {
        promise: undefined as unknown as Promise<RecallResult>,
        startedAt,
        request,
        recallCalls: 1,
        contextCalls: 0,
      }
      entry.promise = runRecall(cfg, query, deps.fetchImpl, undefined, recallTimeoutMs)
        .catch((): RecallResult => ({ status: "error", items: [], received: 0 }))
        .then((r) => {
          entry.recallMs = Date.now() - startedAt
          return r
        })
      pending.set(sid, entry)
      log({ event: "recall_start", session: shortId(sid), request })
    } catch {
      log({ event: "hook_error", hook: "prompt" })
    }
  })

  await ctx.session.hook("context", async (event: any) => {
    const t0 = Date.now()
    const sid = sessionKey(event)
    const system = event?.system
    try {
      const entry = sid ? pending.get(sid) : undefined
      if (!entry) {
        // Không có recall cho request này: gỡ khối cũ (nếu mảng còn mang theo) để không dùng memory của request trước.
        const { action, blocks } = applyBlock(system, null)
        log({
          event: "context",
          status: "no_pending",
          context_calls: 0,
          recall_calls: 0,
          memory_blocks: blocks,
          insert_action: action,
          recall_ms: null,
          context_hook_ms: Date.now() - t0,
          session: shortId(sid),
        })
        return
      }
      entry.contextCalls++
      if (!entry.resolved) {
        const r = await withTimeout(entry.promise, contextWaitMs)
        entry.resolved = r === "timeout" ? { status: "timeout", items: [], received: 0 } : r
      }
      const { block, stats } = renderBlock(entry.resolved, cfg.budget)
      const { action, blocks } = applyBlock(system, BLOCK_MARK + "\n" + block)
      // Chỉ ghi metadata. Không ghi prompt, nội dung memory hay token.
      log({
        event: "context",
        recall_status: entry.resolved.status,
        context_calls: entry.contextCalls,
        recall_calls: entry.recallCalls,
        memory_blocks: blocks,
        insert_action: action,
        recall_ms: entry.recallMs ?? null,
        context_hook_ms: Date.now() - t0,
        received: stats.received,
        inserted: stats.inserted,
        truncated: stats.truncated,
        dropped: stats.dropped,
        chars: stats.chars,
        session: shortId(sid),
        request: entry.request,
      })
    } catch {
      log({ event: "hook_error", hook: "context" })
    }
  })
  return true
}
