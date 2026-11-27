import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { attach, applyBlock, BLOCK_MARK } from "../wiring.ts"

const dir = mkdtempSync(join(tmpdir(), "hr-test-"))
const tokenFile = join(dir, "tok")
writeFileSync(tokenFile, "test-token-not-real")

function env(logPath?: string) {
  return {
    HINDSIGHT_PROXY_URL: "http://fake.local/mcp/",
    HINDSIGHT_READER_TOKEN_FILE: tokenFile,
    ...(logPath ? { HINDSIGHT_RECALL_LOG: logPath } : {}),
  }
}

// Fake MCP proxy: trả memory theo query. Query chứa "SLOW" thì không trả lời (để test timeout).
// Query chứa "FAIL" thì HTTP 500.
function fakeFetch(opts: { delayMs?: number } = {}) {
  const calls: string[] = []
  const fn = async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    const headers = { get: (n: string) => (n.toLowerCase() === "mcp-session-id" ? "sid-1" : null) }
    if (body.method === "initialize") {
      return { status: 200, headers, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) }
    }
    if (body.method === "notifications/initialized") {
      return { status: 202, headers, text: async () => "" }
    }
    const query: string = body.params.arguments.query
    calls.push(query)
    if (query.includes("SLOW")) {
      return await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }
    if (query.includes("FAIL")) {
      return { status: 500, headers, text: async () => "boom" }
    }
    const mem = `MEMORY-FOR:${query}`
    const payload = JSON.stringify({ results: [{ text: mem, document_id: "doc-" + query.slice(0, 8) }] })
    return {
      status: 200,
      headers,
      text: async () =>
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: payload }] } }),
    }
  }
  return Object.assign(fn, { calls })
}

// Đăng ký hook giả để lấy hàm prompt/context.
async function setup(opts: { contextWaitMs?: number; recallTimeoutMs?: number; logPath?: string; fetchImpl?: any } = {}) {
  const hooks: Record<string, (e: any) => any> = {}
  const ctx = { session: { hook: async (name: string, fn: any) => { hooks[name] = fn } } }
  const fetchImpl = opts.fetchImpl ?? fakeFetch()
  await attach(ctx as any, {
    env: env(opts.logPath),
    fetchImpl,
    contextWaitMs: opts.contextWaitMs ?? 2000,
    recallTimeoutMs: opts.recallTimeoutMs ?? 2000,
    logMaxBytes: 10 * 1024 * 1024,
  })
  return { prompt: hooks.prompt, context: hooks.context, fetchImpl }
}

const ownBlocks = (system: any[]) => system.filter((v) => typeof v?.text === "string" && v.text.startsWith(BLOCK_MARK))
const blockText = (system: any[]) => ownBlocks(system).map((v) => v.text).join("\n")

test("T1: cùng một mảng context gọi 50 lần -> tối đa một khối", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-A", prompt: { text: "câu hỏi A" } })
  const system: any[] = [{ type: "text", text: "system gốc" }]
  for (let i = 0; i < 50; i++) await context({ sessionID: "ses-A", system })
  assert.equal(ownBlocks(system).length, 1)
  assert.equal(system.length, 2)
  assert.equal(system[0].text, "system gốc")
})

test("T2: mỗi lần context là mảng mới -> mỗi mảng đúng một khối", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-B", prompt: { text: "câu hỏi B" } })
  for (let i = 0; i < 5; i++) {
    const system: any[] = [{ type: "text", text: "x" + i }]
    await context({ sessionID: "ses-B", system })
    assert.equal(ownBlocks(system).length, 1, "lần " + i)
  }
})

test("T2b: mảng đã có nhiều khối cũ -> dọn về đúng một khối", () => {
  const system: any[] = [
    { type: "text", text: BLOCK_MARK + "\ncũ 1" },
    { type: "text", text: "khác" },
    { type: "text", text: BLOCK_MARK + "\ncũ 2" },
  ]
  const r = applyBlock(system, BLOCK_MARK + "\nmới")
  assert.equal(r.action, "deduplicated")
  assert.equal(ownBlocks(system).length, 1)
  assert.equal(ownBlocks(system)[0].text, BLOCK_MARK + "\nmới")
  assert.equal(system[1].text, "khác")
})

test("T3: hai session đồng thời không lẫn memory", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-X", prompt: { text: "alpha" } })
  prompt({ sessionID: "ses-Y", prompt: { text: "beta" } })
  const sx: any[] = []
  const sy: any[] = []
  await Promise.all([
    (async () => { for (let i = 0; i < 10; i++) await context({ sessionID: "ses-X", system: sx }) })(),
    (async () => { for (let i = 0; i < 10; i++) await context({ sessionID: "ses-Y", system: sy }) })(),
  ])
  assert.match(blockText(sx), /MEMORY-FOR:alpha/)
  assert.doesNotMatch(blockText(sx), /MEMORY-FOR:beta/)
  assert.match(blockText(sy), /MEMORY-FOR:beta/)
  assert.doesNotMatch(blockText(sy), /MEMORY-FOR:alpha/)
})

test("T4: request mới không dùng memory cũ", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-C", prompt: { text: "lượt một" } })
  const s1: any[] = []
  await context({ sessionID: "ses-C", system: s1 })
  assert.match(blockText(s1), /lượt một/)

  // Prompt mới cùng session: mảng system còn khối cũ phải được thay bằng memory mới.
  prompt({ sessionID: "ses-C", prompt: { text: "Hãy cho tôi biết cấu hình chi tiết của bank opencode2 trên proxy Hindsight hiện tại gồm những gì" } })
  await context({ sessionID: "ses-C", system: s1 })
  assert.equal(ownBlocks(s1).length, 1)
  assert.match(blockText(s1), /bank opencode2/)
  assert.doesNotMatch(blockText(s1), /lượt một/)
})

test("T4b: không có recall đang chờ thì gỡ khối cũ, không để lại memory request trước", async () => {
  const { prompt, context } = await setup()
  const system: any[] = [{ type: "text", text: BLOCK_MARK + "\nmemory cũ" }, { type: "text", text: "giữ" }]
  prompt({ sessionID: "ses-D", prompt: { text: "" } }) // không có query -> không có recall
  await context({ sessionID: "ses-D", system })
  assert.equal(ownBlocks(system).length, 0)
  assert.equal(system.length, 1)
  assert.equal(system[0].text, "giữ")
})

test("T5: timeout không treo chat", async () => {
  const { prompt, context } = await setup({ contextWaitMs: 100, recallTimeoutMs: 100 })
  prompt({ sessionID: "ses-E", prompt: { text: "SLOW query" } })
  const system: any[] = []
  const t0 = Date.now()
  await context({ sessionID: "ses-E", system })
  const dt = Date.now() - t0
  assert.ok(dt < 1000, "context phải trả về nhanh, dt=" + dt)
  assert.equal(ownBlocks(system).length, 1)
  assert.match(blockText(system), /không truy cập được/)
})

test("T5b: lỗi proxy (HTTP 500) trả khối lỗi, không ném exception", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-F", prompt: { text: "FAIL query" } })
  const system: any[] = []
  await assert.doesNotReject(context({ sessionID: "ses-F", system }))
  assert.equal(ownBlocks(system).length, 1)
  assert.match(blockText(system), /không truy cập được/)
})

test("T6: không thay đổi system prompt của plugin khác", async () => {
  const { prompt, context } = await setup()
  prompt({ sessionID: "ses-G", prompt: { text: "giữ nguyên" } })
  const other1 = { type: "text", text: "[plugin khác] instruction A", cache: true }
  const other2 = { type: "text", text: "[plugin khác] instruction B" }
  const system: any[] = [other1, other2]
  const snapshot = JSON.stringify([other1, other2])
  for (let i = 0; i < 3; i++) await context({ sessionID: "ses-G", system })
  assert.equal(system[0], other1) // cùng tham chiếu, không bị thay
  assert.equal(system[1], other2)
  assert.equal(JSON.stringify(system.slice(0, 2)), snapshot)
  assert.equal(system.length, 3)
})

test("T7: log chỉ có metadata, không có memory/query/token", async () => {
  const logPath = join(dir, "recall.log")
  const { prompt, context } = await setup({ logPath })
  prompt({ sessionID: "ses-H", prompt: { text: "BÍ-MẬT-QUERY" } })
  const system: any[] = []
  await context({ sessionID: "ses-H", system })
  await context({ sessionID: "ses-H", system })
  assert.ok(existsSync(logPath))
  const raw = readFileSync(logPath, "utf8")
  assert.doesNotMatch(raw, /MEMORY-FOR/)
  assert.doesNotMatch(raw, /BÍ-MẬT-QUERY/)
  assert.doesNotMatch(raw, /test-token-not-real/)
  const ctxLines = raw.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "context")
  assert.equal(ctxLines.length, 2)
  for (const k of ["context_calls", "recall_calls", "memory_blocks", "insert_action", "recall_ms", "context_hook_ms"]) {
    assert.ok(k in ctxLines[1], "thiếu " + k)
  }
  assert.equal(ctxLines[1].context_calls, 2)
  assert.equal(ctxLines[1].memory_blocks, 1)
  assert.equal(ctxLines[1].insert_action, "kept")
})
