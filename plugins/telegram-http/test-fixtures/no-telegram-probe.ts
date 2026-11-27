// WO-197 final (1.59.0): a preload (bun --preload) that makes the Telegram code unloadable in the process it runs in: loading grammy (or its types
// package) or roamer-telegram.ts throws, and the path is appended to $PROBE_OUT (when set). A connector or the agent-inbox daemon started with it must
// start and run as usual; a roamer started with it cannot start (the negative control: the probe does see the load). Tests only.
import { plugin } from 'bun'
import { appendFileSync } from 'fs'

const out = process.env.PROBE_OUT
plugin({
  name: 'no-telegram-probe',
  setup(build) {
    build.onLoad({ filter: /(\/node_modules\/grammy\/|\/node_modules\/@grammyjs\/|\/roamer-telegram\.ts$)/ }, args => {
      if (out) { try { appendFileSync(out, `${args.path}\n`) } catch {} }
      throw new Error(`no-telegram-probe: ${args.path} must not be loaded by this daemon`)
    })
  },
})
