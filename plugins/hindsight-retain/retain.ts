// hindsight-retain (thử nghiệm): retain theo sự kiện kết thúc lượt. Logic thuần, không gọi mạng trực tiếp.
// Quy tắc: chỉ xét lượt mới sau watermark; lượt failed/interrupted không retain; loại synthetic và secret;
// debounce cấu hình được; tối đa 1 job đồng thời mỗi session; retry có backoff; document_id ổn định theo nội dung.
import { createHash } from "node:crypto"

export const SYNTH_MARKS = ["[hindsight-synth:block]", "[Bộ nhớ Hindsight"]
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]\s*\S+|passw(or)?d\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
export const MAX_CONTENT = 2000

export type Outcome = "succeeded" | "failed" | "interrupted"
export type Turn = { id: string; role: "user" | "assistant"; text: string; synthetic?: boolean }

export function containsSecret(s: string): boolean { return SECRET_RE.test(s) }

// Lấy các lượt mới sau watermark, chỉ tính lượt user + assistant thật.
export function newTurns(messages: Turn[], watermark: string | null): Turn[] {
  const start = watermark ? messages.findIndex((m) => m.id === watermark) + 1 : 0
  return messages.slice(Math.max(0, start)).filter((m) => !m.synthetic && !SYNTH_MARKS.some((k) => m.text.includes(k)))
}

// Chọn nội dung đáng lưu: bỏ secret, bỏ output quá dài (cắt), gắn trạng thái nguồn.
export function buildCandidate(turn: { text: string }, outcome: Outcome, sessionID: string, at: string) {
  if (outcome !== "succeeded") return null // failed/interrupted: không lưu như kết quả
  if (containsSecret(turn.text)) return { skipped: "secret" as const }
  const body = turn.text.length > MAX_CONTENT ? turn.text.slice(0, MAX_CONTENT) : turn.text
  return { content: `[nguồn: phiên ${sessionID.slice(-8)} | lúc: ${at} | trạng thái: đã hoàn tất (agent báo cáo, chưa kiểm chứng)]\n${body}`, truncated: turn.text.length > MAX_CONTENT }
}

// document_id ổn định theo phiên + nội dung: retry không tạo bản ghi mới.
export function documentId(sessionID: string, content: string): string {
  const h = createHash("sha256").update(sessionID + "\n" + content).digest("hex").slice(0, 16)
  return `auto-${sessionID.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${h}`
}

export function backoffMs(attempt: number, base = 500): number { return base * 2 ** attempt }

export function isRetryable(err: { kind?: string; http?: number }): boolean {
  return err.kind === "timeout" || err.kind === "network" || err.http === 429 || (err.http ?? 0) >= 500
}

// Debouncer theo session: chỉ chạy job sau khi im lặng `ms`; prompt mới hủy hẹn giờ cũ.
export function makeDebouncer(ms: number, run: (sid: string) => void, timers = { set: setTimeout, clear: clearTimeout }) {
  const t = new Map<string, any>()
  return {
    touch(sid: string) {
      const old = t.get(sid); if (old) timers.clear(old)
      t.set(sid, timers.set(() => { t.delete(sid); run(sid) }, ms))
    },
    cancel(sid: string) { const old = t.get(sid); if (old) { timers.clear(old); t.delete(sid) } },
    pending() { return t.size },
  }
}

// Hàng đợi: tối đa `limit` job đồng thời, và không chạy 2 job cùng session.
export function makeQueue(limit: number) {
  const running = new Set<string>(); const waiting: Array<{ sid: string; job: () => Promise<void> }> = []
  const pump = () => {
    for (let i = 0; i < waiting.length && running.size < limit; ) {
      const w = waiting[i]
      if (running.has(w.sid)) { i++; continue }
      waiting.splice(i, 1); running.add(w.sid)
      w.job().finally(() => { running.delete(w.sid); pump() })
    }
  }
  return {
    push(sid: string, job: () => Promise<void>) { waiting.push({ sid, job }); pump() },
    stats() { return { running: running.size, waiting: waiting.length } },
  }
}
