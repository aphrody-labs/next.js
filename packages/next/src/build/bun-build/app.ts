// App Router compile step of the Bun bundler: three Bun.build passes in place
// of webpack's app layers.
//
//   rsc      server/app/**.js        route modules (CommonJS, "react-server" condition);
//                                    every "use client" module becomes a client reference
//   ssr      server/bun-app-ssr.js   the client modules for server rendering, required by
//                                    id through `__webpack_require__`
//   actions  server/bun-app-actions.js  every Server Action module ("rsc" layer), exported
//                                    by action id; the module id of every page's worker
//   browser  static/chunks/**        main-app plus one entry per client module, which React
//                                    loads through `__webpack_chunk_load__`
//
// and the manifests next-server reads: server/app/*_client-reference-manifest.js,
// server/app-paths-manifest.json and server/server-reference-manifest.{js,json}.
//
// Not supported yet (rejected with an error): "use cache", cacheComponents,
// metadata files (icon, opengraph-image, sitemap, …).
//
// Kept in step with packages/bun-next/lib/build-app.js of aphrody-labs/bun.

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import JSON5 from 'next/dist/compiled/json5'
import nextAppLoader from '../webpack/loaders/next-app-loader'
import { getRSCModuleInformation } from '../analysis/get-page-static-info'
import * as aliases from '../create-compiler-aliases'
import { NEXT_PROJECT_ROOT, NEXT_PROJECT_ROOT_DIST } from '../next-dir-paths'
import { needsExperimentalReact } from '../../lib/needs-experimental-react'
import {
  BunBuildUnsupportedError,
  SOURCE_FILE,
  contentHash,
  posix,
  write,
  type BunPlugin,
  type SwcLayer,
} from './shared'

declare const Bun: any

// next-swc-loader only transforms node_modules files that match this.
const FORCE_TRANSPILE =
  /next\/font|next\/dynamic|use server|use client|use cache/
const NODE_MODULES = /[/\\]node_modules[/\\]/
const EMPTY_NAMESPACE = 'next-bun-empty'
const SSR_RUNTIME = 'bun-app-ssr.js'
const ACTIONS_RUNTIME = 'bun-app-actions.js'
const ACTIONS_MODULE_ID = 'bun-app-actions'
const EXTERNAL_FILE = /next[/\\]dist(?:[/\\]esm)?[/\\].*\.external(?:\.js)?$/
const ESM_DIST = /([/\\]next[/\\]dist)[/\\]esm([/\\])/
const DECLARATION =
  /^const \w+ = \(\) => import\(\/\* webpackMode: "eager" \*\/ ("(?:[^"\\]|\\.)*")\);$/gm
const NOT_EXTERNAL =
  /^(?:private-next-pages\/|next\/(?:dist\/pages\/|(?:app|cache|document|link|form|head|image|legacy\/image|constants|dynamic|script|navigation|headers|router|compat\/router|server)$)|string-hash|private-next-rsc-action-validate|private-next-rsc-action-client-wrapper|private-next-rsc-server-reference|private-next-rsc-cache-wrapper|private-next-rsc-track-dynamic-import$)/
const LAYERS: Record<'rsc' | 'ssr' | 'browser', SwcLayer> = {
  rsc: { isServer: true, serverComponents: true, bundleLayer: 'rsc' },
  ssr: { isServer: true, serverComponents: true, bundleLayer: 'ssr' },
  browser: {
    isServer: false,
    serverComponents: true,
    bundleLayer: 'app-pages-browser',
  },
}

type Layer = keyof typeof LAYERS
type ClientModule = { key: string; id: string }
type Alias = string | false | (string | false)[]

export type AppBuildState = {
  ctx: any
  dir: string
  distDir: string
  pagesDir: string | undefined
  appDir: string | undefined
  entrypoints: { server: Record<string, any> }
  defines: (side: 'server' | 'client') => Record<string, string>
  entriesDir: string
  chunksDir: string
  loaderOptions: (
    request: string
  ) => { loader: string; options: Record<string, any> } | null
  plugins: BunPlugin[]
  minify: boolean
  swcCode: (
    filename: string,
    source: string,
    layer: SwcLayer
  ) => Promise<string>
}

/** The `this` of a webpack loader, as much of it as next-app-loader reads. */
function loaderContext(options: Record<string, any>) {
  return {
    getOptions: () => options,
    _module: { buildInfo: {} },
    _compilation: undefined,
    _compiler: undefined,
    addDependency() {},
    addMissingDependency() {},
    addContextDependency() {},
  }
}

function packageName(request: string) {
  const parts = request.split('/')
  return request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** webpack `resolve.alias` semantics: `key$` matches exactly, `key` also matches `key/…`. */
function aliasTable(nextRoot: string, maps: Record<string, any>[]) {
  const exact = new Map<string, Alias>()
  const prefixes: [string, Alias][] = []
  const add = (key: string, value: Alias) => {
    if (key.endsWith('$')) {
      const name = key.slice(0, -1)
      if (!exact.has(name)) exact.set(name, value)
    } else if (!prefixes.some(([k]) => k === key)) {
      prefixes.push([key, value])
    }
  }
  for (const map of maps) {
    for (const [key, value] of Object.entries(map ?? {})) {
      add(key, value)
      // webpack matches `<next>/link.js` once `next/link` resolved to it.
      const file = key.replace(/\$$/, '')
      if (path.isAbsolute(file)) {
        const relative = path.relative(nextRoot, file).replaceAll('\\', '/')
        if (!relative.startsWith('..')) {
          add(`next/${relative}$`, value)
          add(`next/${relative.replace(/\.js$/, '')}$`, value)
        }
      }
    }
  }
  return (request: string): Alias | undefined => {
    if (exact.has(request)) return exact.get(request)
    for (const [key, value] of prefixes) {
      if (request === key) return value
      if (request.startsWith(key + '/') && typeof value === 'string') {
        return value + request.slice(key.length)
      }
    }
    return undefined
  }
}

function resolveFrom(request: string, dirs: string[]): string {
  let error: unknown
  for (const dir of dirs) {
    try {
      return Bun.resolveSync(request, dir)
    } catch (e) {
      error = e
    }
  }
  throw error
}

export async function buildApp(
  state: AppBuildState
): Promise<{ rootMainFiles: string[]; files: Record<string, string> }> {
  const { ctx, dir, distDir, pagesDir, appDir, entrypoints, defines } = state
  const { entriesDir, chunksDir, loaderOptions, plugins, minify, swcCode } =
    state
  const { config } = ctx
  if (config.cacheComponents) {
    throw new BunBuildUnsupportedError('cacheComponents')
  }
  const nextDist = NEXT_PROJECT_ROOT_DIST

  const generated = entriesDir + path.sep
  const relativeToDir = (file: string) => posix(path.relative(dir, file))
  // Server Action modules by file: their `{ [id]: exportedName }` and the layers importing them.
  const actionModules = new Map<
    string,
    { file: string; ids: Record<string, string>; fromServer: boolean }
  >()
  const collectActions = (
    file: string,
    code: string,
    info: { actionIds?: Record<string, string | { name: string }> },
    layer: Layer
  ) => {
    if (!info.actionIds || Object.keys(info.actionIds).length === 0) return
    if (code.includes('private-next-rsc-cache-wrapper')) {
      throw new BunBuildUnsupportedError(`"use cache" (${relativeToDir(file)})`)
    }
    let mod = actionModules.get(file)
    if (!mod) {
      // Newer releases map an id to `{ name, loc }`, older ones to the export name.
      const ids = Object.fromEntries(
        Object.entries(info.actionIds).map(([id, action]) => [
          id,
          typeof action === 'object' ? action.name : action,
        ])
      )
      mod = { file, ids, fromServer: false }
      actionModules.set(file, mod)
    }
    if (layer === 'rsc') mod.fromServer = true
  }

  // Route entries: next-app-loader's code, as webpack would compile it.
  const rscEntriesDir = path.join(entriesDir, 'rsc')
  const routes: {
    name: string
    page: string
    file: string
    segments: string[]
  }[] = []
  for (const [name, entry] of Object.entries(entrypoints.server)) {
    if (!name.startsWith('app/')) continue
    const request = [
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry.import
        : entry,
    ].flat()[0] as string
    const route = loaderOptions(request)
    if (route?.loader !== 'next-app-loader') {
      throw new BunBuildUnsupportedError(
        `The server entry "${name}" (${request})`
      )
    }
    const code: string = await (nextAppLoader as any).call(
      loaderContext(route.options)
    )
    if (/next-metadata-(?:image|route)-loader/.test(code)) {
      throw new BunBuildUnsupportedError(
        `Metadata files (icon, opengraph-image, sitemap, …) in "${name}"`
      )
    }
    const isPage = !name.endsWith('/route')
    let runtime = path.posix.relative(path.posix.dirname(name), SSR_RUNTIME)
    if (!runtime.startsWith('.')) runtime = './' + runtime
    // The template reads client modules through `__webpack_require__`.
    const header = isPage
      ? `import { __next_bun_require as __webpack_require__ } from ${JSON.stringify(runtime)};\n`
      : ''
    const file = path.join(rscEntriesDir, name + '.js')
    write(file, header + code)
    const segments = [...code.matchAll(DECLARATION)]
      .map((m) => JSON.parse(m[1]) as string)
      .filter((p) => path.isAbsolute(p))
    routes.push({ name, page: route.options.page, file, segments })
  }

  // Resolution shared by the three passes: webpack's per-layer aliases, the
  // server externals of handle-externals.ts, and one copy of next/dist (CJS).
  const channel = needsExperimentalReact(config) ? '-experimental' : ''
  const webpackAliases = (isClient: boolean) =>
    aliases.createWebpackAliases({
      distDir,
      isClient,
      isEdgeServer: false,
      dev: false,
      config,
      pagesDir,
      appDir,
      dir,
      reactProductionProfiling: false,
    })
  const vendored = (layer: string, isBrowser: boolean) =>
    aliases.createVendoredReactAliases(channel as any, {
      layer: layer as any,
      isBrowser,
      isEdgeServer: false,
      reactProductionProfiling: false,
    })
  const aliasOf: Record<Layer, (request: string) => Alias | undefined> = {
    rsc: aliasTable(NEXT_PROJECT_ROOT, [
      vendored('rsc', false),
      aliases.createAppRouterApiAliases(true),
      aliases.createNextApiEsmAliases(),
      aliases.createServerOnlyClientOnlyAliases(true),
      webpackAliases(false),
    ]),
    ssr: aliasTable(NEXT_PROJECT_ROOT, [
      vendored('ssr', false),
      aliases.createAppRouterApiAliases(false),
      aliases.createNextApiEsmAliases(),
      aliases.createServerOnlyClientOnlyAliases(false),
      webpackAliases(false),
    ]),
    browser: aliasTable(NEXT_PROJECT_ROOT, [
      vendored('app-pages-browser', true),
      aliases.createAppRouterApiAliases(false),
      aliases.createNextApiEsmAliases(),
      aliases.createServerOnlyClientOnlyAliases(false),
      webpackAliases(true),
    ]),
  }

  const transpiled = new Set<string>(config.transpilePackages ?? [])
  const optOut = new Set<string>(
    (
      JSON5.parse(
        readFileSync(
          path.join(nextDist, 'lib', 'server-external-packages.jsonc'),
          'utf8'
        )
      ) as string[]
    )
      .concat(config.serverExternalPackages ?? [])
      .filter((name) => !transpiled.has(name))
  )
  const nextExternal = (file: string) =>
    file
      .replace(/^.*?next[/\\]dist/, 'next/dist')
      .replaceAll('\\', '/')
      .replace(/^next\/dist\/esm\//, 'next/dist/')
  /** handle-externals.ts for the app layers: the external request, or undefined to bundle. */
  const serverExternal = (
    request: string,
    importer: string | undefined
  ): string | undefined => {
    if (request === 'next') return 'next/dist/lib/import-next-warning'
    const isLocal = request.startsWith('.') || path.isAbsolute(request)
    if (!isLocal) {
      if (request === 'bun' || request.startsWith('bun:')) return request
      if (NOT_EXTERNAL.test(request)) return undefined
    }
    if (request.includes('@swc/helpers')) return undefined
    if (request.startsWith('next/dist/')) {
      if (request.startsWith('next/dist/shared/lib/image-loader')) {
        return undefined
      }
      if (request.startsWith('next/dist/compiled/next-server')) return request
      if (
        /^next\/dist\/(?:esm\/)?shared\/(?!lib\/router\/router)/.test(request)
      )
        return nextExternal(request)
      if (/^next\/dist\/compiled\/.*\.[cm]?js$/.test(request)) return request
      if (EXTERNAL_FILE.test(request)) return nextExternal(request)
      return undefined
    }
    if (isLocal) {
      if (!/\.external(?:\.js)?$/.test(request) || !importer) return undefined
      const file = path.resolve(path.dirname(importer), request)
      return EXTERNAL_FILE.test(file) ? nextExternal(file) : undefined
    }
    return optOut.has(packageName(request)) ? request : undefined
  }

  const resolver = (layer: Layer): BunPlugin => ({
    name: `next-app-resolve-${layer}`,
    setup(build) {
      const alias = aliasOf[layer]
      const isServer = layer !== 'browser'
      const resolveAliased = (
        request: string,
        dirs: string[],
        depth = 0
      ): { path: string; namespace?: string } | undefined => {
        const target = alias(request)
        if (target === undefined) return undefined
        for (const candidate of [target].flat()) {
          if (candidate === false) {
            return { path: request, namespace: EMPTY_NAMESPACE }
          }
          if (
            depth < 8 &&
            alias(candidate) !== undefined &&
            candidate !== request
          ) {
            const again = resolveAliased(candidate, dirs, depth + 1)
            if (again) return again
            continue
          }
          try {
            return { path: resolveFrom(candidate, dirs) }
          } catch {}
        }
        throw new Error(
          `Bun.build: cannot resolve "${request}" (aliased to ${JSON.stringify(target)})`
        )
      }

      build.onLoad({ filter: /.*/, namespace: EMPTY_NAMESPACE }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }))
      build.onResolve(
        { filter: /.*/ },
        (args: { path: string; importer?: string }) => {
          const request = args.path
          if (/^next-[\w-]+-loader\?/.test(request)) {
            throw new BunBuildUnsupportedError(
              `The webpack loader request "${request}"`
            )
          }
          if (
            isServer &&
            request.startsWith('.') &&
            [SSR_RUNTIME, ACTIONS_RUNTIME].includes(
              path.posix.basename(request)
            )
          ) {
            return { path: request, external: true }
          }
          const importer = args.importer || undefined
          const dirs = importer ? [dir, path.dirname(importer)] : [dir]
          if (isServer) {
            const external = serverExternal(request, importer)
            if (external) return { path: external, external: true }
          }
          let target = request
          // webpack's NormalModuleReplacementPlugin for the app layers of the server.
          if (isServer && /\.\/(.+)\.shared-runtime$/.test(request)) {
            target = `next/dist/server/route-modules/app-page/vendored/contexts/${path.posix.basename(request, '.shared-runtime')}`
          }
          const aliased = resolveAliased(target, dirs)
          if (aliased) return aliased
          if (target !== request) return { path: resolveFrom(target, dirs) }
          if (request.startsWith('next/dist/esm/')) {
            return { path: resolveFrom('next/dist/' + request.slice(14), dirs) }
          }
          if (importer && ESM_DIST.test(importer) && request.startsWith('.')) {
            const file = resolveFrom(request, [path.dirname(importer)])
            const cjs = file.replace(ESM_DIST, '$1$2')
            return { path: existsSync(cjs) ? cjs : file }
          }
          return undefined
        }
      )
    },
  })

  /** next-swc-loader for `layer`; the rsc layer also turns client boundaries into references. */
  const clientModules = new Map<string, ClientModule>()
  const swcLayer = (layer: Layer, collect = true): BunPlugin => ({
    name: `next-app-swc-${layer}`,
    setup(build) {
      if (layer !== 'browser') {
        // Stylesheets reach the page through the browser build; the server only
        // needs the class names of CSS modules.
        build.onLoad({ filter: /\.css$/ }, (args: { path: string }) => {
          if (!args.path.endsWith('.module.css')) {
            return { contents: '', loader: 'js' }
          }
        })
      }
      build.onLoad({ filter: SOURCE_FILE }, async (args: { path: string }) => {
        if (args.path.endsWith('.d.ts') || args.path.startsWith(generated)) {
          return
        }
        const source = readFileSync(args.path, 'utf8')
        if (NODE_MODULES.test(args.path) && !FORCE_TRANSPILE.test(source)) {
          return
        }
        const code = await swcCode(args.path, source, LAYERS[layer])
        const info = getRSCModuleInformation(code, layer === 'rsc')
        if (collect) collectActions(args.path, code, info, layer)
        if (layer !== 'rsc' || info.type !== 'client') {
          return { contents: code, loader: 'js' }
        }
        let mod = clientModules.get(args.path)
        if (!mod) {
          mod = { key: args.path, id: contentHash(relativeToDir(args.path)) }
          clientModules.set(args.path, mod)
        }
        return { contents: clientReference(mod, info), loader: 'js' }
      })
    },
  })

  /** next-flight-loader's proxy for a client module, also registered for `rsc:<id>` lookups. */
  const moduleProxy = JSON.stringify(
    path.join(
      nextDist,
      'build',
      'webpack',
      'loaders',
      'next-flight-loader',
      'module-proxy.js'
    )
  )
  const clientReference = (
    mod: ClientModule,
    info: { clientRefs?: string[]; clientEntryType?: string }
  ) => {
    const key = JSON.stringify(mod.key)
    const register = `(globalThis.__next_bun_rsc || (globalThis.__next_bun_rsc = new Map())).set(${JSON.stringify(mod.id)}, `
    const refs = info.clientRefs ?? []
    let isModule: boolean
    if (mod.key.endsWith('.mjs')) isModule = true
    else if (
      mod.key.endsWith('.cjs') ||
      info.clientEntryType === 'cjs' ||
      refs.length === 0
    ) {
      isModule = false
    } else if (refs.includes('*')) {
      throw new BunBuildUnsupportedError(
        `"export *" in a client boundary (${relativeToDir(mod.key)})`
      )
    } else isModule = true
    if (!isModule) {
      // React's module proxy reports Promise.prototype as its prototype, which the
      // namespace object of `import()` (`__toESM`) inherits: it would be a thenable.
      return `const { createProxy } = require(${moduleProxy});\nmodule.exports = new Proxy(createProxy(${key}), { getPrototypeOf: () => Object.prototype });\n${register}module.exports);\n`
    }
    const lines = [
      `import { registerClientReference } from "react-server-dom-webpack/server";`,
      `const __exports = { __esModule: true };`,
      `function __reference(name) {`,
      `  return registerClientReference(function () {`,
      `    throw new Error("Attempted to call " + name + " of " + ${key} + " from the server, but it's on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");`,
      `  }, ${key}, name);`,
      `}`,
    ]
    for (const ref of refs) {
      if (ref === 'default') {
        lines.push(
          `export default (__exports.default = __reference("default"));`
        )
      } else {
        lines.push(
          `export const ${ref} = (__exports[${JSON.stringify(ref)}] = __reference(${JSON.stringify(ref)}));`
        )
      }
    }
    if (refs.length === 0) lines.push('export {};')
    lines.push(`${register}__exports);`, '')
    return lines.join('\n')
  }

  // rsc: one CommonJS route module per entry.
  const serverDir = path.join(distDir, 'server')
  const rsc = await Bun.build({
    entrypoints: routes.map((route) => route.file),
    root: rscEntriesDir,
    outdir: serverDir,
    naming: '[dir]/[name].[ext]',
    target: 'node',
    format: 'cjs',
    conditions: ['react-server'],
    define: defines('server'),
    plugins: [resolver('rsc'), swcLayer('rsc'), ...plugins],
    metafile: true,
    throw: false,
  })
  if (!rsc.success) {
    throw new AggregateError(
      rsc.logs,
      'Bun.build: App Router server build failed'
    )
  }

  // ssr: every client module, keyed by id, for `__webpack_require__`.
  const ssrEntry = path.join(entriesDir, 'ssr', SSR_RUNTIME)
  write(
    ssrEntry,
    [
      `"use strict";`,
      `const modules = {`,
      ...[...clientModules.values()].map(
        (mod) =>
          `  ${JSON.stringify(mod.id)}: () => require(${JSON.stringify(mod.key)}),`
      ),
      `};`,
      `exports.__next_bun_require = function (id) {`,
      `  if (id === ${JSON.stringify(ACTIONS_MODULE_ID)}) return require(${JSON.stringify('./' + ACTIONS_RUNTIME)});`,
      `  if (id.startsWith("rsc:")) {`,
      `    const proxy = globalThis.__next_bun_rsc && globalThis.__next_bun_rsc.get(id.slice(4));`,
      `    if (proxy === undefined) throw new Error("Bun.build: client reference " + id + " is not loaded");`,
      `    return proxy;`,
      `  }`,
      `  const load = modules[id];`,
      `  if (load === undefined) throw new Error("Bun.build: unknown client module " + id);`,
      `  return load();`,
      `};`,
      '',
    ].join('\n')
  )
  const ssr = await Bun.build({
    entrypoints: [ssrEntry],
    root: path.dirname(ssrEntry),
    outdir: serverDir,
    naming: '[dir]/[name].[ext]',
    target: 'node',
    format: 'cjs',
    define: defines('server'),
    plugins: [resolver('ssr'), swcLayer('ssr'), ...plugins],
    throw: false,
  })
  if (!ssr.success) {
    throw new AggregateError(ssr.logs, 'Bun.build: App Router SSR build failed')
  }

  // actions: the Server Action modules found by the rsc and ssr passes, compiled for
  // the server and exported by action id, which is what React reads from the module.
  if (actionModules.size > 0) {
    const actionsEntry = path.join(entriesDir, 'actions', ACTIONS_RUNTIME)
    const lines = [`"use strict";`]
    ;[...actionModules.values()].forEach((mod, i) => {
      lines.push(`const m${i} = require(${JSON.stringify(mod.file)});`)
      for (const [id, name] of Object.entries(mod.ids)) {
        lines.push(
          `Object.defineProperty(exports, ${JSON.stringify(id)}, { enumerable: true, get: () => m${i}[${JSON.stringify(name)}] });`
        )
      }
    })
    write(actionsEntry, lines.join('\n') + '\n')
    const knownClientModules = clientModules.size
    const actions = await Bun.build({
      entrypoints: [actionsEntry],
      root: path.dirname(actionsEntry),
      outdir: serverDir,
      naming: '[dir]/[name].[ext]',
      target: 'node',
      format: 'cjs',
      conditions: ['react-server'],
      define: defines('server'),
      plugins: [resolver('rsc'), swcLayer('rsc', false), ...plugins],
      throw: false,
    })
    if (!actions.success) {
      throw new AggregateError(
        actions.logs,
        'Bun.build: Server Actions build failed'
      )
    }
    if (clientModules.size !== knownClientModules) {
      throw new BunBuildUnsupportedError(
        'Client Components imported only by Server Action modules'
      )
    }
  }

  // Which stylesheets and client modules each layout/page pulls in on the server.
  const cwd = process.cwd()
  const canonical = (file: string) =>
    process.platform === 'win32'
      ? path.normalize(file).toLowerCase()
      : path.normalize(file)
  const absolute = new Map<string, string>()
  const toAbsolute = (key: string) => {
    let file = absolute.get(key)
    if (file === undefined) {
      const candidates = [
        path.resolve(cwd, key),
        path.resolve(dir, key),
        path.resolve(rscEntriesDir, key),
      ]
      file = canonical(candidates.find(existsSync) ?? candidates[0])
      absolute.set(key, file)
    }
    return file
  }
  const graph = new Map<string, string[]>()
  for (const [key, input] of Object.entries<any>(rsc.metafile.inputs)) {
    graph.set(
      toAbsolute(key),
      (input.imports ?? [])
        .filter((i: any) => !i.external)
        .map((i: any) => toAbsolute(i.path))
    )
  }
  const clientByFile = new Map(
    [...clientModules.values()].map((mod) => [canonical(mod.key), mod])
  )
  const segmentImports = new Map<
    string,
    { css: Set<string>; clients: Set<ClientModule> }
  >()
  for (const segment of new Set(routes.flatMap((route) => route.segments))) {
    const css = new Set<string>()
    const clients = new Set<ClientModule>()
    const seen = new Set<string>()
    const start = canonical(segment)
    if (!graph.has(start)) {
      throw new Error(
        `Bun.build: ${segment} is missing from the server metafile`
      )
    }
    const stack = [start]
    while (stack.length > 0) {
      const file = stack.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const client = clientByFile.get(file)
      if (file.endsWith('.css')) css.add(file)
      else if (client) clients.add(client)
      else for (const dep of graph.get(file) ?? []) stack.push(dep)
    }
    segmentImports.set(segment, { css, clients })
  }

  // browser: main-app, one registering entry per client module, one stylesheet
  // entry per layout/page that imports CSS on the server.
  const browserEntriesDir = path.join(entriesDir, 'app-browser')
  const browserEntries: string[] = []
  const mainApp = path.join(browserEntriesDir, 'main-app.js')
  write(
    mainApp,
    `require(${JSON.stringify(path.join(nextDist, 'client', 'app-next.js'))});\n`
  )
  browserEntries.push(mainApp)
  for (const mod of clientModules.values()) {
    const file = path.join(browserEntriesDir, 'app', mod.id + '.js')
    write(
      file,
      `(self.__next_bun_modules || (self.__next_bun_modules = {}))[${JSON.stringify(mod.id)}] = require(${JSON.stringify(mod.key)});\n`
    )
    browserEntries.push(file)
  }
  const segmentCssEntry = new Map<string, string>()
  for (const [segment, { css }] of segmentImports) {
    if (css.size === 0) continue
    const name = `css/${contentHash(relativeToDir(segment))}`
    const file = path.join(browserEntriesDir, name + '.js')
    write(
      file,
      [...css].map((f) => `import ${JSON.stringify(f)};`).join('\n') + '\n'
    )
    browserEntries.push(file)
    segmentCssEntry.set(segment, name)
  }

  const actionCount = actionModules.size
  const browser = await Bun.build({
    entrypoints: browserEntries,
    root: browserEntriesDir,
    outdir: chunksDir,
    naming: {
      entry: '_bun/[dir]/[name]-[hash].[ext]',
      chunk: '_bun/chunks/chunk-[hash].[ext]',
      asset: '../media/[name]-[hash].[ext]',
    },
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify,
    define: defines('client'),
    plugins: [resolver('browser'), swcLayer('browser'), ...plugins],
    metafile: true,
    throw: false,
  })
  if (!browser.success) {
    throw new AggregateError(
      browser.logs,
      'Bun.build: App Router client build failed'
    )
  }
  if (actionModules.size !== actionCount) {
    throw new BunBuildUnsupportedError(
      'Server Actions imported only by the browser build'
    )
  }

  const cssBundles = new Map<string, string>()
  for (const [output, meta] of Object.entries<any>(browser.metafile.outputs)) {
    if (meta.cssBundle) {
      cssBundles.set(
        posix(path.normalize(output)),
        posix(path.normalize(meta.cssBundle))
      )
    }
  }
  const assetPrefix = (config.assetPrefix || '').replace(/\/$/, '')
  const prefix = `${assetPrefix}/_next/`
  const browserFiles = new Map<
    string,
    { module: string; css?: string; loader?: string }
  >()
  for (const output of browser.outputs) {
    if (output.kind !== 'entry-point') continue
    const relative = posix(path.relative(chunksDir, output.path))
    const name = /^_bun\/(.+)-[^-/]+\.js$/.exec(relative)?.[1]
    if (!name)
      throw new Error(`Bun.build: unexpected client output ${relative}`)
    const css = cssBundles.get(relative)
    const entry: { module: string; css?: string; loader?: string } = {
      module: `static/chunks/${relative}`,
      css: css ? `static/chunks/${css}` : undefined,
    }
    if (!name.startsWith('css/')) {
      // React preinits chunk files as classic scripts, so each module gets a loader.
      const setup =
        name === 'main-app'
          ? 'self.__next_bun_modules||(self.__next_bun_modules={});' +
            'self.__webpack_require__||(self.__webpack_require__=function(id){var m=self.__next_bun_modules[id];if(m===void 0)throw new Error("Bun.build: client module "+id+" is not loaded");return m});' +
            'self.__webpack_require__.u||(self.__webpack_require__.u=function(c){return c});' +
            `self.__webpack_chunk_load__||(self.__webpack_chunk_load__=function(c){return import(${JSON.stringify(prefix)}+c)});`
          : ''
      const loader = `self.process||(self.process={env:{}});${setup}import(${JSON.stringify(
        './' + path.posix.relative(path.posix.dirname(name), relative)
      )});\n`
      entry.loader = `static/chunks/${name}-${contentHash(loader)}.js`
      write(path.join(distDir, entry.loader), loader)
    }
    browserFiles.set(name, entry)
  }

  const clientModulesManifest: Record<string, object> = {}
  const ssrModuleMapping: Record<string, object> = {}
  const rscModuleMapping: Record<string, object> = {}
  for (const mod of clientModules.values()) {
    const entry = browserFiles.get(`app/${mod.id}`)
    if (!entry) throw new Error(`Bun.build: no client output for ${mod.key}`)
    // [chunk id, chunk file] pairs: React imports the id through
    // `__webpack_chunk_load__` and preinits the file during SSR.
    clientModulesManifest[mod.key] = {
      id: mod.id,
      name: '*',
      chunks: [entry.module, entry.loader],
      async: false,
    }
    ssrModuleMapping[mod.id] = {
      '*': { id: mod.id, name: '*', chunks: [], async: false },
    }
    rscModuleMapping[mod.id] = {
      '*': { id: `rsc:${mod.id}`, name: '*', chunks: [], async: false },
    }
  }
  const entryCSSFiles: Record<string, { inlined: boolean; path: string }[]> = {}
  for (const [segment, { clients }] of segmentImports) {
    const files = new Set<string | undefined>()
    const own = segmentCssEntry.get(segment)
    if (own) files.add(browserFiles.get(own)?.css)
    for (const mod of clients) files.add(browserFiles.get(`app/${mod.id}`)?.css)
    files.delete(undefined)
    entryCSSFiles[segment.replace(/\.[^.]+$/, '')] = [...files].map((file) => ({
      inlined: false,
      path: file!,
    }))
  }
  const moduleLoading = config.crossOrigin
    ? { prefix, crossOrigin: config.crossOrigin }
    : { prefix }
  const manifest = JSON.stringify({
    moduleLoading,
    ssrModuleMapping,
    edgeSSRModuleMapping: {},
    clientModules: clientModulesManifest,
    entryCSSFiles,
    rscModuleMapping,
    edgeRscModuleMapping: {},
  })

  const files: Record<string, string> = {}
  const appPathsManifest: Record<string, string> = {}
  for (const route of routes) {
    files[`server/${route.name}_client-reference-manifest.js`] =
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${JSON.stringify(route.page)}]=${manifest};`
    appPathsManifest[route.page] = `${route.name}.js`
  }
  files['server/app-paths-manifest.json'] = JSON.stringify(
    appPathsManifest,
    null,
    2
  )
  // Every page can run every action: they all share one actions module.
  const pageRoutes = routes.filter((route) => !route.name.endsWith('/route'))
  const serverActions: Record<string, object> = {}
  for (const mod of actionModules.values()) {
    const filename = relativeToDir(mod.file)
    for (const [id, exportedName] of Object.entries(mod.ids)) {
      const workers: Record<string, { moduleId: string; async: boolean }> = {}
      const layer: Record<string, string> = {}
      for (const route of pageRoutes) {
        workers[route.name] = { moduleId: ACTIONS_MODULE_ID, async: false }
        layer[route.name] = mod.fromServer ? 'rsc' : 'action-browser'
      }
      serverActions[id] = { workers, layer, filename, exportedName }
    }
  }
  const serverManifest = {
    node: serverActions,
    edge: {},
    encryptionKey: ctx.encryptionKey,
  }
  files['server/server-reference-manifest.json'] =
    JSON.stringify(serverManifest)
  files['server/server-reference-manifest.js'] =
    `self.__RSC_SERVER_MANIFEST=${JSON.stringify(
      JSON.stringify({
        ...serverManifest,
        encryptionKey: 'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
      })
    )}`

  return { rootMainFiles: [browserFiles.get('main-app')!.loader!], files }
}
