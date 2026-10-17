/**
 * dsh-latex-kit — LaTeX tooling for DeepSeek Harness.
 *
 * Three groups of agent tools, all Host-side (no client half, no Web UI):
 *
 *   compile pipeline   latex_doctor / latex_compile / latex_runtime
 *                      A managed Tectonic runtime that this plugin downloads
 *                      and verifies itself, falling back to a system TeX
 *                      installation when the project needs a full TeX Live.
 *
 *   bibliography       bib_lint / bib_fill / cite_audit
 *                      Pure text processing plus Crossref lookups: no TeX
 *                      engine needed, usable on a machine with no LaTeX at all.
 *
 *   rendering          latex_render
 *                      Offline TeX-formula → SVG, independent of any engine.
 *
 * Each group registers its own tools and owns its own files; this module only
 * wires them together and builds the shared context they receive.
 */

import * as paths from './lib/paths.js'
import { log } from './lib/log.js'
import { run, isMissingBinary } from './lib/process.js'
import { resolveTectonic } from './lib/tectonic.js'

import { register as registerDoctor } from './tools/doctor.js'
import { register as registerCompile } from './tools/compile.js'
import { register as registerRuntime } from './tools/runtime.js'
import { register as registerBib } from './tools/bib.js'
import { register as registerRender } from './tools/render.js'

export const name = 'dsh-latex-kit'

/** The tool registry is the only service this plugin requires. */
export const inject = ['tools']

/**
 * @typedef {object} Shared
 * @property {import('@deepseek-ai/cordis').Context} ctx
 * @property {typeof paths} paths
 * @property {(scope: string, message: string) => Promise<void>} log
 * @property {typeof run} run
 * @property {typeof isMissingBinary} isMissingBinary
 * @property {() => Promise<{path: string, source: string, version: string|null, managed: boolean} | null>} resolveTectonic
 */

export function apply(ctx) {
  /** @type {Shared} */
  const shared = { ctx, paths, log, run, isMissingBinary, resolveTectonic }

  for (const register of [registerDoctor, registerCompile, registerRuntime, registerBib, registerRender]) {
    register(ctx, shared)
  }

  log('index', 'registered tool groups: compile, bibliography, rendering')
}
