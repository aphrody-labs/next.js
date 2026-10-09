// Merge upstream vercel/next.js canary into the fork and keep the Bun toolchain.
//
//   bun scripts/aphrody/sync-upstream.ts [--push] [--dry-run] [--keep-conflicts] [--no-install]
//       [--root <dir>] [--remote upstream] [--ref upstream/canary] [--branch canary] [--no-fetch]
//
// Conflicts are first retried as a bunify-aware three-way merge: the merge
// base and the upstream side go through bunify.ts `rewrite()` before
// `git merge-file`, so lines that differ only by the pnpm -> Bun rewrite merge
// cleanly. Files the fork deletes (pnpm-lock.yaml, pnpm-workspace.yaml) stay
// deleted. bun.lock is then regenerated from upstream's pnpm-lock.yaml (Bun
// migrates it), so the fork installs exactly the versions upstream pinned.
// Anything still conflicting stops the sync (exit 2) with the merge aborted,
// unless --keep-conflicts.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  apply as bunify,
  DELETED,
  isManaged,
  lockedVersions,
  rewrite,
} from './bunify.ts'
import { check as checkScope } from './scope.ts'

type Options = {
  root: string
  remote: string
  ref: string
  branch: string
  fetch: boolean
  push: boolean
  dryRun: boolean
  keepConflicts: boolean
  install: boolean
}

export type SyncResult =
  | { status: 'up-to-date'; behind: 0 }
  | {
      status: 'merged'
      behind: number
      commit: string
      resolved: string[]
      pushed: boolean
    }
  | { status: 'dry-run'; behind: number; conflicts: string[] }
  | { status: 'conflicts'; behind: number; conflicts: string[] }

function parseArgs(argv: string[]): Options {
  const value = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const remote = value('--remote', 'upstream')
  return {
    root: value('--root', join(import.meta.dir, '..', '..')),
    remote,
    ref: value('--ref', `${remote}/canary`),
    branch: value('--branch', 'canary'),
    fetch: !argv.includes('--no-fetch'),
    push: argv.includes('--push'),
    dryRun: argv.includes('--dry-run'),
    keepConflicts: argv.includes('--keep-conflicts'),
    install: !argv.includes('--no-install'),
  }
}

function git(root: string, args: string[], input?: string) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  }
}

function gitOk(root: string, args: string[]): string {
  const r = git(root, args)
  if (r.code !== 0)
    throw new Error(
      `git ${args.join(' ')} failed (exit ${r.code}): ${r.err.trim()}`
    )
  return r.out.trim()
}

// Stage blob of a conflicted path, or null when that side deleted it.
function stage(root: string, n: 1 | 2 | 3, path: string): string | null {
  const r = git(root, ['show', `:${n}:${path}`])
  return r.code === 0 ? r.out : null
}

/** pnpm patchedDependencies keys without a version, in an upstream root manifest. */
function unversionedPatches(text: string): string[] {
  try {
    return Object.keys(JSON.parse(text).pnpm?.patchedDependencies ?? {}).filter(
      (k) => k.lastIndexOf('@') <= 0
    )
  } catch {
    return []
  }
}

export async function resolveConflict(
  root: string,
  path: string
): Promise<boolean> {
  if (DELETED.includes(path)) {
    gitOk(root, ['rm', '--quiet', '--force', '--', path])
    return true
  }
  if (!isManaged(path)) return false
  const base = stage(root, 1, path)
  const ours = stage(root, 2, path)
  const theirs = stage(root, 3, path)
  if (base === null || ours === null || theirs === null) return false
  const tmp = join(root, '.git', 'aphrody-sync')
  const files = {
    ours: join(tmp, 'ours'),
    base: join(tmp, 'base'),
    theirs: join(tmp, 'theirs'),
  }
  await Bun.write(files.ours, ours)
  const versions = lockedVersions(root, [
    ...unversionedPatches(base),
    ...unversionedPatches(theirs),
  ])
  await Bun.write(files.base, rewrite(path, base, versions))
  await Bun.write(files.theirs, rewrite(path, theirs, versions))
  const merged = Bun.spawnSync(
    ['git', 'merge-file', '-p', files.ours, files.base, files.theirs],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  if (merged.exitCode !== 0) return false
  await Bun.write(join(root, path), merged.stdout)
  gitOk(root, ['add', '--', path])
  return true
}

/**
 * bun.lock from upstream's pnpm-lock.yaml at `ref`: Bun migrates a pnpm
 * lockfile when no bun.lock exists, keeping every pinned version.
 */
export function relock(root: string, ref: string) {
  for (const file of DELETED) {
    const r = git(root, ['show', `${ref}:${file}`])
    if (r.code === 0) Bun.write(join(root, file), r.out)
  }
  rmSync(join(root, 'bun.lock'), { force: true })
  const proc = Bun.spawnSync(
    [process.execPath, 'install', '--lockfile-only', '--ignore-scripts'],
    {
      cwd: root,
      env: { ...process.env, NEXT_SKIP_NATIVE_POSTINSTALL: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  for (const file of DELETED) rmSync(join(root, file), { force: true })
  if (proc.exitCode !== 0)
    throw new Error(`bun install --lockfile-only failed: ${proc.stderr}`)
}

export async function sync(opts: Options): Promise<SyncResult> {
  const { root } = opts
  if (gitOk(root, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(
      'working tree has uncommitted changes to tracked files; commit them first'
    )
  }
  const current = gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current !== opts.branch)
    throw new Error(`on branch "${current}", expected "${opts.branch}"`)
  if (opts.fetch) gitOk(root, ['fetch', '--quiet', opts.remote])

  const behind = Number(
    gitOk(root, ['rev-list', '--count', `HEAD..${opts.ref}`])
  )
  if (behind === 0) return { status: 'up-to-date', behind: 0 }

  const upstreamHead = gitOk(root, ['rev-parse', '--short', opts.ref])
  const merge = git(root, ['merge', '--no-ff', '--no-commit', opts.ref])
  const conflicted = gitOk(root, ['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .filter(Boolean)
  if (merge.code !== 0 && conflicted.length === 0) {
    git(root, ['merge', '--abort'])
    throw new Error(
      `git merge ${opts.ref} failed: ${merge.err.trim() || merge.out.trim()}`
    )
  }

  const resolved: string[] = []
  const conflicts: string[] = []
  for (const path of conflicted) {
    if (await resolveConflict(root, path)) resolved.push(path)
    else conflicts.push(path)
  }

  if (opts.dryRun || conflicts.length) {
    if (!(conflicts.length && opts.keepConflicts))
      git(root, ['merge', '--abort'])
    return opts.dryRun && !conflicts.length
      ? { status: 'dry-run', behind, conflicts }
      : { status: 'conflicts', behind, conflicts }
  }

  // Upstream may have added pnpm scripts, workspace members or the deleted files back.
  const rewritten = await bunify(root, true)
  for (const file of rewritten) {
    if (DELETED.includes(file))
      git(root, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', file])
    else gitOk(root, ['add', '--', file])
  }
  const leftover = await bunify(root, false)
  if (leftover.length) {
    git(root, ['merge', '--abort'])
    throw new Error(
      `bunify rewrite is not idempotent for: ${leftover.join(', ')}`
    )
  }
  const scope = checkScope(root)
  if (scope.length) {
    git(root, ['merge', '--abort'])
    throw new Error(`scope check failed after the merge:\n${scope.join('\n')}`)
  }
  if (opts.install) {
    relock(root, opts.ref)
    gitOk(root, ['add', '--', 'bun.lock'])
  }

  const lines = [`Merge ${opts.ref} (${upstreamHead}) into ${opts.branch}`, '']
  lines.push(`${behind} upstream commit(s).`)
  if (resolved.length)
    lines.push(`Bun-aware resolution: ${resolved.join(', ')}.`)
  if (rewritten.length) lines.push(`Re-bunified: ${rewritten.join(', ')}.`)
  const commit = git(
    root,
    ['commit', '--quiet', '-F', '-'],
    lines.join('\n') + '\n'
  )
  if (commit.code !== 0)
    throw new Error(`git commit failed: ${commit.err.trim()}`)
  const head = gitOk(root, ['rev-parse', '--short', 'HEAD'])

  let pushed = false
  if (opts.push) {
    gitOk(root, ['push', '--quiet', 'origin', opts.branch])
    pushed = true
  }
  return { status: 'merged', behind, commit: head, resolved, pushed }
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2))
  try {
    const result = await sync(opts)
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'conflicts') {
      console.error(
        `${result.conflicts.length} file(s) conflict beyond the Bun rewrite; ` +
          (opts.keepConflicts
            ? 'the merge is left in progress.'
            : 'the merge was aborted.')
      )
      process.exit(2)
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}
