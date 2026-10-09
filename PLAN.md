# Plan of the aphrody-labs/next.js fork

Coordination: section M of `PLAN.md` in aphrody-labs/bun.

## Done

- Bun replaces pnpm: workspaces, `bun.lock` migrated from upstream's lockfile, `bunfig.toml`, scripts and the pre-commit hook. See `scripts/aphrody/bunify.ts`.
- `@aphrody` scope at publication, with npm aliases. `download-swc` and the postinstall no longer fall back to upstream.
- Bun-aware upstream sync every 6 h.
- npm release for the 8 next-swc platforms and the JS packages, plus a GitHub release.
- `next build` compile step through `Bun.build` (`packages/next/src/build/bun-build`), selected by `NEXT_BUN=1` or `next build --bun`: Pages Router, Node.js runtime, CSS. The App Router, the edge runtime and instrumentation are rejected.
- Turbopack's Node.js process pool and `process.version` probe start `TURBOPACK_NODE_BINARY`, else the `node` or `bun` process that loaded the bindings (`turbopack-core` `node_executable()`).

## Next

1. Bun.build beyond the Pages Router: App Router, edge runtime, standalone output. `withBun` stays in `@aphrody/next-bun` (aphrody-labs/bun, `packages/bun-next`).
2. A faster build of `packages/next` itself: a `Bun.build` transpile has to reproduce `taskr release` (SWC options per target, `dist/esm`, `ncc` and the `next_bundle` runtime bundles) and be measured against it before replacing it.
3. Workers, scripts and tooling go through n2b (Node APIs to Bun APIs when faster or equivalent). `packages/next/src` keeps `process.env` and the `node:` imports, which the edge/client bundles and the DefinePlugin depend on.
4. Move jest suites to `bun test` in batches; keep the rest runnable under Bun.
5. Before/after measures: native build, example app build, dev cold start.
6. Crates: publish the standalone crates (`next-custom-transforms`, `turbo-rcstr`…) under renamed names, if their path dependencies allow it.

## Known limits

- Bun ignores `patchedDependencies` keys without a version, which pnpm accepts. For now `bunify.ts` adds the version from `bun.lock`. To be fixed in Bun (`src/install`).
- pnpm links every workspace package at the root; Bun links only the declared ones. As a result, `@next/eslint-plugin-internal` is declared in the root `devDependencies` by `bunify.ts`.
- Linux native builds run in upstream's `next-swc-builder` image, which builds with node/npm (`@napi-rs/cli`).
- `taskr` reports "Taskfile not found!" for `next#build` under `turbo run build` on Windows, while it finds the file when run directly. Still to be investigated.
- On Windows, sccache fails on `next-napi-bindings` because the command line is too long. Build with `RUSTC_WRAPPER=` and a dedicated `CARGO_TARGET_DIR`.
