// Log JSON Lines: xoay theo dung lượng, dọn theo thời gian ghi (ts) của từng dòng.
// Không ghi prompt, nội dung memory, token. Chỉ ghi sự kiện, trạng thái, số liệu và ID băm.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"

// Mỗi file tối đa 5 MB; giữ file hiện tại + 5 file xoay (.1 .. .5) => tối đa ~30 MB.
export const LOG_MAX_BYTES_DEFAULT = 5 * 1024 * 1024
export const LOG_KEEP = 5
// Giữ bản ghi tối đa 3 ngày, tính theo ts trong từng dòng (không theo mtime file).
export const LOG_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
// Dọn định kỳ tối đa mỗi giờ khi đang chạy (ngoài lần dọn lúc khởi động).
export const PRUNE_EVERY_MS = 60 * 60 * 1000

// Chỉ nhận đúng file log và file xoay dạng path.N (N là số). Không đụng file khác.
function logFiles(path: string): string[] {
  const dir = dirname(path)
  const base = basename(path)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n === base || (n.startsWith(base + ".") && /^\d+$/.test(n.slice(base.length + 1))))
    .map((n) => join(dir, n))
}

// Dọn file tạm sót lại của lần prune bị dừng giữa chừng (mẫu riêng, không khớp file log).
function sweepTempFiles(path: string) {
  const dir = dirname(path)
  const prefix = basename(path) + ".prune-"
  try {
    for (const n of readdirSync(dir)) {
      if (n.startsWith(prefix) && n.endsWith(".part")) rmSync(join(dir, n), { force: true })
    }
  } catch {
    // thư mục không đọc được: bỏ qua
  }
}

// Bỏ mọi dòng có ts cũ hơn maxAgeMs (và dòng không đọc được). File rỗng bị xóa.
// Trả về số dòng đã bỏ.
export function pruneOld(path: string, now: number = Date.now(), maxAgeMs: number = LOG_MAX_AGE_MS): number {
  sweepTempFiles(path)
  const cutoff = now - maxAgeMs
  let removed = 0
  for (const f of logFiles(path)) {
    try {
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0)
      const keep = lines.filter((l) => {
        try {
          const t = Date.parse(JSON.parse(l).ts)
          return Number.isFinite(t) && t >= cutoff
        } catch {
          return false
        }
      })
      if (keep.length === lines.length) continue
      removed += lines.length - keep.length
      if (keep.length === 0) {
        unlinkSync(f)
        continue
      }
      const tmp = `${f}.prune-${process.pid}.part`
      try {
        writeFileSync(tmp, keep.join("\n") + "\n")
        renameSync(tmp, f)
      } finally {
        rmSync(tmp, { force: true })
      }
    } catch {
      // bỏ qua file lỗi, không làm hỏng phiên
    }
  }
  return removed
}

export function makeLogger(path: string | undefined, maxBytes: number = LOG_MAX_BYTES_DEFAULT) {
  if (path) {
    // Tạo thư mục log nếu chưa có (lần đầu trên volume mới). Lỗi ở đây không làm hỏng phiên.
    try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) } catch {}
    pruneOld(path)
  }
  let lastPrune = Date.now()
  return (entry: Record<string, unknown>) => {
    if (!path) return
    try {
      if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = Date.now()
        pruneOld(path)
      }
      if (existsSync(path) && statSync(path).size >= maxBytes) {
        // Xóa file cuối trước; nếu không nó sẽ tồn tại mãi.
        rmSync(`${path}.${LOG_KEEP}`, { force: true })
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
          if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`)
        }
        renameSync(path, `${path}.1`)
      }
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
    } catch {
      // log không được làm hỏng phiên
    }
  }
}

// Băm ID session (sha256, 12 ký tự hex). Không lộ ID thật, vẫn phân biệt được các session.
export const shortId = (s: unknown) =>
  typeof s === "string" && s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : "none"

// SDK: PromptInput.Prompt có trường text (chuỗi). Không dùng trường nào khác.
export function extractQuery(event: any): string {
  const t = event?.prompt?.text
  return typeof t === "string" ? t.trim().slice(0, 500) : ""
}
