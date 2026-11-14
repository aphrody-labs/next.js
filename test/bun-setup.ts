// Preload for `bun test` (wired in bunfig.toml [test]). Replaces jest.config.js:
// global setup, the `// @gate` pragma rewrite (jest transformer before), and
// the after-env setup file.
import { plugin } from 'bun'
import * as bunTest from 'bun:test'
import globalSetup from './jest-global-setup'

globalSetup()

// Bun exposes the test API as module exports; the gate runtime wraps globals.
for (const key of [
  'it',
  'test',
  'describe',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'expect',
  'jest',
] as const) {
  if (!(key in globalThis)) (globalThis as any)[key] = (bunTest as any)[key]
}

const { rewrite } = require('./lib/gate/pragma-transform')
const LOADERS: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = {
  js: 'js',
  mjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  tsx: 'tsx',
}

plugin({
  name: 'next-gate-pragma',
  setup(build) {
    build.onLoad({ filter: /\.test\.(js|jsx|ts|tsx|mjs)$/ }, async (args) => {
      const src = await Bun.file(args.path).text()
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1)
      return { contents: rewrite(src, args.path), loader: LOADERS[ext] }
    })
  },
})

await import('./jest-setup-after-env')

// Jest APIs missing from Bun's `jest` compat object.
const j = (globalThis as any).jest
if (j && typeof j.mocked !== 'function') j.mocked = (value: unknown) => value
if (j && typeof j.replaceProperty !== 'function') {
  const replaced: Array<() => void> = []
  j.replaceProperty = (obj: any, key: string, value: unknown) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key)
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    Object.defineProperty(obj, key, {
      configurable: true,
      writable: true,
      enumerable: true,
      value,
    })
    const restore = () => {
      if (had && desc) Object.defineProperty(obj, key, desc)
      else delete obj[key]
    }
    replaced.push(restore)
    return { restore, replaceValue: (v: unknown) => (obj[key] = v) }
  }
  const origRestore = j.restoreAllMocks?.bind(j)
  j.restoreAllMocks = (...a: unknown[]) => {
    while (replaced.length) replaced.pop()!()
    return origRestore?.(...a)
  }
}
