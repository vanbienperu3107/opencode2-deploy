// hindsight-synth: đưa kết quả recall vào lượt chat dưới dạng synthetic message, thay cho chèn vào system.
// KHÔNG nạp cùng lúc với plugin hindsight-recall (context injection).
import { Plugin } from "@opencode/plugin"
import { attach } from "./synth.ts"

export default Plugin.define({
  id: "hindsight-synth",
  async setup(ctx: any) {
    await attach(ctx, {
      env: (globalThis as any).process?.env ?? {},
      fetchImpl: fetch as any,
    })
  },
})
