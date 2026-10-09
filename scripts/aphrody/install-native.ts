// Root postinstall of the fork (replaces upstream's scripts/install-native.mjs,
// which installs vercel's @next/swc-* with pnpm): installs the fork's prebuilt
// native bindings `@aphrody/next-swc-<platform>` under their upstream names in
// node_modules/@next, with Bun. Never falls back to upstream's packages.
//
//   NEXT_SKIP_NATIVE_POSTINSTALL=1   skip (default in CI)
//   NEXT_TEST_PREFER_OFFLINE=1       prefer the install cache

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aliasSpec, scopedName, SWC_PLATFORMS } from './scope.ts'

const REGISTRY = (
  process.env.npm_config_registry || 'https://registry.npmjs.org'
).replace(/\/$/, '')

export function shouldSkip(env: Record<string, string | undefined>): boolean {
  const raw = env.NEXT_SKIP_NATIVE_POSTINSTALL
  return raw == null || raw === ''
    ? env.CI === 'true'
    : raw !== '0' && raw !== 'false'
}

/** Latest `<nextVersion>-aphrody.N` among the published versions, or undefined. */
export function pickVersion(
  versions: string[],
  nextVersion: string
): string | undefined {
  const prefix = `${nextVersion}-aphrody.`
  let best: string | undefined
  let bestN = -1
  for (const v of versions) {
    if (!v.startsWith(prefix)) continue
    const n = Number(v.slice(prefix.length))
    if (Number.isInteger(n) && n > bestN) {
      best = v
      bestN = n
    }
  }
  return best
}

async function publishedVersions(name: string): Promise<string[]> {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`${name}: registry answered ${res.status}`)
  return Object.keys(
    ((await res.json()) as { versions?: object }).versions ?? {}
  )
}

async function main() {
  if (shouldSkip(process.env)) {
    console.log(
      `Skipping next-swc postinstall (NEXT_SKIP_NATIVE_POSTINSTALL=${JSON.stringify(process.env.NEXT_SKIP_NATIVE_POSTINSTALL)}, CI=${JSON.stringify(process.env.CI)})`
    )
    return
  }
  const cwd = process.cwd()
  // A binding built from this checkout wins over any prebuilt one.
  const native = join(cwd, 'packages/next-swc/native')
  if (
    existsSync(native) &&
    readdirSync(native).some((f) => f.endsWith('.node'))
  ) {
    console.log('next-swc: using the binding built in packages/next-swc/native')
    return
  }
  const nextVersion: string = JSON.parse(
    readFileSync(join(cwd, 'packages/next/package.json'), 'utf8')
  ).version
  const probe = scopedName(`@next/swc-${SWC_PLATFORMS[0]}`)!
  const version = pickVersion(await publishedVersions(probe), nextVersion)
  if (!version) {
    console.warn(
      `next-swc: ${probe} has no ${nextVersion}-aphrody.N release yet; build the binding from source ` +
        '(bun run --filter @next/swc build-native) or set NEXT_SKIP_NATIVE_POSTINSTALL=1'
    )
    return
  }

  const installed = join(cwd, 'node_modules/@next')
  try {
    for (const pkg of readdirSync(installed)) {
      if (!pkg.startsWith('swc-')) continue
      const meta = JSON.parse(
        readFileSync(join(installed, pkg, 'package.json'), 'utf8')
      )
      if (meta.version === version) {
        console.log(
          `@next/${pkg} (${meta.name}@${version}) already installed, skipping`
        )
        return
      }
    }
  } catch {}

  const dir = join(tmpdir(), `next-swc-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  try {
    await Bun.write(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'next-swc-install',
        private: true,
        optionalDependencies: Object.fromEntries(
          SWC_PLATFORMS.map((p) => [
            `@next/swc-${p}`,
            aliasSpec(`@next/swc-${p}`, version),
          ])
        ),
      })
    )
    const args = [
      process.execPath,
      'install',
      '--no-save',
      '--ignore-scripts',
      '--linker=hoisted',
    ]
    if (process.env.NEXT_TEST_PREFER_OFFLINE === '1')
      args.push('--prefer-offline')
    const proc = Bun.spawn(args, {
      cwd: dir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await proc.exited) !== 0)
      throw new Error(`bun install exited with ${proc.exitCode}`)

    const from = join(dir, 'node_modules/@next')
    const pkgs = existsSync(from) ? readdirSync(from) : []
    if (!pkgs.length) {
      throw new Error(
        `No binary for ${process.platform}-${process.arch} in ${version}. ` +
          'Build it from source and set NEXT_SKIP_NATIVE_POSTINSTALL=1.'
      )
    }
    mkdirSync(installed, { recursive: true })
    await Promise.all(
      pkgs.map(async (pkg) => {
        const to = join(installed, pkg)
        await rm(to, { recursive: true, force: true })
        await cp(join(from, pkg), to, { recursive: true, force: true })
      })
    )
    console.log(`Installed ${version}:`, pkgs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    throw new Error('Failed to install @aphrody/next-swc binary packages', {
      cause: err,
    })
  })
}
