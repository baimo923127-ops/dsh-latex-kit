/**
 * Minimal append-only log for the plugin.
 *
 * Deliberately tiny: this exists so a failed Tectonic download or a compile
 * that died in a way no tool result could explain still leaves a trace the
 * user can hand back. Logging never throws and never blocks a tool result.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { kitHome } from './paths.js'

let queue = Promise.resolve()

function logFile() {
  return join(kitHome(), 'latex-kit.log')
}

/**
 * Append one line. Failures are swallowed on purpose — a logger that can break
 * a compile is worse than no logger.
 */
export function log(scope, message) {
  const line = `${new Date().toISOString()} [${scope}] ${message}\n`
  queue = queue
    .then(async () => {
      await mkdir(kitHome(), { recursive: true })
      await appendFile(logFile(), line, 'utf8')
    })
    .catch(() => {})
  return queue
}

/** Where the log lives, for tools that report their own diagnostics. */
export function logPath() {
  return logFile()
}
