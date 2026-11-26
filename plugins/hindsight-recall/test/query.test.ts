import { test } from "node:test"
import assert from "node:assert/strict"
import { buildQuery, needsContext, normalizeVi, QUERY_MAX_CHARS, FOLLOWUP_MAX_CHARS } from "./core.ts"

const PREV_BITEL = "Bitel đang triển khai gói cước mới cho khu vực miền Nam"
const PREV_HIND = "Hindsight bank opencode2 dùng endpoint proxy nội bộ"

test("'Cái đó thì sao?' cần ngữ cảnh trước", () => {
  assert.equal(needsContext("Cái đó thì sao?"), true)
  assert.equal(buildQuery("Cái đó thì sao?", PREV_HIND), PREV_HIND + "\nCái đó thì sao?")
})
test("đang nói Bitel rồi hỏi 'Kiểm tra CT106' là đổi chủ đề, không ghép", () => {
  assert.equal(needsContext("Kiểm tra CT106"), false)
  assert.equal(buildQuery("Kiểm tra CT106", PREV_BITEL), "Kiểm tra CT106")
})
test("câu dài có 'cấu hình đó' vẫn cần ngữ cảnh (không dựa vào độ dài)", () => {
  const long = "Hãy giải thích chi tiết từng tham số trong cấu hình đó và giá trị mặc định của mỗi tham số là gì trong môi trường này"
  assert.ok(long.length > 80)
  assert.equal(needsContext(long), true)
  assert.equal(buildQuery(long, PREV_HIND).startsWith(PREV_HIND + "\n"), true)
})
test("câu độc lập ngắn không bị ghép", () => {
  assert.equal(needsContext("Thủ đô Việt Nam là gì?"), false)
  assert.equal(buildQuery("Thủ đô Việt Nam là gì?", PREV_BITEL), "Thủ đô Việt Nam là gì?")
})
test("tiếng Việt không dấu vẫn nhận diện tín hiệu tham chiếu", () => {
  assert.equal(needsContext("cai do thi sao"), true)
  assert.equal(needsContext("con lai thi sao"), true)
  assert.equal(needsContext("Kiem tra CT106"), false)
})
test("không có câu trước thì chỉ dùng câu hiện tại", () => {
  assert.equal(buildQuery("Cái đó thì sao?", undefined), "Cái đó thì sao?")
})
test("prompt rỗng hoặc chỉ khoảng trắng trả chuỗi rỗng", () => {
  assert.equal(buildQuery("   ", PREV_BITEL), "")
})
test("giới hạn: câu hiện tại và phần ngữ cảnh đều bị cắt", () => {
  assert.equal(buildQuery("a".repeat(900), undefined).length, QUERY_MAX_CHARS)
  const out = buildQuery("cái đó thì sao " + "b".repeat(600), "x".repeat(900))
  assert.ok(out.length <= FOLLOWUP_MAX_CHARS + 1 + QUERY_MAX_CHARS)
  assert.equal(out.slice(0, FOLLOWUP_MAX_CHARS), "x".repeat(FOLLOWUP_MAX_CHARS))
})
test("giới từ 'trên' không phải tín hiệu tham chiếu", () => {
  assert.equal(needsContext("Hãy kiểm tra trên proxy hiện tại"), false)
  assert.equal(needsContext("Cấu hình trên máy chủ là gì?"), false)
})
test("normalizeVi bỏ dấu và đ", () => {
  assert.equal(normalizeVi("Đã kiểm tra"), "da kiem tra")
})
