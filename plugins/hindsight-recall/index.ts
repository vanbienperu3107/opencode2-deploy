// hindsight-recall: plugin OpenCode. Gọi recall qua proxy trước mỗi lượt model và chèn kết quả vào system.
// Cấu hình từ biến môi trường lúc chạy: HINDSIGHT_PROXY_URL, HINDSIGHT_READER_TOKEN_FILE, HINDSIGHT_RECALL_LOG (tùy chọn).
import { Plugin } from "@opencode/plugin"
import { attach } from "./wiring.ts"

export default Plugin.define({
  id: "hindsight-recall",
  async setup(ctx: any) {
    await attach(ctx, {
      env: (globalThis as any).process?.env ?? {},
      fetchImpl: fetch as any,
    })
  },
})
