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
//   AGENTS.md                  pnpm/npx commands -> bun, plus the fork's preamble
//   scripts/**                 `#!/usr/bin/env node` -> bun; pnpm/npx spawns -> bun (SOURCE_REWRITES)
//   pnpm-workspace.yaml        removed; its settings live in package.json and bunfig.toml

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BUN_VERSION = '1.4.3-aphrody.2'

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

/** Root scripts the fork adds, inserted after `test-unit`. */
export const FORK_SCRIPTS: Record<string, string> = {
  'test-unit-bun': 'bun scripts/aphrody/test-unit-bun.ts',
}

function withForkScripts(
  scripts: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  let placed = false
  for (const [name, script] of Object.entries(scripts)) {
    if (name in FORK_SCRIPTS) continue
    out[name] = script
    if (name === 'test-unit') {
      Object.assign(out, FORK_SCRIPTS)
      placed = true
    }
  }
  if (!placed) Object.assign(out, FORK_SCRIPTS)
  return out
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
      out.scripts = withForkScripts(out.scripts as Record<string, string>)
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
    ...pkg.dependencies,
    ...pkg.devDependencies,
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
    out.overrides = { ...pkg.overrides, ...pnpm.overrides }
  const patches: Record<string, string> = { ...pkg.patchedDependencies }
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

/** Markdown files whose pnpm/npx commands are rewritten, with the fork's preamble after the title. */
export const DOC_FILES = ['AGENTS.md']

const NOTE_BEGIN = '<!-- aphrody:bun -->'
const NOTE_END = '<!-- /aphrody:bun -->'

/** Preamble of AGENTS.md: what differs from upstream's pnpm/Node.js instructions. */
export const AGENTS_NOTE = `${NOTE_BEGIN}

> **Fork aphrody-labs/next.js.** This checkout installs and runs its tooling with Bun, not pnpm.
> \`scripts/aphrody/bunify.ts\` writes this note and the Bun commands below from upstream's
> AGENTS.md: change the rewrite there, not here.
>
> - Install: \`bun install\` (\`bun.lock\`; \`bunfig.toml\`: isolated linker, pnpm's public hoisting,
>   48 h minimum release age). There is no \`pnpm-lock.yaml\` nor \`pnpm-workspace.yaml\`.
> - Scripts: \`bun run <script>\`, \`bun run --filter=<package> <script>\` for one package. Package
>   binaries: \`bun run --cwd packages/next taskr <task>\`, \`bunx <bin>\`.
> - Unit tests that pass on Bun: \`bun run test-unit-bun\` (\`bun test --isolate\` over the files listed
>   in \`scripts/aphrody/bun-unit-tests.txt\`). Every other suite (\`test-unit\`, \`test-dev-*\`,
>   \`test-start-*\`) still runs Jest through \`scripts/run-jest.sh\`, and \`jest.config.js\` loads
>   \`next/jest\` from the built \`packages/next/dist\`.
> - Fork tooling: \`bun test scripts/aphrody/test\`; upstream merge \`bun scripts/aphrody/sync-upstream.ts\`;
>   npm release \`scripts/aphrody/publish-npm.ts\` (\`@aphrody/*\` packages, see \`APHRODY.md\`).
> - Not verified on this fork: the Jest e2e and integration commands below, and \`turbo run build\`
>   on Windows, where \`next#build\` reports "Taskfile not found!" (see \`PLAN.md\`).

${NOTE_END}`

/** Rewrites the commands of a Markdown file (outside the fork's note) for Bun. */
export function rewriteDocCommands(text: string): string {
  return text
    .replace(
      /\bThis is a pnpm monorepo\b/g,
      'This is a Bun workspaces monorepo'
    )
    .replace(
      /`pnpm` and `npx` do not work/g,
      '`bun run` and `bunx` do not work'
    )
    .replace(
      /\bpnpm --filter=next exec taskr\b/g,
      'bun run --cwd packages/next taskr'
    )
    .replace(/\bpnpm install\b/g, 'bun install')
    .replace(/\bnpx (?=[\w@])/g, 'bunx ')
    .replace(/\bpnpm (--filter=\S+ )?(?:run |exec )?(?=[\w-])/g, 'bun run $1')
}

export function rewriteDoc(text: string): string {
  const begin = text.indexOf(NOTE_BEGIN)
  const end = begin >= 0 ? text.indexOf(NOTE_END, begin) : -1
  const body =
    begin >= 0 && end >= 0
      ? text.slice(0, begin).replace(/\n+$/, '\n') +
        text.slice(end + NOTE_END.length).replace(/^\n+/, '\n')
      : text
  const out = rewriteDocCommands(body)
  // After the first `# ` title, or at the top.
  const title = /^# .*\n/m.exec(out)
  const at = title ? title.index + title[0].length : 0
  return out.slice(0, at) + '\n' + AGENTS_NOTE + '\n' + out.slice(at)
}

/**
 * Upstream tooling under scripts/ that spawns pnpm or npx, found by the n2b
 * audit (`aphrody n2b scripts`): literal rewrites per file. Each replacement
 * never contains its pattern, so the rewrite is idempotent.
 */
export const SOURCE_REWRITES: Record<string, [RegExp, string][]> = {
  'scripts/build-native.ts': [
    [/\['pnpm', 'run', 'build-native'/g, "['bun', 'run', 'build-native'"],
  ],
  'scripts/devlow-bench.mjs': [
    [/command\('pnpm', (\w+),/g, "command('bun', ['run', ...$1],"],
  ],
  'scripts/analyze-dev-server-bundle.js': [[/'npx taskr /g, "'bun run taskr "]],
  'scripts/benchmark-next-dev-boot.js': [[/'npx taskr /g, "'bun run taskr "]],
}

/** Scripts under scripts/ (fork tooling in scripts/aphrody excluded) whose node shebang becomes bun. */
const SCRIPT_SOURCE =
  /^scripts\/(?!aphrody\/)(?!.*\/node_modules\/).+\.(?:js|mjs|cjs|ts)$/

export function rewriteSource(path: string, text: string): string {
  let out = text.replace(
    /^#!\/usr\/bin\/env node(?=\r?\n)/,
    '#!/usr/bin/env bun'
  )
  for (const [pattern, replacement] of SOURCE_REWRITES[path] ?? [])
    out = out.replace(pattern, replacement)
  return out
}

export function isManaged(path: string): boolean {
  const p = path.replaceAll('\\', '/')
  return (
    p === 'package.json' ||
    MEMBER.test(p) ||
    SHELL_FILES.includes(p) ||
    DOC_FILES.includes(p) ||
    SCRIPT_SOURCE.test(p)
  )
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
  if (DOC_FILES.includes(p)) return rewriteDoc(text)
  if (SCRIPT_SOURCE.test(p)) return rewriteSource(p, text)
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
  const files = ['package.json', ...SHELL_FILES, ...DOC_FILES]
  for (const f of new Bun.Glob('scripts/**/*.{js,mjs,cjs,ts}').scanSync({
    cwd: root,
    onlyFiles: true,
  })) {
    const p = f.replaceAll('\\', '/')
    if (SCRIPT_SOURCE.test(p)) files.push(p)
  }
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
