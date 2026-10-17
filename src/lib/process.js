/**
 * Child-process helper shared by every tool in this plugin.
 *
 * All external work (Tectonic, latexmk) goes through here so that three things
 * are true everywhere at once: a timeout always kills the whole tree, a
 * missing binary is reported as `ENOENT` rather than an exception the caller
 * has to unwrap, and output is bounded so a pathological log cannot blow up a
 * tool result.
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 120_000
/** Per-stream cap; TeX logs are famously long and the tail is the useful part. */
const MAX_STREAM_CHARS = 64_000

/**
 * Run a program and resolve with its outcome. Never rejects for a non-zero
 * exit — the caller decides what a failure means.
 *
 * @param {string} file absolute path or PATH-resolvable name
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null, durationMs:number}>}
 */
export function run(file, args, options = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const append = (current, chunk) => {
      const next = current + chunk
      return next.length > MAX_STREAM_CHARS ? next.slice(-MAX_STREAM_CHARS) : next
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      // Tectonic spawns no children of its own, but latexmk runs engines, and
      // on Windows killing the shell leaves those behind. Kill the group where
      // the platform supports it.
      try {
        if (process.platform === 'win32' && child.pid !== undefined) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch { /* already gone */ }
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        spawnError: spawnError ?? null,
        durationMs: Date.now() - started,
      })
    }

    child.on('error', (error) => finish(null, error instanceof Error ? error.message : String(error)))
    child.on('close', (code) => finish(code, null))
  })
}

/** True when a failed run means "the binary is not installed", not "it failed". */
export function isMissingBinary(result) {
  return result.spawnError !== null && /ENOENT/i.test(result.spawnError)
}
