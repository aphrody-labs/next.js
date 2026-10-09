// The fork installs, builds and tests with Bun instead of pnpm and Node.js.
// This file is the single source of truth for that change to upstream files:
// `rewrite()` maps an upstream file to the fork's and is idempotent, so the
// upstream sync applies it to both sides of a three-way merge and the change
// never conflicts (scripts/aphrody/sync-upstream.ts).
//
//   bun scripts/aphrody/bunify.ts --check   list files that still need the rewrite (exit 1 if any)
//   bun scripts/aphrody/bunify.ts --write   rewrite them in place
//
// Managed files:
//   package.json (root)        pnpm settings -> Bun (`workspaces`, `overrides`, `patchedDependencies`),
//                              `packageManager`, lifecycle and scripts
//   **/package.json            `scripts`: pnpm, node, tsx -> bun (workspace members only)
//   .husky/pre-commit          pnpm -> bun
//   pnpm-workspace.yaml        removed; its settings live in package.json and bunfig.toml

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BUN_VERSION = '1.4.3'

/** Workspace globs, from upstream's pnpm-workspace.yaml (kept in sync by the rewrite of package.json). */
export const WORKSPACES = [
  'apps/*',
  'packages/*',
  'bench/*',
  'crates/*/js',
  'turbopack/crates/*/js',
  'turbopack/crates/turbopack-tests/tests/execution',
]

/** Files upstream has and the fork deletes. */
export const DELETED = ['pnpm-workspace.yaml', 'pnpm-lock.yaml']

/** Rewrites one shell command line from a package.json script. */
export function rewriteScript(script: string): string {
  return (
    script
      // pnpm pack --out x  ->  bun pm pack --filename x
      .replace(/\bpnpm pack --out\b/g, 'bun pm pack --filename')
      // pnpm --filter "<f>" [--stream] run <s>  ->  bun run --filter "<f>" <s>
      .replace(
        /\bpnpm (--filter (?:"[^"]*"|'[^']*'|\S+))(?: --stream)? run (\S+)/g,
        'bun run $1 $2'
      )
      .replace(/\bpnpm (?:run |exec )?/g, 'bun run ')
      // Node.js and tsx run on Bun.
      .replace(
        /(^|&& |; |\|\| |run-p |\b(?:cross-env|env)(?: [A-Z_][A-Z0-9_]*=(?:"[^"]*"|\S*))+ )node (?=[\w./"'-])/g,
        '$1bun '
      )
      .replace(/(^|&& |; |\|\| )tsx (?=[\w./"'-])/g, '$1bun ')
  )
}

/** Root scripts whose pnpm form has no one-to-one Bun command. */
export const ROOT_SCRIPTS: Record<string, string> = {
  // The fork installs its own @aphrody/next-swc-* bindings (scripts/aphrody/install-native.ts).
  postinstall:
    'bun scripts/git-configure.mjs && bun scripts/aphrody/install-native.ts',
  clean:
    'bun run --filter "./packages/**" clean && bun -e "for (const d of new Bun.Glob(\\"packages/*/{dist,node_modules}\\").scanSync({ onlyFiles: false })) require(\\"node:fs\\").rmSync(d, { recursive: true, force: true })"',
}

function rewriteScripts(
  scripts: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!scripts) return scripts
  const out: Record<string, string> = {}
  for (const [name, script] of Object.entries(scripts)) {
    // pnpm runs `pnpm:devPreinstall` before installing the root project; Bun runs `preinstall`.
    const key = name === 'pnpm:devPreinstall' ? 'preinstall' : name
    out[key] = typeof script === 'string' ? rewriteScript(script) : script
  }
  return out
}

/**
 * Workspace members the root imports without declaring them: pnpm hoists every
 * workspace package to the root node_modules, Bun links declared ones only.
 */
export const ROOT_WORKSPACE_DEPS = ['@next/eslint-plugin-internal']

/** pnpm `patchedDependencies` keys may omit the version; Bun needs `name@version`. */
function bunPatchKey(key: string, versions: Record<string, string>): string {
  const at = key.lastIndexOf('@')
  if (at > 0) return key
  const version = versions[key]
  return version ? `${key}@${version}` : key
}

/**
 * The root manifest with pnpm's settings moved to their Bun equivalents.
 * `patchVersions` gives the installed version of patched packages whose pnpm
 * key has none (read from the patch file name or the lockfile).
 */
export function rewriteRootManifest(
  text: string,
  patchVersions: Record<string, string> = {}
): string {
  const pkg = JSON.parse(text)
  const pnpm = pkg.pnpm ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'pnpm') continue
    if (key === 'workspaces') {
      out.workspaces = WORKSPACES
      continue
    }
    if (key === 'scripts') {
      out.scripts = { ...rewriteScripts(value as Record<string, string>) }
      for (const [name, script] of Object.entries(ROOT_SCRIPTS)) {
        if (name in (out.scripts as object))
          (out.scripts as Record<string, string>)[name] = script
      }
      continue
    }
    if (key === 'packageManager') {
      out.packageManager = `bun@${BUN_VERSION}`
      continue
    }
    out[key] = value
  }
  if (!out.workspaces) out.workspaces = WORKSPACES
  const declared = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }
  const missing = ROOT_WORKSPACE_DEPS.filter((name) => !(name in declared))
  if (missing.length) {
    const dev = {
      ...(out.devDependencies as Record<string, string> | undefined),
    }
    for (const name of missing) dev[name] = 'workspace:*'
    out.devDependencies = Object.fromEntries(
      Object.entries(dev).sort(([a], [b]) => a.localeCompare(b))
    )
  }
  if (pnpm.overrides || pkg.overrides)
    out.overrides = { ...(pkg.overrides ?? {}), ...(pnpm.overrides ?? {}) }
  const patches = { ...(pkg.patchedDependencies ?? {}) }
  for (const [key, path] of Object.entries<string>(
    pnpm.patchedDependencies ?? {}
  )) {
    patches[bunPatchKey(key, patchVersions)] = path
  }
  if (Object.keys(patches).length) out.patchedDependencies = patches
  if (!out.packageManager) out.packageManager = `bun@${BUN_VERSION}`
  return JSON.stringify(out, null, 2) + '\n'
}

/** A workspace member manifest: only its scripts change. */
export function rewriteMemberManifest(text: string): string {
  const pkg = JSON.parse(text)
  if (!pkg.scripts) return text
  const scripts = rewriteScripts(pkg.scripts)
  if (JSON.stringify(scripts) === JSON.stringify(pkg.scripts)) return text
  // Keep upstream formatting: replace the scripts block only.
  const next = { ...pkg, scripts }
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  '
  return JSON.stringify(next, null, indent) + (text.endsWith('\n') ? '\n' : '')
}

const MEMBER = new RegExp(
  '^(?:' +
    WORKSPACES.map((g) =>
      g.replaceAll('.', '\\.').replaceAll('*', '[^/]+')
    ).join('|') +
    ')/package\\.json$'
)

/** Shell files outside package.json whose commands run on Bun. */
export const SHELL_FILES = ['.husky/pre-commit']

export function isManaged(path: string): boolean {
  const p = path.replaceAll('\\', '/')
  return p === 'package.json' || MEMBER.test(p) || SHELL_FILES.includes(p)
}

export function rewrite(
  path: string,
  text: string,
  patchVersions: Record<string, string> = {}
): string {
  const p = path.replaceAll('\\', '/')
  if (p === 'package.json') return rewriteRootManifest(text, patchVersions)
  if (MEMBER.test(p)) return rewriteMemberManifest(text)
  if (SHELL_FILES.includes(p))
    return text.split('\n').map(rewriteScript).join('\n')
  return text
}

/** Versions of patched packages whose pnpm key has none, from `bun.lock`. */
export function lockedVersions(
  root: string,
  names: string[]
): Record<string, string> {
  const out: Record<string, string> = {}
  const lock = join(root, 'bun.lock')
  if (!existsSync(lock)) return out
  const text = readFileSync(lock, 'utf8')
  for (const name of names) {
    const m = new RegExp(
      `"${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@(\\d[^"]*)"`
    ).exec(text)
    if (m) out[name] = m[1]
  }
  return out
}

export function managedFiles(root: string): string[] {
  const files = ['package.json', ...SHELL_FILES]
  for (const glob of WORKSPACES) {
    for (const f of new Bun.Glob(`${glob}/package.json`).scanSync({
      cwd: root,
      onlyFiles: true,
    })) {
      files.push(f.replaceAll('\\', '/'))
    }
  }
  return [...new Set(files)].sort()
}

export async function apply(root: string, write: boolean): Promise<string[]> {
  const changed: string[] = []
  const rootManifest = join(root, 'package.json')
  const rootPkg = existsSync(rootManifest)
    ? JSON.parse(readFileSync(rootManifest, 'utf8'))
    : {}
  const unversioned = Object.keys(
    rootPkg.pnpm?.patchedDependencies ?? {}
  ).filter((k) => k.lastIndexOf('@') <= 0)
  const versions = lockedVersions(root, unversioned)
  for (const file of managedFiles(root)) {
    const abs = join(root, file)
    if (!existsSync(abs)) continue
    const before = await Bun.file(abs).text()
    const after = rewrite(file, before, versions)
    if (after === before) continue
    changed.push(file)
    if (write) await Bun.write(abs, after)
  }
  for (const file of DELETED) {
    if (!existsSync(join(root, file))) continue
    changed.push(file)
    if (write) await Bun.file(join(root, file)).delete()
  }
  return changed
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const rootIdx = args.indexOf('--root')
  const root =
    rootIdx >= 0 ? args[rootIdx + 1] : join(import.meta.dir, '..', '..')
  const changed = await apply(root, write)
  for (const f of changed) console.log(`${write ? 'rewrote' : 'pending'} ${f}`)
  if (!write && changed.length) {
    console.error(
      `${changed.length} file(s) still use pnpm/Node.js; run with --write`
    )
    process.exit(1)
  }
}
