// Machine-level deployment config, kept OUTSIDE this repo.
//
// Values that identify a particular deployment (the control-plane URL, launchd
// labels, ...) are never hardcoded in the plugin. Each machine keeps one
// KEY=VALUE file that every daemon reads at startup:
//
//   ~/.config/crab-labs-plugins/env        (override the path: CRAB_LABS_PLUGINS_ENV)
//
// A variable already set in the daemon's own environment (plist / systemd unit)
// wins over the file. Blank lines and `#` comments are ignored; values may be
// wrapped in single or double quotes. A missing file is not an error: features
// that need an unset value stay off.
//
// server.ts imports this module FIRST, so module-level env reads in the files it
// imports (channel-bot-control.ts, ...) already see the loaded values.

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function parseFleetConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

/** Copy the file's values into env without overriding anything already set. Returns the keys applied. */
export function applyFleetConfig(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const applied: string[] = []
  for (const [k, v] of Object.entries(parseFleetConfig(text))) {
    if (env[k] !== undefined) continue
    env[k] = v
    applied.push(k)
  }
  return applied
}

export const FLEET_CONFIG_PATH = process.env.CRAB_LABS_PLUGINS_ENV
  ?? join(homedir(), '.config', 'crab-labs-plugins', 'env')
export const fleetConfigApplied = applyFleetConfig(FLEET_CONFIG_PATH)
