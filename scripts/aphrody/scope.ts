// The fork publishes its npm packages under the @aphrody scope. This file is
// the single source of truth for that rename.
//
// Unlike the Bun fork, the sources keep the upstream names: applications
// import `next/link` and Next.js resolves `@next/swc-*` and `@next/env` at run
// time, so the rename happens only in the published manifests. A consumer
// installs `"next": "npm:@aphrody/next@<version>"`; the published `next`
// depends on its siblings through the same kind of alias
// (`"@next/env": "npm:@aphrody/next-env@<version>"`), so every `require()` in
// the published code resolves unchanged. Code that downloads a package from
// the registry by name (the SWC fallback) asks `swcPackageName()` in
// packages/next/src/lib/aphrody-scope.ts.
//
//   bun scripts/aphrody/scope.ts --check   every public workspace package has a scoped name (exit 1 if not)
//   bun scripts/aphrody/scope.ts --list    upstream name -> published name

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCOPE = '@aphrody'
export const REPOSITORY = 'aphrody-labs/next.js'

/** Native SWC/Turbopack platforms published as `@aphrody/next-swc-<platform>`, as upstream. */
export const SWC_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-arm64-msvc',
  'win32-x64-msvc',
] as const

/** Upstream packages of this repository the fork does not publish. */
export const NOT_PUBLISHED = new Set(['@vercel/devlow-bench'])

/**
 * The published name of an upstream package of this repository, or undefined
 * when the package is not one of ours (a registry dependency).
 */
export function scopedName(name: string): string | undefined {
  if (name.startsWith(`${SCOPE}/`)) return name
  if (name === 'next') return `${SCOPE}/next`
  if (name.startsWith('@next/'))
    return `${SCOPE}/next-${name.slice('@next/'.length)}`
  if (
    name === 'create-next-app' ||
    name === 'eslint-config-next' ||
    name === 'next-rspack'
  ) {
    return `${SCOPE}/${name}`
  }
  return undefined
}

/** npm alias spec that installs the fork's package under its upstream name. */
export function aliasSpec(name: string, version: string): string {
  const scoped = scopedName(name)
  if (!scoped) throw new Error(`${name} is not a package of this repository`)
  return `npm:${scoped}@${version}`
}

const DEP_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/**
 * The manifest as published: scoped name, version, links to the fork, and
 * every dependency on a package of this repository turned into an alias of
 * the fork's package at `version`. Keys stay the upstream names, so
 * `require("@next/env")` keeps working.
 */
export function publishManifest(
  pkg: Record<string, any>,
  version: string,
  dir: string
): Record<string, any> {
  const name = scopedName(pkg.name)
  if (!name) throw new Error(`${pkg.name} has no scoped name`)
  const out: Record<string, any> = {
    ...pkg,
    name,
    version,
    repository: {
      type: 'git',
      url: `https://github.com/${REPOSITORY}`,
      directory: dir,
    },
    homepage: `https://github.com/${REPOSITORY}#readme`,
    bugs: { url: `https://github.com/${REPOSITORY}/issues` },
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (!deps) continue
    const next: Record<string, string> = {}
    for (const [dep, range] of Object.entries<string>(deps)) {
      if (!scopedName(dep) || dep.startsWith(`${SCOPE}/`)) {
        next[dep] = range
        continue
      }
      if (field === 'peerDependencies') {
        // A peer is satisfied by the app's own install; accept the fork's version too.
        next[dep] = range.startsWith('workspace:')
          ? `${version}`
          : `${range} || ${version}`
        continue
      }
      next[dep] = aliasSpec(dep, version)
    }
    out[field] = next
  }
  for (const field of ['devDependencies', 'scripts', 'taskr']) delete out[field]
  delete out.private
  out.publishConfig = { access: 'public' }
  return out
}

/** `next`'s optionalDependencies on the native packages, aliased to the fork's. */
export function swcOptionalDependencies(
  version: string,
  platforms: readonly string[] = SWC_PLATFORMS
) {
  return Object.fromEntries(
    platforms.map((p) => [
      `@next/swc-${p}`,
      aliasSpec(`@next/swc-${p}`, version),
    ])
  )
}

export type WorkspacePackage = { dir: string; name: string; private: boolean }

/** Public packages under packages/*. */
export function workspacePackages(root: string): WorkspacePackage[] {
  const out: WorkspacePackage[] = []
  for (const file of new Bun.Glob('packages/*/package.json').scanSync({
    cwd: root,
  })) {
    const pkg = JSON.parse(readFileSync(join(root, file), 'utf8'))
    out.push({
      dir: file.replaceAll('\\', '/').replace(/\/package\.json$/, ''),
      name: pkg.name,
      private: !!pkg.private,
    })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Problems that would publish an unscoped package or a fallback to upstream. */
export function check(root: string): string[] {
  const problems: string[] = []
  for (const pkg of workspacePackages(root)) {
    if (pkg.private || NOT_PUBLISHED.has(pkg.name)) continue
    if (!scopedName(pkg.name))
      problems.push(`${pkg.dir}: ${pkg.name} has no @aphrody name`)
  }
  const loader = join(root, 'packages/next/src/lib/download-swc.ts')
  const source = readFileSync(loader, 'utf8')
  const calls = [
    ...source.matchAll(/await extractBinary\(([\s\S]*?)\)\n/g),
  ].map((m) => m[1])
  if (
    !calls.length ||
    calls.some((args) => !args.includes('swcPackageName('))
  ) {
    problems.push(
      'packages/next/src/lib/download-swc.ts: every extractBinary() must download swcPackageName(...)'
    )
  }
  return problems
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const rootIdx = args.indexOf('--root')
  const root =
    rootIdx >= 0 ? args[rootIdx + 1] : join(import.meta.dir, '..', '..')
  if (args.includes('--list')) {
    for (const pkg of workspacePackages(root)) {
      if (pkg.private || NOT_PUBLISHED.has(pkg.name)) continue
      console.log(`${pkg.name} -> ${scopedName(pkg.name)}`)
    }
    for (const p of SWC_PLATFORMS)
      console.log(`@next/swc-${p} -> ${scopedName(`@next/swc-${p}`)}`)
  } else {
    const problems = check(root)
    for (const p of problems) console.error(p)
    if (problems.length) process.exit(1)
    console.log('scope: ok')
  }
}
