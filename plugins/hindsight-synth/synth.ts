// hindsight-synth: đưa kết quả recall vào lượt chat dưới dạng synthetic message (không đụng system).
// Thay thế plugin hindsight-recall (context injection). KHÔNG nạp đồng thời hai plugin.
// Không gọi retain. Không xóa/sửa lịch sử gốc: chỉ lọc danh sách message gửi model trong hook context.
import {
  CONTEXT_WAIT_MS,
  RECALL_TIMEOUT_MS,
  buildQuery,
  loadConfig,
  renderBlock,
  runRecall,
  withTimeout,
  type FetchLike,
  type RecallResult,
} from "./core.ts"
import { extractQuery, makeLogger, shortId } from "./log.ts"
import { createHash } from "node:crypto"

export const SYNTH_MARK = "[hindsight-synth:block]"
export const MAX_TRACKED_SESSIONS = 100
// Retry có backoff, chỉ cho lỗi tạm (timeout, network, HTTP 429/5xx). Lỗi token/parse/4xx không retry.
export const RETRY_ATTEMPTS = 2
export const RETRY_BASE_MS = 200
export function isTransient(r: RecallResult): boolean {
  const f = r.failure
  if (!f) return false
  if (f.kind === "timeout" || f.kind === "network") return true
  if (f.kind === "http" && (f.http === 429 || (f.http !== undefined && f.http >= 500))) return true
  return false
}

export interface Deps {
  env: Record<string, string | undefined>
  fetchImpl: FetchLike
  contextWaitMs?: number
  recallTimeoutMs?: number
  logMaxBytes?: number
}

export interface SynthRegistrar {
  session: {
    hook(name: string, fn: (event: any) => any): any
    synthetic(input: { sessionID: string; text: string; resume?: boolean }): Promise<any>
  }
}

function sessionKey(event: any): string {
  return typeof event?.sessionID === "string" && event.sessionID ? event.sessionID : ""
}

function errKind(e: unknown): string {
  const n = (e as any)?.name
  return typeof n === "string" ? n.slice(0, 40) : "unknown"
}

function textOf(m: any): string {
  if (typeof m?.content === "string") return m.content
  if (Array.isArray(m?.content)) return m.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
  return ""
}

// Trả về chỉ số các block synthetic trong messages. Chỉ nhận diện bằng SYNTH_MARK ở đầu nội dung.
export function synthIndexes(messages: any[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => {
    if (m?.role === "user" && textOf(m).startsWith(SYNTH_MARK)) out.push(i)
  })
  return out
}

// Lọc request: giữ block synthetic MỚI NHẤT, bỏ các block cũ hơn. Không đổi lịch sử gốc, chỉ đổi mảng gửi đi.
// Trả về số block đã bỏ để log.
export function pruneForRequest(messages: any[]): number {
  const idx = synthIndexes(messages)
  if (idx.length === 0) return 0
  // Block của lượt N được chèn TRƯỚC tin nhắn người dùng của lượt N. Ranh giới là tin nhắn người dùng thật
  // thứ hai từ cuối (lượt trước). Block nằm sau ranh giới này thuộc lượt hiện tại; block cũ hơn bị bỏ khỏi request.
  const real: number[] = []
  messages.forEach((m, i) => {
    if (m?.role === "user" && !textOf(m).startsWith(SYNTH_MARK)) real.push(i)
  })
  const prevReal = real.length >= 2 ? real[real.length - 2] : -1
  const latest = idx[idx.length - 1]
  const keep = latest > prevReal ? latest : -1
  const drop = idx.filter((i) => i !== keep).sort((a, b) => b - a)
  for (const i of drop) messages.splice(i, 1)
  return drop.length
}

export async function attach(ctx: SynthRegistrar, deps: Deps): Promise<boolean> {
  const log = makeLogger(deps.env.HINDSIGHT_RECALL_LOG, deps.logMaxBytes)
  const cfg = loadConfig(deps.env)
  if (!cfg) {
    log({ event: "disabled", plugin: "synth", reason: "config_missing" })
    return false
  }
  const contextWaitMs = deps.contextWaitMs ?? CONTEXT_WAIT_MS
  const recallTimeoutMs = deps.recallTimeoutMs ?? RECALL_TIMEOUT_MS
  const lastPrompt = new Map<string, string>()
  // Hash khối gần nhất đã chèn cho mỗi session (chỉ để tránh chèn trùng liên tiếp).
  const lastHash = new Map<string, string>()
  let seq = 0
  log({ event: "loaded", plugin: "synth", total_chars: cfg.budget.totalChars, item_chars: cfg.budget.itemChars })

  // Hook context: chạy trước mỗi request model. Chỉ lọc mảng messages gửi đi.
  await ctx.session.hook("context", (event: any) => {
    try {
      const msgs = Array.isArray(event?.messages) ? event.messages : null
      if (!msgs) return
      const pruned = pruneForRequest(msgs)
      if (pruned > 0) log({ event: "synth", status: "pruned", count: pruned, session: shortId(sessionKey(event)) })
    } catch {
      log({ event: "hook_error", plugin: "synth", hook: "context" })
    }
  })

  await ctx.session.hook("prompt", async (event: any) => {
    const request = ++seq
    const sid = sessionKey(event)
    if (!sid) {
      log({ event: "synth", status: "skipped", reason: "no_session", request })
      return
    }
    const raw = extractQuery(event)
    if (!raw) {
      log({ event: "synth", status: "skipped", reason: "no_query", session: shortId(sid), request })
      return
    }
    try {
      const query = buildQuery(raw, lastPrompt.get(sid))
      lastPrompt.delete(sid)
      lastPrompt.set(sid, raw)
      while (lastPrompt.size > MAX_TRACKED_SESSIONS) lastPrompt.delete(lastPrompt.keys().next().value as string)

      const t0 = Date.now()
      const deadline = t0 + contextWaitMs
      let r: RecallResult = { status: "timeout", items: [], received: 0 }
      let attempts = 0
      for (let a = 0; a <= RETRY_ATTEMPTS; a++) {
        attempts = a + 1
        const left = deadline - Date.now()
        if (left <= 0) break
        const got = await withTimeout(runRecall(cfg, query, deps.fetchImpl, undefined, Math.min(recallTimeoutMs, left)), left)
        r = got === "timeout" ? { status: "timeout", items: [], received: 0 } : got
        if (r.status === "ok" || !isTransient(r)) break
        if (a < RETRY_ATTEMPTS) {
          const wait = Math.min(RETRY_BASE_MS * 2 ** a, Math.max(0, deadline - Date.now()))
          if (wait <= 0) break
          await new Promise((res) => setTimeout(res, wait))
        }
      }
      const recallMs = Date.now() - t0
      if (r.status !== "ok") {
        // Lượt hiện tại không có memory: chèn block TRẠNG THÁI (rỗng/lỗi) để model biết, không dùng block lượt trước.
        const stateBlock = renderBlock(r, cfg.budget).block
        try {
          await ctx.session.synthetic({ sessionID: sid, text: SYNTH_MARK + "\n" + stateBlock, resume: false })
        } catch (e) {
          log({ event: "synth", status: "failed", reason: errKind(e), session: shortId(sid), request })
        }
        log({
          event: "synth",
          status: "state_injected",
          recall_status: r.status,
          recall_stage: r.failure?.stage,
          recall_kind: r.failure?.kind,
          recall_http: r.failure?.http,
          recall_cid: r.failure?.cid,
          recall_ms: recallMs,
          attempts,
          session: shortId(sid),
          request,
        })
        return
      }
      const { block, stats } = renderBlock(r, cfg.budget)
      if (stats.inserted === 0) {
        log({ event: "synth", status: "skipped", reason: "no_fit", received: stats.received, dropped: stats.dropped, session: shortId(sid), request })
        return
      }
      const hash = createHash("sha256").update(block).digest("hex").slice(0, 16)
      // Block trùng với block gần nhất: không chèn lại. Block cũ vẫn đúng ngữ cảnh.
      try {
        await ctx.session.synthetic({ sessionID: sid, text: SYNTH_MARK + "\n" + block, resume: false })
        lastHash.delete(sid)
        lastHash.set(sid, hash)
        while (lastHash.size > MAX_TRACKED_SESSIONS) lastHash.delete(lastHash.keys().next().value as string)
        log({
          event: "synth",
          status: "injected",
          recall_status: "ok",
          received: stats.received,
          inserted: stats.inserted,
          truncated: stats.truncated,
          dropped: stats.dropped,
          chars: stats.chars,
          recall_ms: recallMs,
          session: shortId(sid),
          request,
        })
      } catch (e) {
        log({ event: "synth", status: "failed", reason: errKind(e), session: shortId(sid), request })
      }
    } catch {
      log({ event: "hook_error", plugin: "synth", hook: "prompt" })
    }
  })
  return true
}
