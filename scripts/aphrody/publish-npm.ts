// Publishes the fork's npm packages under @aphrody (replaces scripts/publish-release.js).
//
//   bun scripts/aphrody/publish-npm.ts version                      print the next `<base>-aphrody.N`
//   bun scripts/aphrody/publish-npm.ts publish --version <v> [--native <dir>] [--out <dir>] [--dry-run]
//
// Every package of the release shares one version, `<packages/next version>-aphrody.<n>`.
// `publish` expects the JS packages built (`bun run build`) and the native
// bindings in `--native` (default packages/next-swc/native, next-swc.<platform>.node).
// It publishes the native packages first, then each public package of
// packages/* with its manifest rewritten by scope.ts `publishManifest()`, and
// `next` last with its `@next/swc-*` optionalDependencies aliased to the fork's.
// A name@version already on the registry is skipped, so a re-run resumes.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NOT_PUBLISHED,
  publishManifest,
  REPOSITORY,
  scopedName,
  swcOptionalDependencies,
  SWC_PLATFORMS,
  workspacePackages,
} from './scope.ts'

const ROOT = join(import.meta.dir, '..', '..')
const REGISTRY = (
  process.env.npm_config_registry || 'https://registry.npmjs.org'
).replace(/\/$/, '')

/** `<base>-aphrody.<n+1>` where n is the highest published for that base. */
export function nextVersion(base: string, published: Iterable<string>): string {
  const re = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-aphrody\\.(\\d+)$`
  )
  let max = 0
  for (const v of published) {
    const m = re.exec(v)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${base}-aphrody.${max + 1}`
}

/** npm dist-tag: the prerelease channel of the upstream base (`canary`, `rc`...), else `latest`. */
export function distTag(version: string): string {
  const base = version.replace(/-aphrody\.\d+$/, '')
  const pre = /^\d+\.\d+\.\d+-([a-z]+)/.exec(base)
  return pre ? pre[1] : 'latest'
}

export async function publishedVersions(name: string): Promise<string[]> {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`${name}: registry answered ${res.status}`)
  return Object.keys(
    ((await res.json()) as { versions?: object }).versions ?? {}
  )
}

/** Manifest of `@aphrody/next-swc-<platform>`, from crates/next-napi-bindings/npm/<platform>. */
export function nativeManifest(
  pkg: Record<string, any>,
  platform: string,
  version: string
): Record<string, any> {
  return {
    ...pkg,
    name: scopedName(`@next/swc-${platform}`),
    version,
    repository: {
      type: 'git',
      url: `https://github.com/${REPOSITORY}`,
      directory: `crates/next-napi-bindings/npm/${platform}`,
    },
    publishConfig: { access: 'public' },
  }
}

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  if (proc.exitCode !== 0)
    throw new Error(
      `${cmd.join(' ')} (in ${cwd}) failed:\n${proc.stdout}\n${proc.stderr}`
    )
  return proc.stdout.toString()
}

async function publishDir(
  dir: string,
  name: string,
  version: string,
  dryRun: boolean
) {
  if (!dryRun && (await publishedVersions(name)).includes(version)) {
    console.log(`skip ${name}@${version} (already published)`)
    return
  }
  const args = [
    process.execPath,
    'publish',
    '--access',
    'public',
    '--tag',
    distTag(version),
    '--ignore-scripts',
  ]
  if (dryRun) args.push('--dry-run')
  run(args, dir)
  console.log(`${dryRun ? 'packed' : 'published'} ${name}@${version}`)
}

/** Packs a workspace package as upstream ships it, then rewrites the packed manifest. */
async function stageWorkspacePackage(
  dir: string,
  version: string,
  out: string
): Promise<string> {
  const source = JSON.parse(
    readFileSync(join(ROOT, dir, 'package.json'), 'utf8')
  )
  const tgzDir = join(out, 'tgz')
  mkdirSync(tgzDir, { recursive: true })
  const tgz = run(
    [
      process.execPath,
      'pm',
      'pack',
      '--ignore-scripts',
      '--quiet',
      '--destination',
      tgzDir,
    ],
    join(ROOT, dir)
  )
    .trim()
    .split('\n')
    .pop()!
  const staging = join(out, dir.replaceAll('/', '__'))
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  run(
    [
      'tar',
      '-xzf',
      tgz.includes('/') || tgz.includes('\\') ? tgz : join(tgzDir, tgz),
      '-C',
      staging,
      '--strip-components=1',
    ],
    ROOT
  )
  const manifest = publishManifest(source, version, dir)
  if (source.name === 'next') {
    manifest.optionalDependencies = {
      ...manifest.optionalDependencies,
      ...swcOptionalDependencies(version),
    }
  }
  await Bun.write(
    join(staging, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  )
  return staging
}

export async function publish(opts: {
  version: string
  native: string
  out: string
  dryRun: boolean
}) {
  const { version, native, out, dryRun } = opts
  if (!/-aphrody\.\d+$/.test(version))
    throw new Error(`version ${version} is not <base>-aphrody.<n>`)
  mkdirSync(out, { recursive: true })

  // Native bindings: every platform must be present, the fork never ships a partial release.
  const missing = SWC_PLATFORMS.filter(
    (p) => !existsSync(join(native, `next-swc.${p}.node`))
  )
  if (missing.length && !dryRun)
    throw new Error(
      `missing native bindings in ${native}: ${missing.join(', ')}`
    )
  for (const platform of SWC_PLATFORMS) {
    const binary = join(native, `next-swc.${platform}.node`)
    if (!existsSync(binary)) continue
    const src = join(ROOT, 'crates/next-napi-bindings/npm', platform)
    const staging = join(out, `swc-${platform}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const manifest = nativeManifest(
      JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')),
      platform,
      version
    )
    await Bun.write(
      join(staging, 'package.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    )
    await Bun.write(
      join(staging, `next-swc.${platform}.node`),
      Bun.file(binary)
    )
    if (existsSync(join(src, 'README.md')))
      await Bun.write(
        join(staging, 'README.md'),
        Bun.file(join(src, 'README.md'))
      )
    await publishDir(staging, manifest.name, version, dryRun)
  }

  // JS packages, `next` last so its dependencies resolve the moment it appears.
  const pkgs = workspacePackages(ROOT).filter(
    (p) => !p.private && !NOT_PUBLISHED.has(p.name)
  )
  pkgs.sort((a, b) => Number(a.name === 'next') - Number(b.name === 'next'))
  for (const pkg of pkgs) {
    const staging = await stageWorkspacePackage(pkg.dir, version, out)
    await publishDir(staging, scopedName(pkg.name)!, version, dryRun)
  }
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2)
  const value = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  if (cmd === 'version') {
    const base = JSON.parse(
      readFileSync(join(ROOT, 'packages/next/package.json'), 'utf8')
    ).version
    console.log(nextVersion(base, await publishedVersions(scopedName('next')!)))
  } else if (cmd === 'publish') {
    const version = value('--version')
    if (!version) throw new Error('--version is required')
    await publish({
      version,
      native: value('--native') ?? join(ROOT, 'packages/next-swc/native'),
      out: value('--out') ?? join(tmpdir(), 'aphrody-next-npm'),
      dryRun: args.includes('--dry-run'),
    })
  } else {
    console.error(
      'usage: publish-npm.ts version | publish --version <v> [--native <dir>] [--out <dir>] [--dry-run]'
    )
    process.exit(1)
  }
}
