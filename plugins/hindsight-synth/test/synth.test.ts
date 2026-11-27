import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attach, pruneForRequest, isTransient, SYNTH_MARK } from "../synth.ts"

const dir = mkdtempSync(join(tmpdir(), "synth2-"))
const TOKEN_FILE = join(dir, "tok")
writeFileSync(TOKEN_FILE, "TESTTOKEN-NOT-REAL")
const env = (extra: Record<string, string> = {}) => ({ HINDSIGHT_PROXY_URL: "http://proxy.test/mcp/", HINDSIGHT_READER_TOKEN_FILE: TOKEN_FILE, ...extra })
const quiet = { contextWaitMs: 3000, recallTimeoutMs: 2000 }

// Chủ đề -> memory khác nhau (4 chủ đề + OCS).
const TOPICS: Record<string, string> = {
  OCS: "FAKE-MEM-OCS: nội dung OCS giả lập",
  HANOI: "FAKE-MEM-HANOI: thời tiết Hà Nội giả lập",
  CT106: "FAKE-MEM-CT106: trạng thái CT106 giả lập",
  BITEL: "FAKE-MEM-BITEL: gói cước Bitel giả lập",
  KHO: "FAKE-MEM-KHO: thông tin kho giả lập",
}

function fakeCtx() {
  const hooks: Record<string, (e: any) => any> = {}
  const calls: any[] = []
  return {
    hooks,
    calls,
    session: {
      hook(name: string, fn: (e: any) => any) { hooks[name] = fn },
      async synthetic(input: any) { calls.push(input); return { type: "synthetic" } },
    },
  }
}

// Từ khóa tiếng Việt thường theo chủ đề (câu hỏi thật không viết hoa mã).
const KEYWORDS: Record<string, string[]> = {
  OCS: ["ocs"],
  HANOI: ["hà nội", "ha noi"],
  CT106: ["ct106"],
  BITEL: ["bitel"],
  KHO: ["kho"],
}

// Fake MCP theo chủ đề: trả memory khớp từ khóa trong query. queries ghi lại để kiểm tra ghép.
function fakeFetch(queries: string[], opts: { failTimes?: number; failKind?: "http500" | "hang" | "http400"; empty?: boolean } = {}) {
  let fails = opts.failTimes ?? 0
  const resp = (status: number, body: string, h: Record<string, string> = {}) => ({
    status, headers: { get: (k: string) => h[k.toLowerCase()] ?? null }, text: async () => body,
  })
  return async (_u: string, init: any): Promise<any> => {
    const b = JSON.parse(init.body)
    if (b.method === "initialize") return resp(200, "{}", { "mcp-session-id": "s1" })
    if (b.method === "notifications/initialized") return resp(202, "")
    const q: string = b.params.arguments.query
    queries.push(q)
    if (fails > 0) {
      fails--
      if (opts.failKind === "hang") return new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))
      if (opts.failKind === "http400") return resp(400, "bad")
      return resp(500, "secret body")
    }
    const low = q.toLowerCase()
    const key = Object.keys(KEYWORDS).find((k) => KEYWORDS[k].some((w) => low.includes(w))) ?? "KHO"
    const data = { results: opts.empty ? [] : [{ text: TOPICS[key] }] }
    return resp(200, JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } }))
  }
}

// Đếm số khối memory trong messages (theo marker).
const blocks = (msgs: any[]) => msgs.filter((m) => m.role === "user" && String(m.content?.[0]?.text ?? m.content ?? "").startsWith(SYNTH_MARK)).length

// ---- Lọc request (không đổi lịch sử) ----
// ---- Lọc request (không đổi lịch sử). Block của lượt N nằm trước tin nhắn người dùng của lượt N ----
test("L1 lọc request: giữ block của lượt hiện tại, bỏ block lượt trước; lịch sử gốc không đổi", () => {
  const hist = [
    { role: "system", content: "sys" },
    { role: "user", content: SYNTH_MARK + "\nA" },
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: SYNTH_MARK + "\nB" },
    { role: "user", content: "p2" },
  ]
  const snapshot = JSON.stringify(hist)
  const req = hist.slice()
  assert.equal(pruneForRequest(req), 1)
  assert.equal(req.filter((m) => String(m.content).startsWith(SYNTH_MARK)).length, 1)
  assert.ok(String(req.find((m) => String(m.content).startsWith(SYNTH_MARK))!.content).endsWith("B"))
  assert.equal(JSON.stringify(hist), snapshot)
})
test("L2 không có block: không đổi gì", () => {
  const req = [{ role: "user", content: "p1" }]
  assert.equal(pruneForRequest(req), 0)
  assert.equal(req.length, 1)
})
test("L3 chỉ một block của lượt hiện tại: giữ nguyên", () => {
  const req = [{ role: "user", content: SYNTH_MARK + "\nA" }, { role: "user", content: "p" }]
  assert.equal(pruneForRequest(req), 0)
  assert.equal(req.length, 2)
})
test("L5 lượt hiện tại không có block (recall rỗng/lỗi): không dùng block của lượt trước", () => {
  const req = [
    { role: "user", content: SYNTH_MARK + "\nOLD" },
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "p2-no-block" },
  ]
  assert.equal(pruneForRequest(req), 1)
  assert.equal(req.filter((m) => String(m.content).startsWith(SYNTH_MARK)).length, 0)
})
test("L4 không nhận nhầm user thường có chữ giống marker ở giữa", () => {
  const req = [{ role: "user", content: "xem " + SYNTH_MARK + " ở trên" }]
  assert.equal(pruneForRequest(req), 0)
})
test("C1 compaction: giữ block của lượt hiện tại sau khi lịch sử bị rút gọn", () => {
  const hist = [
    { role: "user", content: "summary-of-earlier" },
    { role: "user", content: SYNTH_MARK + "\nOLD" },
    { role: "user", content: "p-prev" },
    { role: "user", content: SYNTH_MARK + "\nNEW" },
    { role: "user", content: "p-latest" },
  ]
  const req = hist.slice()
  assert.equal(pruneForRequest(req), 1)
  assert.equal(req.filter((m) => String(m.content).startsWith(SYNTH_MARK)).length, 1)
  assert.ok(String(req.find((m) => String(m.content).startsWith(SYNTH_MARK))!.content).endsWith("NEW"))
})
test("R1 lỗi HTTP 500 rồi thành công: retry và chèn được", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await (await import("../synth.ts")).attach(ctx, { env: env(), fetchImpl: fakeFetch(q, { failTimes: 1 }) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_R1", prompt: { text: "OCS là gì" } })
  assert.equal(ctx.calls.length, 1)
  assert.equal(q.length, 2) // 2 lần tools/call: lỗi 500 rồi retry thành công (initialize không ghi vào q)
})
test("R2 HTTP 400 không retry", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q, { failTimes: 9, failKind: "http400" }) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_R2", prompt: { text: "OCS là gì" } })
  assert.equal(ctx.calls.length, 1) // chèn block trạng thái lỗi, không retry
  assert.equal(q.length, 1) // chỉ 1 lần tools/call, không retry
})
test("R3 treo mãi: hết ngân sách thời gian, hook trả trong khoảng cho phép", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q, { failTimes: 99, failKind: "hang" }) as any, contextWaitMs: 400, recallTimeoutMs: 150 })
  const t0 = Date.now()
  await ctx.hooks.prompt({ sessionID: "ses_R3", prompt: { text: "OCS là gì" } })
  assert.ok(Date.now() - t0 < 1500, `chậm: ${Date.now() - t0}ms`)
  assert.equal(ctx.calls.length, 1) // chèn block "không truy cập được"
  assert.ok(String(ctx.calls[0].text).includes("không truy cập"))
})
test("R5 lỗi ở lượt hiện tại: chèn block không truy cập và KHÔNG dùng block lượt trước", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q, { failTimes: 9, failKind: "http400" }) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_R5", prompt: { text: "OCS là gì" } })
  assert.equal(ctx.calls.length, 1)
  assert.ok(String(ctx.calls[0].text).includes("không truy cập"))
  assert.ok(!String(ctx.calls[0].text).includes("OCS"))
})
test("R6 rỗng (recall thành công, không có kết quả): chèn block không có kết quả", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q, { empty: true }) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_R6", prompt: { text: "Kho dữ liệu chạy lúc mấy giờ" } })
  assert.equal(ctx.calls.length, 1)
  assert.ok(String(ctx.calls[0].text).includes("không có kết quả"))
  assert.ok(!String(ctx.calls[0].text).includes("không truy cập"))
})
test("R4 isTransient: timeout/network/429/5xx là tạm; 4xx/token/parse thì không", () => {
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "timeout" } } as any), true)
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "http", http: 503 } } as any), true)
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "http", http: 429 } } as any), true)
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "http", http: 404 } } as any), false)
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "token" } } as any), false)
  assert.equal(isTransient({ status: "error", items: [], received: 0, failure: { stage: "x", kind: "parse" } } as any), false)
})

// ---- Session dài, nhiều chủ đề, không tích lũy bản sao ----
test("M1 bốn chủ đề liên tiếp trong một session: mỗi lượt đúng memory, không trùng liên tiếp", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  const seq = [["OCS", "OCS là gì?"], ["HANOI", "Thời tiết Hà Nội mai thế nào?"], ["CT106", "Kiểm tra CT106"], ["BITEL", "Gói Bitel miền Nam ra sao?"]]
  for (const [, t] of seq) await ctx.hooks.prompt({ sessionID: "ses_M1", prompt: { text: t } })
  assert.equal(ctx.calls.length, 4)
  for (let i = 0; i < 4; i++) assert.ok(ctx.calls[i].text.includes(TOPICS[seq[i][0]].split(":")[0]), `lượt ${i + 1} sai memory`)
})
test("M2 lượt thứ tư vẫn nhận đúng memory dù đã có 3 block trước đó", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  for (const t of ["OCS là gì?", "Thời tiết Hà Nội?", "Kiểm tra CT106", "Gói Bitel ra sao?"]) await ctx.hooks.prompt({ sessionID: "ses_M2", prompt: { text: t } })
  assert.ok(ctx.calls[3].text.includes("FAKE-MEM-BITEL"))
})
test("M3 cùng memory lặp lại liên tiếp: không chèn bản sao", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  for (const t of ["OCS là gì?", "OCS cho tôi biết thêm", "OCS nữa đi"]) await ctx.hooks.prompt({ sessionID: "ses_M3", prompt: { text: t } })
  assert.equal(ctx.calls.length, 3)
})
test("M6 hai lượt liên tiếp cùng kết quả: cả hai lượt đều nhận block (không chặn trùng)", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_M6", prompt: { text: "OCS là gì?" } })
  await ctx.hooks.prompt({ sessionID: "ses_M6", prompt: { text: "OCS là gì?" } })
  assert.equal(ctx.calls.length, 2, "phải chèn cho cả hai lượt")
  assert.ok(ctx.calls[0].text.includes("OCS"), "lượt 1 thiếu memory")
  assert.ok(ctx.calls[1].text.includes("OCS"), "lượt 2 thiếu memory")
})
test("M4 cách ly session: session B không nhận memory của session A", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  await ctx.hooks.prompt({ sessionID: "ses_A", prompt: { text: "OCS là gì?" } })
  await ctx.hooks.prompt({ sessionID: "ses_B", prompt: { text: "Thời tiết Hà Nội?" } })
  assert.equal(ctx.calls.find((c) => c.sessionID === "ses_B").text.includes("FAKE-MEM-OCS"), false)
  assert.equal(ctx.calls.find((c) => c.sessionID === "ses_A").text.includes("FAKE-MEM-HANOI"), false)
})
test("M5 đổi chủ đề rồi quay lại: lượt quay lại nhận memory đúng, không bị chặn bởi giới hạn", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  for (const t of ["OCS là gì?", "Thời tiết Hà Nội?", "OCS là gì nữa?"]) await ctx.hooks.prompt({ sessionID: "ses_M5", prompt: { text: t } })
  assert.equal(ctx.calls.length, 3)
  assert.ok(ctx.calls[2].text.includes("FAKE-MEM-OCS"))
})

// ---- Subagent và compaction: hành vi plugin ----
test("S1 subagent: không có sessionID riêng -> không recall và không chèn (không lẫn session cha)", async () => {
  const ctx = fakeCtx(); const q: string[] = []
  await attach(ctx, { env: env(), fetchImpl: fakeFetch(q) as any, ...quiet })
  await ctx.hooks.prompt({ prompt: { text: "OCS là gì?" } })
  assert.equal(ctx.calls.length, 0)
  assert.equal(q.length, 0)
})
test("C1 compaction: lọc request vẫn giữ block mới nhất sau khi lịch sử bị rút gọn", () => {
  const hist = [
    { role: "system", content: "sys" },
    { role: "user", content: "summary-of-earlier" },
    { role: "user", content: SYNTH_MARK + "\nOLD" },
    { role: "user", content: "p-latest" },
    { role: "user", content: SYNTH_MARK + "\nNEW" },
  ]
  const req = hist.slice()
  pruneForRequest(req)
  assert.equal(req.filter((m) => String(m.content).startsWith(SYNTH_MARK)).length, 1)
  assert.ok(String(req.find((m) => String(m.content).startsWith(SYNTH_MARK))!.content).endsWith("NEW"))
})
