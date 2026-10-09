# aphrody-labs/next.js

Fork of [vercel/next.js](https://github.com/vercel/next.js) that installs, builds and runs on [Bun](https://github.com/aphrody-labs/bun). It is published on npm under `@aphrody`.

## Install

```sh
bun add next@npm:@aphrody/next@canary
```

The sources keep the upstream package names, so applications still import `next/*`. Only the published manifests are renamed:

| Upstream                                               | Published                                    |
| ------------------------------------------------------ | -------------------------------------------- |
| `next`                                                 | `@aphrody/next`                              |
| `@next/<name>`                                         | `@aphrody/next-<name>`                       |
| `@next/swc-<platform>`                                 | `@aphrody/next-swc-<platform>` (8 platforms) |
| `create-next-app`, `eslint-config-next`, `next-rspack` | `@aphrody/<name>`                            |

Inside a published package, a dependency on another package of the fork is an npm alias, for example `"@next/env": "npm:@aphrody/next-env@<v>"`, so `require("@next/env")` keeps resolving. Downloading the SWC binary (`download-swc.ts`) and the monorepo postinstall only fetch `@aphrody/next-swc-*`. They never fall back to Vercel's packages.

Versions have the form `<upstream version>-aphrody.<n>`, and every package of a release shares the same version.

## Toolchain

| Upstream                                      | Fork                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | `bun install`; `workspaces`, `overrides` and `patchedDependencies` in `package.json`; `bunfig.toml` (isolated linker, pnpm's public hoisting, 48 h minimum release age); `bun.lock` |
| `pnpm run`, `node`, `tsx` in scripts          | `bun run`, `bun`                                                                                                                                                                    |
| `scripts/install-native.mjs` (postinstall)    | `scripts/aphrody/install-native.ts`                                                                                                                                                 |
| `scripts/publish-release.js`                  | `scripts/aphrody/publish-npm.ts`                                                                                                                                                    |

`scripts/aphrody/bunify.ts` is the single source of truth for these rewrites. It is idempotent.

## Scripts and workflows

| File                                          | Role                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/aphrody/bunify.ts`                   | pnpm/Node to Bun rewrite of the managed files (`--check`, `--write`)                                                                                                                        |
| `scripts/aphrody/scope.ts`                    | `@aphrody` names, npm aliases, scope check                                                                                                                                                  |
| `scripts/aphrody/sync-upstream.ts`            | merges `upstream/canary`. Conflicts on managed files are retried as a Bun-aware three-way merge. pnpm files stay deleted. `bun.lock` is re-migrated from upstream's `pnpm-lock.yaml`        |
| `scripts/aphrody/install-native.ts`           | postinstall: the newest `@aphrody/next-swc-*` for the checkout's version. A binding built locally in `packages/next-swc/native` takes precedence                                            |
| `scripts/aphrody/publish-npm.ts`              | `version [--tag aphrody-v<v>]`, `publish --version <v> [--dry-run]`: native packages, then the JS packages, then `next`                                                                     |
| `scripts/aphrody/consume.ts`                  | `<consumer root> --version <v> [--write]`: points `next`, `@next/*`... of a consumer (root, workspaces, catalogs, overrides) at `npm:@aphrody/<name>@<v>`; refuses a version missing on npm |
| `scripts/aphrody/test-unit-bun.ts`            | `bun run test-unit-bun`: the unit tests of `scripts/aphrody/bun-unit-tests.txt` under `bun test --isolate`; the other suites stay on Jest                                                   |
| `.github/actions/aphrody-setup-bun`           | installs the aphrody-labs/bun release pinned by `packageManager`                                                                                                                            |
| `.github/workflows/aphrody-upstream-sync.yml` | runs every 6 h: `sync-upstream.ts --push`                                                                                                                                                   |
| `.github/workflows/aphrody-release.yml`       | tag `aphrody-v*` or manual: next-swc for 8 platforms, Bun build, npm publish, GitHub release                                                                                                |

The tests of these scripts are in `scripts/aphrody/test`:

```sh
bun test scripts/aphrody/test
```

## Merging upstream

Merge only, never rebase:

```sh
bun scripts/aphrody/sync-upstream.ts [--dry-run] [--push]
```

The script exits with code 2 when a conflict remains outside the Bun rewrite. In that case, resolve it by hand with `--keep-conflicts`.

The remaining work and the known limits are listed in `PLAN.md`.
