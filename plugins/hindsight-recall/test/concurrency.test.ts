import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { attach, applyBlock, BLOCK_MARK } from "../wiring.ts"

const dir = mkdtempSync(join(tmpdir(), "hr-conc-"))
const tokenFile = join(dir, "tok")
writeFileSync(tokenFile, "test-token-not-real")
const env = { HINDSIGHT_PROXY_URL: "http://fake.local/mcp/", HINDSIGHT_READER_TOKEN_FILE: tokenFile }

// Fake proxy có điều khiển độ trễ theo query: "DELAY<ms>:" đặt độ trễ, "SLOW" = không trả lời cho tới khi abort.
function fake(calls: string[] = []) {
  return async (_u: string, init: any) => {
    const body = JSON.parse(init.body)
    const headers = { get: (n: string) => (n.toLowerCase() === "mcp-session-id" ? "s" : null) }
    if (body.method === "initialize") return { status: 200, headers, text: async () => "{}" }
    if (body.method === "notifications/initialized") return { status: 202, headers, text: async () => "" }
    const q: string = body.params.arguments.query
    calls.push(q)
    const m = /DELAY(\d+):/.exec(q)
    if (m) await new Promise((r) => setTimeout(r, Number(m[1])))
    if (q.includes("SLOW")) await new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort"))))
    const payload = JSON.stringify({ results: [{ text: "MEM<" + q.slice(-30) + ">", document_id: "d" }] })
    return { status: 200, headers, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: payload }] } }) }
  }
}

async function setup(fetchImpl: any, o: { contextWaitMs?: number; recallTimeoutMs?: number } = {}) {
  const hooks: Record<string, any> = {}
  await attach({ session: { hook: async (n: string, f: any) => { hooks[n] = f } } } as any, {
    env, fetchImpl, contextWaitMs: o.contextWaitMs ?? 2000, recallTimeoutMs: o.recallTimeoutMs ?? 2000, logMaxBytes: 10 << 20,
  })
  return { prompt: hooks.prompt, context: hooks.context }
}
const own = (s: any[]) => s.filter((v) => typeof v?.text === "string" && v.text.startsWith(BLOCK_MARK))
const txt = (s: any[]) => own(s).map((v) => v.text).join("\n")

test("50 mảng system mới trong cùng lượt: mỗi mảng đúng một block, phần tử khác giữ nguyên", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "p50", prompt: { text: "câu hỏi lượt 50" } })
  for (let i = 0; i < 50; i++) {
    const other = { type: "text", text: "[khác] " + i }
    const system: any[] = [other]
    await context({ sessionID: "p50", system })
    assert.equal(own(system).length, 1, "mảng " + i)
    assert.equal(system[0], other)
    assert.equal(system.length, 2)
  }
})

test("một mảng xử lý lặp 50 lần: vẫn đúng một block", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "rep50", prompt: { text: "lặp" } })
  const system: any[] = [{ type: "text", text: "gốc" }]
  for (let i = 0; i < 50; i++) await context({ sessionID: "rep50", system })
  assert.equal(own(system).length, 1)
  assert.equal(system.length, 2)
})

test("session/lượt đồng thời: mỗi session chỉ thấy memory của chính nó", async () => {
  const { prompt, context } = await setup(fake())
  const sessions = ["A", "B", "C", "D"]
  await Promise.all(sessions.map(async (s) => {
    prompt({ sessionID: "ses-" + s, prompt: { text: "câu của " + s } })
    for (let i = 0; i < 5; i++) {
      const sys: any[] = []
      await context({ sessionID: "ses-" + s, system: sys })
      assert.match(txt(sys), new RegExp("câu của " + s))
      for (const other of sessions.filter((x) => x !== s)) assert.doesNotMatch(txt(sys), new RegExp("câu của " + other))
    }
  }))
})

test("prompt mới đến khi recall cũ chưa xong: context lấy kết quả của lượt mới, không lấy lượt cũ", async () => {
  const { prompt, context } = await setup(fake(), { contextWaitMs: 2000, recallTimeoutMs: 2000 })
  prompt({ sessionID: "race", prompt: { text: "DELAY300:lượt cũ" } })
  prompt({ sessionID: "race", prompt: { text: "lượt mới nhanh" } })
  const sys: any[] = []
  await context({ sessionID: "race", system: sys })
  assert.match(txt(sys), /lượt mới nhanh/)
  assert.doesNotMatch(txt(sys), /lượt cũ/)
})

test("timeout rồi kết quả cũ trả muộn: không ghi đè lượt mới", async () => {
  const { prompt, context } = await setup(fake(), { contextWaitMs: 100, recallTimeoutMs: 1000 })
  prompt({ sessionID: "late", prompt: { text: "DELAY400:lượt cũ chậm" } })
  const sys1: any[] = []
  await context({ sessionID: "late", system: sys1 }) // hết 100ms -> khối timeout
  assert.match(txt(sys1), /không truy cập được/)
  prompt({ sessionID: "late", prompt: { text: "lượt mới" } })
  await new Promise((r) => setTimeout(r, 600)) // kết quả cũ về muộn
  const sys2: any[] = []
  await context({ sessionID: "late", system: sys2 })
  assert.match(txt(sys2), /lượt mới/)
  assert.doesNotMatch(txt(sys2), /lượt cũ chậm/)
})

test("hủy lượt (prompt rỗng sau prompt có nội dung): không dùng recall cũ", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "cancel", prompt: { text: "câu có nội dung" } })
  prompt({ sessionID: "cancel", prompt: { text: "   " } })
  const sys: any[] = []
  await context({ sessionID: "cancel", system: sys })
  assert.equal(own(sys).length, 0)
})

test("prompt có file (không có text): không tạo recall sai và không lỗi", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "file", prompt: { text: "", files: [{ name: "a.log" }] } })
  const sys: any[] = []
  await assert.doesNotReject(context({ sessionID: "file", system: sys }))
  assert.equal(own(sys).length, 0)
})

test("subagent có sessionID riêng: không lẫn memory với session cha", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "parent", prompt: { text: "câu của cha" } })
  prompt({ sessionID: "child", prompt: { text: "việc của con" } })
  const sp: any[] = []
  const sc: any[] = []
  await context({ sessionID: "parent", system: sp })
  await context({ sessionID: "child", system: sc })
  assert.match(txt(sp), /câu của cha/)
  assert.match(txt(sc), /việc của con/)
  assert.doesNotMatch(txt(sc), /câu của cha/)
})

test("compaction: mảng system bị thu gọn (không còn block cũ) -> chèn lại đúng một block", async () => {
  const { prompt, context } = await setup(fake())
  prompt({ sessionID: "cmp", prompt: { text: "sau compaction" } })
  const sys: any[] = [{ type: "text", text: "tóm tắt mới" }]
  await context({ sessionID: "cmp", system: sys })
  assert.equal(own(sys).length, 1)
  assert.equal(sys[0].text, "tóm tắt mới")
})

test("restart: entry không còn trong bộ nhớ -> không chèn memory cũ, không lỗi", async () => {
  const { context } = await setup(fake())
  const sys: any[] = [{ type: "text", text: BLOCK_MARK + "\nmemory từ trước restart" }]
  await context({ sessionID: "after-restart", system: sys })
  assert.equal(own(sys).length, 0)
})

test("cache không tăng vô hạn: vượt MAX_TRACKED_SESSIONS thì session cũ bị bỏ", async () => {
  const calls: string[] = []
  const { prompt, context } = await setup(fake(calls))
  for (let i = 0; i < 150; i++) prompt({ sessionID: "bulk-" + i, prompt: { text: "câu " + i } })
  // session đầu tiên đã bị dọn khỏi pending -> không còn recall
  const sys: any[] = []
  await context({ sessionID: "bulk-0", system: sys })
  assert.equal(own(sys).length, 0)
  const sys2: any[] = []
  await context({ sessionID: "bulk-149", system: sys2 })
  assert.equal(own(sys2).length, 1)
})

test("applyBlock không đụng phần tử khác khi nhiều block", () => {
  const other = { type: "text", text: "giữ" }
  const system: any[] = [{ type: "text", text: BLOCK_MARK + "\na" }, other, { type: "text", text: BLOCK_MARK + "\nb" }]
  applyBlock(system, BLOCK_MARK + "\nc")
  assert.equal(system[1], other)
  assert.equal(own(system).length, 1)
})
