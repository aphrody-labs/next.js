// Bun bundler for `next build` (NEXT_BUN=1, set by `withBun()` or the
// environment): the compile step (webpack's three compilers) becomes two
// `Bun.build` passes. Everything before and after it (page data collection,
// prerendering, manifests, traces) still runs in Next.js, which only needs the
// files webpack would have written:
//
//   server/pages/**.js              CommonJS route modules required by next-server
//   static/chunks/**                browser scripts listed in build-manifest.json
//   build-manifest.json, server/pages-manifest.json, static/<buildId>/_buildManifest.js
//   and the empty manifests of features this bundler does not implement yet.
//
// Scope: Pages Router on the Node.js runtime, global CSS and CSS modules (Bun's
// CSS bundler, plus the Bun plugins given to `configureBunBuild`, e.g.
// Tailwind CSS). The App Router (Server and Client Components, route handlers)
// is compiled by app.ts. Server Actions, instrumentation, the edge runtime and
// `experimental.parallelServerCompiles` are rejected.

import { readFileSync, rmSync } from 'fs'
import { parse as parseQuery } from 'querystring'
import path from 'path'
import { NextBuildContext } from '../build-context'
import { createEntrypoints } from '../entries'
import { loadEntrypoint } from '../load-entrypoint'
import { getDefineEnv } from '../define-env'
import { loadProjectInfo } from '../webpack-config'
import { normalizePagePath } from '../../shared/lib/page-path/normalize-page-path'
import getRouteFromEntrypoint from '../../server/get-route-from-entrypoint'
import { generateClientManifest } from '../webpack/plugins/build-manifest-plugin'
import {
  createEdgeRuntimeManifest,
  srcEmptySsgManifest,
} from '../webpack/plugins/build-manifest-plugin-utils'
import { transform } from '../swc'
import { getLoaderSWCOptions } from '../swc/options'
import * as Log from '../output/log'
import { findConfig } from '../../lib/find-config'
import { getPostCssPlugins } from '../webpack/config/blocks/css/plugins'
import type { BuildTraceContext } from '../webpack/plugins/next-trace-entrypoints-plugin'
import { buildApp } from './app'
import {
  BunBuildUnsupportedError,
  SOURCE_FILE,
  contentHash,
  posix,
  write,
  type BunPlugin,
  type SwcLayer,
} from './shared'

export { BunBuildUnsupportedError }

// `Bun` exists when Next.js runs on Bun; packages/next does not depend on bun-types.
declare const Bun: any

const PAGES_DIR_ALIAS = 'private-next-pages'
const ROOT_DIR_ALIAS = 'private-next-root-dir'
const APP_DIR_ALIAS = 'private-next-app-dir'

let extraPlugins: BunPlugin[] = []

/** Bun plugins added to the server and client builds (Tailwind CSS, …). */
export function configureBunBuild(options: { plugins?: BunPlugin[] }) {
  extraPlugins = options.plugins ?? []
}

function resolveAliasIn(dirs: [string, string | undefined][]) {
  return (request: string) => {
    for (const [alias, target] of dirs) {
      if (target && (request === alias || request.startsWith(alias + '/'))) {
        return path.join(target, request.slice(alias.length))
      }
    }
    return request
  }
}

/** `loader?query!` entry requests as webpack writes them in `createEntrypoints`. */
export function parseLoaderRequest(
  request: string
): { loader: string; options: Record<string, any> } | null {
  const match = /^([^?!]+)\?(.*)!$/.exec(request)
  return match ? { loader: match[1], options: parseQuery(match[2]) } : null
}

/**
 * @param compilerNames `null` for a full build; Next.js only passes names with
 *   `experimental.parallelServerCompiles`.
 */
export async function bunBuild(
  compilerNames: string[] | null
): Promise<{ duration: number; buildTraceContext: BuildTraceContext }> {
  if (typeof Bun === 'undefined') {
    throw new Error('NEXT_BUN is set but Next.js is not running on Bun.')
  }
  if (compilerNames) {
    throw new BunBuildUnsupportedError('experimental.parallelServerCompiles')
  }
  const start = performance.now()
  const ctx = NextBuildContext as any
  const { dir, config, pagesDir, appDir, buildId } = ctx
  const distDir = path.join(dir, config.distDir)

  const hasAppRouter =
    !!ctx.mappedAppPages && Object.keys(ctx.mappedAppPages).length > 0
  if (ctx.hasInstrumentationHook) {
    throw new BunBuildUnsupportedError('instrumentation')
  }

  const entrypoints = await createEntrypoints({
    buildId,
    config,
    envFiles: ctx.loadedEnvFiles,
    isDev: false,
    rootDir: dir,
    pageExtensions: config.pageExtensions,
    pagesDir,
    appDir,
    pages: ctx.mappedPages,
    appPaths: ctx.mappedAppPages,
    previewMode: ctx.previewProps,
    rootPaths: ctx.mappedRootPaths,
    hasInstrumentationHook: ctx.hasInstrumentationHook,
  } as any)
  if (Object.keys(entrypoints.edgeServer).length > 0) {
    throw new BunBuildUnsupportedError('The edge runtime')
  }

  const resolveAlias = resolveAliasIn([
    [PAGES_DIR_ALIAS, pagesDir],
    [ROOT_DIR_ALIAS, dir],
    [APP_DIR_ALIAS, appDir],
  ])

  const projectInfo = await loadProjectInfo({ dir, config, dev: false })
  const defines = (side: 'server' | 'client') => {
    const env: Record<string, any> = getDefineEnv({
      isTurbopack: false,
      clientRouterFilters: ctx.clientRouterFilters,
      config,
      dev: false,
      distDir,
      projectPath: dir,
      fetchCacheKeyPrefix: ctx.fetchCacheKeyPrefix,
      hasRewrites: ctx.hasRewrites,
      isClient: side === 'client',
      isEdgeServer: false,
      isNodeServer: side === 'server',
      middlewareMatchers: entrypoints.middlewareMatchers,
      omitNonDeterministic: ctx.isCompileMode,
      rewrites: ctx.rewrites,
    } as any)
    // DefinePlugin accepts `undefined` values; Bun.build wants an expression string.
    for (const key in env) env[key] ??= 'undefined'
    return env
  }
  const swcState: SwcState = {
    ctx,
    dir,
    distDir,
    pagesDir,
    appDir,
    projectInfo,
  }
  const loadableIds = new Set<string>()
  const swc = (side: 'server' | 'client') =>
    nextSwcPlugin({ ...swcState, side, loadableIds })
  const postcss = await postcssPlugin(swcState)
  const cssPlugins = postcss ? [...extraPlugins, postcss] : extraPlugins

  const entriesDir = path.join(distDir, 'cache', 'bun-entries')
  rmSync(entriesDir, { recursive: true, force: true })

  // Server: one self-contained CommonJS file per page, like webpack's
  // `server/pages/*.js`. Packages stay external and are required at run time.
  const serverEntriesDir = path.join(entriesDir, 'server')
  const serverEntries: string[] = []
  const pagesManifest: Record<string, string> = {}
  for (const [name, imports] of Object.entries<any>(entrypoints.server)) {
    if (hasAppRouter && name.startsWith('app/')) continue
    const [request] = [imports].flat() as string[]
    if (!name.startsWith('pages/')) {
      throw new BunBuildUnsupportedError(`The server entry "${name}"`)
    }
    const route = parseLoaderRequest(request)
    let source: string
    if (!route) {
      source = `module.exports = require(${JSON.stringify(resolveAlias(request))});\n`
    } else if (
      route.loader === 'next-route-loader' &&
      route.options.kind === 'PAGES'
    ) {
      const { page, absolutePagePath, absoluteAppPath, absoluteDocumentPath } =
        route.options
      source = await loadEntrypoint('pages', {
        VAR_USERLAND: resolveAlias(absolutePagePath),
        VAR_MODULE_DOCUMENT: resolveAlias(absoluteDocumentPath),
        VAR_MODULE_APP: resolveAlias(absoluteAppPath),
        VAR_DEFINITION_PAGE: normalizePagePath(page),
        VAR_DEFINITION_PATHNAME: page,
      })
    } else if (
      route.loader === 'next-route-loader' &&
      route.options.kind === 'PAGES_API'
    ) {
      const { page, absolutePagePath } = route.options
      source = await loadEntrypoint('pages-api', {
        VAR_USERLAND: resolveAlias(absolutePagePath),
        VAR_DEFINITION_PAGE: normalizePagePath(page),
        VAR_DEFINITION_PATHNAME: page,
      })
    } else {
      throw new BunBuildUnsupportedError(
        `The server entry "${name}" (${request})`
      )
    }
    const file = path.join(serverEntriesDir, name + '.js')
    write(file, source)
    serverEntries.push(file)
    pagesManifest[getRouteFromEntrypoint(name)!] = name + '.js'
  }

  if (serverEntries.length > 0) {
    const server = await Bun.build({
      entrypoints: serverEntries,
      root: serverEntriesDir,
      outdir: path.join(distDir, 'server'),
      naming: '[dir]/[name].[ext]',
      target: 'node',
      format: 'cjs',
      packages: 'external',
      define: defines('server'),
      plugins: [swc('server'), ...cssPlugins],
      throw: false,
    })
    if (!server.success) {
      throw new AggregateError(server.logs, 'Bun.build: server build failed')
    }
  }

  // Client: ES modules with code splitting so React and Next's client runtime
  // are shared between pages. Next.js loads page scripts as classic scripts, so
  // every entry gets a tiny classic loader that imports the module.
  const clientEntriesDir = path.join(entriesDir, 'client')
  const clientEntries: string[] = []
  const mainEntry = path.join(clientEntriesDir, 'main.js')
  write(
    mainEntry,
    `const client = require("next/dist/client/index.js");
self.__next_set_public_path__ = () => {};
window.next = {
  version: client.version,
  get router() {
    return client.router;
  },
  emitter: client.emitter,
};
client.initialize({}).then(() => client.hydrate()).catch(console.error);
`
  )
  clientEntries.push(mainEntry)
  for (const [name, imports] of Object.entries<any>(entrypoints.client)) {
    // Pages-style fallbacks of the App Router (`app/_not-found/page`, …): webpack
    // builds them but no manifest references them.
    if (hasAppRouter && name.startsWith('app/')) continue
    const [request, ...extra] = [imports].flat() as string[]
    const route = parseLoaderRequest(request)
    if (route?.loader !== 'next-client-pages-loader') {
      throw new BunBuildUnsupportedError(`The client entry "${name}"`)
    }
    const file = path.join(clientEntriesDir, name + '.js')
    write(
      file,
      [
        ...extra.map((e) => `import ${JSON.stringify(e)};`),
        `import * as page from ${JSON.stringify(resolveAlias(route.options.absolutePagePath))};`,
        `(window.__NEXT_P = window.__NEXT_P || []).push([${JSON.stringify(route.options.page)}, () => page]);`,
        '',
      ].join('\n')
    )
    clientEntries.push(file)
  }

  const chunksDir = path.join(distDir, 'static', 'chunks')
  const client = await Bun.build({
    entrypoints: clientEntries,
    root: clientEntriesDir,
    outdir: chunksDir,
    naming: {
      entry: '_bun/[dir]/[name]-[hash].[ext]',
      chunk: '_bun/chunks/chunk-[hash].[ext]',
      asset: '../media/[name]-[hash].[ext]',
    },
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !ctx.noMangling,
    define: defines('client'),
    plugins: [swc('client'), ...cssPlugins],
    metafile: true,
    throw: false,
  })
  if (!client.success) {
    throw new AggregateError(client.logs, 'Bun.build: client build failed')
  }

  // The stylesheet Bun bundled for each entry, keyed by output path relative to chunksDir.
  const cssBundles = new Map<string, string>()
  for (const [output, meta] of Object.entries<any>(client.metafile.outputs)) {
    if (meta.cssBundle) {
      cssBundles.set(
        posix(path.normalize(output)),
        posix(path.normalize(meta.cssBundle))
      )
    }
  }
  const clientFiles = new Map<string, string>()
  const clientCss = new Map<string, string>()
  for (const output of client.outputs) {
    if (output.kind !== 'entry-point') continue
    const relative = posix(path.relative(chunksDir, output.path))
    const name = /^_bun\/(.+)-[^-/]+\.js$/.exec(relative)?.[1]
    if (!name)
      throw new Error(`Bun.build: unexpected client output ${relative}`)
    // `process` is provided to browser code the way webpack's ProvidePlugin does.
    const loader = `self.process||(self.process={env:{}});import(${JSON.stringify(
      './' + path.posix.relative(path.posix.dirname(name), relative)
    )});\n`
    const file = `static/chunks/${name}-${contentHash(loader)}.js`
    write(path.join(distDir, file), loader)
    clientFiles.set(name, file)
    const css = cssBundles.get(relative)
    if (css) clientCss.set(name, `static/chunks/${css}`)
  }

  const polyfills = readFileSync(
    require.resolve('../polyfills/polyfill-nomodule')
  )
  const polyfillFile = `static/chunks/polyfills-${contentHash(polyfills)}.js`
  write(path.join(distDir, polyfillFile), polyfills)

  const app = hasAppRouter
    ? await buildApp({
        ctx,
        dir,
        distDir,
        pagesDir,
        appDir,
        entrypoints,
        defines,
        entriesDir,
        chunksDir,
        loaderOptions: parseLoaderRequest,
        plugins: cssPlugins,
        minify: !ctx.noMangling,
        swcCode: (filename, source, layer) =>
          swcCode(swcState, filename, source, layer),
      })
    : null

  // Same shape and helpers as webpack's BuildManifestPlugin.
  const mainFile = clientFiles.get('main')!
  const assetMap: any = {
    polyfillFiles: [polyfillFile],
    devFiles: [],
    lowPriorityFiles: [],
    rootMainFiles: app ? app.rootMainFiles : [],
    rootMainFilesTree: {},
    pages: { '/_app': [] },
  }
  for (const [name, file] of clientFiles) {
    if (name === 'main') continue
    const css = clientCss.get(name)
    assetMap.pages[getRouteFromEntrypoint(name)!] = css
      ? [mainFile, file, css]
      : [mainFile, file]
  }
  const buildManifestPath = `static/${buildId}/_buildManifest.js`
  const ssgManifestPath = `static/${buildId}/_ssgManifest.js`
  assetMap.lowPriorityFiles.push(buildManifestPath, ssgManifestPath)
  assetMap.pages = Object.fromEntries(
    Object.entries(assetMap.pages).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  )

  // Bundled ESM chunks cannot be listed as classic preload scripts: `files` stays empty.
  const loadableManifest = JSON.stringify(
    Object.fromEntries(
      [...loadableIds].sort().map((id) => [id, { id, files: [] }])
    )
  )
  const fontManifest = JSON.stringify({
    pages: {},
    app: {},
    appUsingSizeAdjust: false,
    pagesUsingSizeAdjust: false,
  })
  const files: Record<string, string> = {
    'build-manifest.json': JSON.stringify(assetMap, null, 2),
    'server/middleware-build-manifest.js': createEdgeRuntimeManifest(assetMap),
    [buildManifestPath]: `self.__BUILD_MANIFEST = ${generateClientManifest(
      assetMap,
      ctx.rewrites,
      ctx.clientRouterFilters
    )};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()`,
    [ssgManifestPath]: srcEmptySsgManifest,
    'server/pages-manifest.json': JSON.stringify(pagesManifest, null, 2),
    'react-loadable-manifest.json': loadableManifest,
    'server/middleware-react-loadable-manifest.js': `self.__REACT_LOADABLE_MANIFEST=${JSON.stringify(loadableManifest)};`,
    'dynamic-css-manifest.json': '[]',
    'server/dynamic-css-manifest.js': `self.__DYNAMIC_CSS_MANIFEST="[]";`,
    'server/next-font-manifest.json': fontManifest,
    'server/next-font-manifest.js': `self.__NEXT_FONT_MANIFEST=${JSON.stringify(fontManifest)};`,
    'server/middleware-manifest.json': JSON.stringify(
      { version: 3, middleware: {}, functions: {}, sortedMiddleware: [] },
      null,
      2
    ),
    'server/interception-route-rewrite-manifest.js': `self.__INTERCEPTION_ROUTE_REWRITE_MANIFEST="[]";`,
    ...app?.files,
  }
  for (const [file, contents] of Object.entries(files)) {
    write(path.join(distDir, file), contents)
  }

  const duration = (performance.now() - start) / 1000
  Log.event(`Compiled successfully with Bun in ${duration.toFixed(1)}s`)
  return { duration, buildTraceContext: {} }
}

type SwcState = {
  ctx: any
  dir: string
  distDir: string
  pagesDir: string | undefined
  appDir: string | undefined
  projectInfo: any
}

/**
 * Next.js' SWC transform of one module, with the options next-swc-loader gives
 * it in the webpack layer `layer.bundleLayer`.
 */
async function swcCode(
  state: SwcState,
  filename: string,
  source: string,
  layer: SwcLayer
): Promise<string> {
  const { ctx, dir, distDir, pagesDir, appDir, projectInfo } = state
  const { config } = ctx
  const options = getLoaderSWCOptions({
    filename,
    development: !!config.experimental.allowDevelopmentBuild,
    isServer: layer.isServer,
    pagesDir,
    appDir,
    isPageFile: !!layer.isPageFile,
    isCacheComponents: config.cacheComponents,
    hasReactRefresh: false,
    modularizeImports: config.modularizeImports,
    optimizePackageImports: config.experimental.optimizePackageImports,
    swcPlugins: config.experimental.swcPlugins,
    compilerOptions: config.compiler,
    optimizeServerReact: config.experimental.optimizeServerReact,
    jsConfig: projectInfo.jsConfig,
    supportedBrowsers: projectInfo.supportedBrowsers,
    swcCacheDir: path.join(distDir, 'cache', 'swc'),
    relativeFilePathFromRoot: path.relative(dir, filename),
    serverComponents: layer.serverComponents,
    serverReferenceHashSalt: ctx.encryptionKey,
    bundleLayer: layer.bundleLayer,
    esm: true,
    cacheHandlers: config.cacheHandlers,
    useCacheEnabled: config.experimental.useCache,
  } as any)
  const output = await transform(source, {
    ...options,
    filename,
    sourceMaps: false,
  })
  return output.code
}

/**
 * The project's PostCSS configuration (`postcss.config.*`), loaded the way
 * webpack's CSS rules load it, as a Bun plugin; null without one, where Bun's
 * CSS bundler alone stands in for Next's default plugins.
 */
async function postcssPlugin(state: SwcState): Promise<BunPlugin | null> {
  const { ctx, dir, projectInfo } = state
  if (!(await findConfig(dir, 'postcss'))) return null
  const { config } = ctx
  const plugins = await getPostCssPlugins(
    dir,
    projectInfo.supportedBrowsers,
    !!config.experimental.disablePostcssPresetEnv,
    !!config.experimental.useLightningcss
  )
  const postcss = require('postcss') as typeof import('postcss')
  const processor = ((postcss as any).default ?? postcss)(plugins)
  return {
    name: 'next-postcss',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args: { path: string }) => {
        const result = await processor.process(
          readFileSync(args.path, 'utf8'),
          { from: args.path, map: false }
        )
        return { contents: result.css, loader: 'css' }
      })
    },
  }
}

const STRING = String.raw`"(?:[^"\x5c]|\x5c.)*"`
const LOADABLE_GENERATED = /\bloadableGenerated:/g
// Browser: `webpack: () => [require.resolveWeak("./x")]` (function or arrow form).
const LOADABLE_WEBPACK =
  /loadableGenerated:\s*\{\s*webpack:\s*(?:function\s*\(\)\s*\{\s*return\s*\[([^\]]*)\];?\s*\}|\(\)\s*=>\s*\[([^\]]*)\])\s*\}/g
const RESOLVE_WEAK = new RegExp(
  String.raw`require\.resolveWeak\(\s*(${STRING})\s*\)`,
  'g'
)
// Server: `modules: ["pages/x.js -> " + "./x"]`.
const LOADABLE_MODULES =
  /loadableGenerated:\s*\{\s*modules:\s*\[([^\]]*)\]\s*\}/g
const MODULE_REQUEST = new RegExp(String.raw`${STRING}\s*\+\s*(${STRING})`, 'g')

/**
 * Gives every next/dynamic call the same module ids on both sides (the imported
 * file relative to the project) in place of webpack's `require.resolveWeak`
 * ids, so the server's `dynamicIds` match the browser's ready initializers.
 */
function loadableModules(
  code: string,
  {
    file,
    dir,
    isServer,
    loadableIds,
  }: { file: string; dir: string; isServer: boolean; loadableIds: Set<string> }
) {
  const expected = code.match(LOADABLE_GENERATED)?.length ?? 0
  if (expected === 0) return code
  let replaced = 0
  const ids = (list: string, pattern: RegExp) =>
    [...list.matchAll(pattern)].map(([, literal]) => {
      const request: string = JSON.parse(literal)
      let resolved: string
      try {
        resolved = Bun.resolveSync(request, path.dirname(file))
      } catch {
        throw new BunBuildUnsupportedError(
          `next/dynamic of "${request}" in ${file} (unresolved)`
        )
      }
      const id = posix(path.relative(dir, resolved))
      loadableIds.add(id)
      return id
    })
  const rewrite = (list: string, pattern: RegExp) => {
    replaced++
    return `loadableGenerated: { modules: ${JSON.stringify(ids(list, pattern))} }`
  }
  code = isServer
    ? code.replace(LOADABLE_MODULES, (_, list: string) =>
        rewrite(list, MODULE_REQUEST)
      )
    : code.replace(LOADABLE_WEBPACK, (_, fn?: string, arrow?: string) =>
        rewrite((fn ?? arrow)!, RESOLVE_WEAK)
      )
  if (replaced !== expected)
    throw new BunBuildUnsupportedError(`This next/dynamic call shape (${file})`)
  return code
}

/** Runs Next.js' SWC transforms (SSG stripping, styled-jsx, next/dynamic, …) on project sources. */
function nextSwcPlugin({
  side,
  loadableIds,
  ...state
}: SwcState & {
  side: 'server' | 'client'
  loadableIds: Set<string>
}): BunPlugin {
  const { distDir, pagesDir } = state
  const isServer = side === 'server'
  const generated = path.join(distDir, 'cache', 'bun-entries') + path.sep

  return {
    name: 'next-swc',
    setup(build) {
      // The server only needs the class names of CSS modules; global stylesheets
      // are bundled by the client build alone.
      if (isServer) {
        build.onLoad({ filter: /\.css$/ }, (args: { path: string }) => {
          if (!args.path.endsWith('.module.css')) {
            return { contents: '', loader: 'js' }
          }
        })
      }
      build.onLoad({ filter: SOURCE_FILE }, async (args: { path: string }) => {
        if (
          args.path.includes(`${path.sep}node_modules${path.sep}`) ||
          args.path.startsWith(generated) ||
          args.path.endsWith('.d.ts')
        ) {
          return
        }
        const isPageFile =
          !!pagesDir && args.path.startsWith(pagesDir + path.sep)
        const isApiRoute =
          isPageFile &&
          args.path.startsWith(path.join(pagesDir!, 'api') + path.sep)
        const source = readFileSync(args.path, 'utf8')
        const code = await swcCode(state, args.path, source, {
          isServer,
          isPageFile,
          serverComponents: false,
          bundleLayer: isServer
            ? isApiRoute
              ? 'api-node'
              : 'pages-dir-node'
            : 'pages-dir-browser',
        })
        return {
          contents: loadableModules(code, {
            file: args.path,
            dir: state.dir,
            isServer,
            loadableIds,
          }),
          loader: 'js',
        }
      })
    },
  }
}
