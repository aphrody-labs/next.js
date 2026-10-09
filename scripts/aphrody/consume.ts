// Points a consumer repository (Shenron, Aphrody...) at a published @aphrody release.
//
//   bun scripts/aphrody/consume.ts <consumer root> --version <v> [--write]
//
// Rewrites `next`, `@next/*`, `eslint-config-next`... in the root package.json
// and every workspace package.json of the consumer to `npm:@aphrody/<name>@<v>`
// (scope.ts `aliasSpec`): dependencies, devDependencies, optionalDependencies,
// overrides, resolutions and Bun catalogs (`catalog`, `catalogs`, and the same
// under `workspaces`). peerDependencies keep their upstream range, `catalog:`
// and `workspace:` references stay, and `@aphrody/*` keys are left alone.
// Refuses, without writing anything, when one of the rewritten packages has no
// `<v>` on npm. Prints the plan; `--write` applies it.

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  aliasSpec,
  NOT_PUBLISHED,
  SCOPE,
  scopedName,
  workspacePackages,
} from './scope.ts'
import { publishedVersions } from './publish-npm.ts'

const ROOT = join(import.meta.dir, '..', '..')

/** Upstream names the fork publishes under @aphrody (public packages of this checkout). */
export function publishable(root = ROOT): Set<string> {
  return new Set(
    workspacePackages(root)
      .filter((p) => !p.private && !NOT_PUBLISHED.has(p.name))
      .map((p) => p.name)
  )
}

export type Change = {
  file: string
  path: string
  name: string
  from: string
  to: string
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
] as const

function rewriteMap(
  deps: Record<string, unknown> | undefined,
  path: string,
  file: string,
  version: string,
  names: Set<string>,
  changes: Change[]
) {
  if (!deps || typeof deps !== 'object') return
  for (const [name, from] of Object.entries(deps)) {
    if (typeof from !== 'string') continue
    if (name.startsWith(`${SCOPE}/`) || !names.has(name)) continue
    if (from.startsWith('catalog:') || from.startsWith('workspace:')) continue
    const to = aliasSpec(name, version)
    if (from === to) continue
    deps[name] = to
    changes.push({ file, path: `${path}.${name}`, name, from, to })
  }
}

/** Rewrites one consumer manifest in place; returns what changed. */
export function rewriteConsumer(
  pkg: Record<string, any>,
  version: string,
  names: Set<string>,
  file = 'package.json'
): Change[] {
  const changes: Change[] = []
  const scopes: [Record<string, any> | undefined, string][] = [
    [pkg, ''],
    [Array.isArray(pkg.workspaces) ? undefined : pkg.workspaces, 'workspaces.'],
  ]
  for (const [obj, prefix] of scopes) {
    if (!obj) continue
    if (obj === pkg)
      for (const field of DEP_FIELDS)
        rewriteMap(obj[field], field, file, version, names, changes)
    rewriteMap(obj.catalog, `${prefix}catalog`, file, version, names, changes)
    for (const [cat, deps] of Object.entries(obj.catalogs ?? {}))
      rewriteMap(
        deps as Record<string, unknown>,
        `${prefix}catalogs.${cat}`,
        file,
        version,
        names,
        changes
      )
  }
  return changes
}

/** package.json of the consumer root and of each of its workspaces. */
export function consumerManifests(root: string): string[] {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? [])
  const files = new Set([join(root, 'package.json')])
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`)
    for (const f of glob.scanSync({ cwd: root, onlyFiles: true }))
      if (!f.split(/[\\/]/).includes('node_modules')) files.add(join(root, f))
  }
  return [...files].sort()
}

export async function consume(opts: {
  root: string
  version: string
  write: boolean
  names?: Set<string>
  versionsOf?: (name: string) => Promise<string[]>
}): Promise<Change[]> {
  const { root, version, write } = opts
  if (!/-aphrody\.\d+$/.test(version))
    throw new Error(`version ${version} is not <base>-aphrody.<n>`)
  const names = opts.names ?? publishable()
  const versionsOf = opts.versionsOf ?? publishedVersions
  const plans: [string, Record<string, any>][] = []
  const changes: Change[] = []
  for (const file of consumerManifests(root)) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const found = rewriteConsumer(
      pkg,
      version,
      names,
      relative(root, file).replaceAll('\\', '/')
    )
    if (found.length) plans.push([file, pkg])
    changes.push(...found)
  }
  const missing: string[] = []
  for (const name of new Set(changes.map((c) => c.name))) {
    const scoped = scopedName(name)!
    if (!(await versionsOf(scoped)).includes(version))
      missing.push(`${scoped}@${version}`)
  }
  if (missing.length)
    throw new Error(`not on npm, nothing written: ${missing.join(', ')}`)
  if (write)
    for (const [file, pkg] of plans)
      await Bun.write(file, JSON.stringify(pkg, null, 2) + '\n')
  return changes
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--version')
  const version = i >= 0 ? args[i + 1] : undefined
  const root = args.find((a, j) => !a.startsWith('--') && j !== i + 1)
  if (!root || !version || !existsSync(join(root, 'package.json'))) {
    console.error(
      'usage: consume.ts <consumer root> --version <base>-aphrody.<n> [--write]'
    )
    process.exit(1)
  }
  const write = args.includes('--write')
  try {
    const changes = await consume({ root, version, write })
    for (const c of changes)
      console.log(`${c.file} ${c.path}: ${c.from} -> ${c.to}`)
    console.log(
      `${changes.length} change(s) ${write ? 'written' : '(dry run, --write applies)'}; then run \`bun install\` in ${root}`
    )
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}
