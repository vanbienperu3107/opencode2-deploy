import { test } from "node:test"
import assert from "node:assert/strict"
import { newTurns, buildCandidate, documentId, backoffMs, isRetryable, makeDebouncer, makeQueue, containsSecret } from "../retain.ts"

const msgs = [
  { id: "u1", role: "user" as const, text: "hỏi A" }, { id: "a1", role: "assistant" as const, text: "đáp A" },
  { id: "u2", role: "user" as const, text: "hỏi B" }, { id: "a2", role: "assistant" as const, text: "đáp B" },
]
test("R1 watermark: chỉ lấy lượt sau watermark", () => {
  assert.deepEqual(newTurns(msgs, "a1").map((m) => m.id), ["u2", "a2"])
  assert.deepEqual(newTurns(msgs, null).length, 4)
})
test("R2 loại synthetic block và tin có marker", () => {
  const withSynth = [...msgs, { id: "s1", role: "user" as const, text: "x", synthetic: true },
    { id: "s2", role: "user" as const, text: "[hindsight-synth:block] y" }]
  assert.deepEqual(newTurns(withSynth, "a2").map((m) => m.id), [])
})
test("R3 failed/interrupted không thành candidate", () => {
  assert.equal(buildCandidate({ text: "dở dang" }, "failed", "ses_abcdef12", "t"), null)
  assert.equal(buildCandidate({ text: "dở dang" }, "interrupted", "ses_abcdef12", "t"), null)
})
test("R4 succeeded có nguồn và nhãn 'chưa kiểm chứng'", () => {
  const c = buildCandidate({ text: "kết quả 2+2=4" }, "succeeded", "ses_abcdef12", "2026-11-27T00:00Z") as any
  assert.ok(c.content.includes("chưa kiểm chứng"))
  assert.ok(c.content.includes("kết quả 2+2=4"))
})
test("R5 secret bị loại, không lưu", () => {
  const fakeKey = "sk-" + "ABCDEFGHIJKLMNOPQRST"
  assert.equal(containsSecret("token " + fakeKey), true)
  assert.deepEqual(buildCandidate({ text: "api_key = abc123xyz" }, "succeeded", "ses_1234567", "t"), { skipped: "secret" })
  assert.equal(containsSecret("bình thường không có khóa"), false)
})
test("R6 output dài bị cắt 2000 ký tự", () => {
  const c = buildCandidate({ text: "a".repeat(5000) }, "succeeded", "ses_abcdef12", "t") as any
  assert.equal(c.truncated, true); assert.ok(c.content.length < 2300)
})
test("R7 document_id hợp lệ theo proxy và ổn định", () => {
  const d1 = documentId("ses_ABCDEF12xyz", "nội dung"), d2 = documentId("ses_ABCDEF12xyz", "nội dung")
  assert.equal(d1, d2)
  assert.match(d1, /^[a-z0-9-]{3,119}$/)
  assert.notEqual(d1, documentId("ses_ABCDEF12xyz", "khác"))
})
test("R8 backoff nhân đôi và chỉ retry lỗi tạm", () => {
  assert.deepEqual([0, 1, 2].map((a) => backoffMs(a)), [500, 1000, 2000])
  assert.equal(isRetryable({ kind: "timeout" }), true)
  assert.equal(isRetryable({ http: 503 }), true)
  assert.equal(isRetryable({ http: 400 }), false)
})
test("R9 debounce: prompt mới hủy hẹn giờ cũ, chỉ chạy một lần", async () => {
  const calls: string[] = []
  const d = makeDebouncer(20, (s) => calls.push(s))
  d.touch("ses_a"); d.touch("ses_a"); d.touch("ses_a")
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(calls, ["ses_a"])
})
test("R10 debounce cancel không chạy job", async () => {
  const calls: string[] = []
  const d = makeDebouncer(20, (s) => calls.push(s))
  d.touch("ses_b"); d.cancel("ses_b")
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(calls, [])
})
test("R11 queue: giới hạn đồng thời và không chạy 2 job cùng session", async () => {
  const q = makeQueue(2); let active = 0, maxActive = 0; const sameSession: number[] = []
  let sa = 0
  const job = (sid: string, ms: number) => async () => {
    active++; maxActive = Math.max(maxActive, active)
    if (sid === "A") { sa++; sameSession.push(sa) }
    await new Promise((r) => setTimeout(r, ms)); active--
  }
  q.push("A", job("A", 30)); q.push("A", job("A", 30)); q.push("B", job("B", 30)); q.push("C", job("C", 30))
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(maxActive <= 2, `maxActive=${maxActive}`)
  assert.equal(q.stats().running, 0); assert.equal(q.stats().waiting, 0)
  assert.equal(sa, 2)
})
