# Plan of the aphrody-labs/next.js fork

Coordination: section M of `PLAN.md` in aphrody-labs/bun.

## Done

- Bun replaces pnpm: workspaces, `bun.lock` migrated from upstream's lockfile, `bunfig.toml`, scripts and the pre-commit hook. See `scripts/aphrody/bunify.ts`.
- `@aphrody` scope at publication, with npm aliases. `download-swc` and the postinstall no longer fall back to upstream.
- Bun-aware upstream sync every 6 h.
- npm release for the 8 next-swc platforms and the JS packages, plus a GitHub release.
- `next build` compile step through `Bun.build` (`packages/next/src/build/bun-build`), selected by `NEXT_BUN=1` or `next build --bun`: Pages Router, Node.js runtime, CSS. The App Router, the edge runtime and instrumentation are rejected.
- Turbopack's Node.js process pool and `process.version` probe start `TURBOPACK_NODE_BINARY`, else the `node` or `bun` process that loaded the bindings (`turbopack-core` `node_executable()`).
- AGENTS.md and `scripts/**` are managed by `bunify.ts` (Bun commands, `bun` shebangs, fork note between `<!-- aphrody:bun -->` markers), so `sync-upstream.ts` keeps them on Bun (f489e60f28).
- `bun run test-unit-bun`: 128 of the 155 `packages/next/src/**/*.test.ts` files pass under `bun test --isolate` (1398 pass, 0 fail, 6.1 s on Windows). The 27 others and every other suite stay on Jest (f489e60f28).
- Release on the fork's Bun (`.github/actions/aphrody-setup-bun`), tag version checked against `packages/next`, `test-unit-bun` before publishing, local `publish --dry-run` packs the 16 JS packages on Windows; `consume.ts` prepares the consumers (a86c3b0f4a).

## Next

1. Final pass, once: delete `packages/next/dist`, then `bun run --cwd packages/next build` (taskr release); then `bun run test-unit-bun`, `bun test scripts/aphrody/test`, and the first release: push the tag `aphrody-v16.5.0-canary.5-aphrody.1` (or run "Aphrody release" with `dry-run` first). Secrets NPM_TOKEN, APHRODY_SYNC_TOKEN and CARGO_REGISTRY_TOKEN are set; neither aphrody workflow has run yet.
2. After the release, consumers: `bun scripts/aphrody/consume.ts C:/shenron --version <v>` (root `catalog`: next, @next/env, @next/third-parties; apps/site and packages/auth use `catalog:`, the auth peer range stays), and `bun scripts/aphrody/consume.ts C:/aphrody --version <v>` (`workspaces.catalog.next` 16.3.8, used by m3/packages/m3-next, rg-ui and the m3-next examples through `catalog:`), each followed by `bun install`. Before that it refuses: no @aphrody/next on npm.
3. Bun.build beyond the Pages Router: App Router, edge runtime, standalone output. `withBun` stays in `@aphrody/next-bun` (aphrody-labs/bun, `packages/bun-next`).
4. A faster build of `packages/next` itself: a `Bun.build` transpile has to reproduce `taskr release` (SWC options per target, `dist/esm`, `ncc` and the `next_bundle` runtime bundles) and be measured against it before replacing it.
5. Workers, scripts and tooling go through n2b (Node APIs to Bun APIs when faster or equivalent). `packages/next/src` keeps `process.env` and the `node:` imports, which the edge/client bundles and the DefinePlugin depend on.
6. Move the remaining jest suites to `bun test` in batches (27 unit files fail under Bun, e.g. static-paths/app, config, trace/tracer, route-regex, worker); Jest itself needs `next/jest` from `dist`.
7. Before/after measures: native build, example app build, dev cold start.
8. Crates: publish the standalone crates (`next-custom-transforms`, `turbo-rcstr`…) under renamed names, if their path dependencies allow it.

## Known limits

- n2b (C:\aphrody) autofix is not applied to `scripts/`: it emits `await Bun.file().text()` in synchronous/CJS code and `Bun.write(file, body, 'utf8')`. scripts/ measured 397 findings before, 378 after the bunify pass (19 node shebangs to 0).
- Upstream workflows (build-and-test, build-and-deploy, Turbopack Benchmark) queue forever on the fork: their jobs wait for Vercel runners.
- turbo 2.9.4 warns "Unsupported bun lockfile version: 2" and filters undeclared env vars unless `--env-mode loose`.

- Bun ignores `patchedDependencies` keys without a version, which pnpm accepts. For now `bunify.ts` adds the version from `bun.lock`. To be fixed in Bun (`src/install`).
- pnpm links every workspace package at the root; Bun links only the declared ones. As a result, `@next/eslint-plugin-internal` is declared in the root `devDependencies` by `bunify.ts`.
- Linux native builds run in upstream's `next-swc-builder` image, which builds with node/npm (`@napi-rs/cli`).
- `taskr` reports "Taskfile not found!" for `next#build` under `turbo run build` on Windows, while it finds the file when run directly. Still to be investigated.
- On Windows, sccache fails on `next-napi-bindings` because the command line is too long. Build with `RUSTC_WRAPPER=` and a dedicated `CARGO_TARGET_DIR`.
