// Runs the Jest unit tests of packages/next/src that pass under `bun test`.
//
//   bun scripts/aphrody/test-unit-bun.ts [bun test args...]
//   bun scripts/aphrody/test-unit-bun.ts --check    verify the list only
//
// The list (scripts/aphrody/bun-unit-tests.txt) holds the files checked one
// by one with `bun test <file>`; the others still run with Jest
// (`bun run test-unit`). `--isolate` gives each file a fresh global object:
// some files set process.env.NODE_ENV or mock modules for the next ones.
// A listed file that no longer exists fails the run instead of being skipped.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
export const LIST = join(import.meta.dir, 'bun-unit-tests.txt')

export function readList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export function problems(root: string, files: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file)) out.push(`${file}: listed twice`)
    seen.add(file)
    if (!/\.test\.tsx?$/.test(file)) out.push(`${file}: not a test file`)
    if (!existsSync(join(root, file))) out.push(`${file}: missing`)
  }
  return out
}

if (import.meta.main) {
  const files = readList(await Bun.file(LIST).text())
  const errors = problems(ROOT, files)
  for (const e of errors) console.error(e)
  if (errors.length) {
    console.error(`fix ${LIST}`)
    process.exit(1)
  }
  const args = process.argv.slice(2)
  if (args.includes('--check')) {
    console.log(`${files.length} files`)
    process.exit(0)
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      'test',
      '--isolate',
      ...args,
      ...files.map((f) => `./${f}`),
    ],
    {
      cwd: ROOT,
      stdio: ['inherit', 'inherit', 'inherit'],
    }
  )
  process.exit(await proc.exited)
}
