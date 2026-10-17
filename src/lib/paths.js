/**
 * Runtime paths for dsh-latex-kit.
 *
 * Everything this plugin creates at runtime lives under `$DSH_HOME/latex-kit`,
 * never inside the package directory and never inside the user's project. That
 * keeps the package read-only after install (a linked package is a working
 * tree) and makes `latex_runtime remove` a single directory delete.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH home; honours DSH_HOME the same way the host does. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Root of all plugin runtime state. */
export function kitHome() {
  return join(dshHome(), 'latex-kit')
}

/** Downloaded Tectonic binaries, one subdirectory per version+platform. */
export function runtimeDir() {
  return join(kitHome(), 'runtime')
}

/** Tectonic's own package cache, kept separate so `remove` can drop both. */
export function packageCacheDir() {
  return join(kitHome(), 'packages')
}

/** Scratch directory for compile output and render artefacts. */
export function buildDir() {
  return join(kitHome(), 'build')
}

/** Download staging area; a failed download never leaves a half file here. */
export function stagingDir() {
  return join(kitHome(), 'staging')
}
