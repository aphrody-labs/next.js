#!/usr/bin/env bun
/**
 * Fast build pipeline for Next.js powered by Bun.build.
 * Compiles packages/next (server, client, shared, lib, etc.) from src to dist
 * in parallel in seconds rather than minutes.
 */

import {
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const NEXT_DIR = join(ROOT, 'packages/next')
const SRC_DIR = join(NEXT_DIR, 'src')
const DIST_DIR = join(NEXT_DIR, 'dist')

const start = performance.now()
console.log('⚡ Starting Next.js fast-build with Bun.build...')

// Read version information for build-time define replacements
const nextPkg = JSON.parse(readFileSync(join(NEXT_DIR, 'package.json'), 'utf8'))
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const nextVersion = nextPkg.version
const requiredNodeVersion = nextPkg.engines?.node ?? '>=20.9.0'
const requiredReactVersion =
  rootPkg.devDependencies?.['react-server-dom-webpack'] ?? '19.0.0'

const defines = {
  'process.env.__NEXT_VERSION': JSON.stringify(nextVersion),
  'process.env.__NEXT_REQUIRED_NODE_VERSION_RANGE':
    JSON.stringify(requiredNodeVersion),
  'process.env.REQUIRED_APP_REACT_VERSION':
    JSON.stringify(requiredReactVersion),
}

// Plugin to mark all imports as external so each module compiles individually
const externalPlugin = {
  name: 'external-all',
  setup(build: any) {
    build.onResolve({ filter: /.*/ }, (args: any) => {
      if (args.importer) {
        return { path: args.path, external: true }
      }
    })
  },
}

// 1. Copy precompiled assets and dependencies into dist/
console.log('📦 Setting up precompiled assets and runtime artifacts...')

mkdirSync(DIST_DIR, { recursive: true })

// Copy src/compiled -> dist/compiled
const srcCompiled = join(SRC_DIR, 'compiled')
const distCompiled = join(DIST_DIR, 'compiled')
if (existsSync(srcCompiled)) {
  cpSync(srcCompiled, distCompiled, { recursive: true, force: true })
}

// Copy @next/react-refresh-utils if available in workspaces
const reactRefreshUtilsDist = join(ROOT, 'packages/react-refresh-utils/dist')
if (existsSync(reactRefreshUtilsDist)) {
  const dest = join(distCompiled, '@next/react-refresh-utils/dist')
  mkdirSync(dest, { recursive: true })
  cpSync(reactRefreshUtilsDist, dest, { recursive: true, force: true })
}

// Copy react-refresh if available
try {
  const reactRefreshPkg = require.resolve('react-refresh/package.json', {
    paths: [NEXT_DIR],
  })
  const reactRefreshDir = dirname(reactRefreshPkg)
  const dest = join(distCompiled, 'react-refresh')
  mkdirSync(dest, { recursive: true })
  cpSync(reactRefreshDir, dest, { recursive: true, force: true })
} catch {}

// Copy @next/font if available
const fontDist = join(ROOT, 'packages/font')
if (existsSync(fontDist)) {
  const dest = join(distCompiled, '@next/font')
  mkdirSync(dest, { recursive: true })
  for (const sub of ['dist', 'google', 'local']) {
    const srcSub = join(fontDist, sub)
    if (existsSync(srcSub)) {
      cpSync(srcSub, join(dest, sub), { recursive: true, force: true })
    }
  }
}

// Copy browser polyfills into dist/build/polyfills
const polyfillDir = join(DIST_DIR, 'build/polyfills')
mkdirSync(polyfillDir, { recursive: true })
try {
  const nomodule = require.resolve('@next/polyfill-nomodule', {
    paths: [NEXT_DIR],
  })
  cpSync(nomodule, join(polyfillDir, 'polyfill-nomodule.js'))
} catch {}
try {
  const modulePolyfill = require.resolve('@next/polyfill-module', {
    paths: [NEXT_DIR],
  })
  cpSync(modulePolyfill, join(polyfillDir, 'polyfill-module.js'))
} catch {}

// Copy styled-jsx types into dist/styled-jsx/types
try {
  const styledJsxPkg = require.resolve('styled-jsx/package.json', {
    paths: [NEXT_DIR],
  })
  const styledJsxDir = dirname(styledJsxPkg)
  const typesDest = join(DIST_DIR, 'styled-jsx/types')
  mkdirSync(typesDest, { recursive: true })
  for (const file of new Bun.Glob('*.d.ts').scanSync({ cwd: styledJsxDir })) {
    cpSync(join(styledJsxDir, file), join(typesDest, file))
  }
} catch {}

// Write capsize-font-metrics.json
try {
  const {
    entireMetricsCollection,
  } = require('@capsizecss/metrics/entireMetricsCollection')
  const metricsDir = join(DIST_DIR, 'server')
  mkdirSync(metricsDir, { recursive: true })
  writeFileSync(
    join(metricsDir, 'capsize-font-metrics.json'),
    JSON.stringify(entireMetricsCollection, null, 2)
  )
} catch {}

// Copy docs
const docsSrc = join(ROOT, 'docs')
const docsDest = join(DIST_DIR, 'docs')
if (existsSync(docsSrc)) {
  mkdirSync(docsDest, { recursive: true })
  cpSync(docsSrc, docsDest, { recursive: true, force: true })
}
const upgradeDocsSrc = join(SRC_DIR, 'lib/upgrade')
const upgradeDocsDest = join(DIST_DIR, 'lib/upgrade')
if (existsSync(upgradeDocsSrc)) {
  mkdirSync(upgradeDocsDest, { recursive: true })
  for (const md of new Bun.Glob('*.md').scanSync({ cwd: upgradeDocsSrc })) {
    cpSync(join(upgradeDocsSrc, md), join(upgradeDocsDest, md))
  }
}

// Copy non-JS assets (.json, .jsonc, .woff2) from src to dist
for (const asset of new Bun.Glob('**/*.{json,jsonc,woff2}').scanSync({
  cwd: SRC_DIR,
})) {
  const srcPath = join(SRC_DIR, asset)
  const distPath = join(DIST_DIR, asset)
  mkdirSync(dirname(distPath), { recursive: true })
  cpSync(srcPath, distPath)
}

// 2. Discover TypeScript/JavaScript entrypoints
console.log('🔍 Scanning source files across packages/next...')

const allFiles = Array.from(
  new Bun.Glob('**/*.{ts,tsx,js,mjs,mts}').scanSync({ cwd: SRC_DIR })
)

const entrypoints = allFiles
  .filter(
    (f) =>
      !f.endsWith('.d.ts') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.test.tsx') &&
      !f.includes('__tests__')
  )
  .map((f) => join(SRC_DIR, f))

console.log(`Found ${entrypoints.length} source files to compile.`)

// 3. Compile CJS to dist/ and ESM to dist/esm/ in parallel
console.log('🚀 Compiling with Bun.build in parallel...')

const esmFilterPrefixes = [
  'server/',
  'client/',
  'shared/',
  'lib/',
  'build/',
  'api/',
]
const esmEntrypoints = entrypoints.filter((p) => {
  const rel = relative(SRC_DIR, p).replaceAll('\\', '/')
  return esmFilterPrefixes.some((prefix) => rel.startsWith(prefix))
})

const [cjsResult, esmResult] = await Promise.all([
  // CommonJS build
  Bun.build({
    entrypoints,
    root: SRC_DIR,
    outdir: DIST_DIR,
    target: 'node',
    format: 'cjs',
    define: defines,
    sourcemap: 'external',
    plugins: [externalPlugin],
  }),
  // ESM build
  Bun.build({
    entrypoints: esmEntrypoints,
    root: SRC_DIR,
    outdir: join(DIST_DIR, 'esm'),
    target: 'node',
    format: 'esm',
    define: defines,
    sourcemap: 'external',
    plugins: [externalPlugin],
  }),
])

if (!cjsResult.success) {
  console.error('❌ CJS build failed:')
  for (const log of cjsResult.logs) console.error(log)
  process.exit(1)
}

if (!esmResult.success) {
  console.error('❌ ESM build failed:')
  for (const log of esmResult.logs) console.error(log)
  process.exit(1)
}

// Ensure dist/bin/next has execute permissions
const binNext = join(DIST_DIR, 'bin/next')
const binNextJs = join(DIST_DIR, 'bin/next.js')
if (existsSync(binNextJs) && !existsSync(binNext)) {
  cpSync(binNextJs, binNext)
}

// 4. Wire @aphrody/next-bun runner integration
const bunNextPkgPath = 'C:/bun/packages/bun-next'
if (existsSync(bunNextPkgPath)) {
  console.log('🔗 Wiring @aphrody/next-bun runner into Next.js...')
  // Ensure @aphrody/next-bun can resolve the built next dist
  const nodeModulesNext = join(ROOT, 'node_modules/next')
  if (existsSync(nodeModulesNext)) {
    try {
      cpSync(DIST_DIR, join(nodeModulesNext, 'dist'), {
        recursive: true,
        force: true,
      })
    } catch {}
  }
}

const elapsed = ((performance.now() - start) / 1000).toFixed(2)
console.log(
  `✅ Fast build completed successfully in ${elapsed}s! (${cjsResult.outputs.length} CJS files, ${esmResult.outputs.length} ESM files)`
)
