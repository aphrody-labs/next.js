import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTS_NOTE,
  FORK_SCRIPTS,
  isManaged,
  rewrite,
  rewriteRootManifest,
  rewriteScript,
  rewriteSource,
  SOURCE_REWRITES,
} from '../bunify.ts'
import { LIST, problems, readList } from '../test-unit-bun.ts'
import {
  aliasSpec,
  check,
  publishManifest,
  scopedName,
  swcOptionalDependencies,
} from '../scope.ts'
import { sync } from '../sync-upstream.ts'
import { pickVersion, shouldSkip } from '../install-native.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')

describe('bunify', () => {
  test('scripts run on Bun', () => {
    expect(rewriteScript('pnpm build:source && pnpm types')).toBe(
      'bun run build:source && bun run types'
    )
    expect(rewriteScript('pnpm pack --out ./packed.tgz')).toBe(
      'bun pm pack --filename ./packed.tgz'
    )
    expect(
      rewriteScript('pnpm --filter "./packages/**" --stream run types')
    ).toBe('bun run --filter "./packages/**" types')
    expect(rewriteScript('node scripts/a.mjs && node scripts/b.mjs')).toBe(
      'bun scripts/a.mjs && bun scripts/b.mjs'
    )
    expect(rewriteScript('tsx scripts/pack-next.ts')).toBe(
      'bun scripts/pack-next.ts'
    )
    expect(rewriteScript('cross-env A=1 B=2 node --inspect x.js')).toBe(
      'cross-env A=1 B=2 bun --inspect x.js'
    )
    // Not a command: left alone.
    expect(rewriteScript('swc -d dist src')).toBe('swc -d dist src')
    expect(rewriteScript('taskr release')).toBe('taskr release')
  })

  test('root manifest: pnpm settings become Bun settings', () => {
    const upstream = JSON.stringify({
      name: 'nextjs-project',
      workspaces: ['packages/*'],
      scripts: { 'pnpm:devPreinstall': 'node a.mjs', build: 'turbo run build' },
      packageManager: 'pnpm@10.33.0',
      pnpm: {
        overrides: { postcss: '8.5.23' },
        packageExtensions: { x: {} },
        patchedDependencies: {
          'taskr@1.1.0': 'patches/taskr.patch',
          'postcss-scss': 'patches/postcss-scss.patch',
        },
      },
    })
    const out = JSON.parse(
      rewriteRootManifest(upstream, { 'postcss-scss': '4.0.3' })
    )
    expect(out.pnpm).toBeUndefined()
    expect(out.packageManager).toStartWith('bun@')
    expect(out.workspaces).toContain('crates/*/js')
    expect(out.scripts).toEqual({
      preinstall: 'bun a.mjs',
      build: 'turbo run build',
      ...FORK_SCRIPTS,
    })
    expect(out.overrides).toEqual({ postcss: '8.5.23' })
    expect(out.patchedDependencies).toEqual({
      'taskr@1.1.0': 'patches/taskr.patch',
      'postcss-scss@4.0.3': 'patches/postcss-scss.patch',
    })
    // Idempotent.
    expect(
      rewriteRootManifest(
        rewriteRootManifest(upstream, { 'postcss-scss': '4.0.3' })
      )
    ).toBe(rewriteRootManifest(upstream, { 'postcss-scss': '4.0.3' }))
  })

  test('managed files', () => {
    expect(isManaged('package.json')).toBe(true)
    expect(isManaged('packages/next/package.json')).toBe(true)
    expect(
      isManaged('turbopack/crates/turbopack-ecmascript-runtime/js/package.json')
    ).toBe(true)
    expect(isManaged('test/e2e/app/package.json')).toBe(false)
    expect(
      rewrite('test/e2e/app/package.json', '{"scripts":{"a":"pnpm x"}}')
    ).toBe('{"scripts":{"a":"pnpm x"}}')
  })

  test('root manifest: fork scripts after test-unit, once', () => {
    const upstream = JSON.stringify({
      name: 'x',
      scripts: { 'test-types': 'tsc', 'test-unit': 'jest', lint: 'x' },
    })
    const once = rewriteRootManifest(upstream)
    expect(Object.keys(JSON.parse(once).scripts)).toEqual([
      'test-types',
      'test-unit',
      ...Object.keys(FORK_SCRIPTS),
      'lint',
    ])
    expect(rewriteRootManifest(once)).toBe(once)
  })

  test('AGENTS.md: Bun commands and the fork note, idempotent', () => {
    const upstream = [
      '# Next.js Development Guide',
      '',
      '## Codebase structure',
      '',
      'This is a pnpm monorepo containing the Next.js framework.',
      '',
      '```bash',
      'pnpm --filter=next build',
      'pnpm build-all   # bootstrap',
      'pnpm --filter=next exec taskr <task>',
      'HEADLESS=true pnpm test-dev-turbo test/a.ts',
      'npx eslint --fix <files>',
      '```',
      '',
      'A fresh worktree has no `node_modules`, so `pnpm` and `npx` do not work in it.',
      'Delete it and run `pnpm install`. `pnpm typescript` runs `tsc`.',
      '',
    ].join('\n')
    const out = rewrite('AGENTS.md', upstream)
    expect(out).toStartWith(`# Next.js Development Guide\n\n${AGENTS_NOTE}\n\n`)
    expect(out).toContain('This is a Bun workspaces monorepo')
    expect(out).toContain('bun run --filter=next build\n')
    expect(out).toContain('bun run build-all   # bootstrap')
    expect(out).toContain('bun run --cwd packages/next taskr <task>')
    expect(out).toContain('HEADLESS=true bun run test-dev-turbo test/a.ts')
    expect(out).toContain('bunx eslint --fix <files>')
    expect(out).toContain('so `bun run` and `bunx` do not work')
    expect(out).toContain('run `bun install`. `bun run typescript` runs')
    expect(rewrite('AGENTS.md', out)).toBe(out)
    expect(isManaged('AGENTS.md')).toBe(true)
    // The checkout's AGENTS.md keeps no pnpm/npx command outside the note.
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
    expect(agents.replace(AGENTS_NOTE, '')).not.toMatch(/\bpnpm |\bnpx /)
  })

  test('scripts/: node shebang and pnpm/npx spawns run on Bun', () => {
    expect(rewriteSource('scripts/a.js', '#!/usr/bin/env node\nx()\n')).toBe(
      '#!/usr/bin/env bun\nx()\n'
    )
    expect(
      rewriteSource(
        'scripts/devlow-bench.mjs',
        "let s = command('pnpm', buildArgs, {"
      )
    ).toBe("let s = command('bun', ['run', ...buildArgs], {")
    expect(
      rewriteSource(
        'scripts/build-native.ts',
        "const c = ['pnpm', 'run', 'build-native', ...a]"
      )
    ).toBe("const c = ['bun', 'run', 'build-native', ...a]")
    expect(
      rewriteSource(
        'scripts/benchmark-next-dev-boot.js',
        "execSync('npx taskr cli')"
      )
    ).toBe("execSync('bun run taskr cli')")
    expect(isManaged('scripts/sync-react.js')).toBe(true)
    expect(isManaged('scripts/aphrody/bunify.ts')).toBe(false)
    expect(isManaged('scripts/wasi-test-host/node_modules/x/a.js')).toBe(false)
    // Every per-file rewrite still finds its upstream pattern, or its result.
    for (const [file, rules] of Object.entries(SOURCE_REWRITES)) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const [pattern, replacement] of rules) {
        expect(text).not.toMatch(pattern)
        expect(text).toContain(replacement.split('$1')[0])
      }
    }
  })

  test('the checkout is bunified', () => {
    const proc = Bun.spawnSync(
      [process.execPath, join(ROOT, 'scripts/aphrody/bunify.ts'), '--check'],
      { cwd: ROOT }
    )
    expect(proc.stderr.toString()).toBe('')
    expect(proc.exitCode).toBe(0)
  })
})

describe('scope', () => {
  test('names', () => {
    expect(scopedName('next')).toBe('@aphrody/next')
    expect(scopedName('@next/env')).toBe('@aphrody/next-env')
    expect(scopedName('@next/swc-win32-x64-msvc')).toBe(
      '@aphrody/next-swc-win32-x64-msvc'
    )
    expect(scopedName('create-next-app')).toBe('@aphrody/create-next-app')
    expect(scopedName('react')).toBeUndefined()
    expect(aliasSpec('@next/env', '1.0.0-aphrody.1')).toBe(
      'npm:@aphrody/next-env@1.0.0-aphrody.1'
    )
  })

  test("published manifest aliases the fork's packages under their upstream names", () => {
    const pkg = {
      name: 'next',
      version: '16.5.0-canary.5',
      dependencies: { '@next/env': 'workspace:*', 'styled-jsx': '5.1.6' },
      peerDependencies: { react: '^19' },
      devDependencies: { '@next/swc': 'workspace:*' },
      scripts: { build: 'taskr release' },
    }
    const v = '16.5.0-canary.5-aphrody.1'
    const out = publishManifest(pkg, v, 'packages/next')
    expect(out.name).toBe('@aphrody/next')
    expect(out.version).toBe(v)
    expect(out.dependencies).toEqual({
      '@next/env': `npm:@aphrody/next-env@${v}`,
      'styled-jsx': '5.1.6',
    })
    expect(out.devDependencies).toBeUndefined()
    expect(out.scripts).toBeUndefined()
    expect(out.repository.url).toBe('https://github.com/aphrody-labs/next.js')
    expect(swcOptionalDependencies(v)['@next/swc-linux-x64-musl']).toBe(
      `npm:@aphrody/next-swc-linux-x64-musl@${v}`
    )
    const third = publishManifest(
      { name: '@next/third-parties', peerDependencies: { next: '^16.0.0' } },
      v,
      'packages/third-parties'
    )
    expect(third.peerDependencies.next).toBe(`^16.0.0 || ${v}`)
  })

  test('the checkout passes the scope check (no upstream fallback)', () => {
    expect(check(ROOT)).toEqual([])
  })
})

describe('sync-upstream', () => {
  function git(cwd: string, ...args: string[]) {
    const p = Bun.spawnSync(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr}`)
    return p.stdout.toString().trim()
  }

  test('a pnpm-only upstream change to a bunified manifest merges without conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aphrody-next-sync-'))
    try {
      const up = join(dir, 'up')
      const fork = join(dir, 'fork')
      Bun.spawnSync(['git', 'init', '-q', '-b', 'canary', up])
      git(up, 'config', 'user.email', 't@t')
      git(up, 'config', 'user.name', 't')
      const member = (scripts: Record<string, string>) =>
        JSON.stringify(
          { name: '@next/env', version: '1.0.0', scripts },
          null,
          2
        ) + '\n'
      await Bun.write(
        join(up, 'packages/next-env/package.json'),
        member({ build: 'pnpm types', types: 'tsc' })
      )
      await Bun.write(join(up, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      await Bun.write(
        join(up, 'packages/next/src/lib/download-swc.ts'),
        'await extractBinary(o, swcPackageName(t), v)\n'
      )
      git(up, 'add', '.')
      git(up, 'commit', '-qm', 'base')

      Bun.spawnSync(['git', 'clone', '-q', up, fork])
      git(fork, 'config', 'user.email', 't@t')
      git(fork, 'config', 'user.name', 't')
      git(fork, 'remote', 'add', 'upstream', up)
      writeFileSync(
        join(fork, 'packages/next-env/package.json'),
        member({ build: 'bun run types', types: 'tsc' })
      )
      git(fork, 'rm', '-q', 'pnpm-lock.yaml')
      git(fork, 'commit', '-qam', 'bunify')

      // Upstream edits the same script line (pnpm form) and the lockfile.
      writeFileSync(
        join(up, 'packages/next-env/package.json'),
        member({ build: 'pnpm types && pnpm x', types: 'tsc' })
      )
      writeFileSync(
        join(up, 'pnpm-lock.yaml'),
        'lockfileVersion: 9\n# changed\n'
      )
      git(up, 'commit', '-qam', 'upstream change')

      const result = await sync({
        root: fork,
        remote: 'upstream',
        ref: 'upstream/canary',
        branch: 'canary',
        fetch: true,
        push: false,
        dryRun: false,
        keepConflicts: false,
        install: false,
      })
      expect(result.status).toBe('merged')
      const merged = JSON.parse(
        readFileSync(join(fork, 'packages/next-env/package.json'), 'utf8')
      )
      expect(merged.scripts.build).toBe('bun run types && bun run x')
      expect(git(fork, 'ls-files', 'pnpm-lock.yaml')).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an upstream edit of a rewritten AGENTS.md line merges without conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aphrody-next-sync-'))
    try {
      const up = join(dir, 'up')
      const fork = join(dir, 'fork')
      Bun.spawnSync(['git', 'init', '-q', '-b', 'canary', up])
      git(up, 'config', 'user.email', 't@t')
      git(up, 'config', 'user.name', 't')
      const agents = (cmd: string) =>
        `# Guide\n\n## Build\n\n\`\`\`bash\n${cmd}\n\`\`\`\n`
      await Bun.write(join(up, 'AGENTS.md'), agents('pnpm --filter=next build'))
      await Bun.write(
        join(up, 'packages/next/src/lib/download-swc.ts'),
        'await extractBinary(o, swcPackageName(t), v)\n'
      )
      git(up, 'add', '.')
      git(up, 'commit', '-qm', 'base')

      Bun.spawnSync(['git', 'clone', '-q', up, fork])
      git(fork, 'config', 'user.email', 't@t')
      git(fork, 'config', 'user.name', 't')
      git(fork, 'remote', 'add', 'upstream', up)
      writeFileSync(
        join(fork, 'AGENTS.md'),
        rewrite('AGENTS.md', agents('pnpm --filter=next build'))
      )
      git(fork, 'commit', '-qam', 'bunify')

      writeFileSync(
        join(up, 'AGENTS.md'),
        agents('pnpm --filter=next build --watch')
      )
      git(up, 'commit', '-qam', 'upstream change')

      const result = await sync({
        root: fork,
        remote: 'upstream',
        ref: 'upstream/canary',
        branch: 'canary',
        fetch: true,
        push: false,
        dryRun: false,
        keepConflicts: false,
        install: false,
      })
      expect(result.status).toBe('merged')
      expect(readFileSync(join(fork, 'AGENTS.md'), 'utf8')).toBe(
        rewrite('AGENTS.md', agents('pnpm --filter=next build --watch'))
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('test-unit-bun', () => {
  test('the list names existing test files once', async () => {
    const files = readList(await Bun.file(LIST).text())
    expect(files.length).toBeGreaterThan(0)
    expect(problems(ROOT, files)).toEqual([])
    expect(problems(ROOT, ['a.test.ts', 'a.test.ts', 'b.ts'])).toEqual([
      'a.test.ts: missing',
      'a.test.ts: listed twice',
      'a.test.ts: missing',
      'b.ts: not a test file',
      'b.ts: missing',
    ])
  })
})

describe('install-native', () => {
  test('picks the latest fork release of the checkout version, never upstream', () => {
    const versions = [
      '16.5.0-canary.5',
      '16.5.0-canary.5-aphrody.2',
      '16.5.0-canary.5-aphrody.10',
      '16.5.0-canary.4-aphrody.9',
    ]
    expect(pickVersion(versions, '16.5.0-canary.5')).toBe(
      '16.5.0-canary.5-aphrody.10'
    )
    expect(pickVersion(['16.5.0-canary.5'], '16.5.0-canary.5')).toBeUndefined()
  })

  test('skip rules match upstream', () => {
    expect(shouldSkip({ CI: 'true' })).toBe(true)
    expect(shouldSkip({})).toBe(false)
    expect(shouldSkip({ CI: 'true', NEXT_SKIP_NATIVE_POSTINSTALL: '0' })).toBe(
      false
    )
    expect(shouldSkip({ NEXT_SKIP_NATIVE_POSTINSTALL: '1' })).toBe(true)
  })
})

describe('publish-npm', () => {
  test('versions and dist-tags', async () => {
    const { distTag, nextVersion } = await import('../publish-npm.ts')
    expect(nextVersion('16.5.0-canary.5', [])).toBe('16.5.0-canary.5-aphrody.1')
    expect(
      nextVersion('16.5.0-canary.5', [
        '16.5.0-canary.5-aphrody.3',
        '16.5.0-canary.4-aphrody.9',
      ])
    ).toBe('16.5.0-canary.5-aphrody.4')
    expect(distTag('16.5.0-canary.5-aphrody.1')).toBe('canary')
    expect(distTag('16.4.0-aphrody.2')).toBe('latest')
  })

  test('native package manifest', async () => {
    const { nativeManifest } = await import('../publish-npm.ts')
    const pkg = JSON.parse(
      readFileSync(
        join(ROOT, 'crates/next-napi-bindings/npm/linux-x64-musl/package.json'),
        'utf8'
      )
    )
    const out = nativeManifest(
      pkg,
      'linux-x64-musl',
      '16.5.0-canary.5-aphrody.1'
    )
    expect(out.name).toBe('@aphrody/next-swc-linux-x64-musl')
    expect(out.main).toBe('next-swc.linux-x64-musl.node')
    expect(out.repository.url).toBe('https://github.com/aphrody-labs/next.js')
  })
})
