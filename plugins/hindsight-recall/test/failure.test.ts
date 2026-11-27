import { test } from "node:test"
import assert from "node:assert/strict"
import { runRecall, RECALL_TIMEOUT_MS } from "../core.ts"

const cfg: any = { proxyUrl: "http://proxy.test/mcp/", tokenFile: "/nonexistent", budget: {} }
const okTok = () => "TESTTOKEN-NOT-REAL"
const resp = (status: number, body: string, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => body,
})
const rpcOk = JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ text: "x" }] }) }] } })

test("F1: initialize HTTP 500 -> stage initialize, kind http, http 500, không lộ token", async () => {
  const r = await runRecall(cfg, "q", async () => resp(500, "secret body"), okTok)
  assert.equal(r.status, "error")
  assert.equal(r.failure?.stage, "initialize")
  assert.equal(r.failure?.kind, "http")
  assert.equal(r.failure?.http, 500)
  assert.ok(!JSON.stringify(r).includes("secret body"))
  assert.ok(!JSON.stringify(r).includes("TESTTOKEN"))
})

test("F2: tools/call HTTP 502 -> stage tools_call, http 502", async () => {
  let n = 0
  const f = async () => (++n === 1 ? resp(200, "{}", { "mcp-session-id": "s" }) : n === 2 ? resp(202, "") : resp(502, "x"))
  const r = await runRecall(cfg, "q", f as any, okTok)
  assert.equal(r.failure?.stage, "tools_call")
  assert.equal(r.failure?.http, 502)
})

test("F3: JSON-RPC error -> kind rpc", async () => {
  let n = 0
  const f = async () => (++n === 1 ? resp(200, "{}") : n === 2 ? resp(202, "") : resp(200, JSON.stringify({ error: { message: "x" } })))
  const r = await runRecall(cfg, "q", f as any, okTok)
  assert.equal(r.failure?.kind, "rpc")
  assert.equal(r.failure?.stage, "tools_call")
})

test("F4: tool isError -> kind tool", async () => {
  let n = 0
  const f = async () => (++n === 1 ? resp(200, "{}") : n === 2 ? resp(202, "") : resp(200, JSON.stringify({ result: { isError: true } })))
  const r = await runRecall(cfg, "q", f as any, okTok)
  assert.equal(r.failure?.kind, "tool")
})

test("F5: body không phải JSON -> kind parse", async () => {
  let n = 0
  const f = async () => (++n === 1 ? resp(200, "{}") : n === 2 ? resp(202, "") : resp(200, "<html>"))
  const r = await runRecall(cfg, "q", f as any, okTok)
  assert.equal(r.failure?.kind, "parse")
})

test("F6: timeout -> status timeout, kind timeout", async () => {
  const f = (_u: string, init: any) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(new Error("aborted")))
  })
  const r = await runRecall(cfg, "q", f as any, okTok, 20)
  assert.equal(r.status, "timeout")
  assert.equal(r.failure?.kind, "timeout")
})

test("F7: network throw -> kind network, không lưu message", async () => {
  const r = await runRecall(cfg, "q", async () => { throw new Error("ECONNREFUSED secret-host") }, okTok)
  assert.equal(r.failure?.kind, "network")
  assert.ok(!JSON.stringify(r).includes("secret-host"))
})

test("F8: token không đọc được -> stage token", async () => {
  const r = await runRecall(cfg, "q", async () => resp(200, "{}"), () => { throw new Error("nope") })
  assert.equal(r.failure?.stage, "token")
})

test("F9: cid khác nhau giữa các lượt", async () => {
  const f = async () => resp(500, "")
  const a = await runRecall(cfg, "q", f as any, okTok)
  const b = await runRecall(cfg, "q", f as any, okTok)
  assert.notEqual(a.failure?.cid, b.failure?.cid)
})
