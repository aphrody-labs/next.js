#!/usr/bin/env bun
// aphrody-labs/next.js: release build of next-napi-bindings with ThinLTO (Cargo profile `release-xlto`)
// plus cross-language LTO: rustc emits LLVM bitcode (-Clinker-plugin-lto), C/C++ dependencies are compiled by
// clang-cl with -flto=thin, and lld-link runs one ThinLTO over both. Requires clang/lld and rustc on the same LLVM major;
// a mismatch aborts (it is reported, never forced).
// Usage: bun scripts/aphrody/build-native-xlto.ts [--no-xlang]   (--no-xlang = ThinLTO only, rustc-only bitcode)
import { $ } from "bun";
import { statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SWC = join(ROOT, "packages/next-swc");
const noX = process.argv.includes("--no-xlang");
const TRIPLE = "x86_64-pc-windows-msvc";
const LLVM = process.env.LLVM_BIN ?? "C:/Program Files/LLVM/bin";

const rustLlvm = (await $`rustc -vV`.text()).match(/LLVM version: (\d+)\.(\d+)/);
const clangVer = (await $`${LLVM}/clang.exe --version`.text()).match(/clang version (\d+)\.(\d+)/);
console.log(`rustc LLVM ${rustLlvm?.[1]}.${rustLlvm?.[2]}, clang ${clangVer?.[1]}.${clangVer?.[2]}`);
if (!noX && rustLlvm?.[1] !== clangVer?.[1]) {
  console.error("LLVM major mismatch between rustc and clang: cross-language LTO is unsafe, rerun with --no-xlang");
  process.exit(2);
}

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
delete env.RUSTC_WRAPPER;
const T = TRIPLE.replaceAll("-", "_");
if (!noX) {
  env[`CC_${T}`] = `${LLVM}/clang-cl.exe`;
  env[`CXX_${T}`] = `${LLVM}/clang-cl.exe`;
  env[`AR_${T}`] = `${LLVM}/llvm-lib.exe`;
  env[`CFLAGS_${T}`] = "-flto=thin";
  env[`CXXFLAGS_${T}`] = "-flto=thin";
  // --target scopes these flags to target artifacts only (build scripts and proc-macros stay ordinary host code).
  env[`CARGO_TARGET_${T.toUpperCase()}_LINKER`] = `${LLVM}/lld-link.exe`;
  env[`CARGO_TARGET_${T.toUpperCase()}_RUSTFLAGS`] = "-Clinker-plugin-lto";
}

const t0 = performance.now();
await $`bun x napi build --platform -p next-napi-bindings --manifest-path ../../Cargo.toml --profile release-xlto --target ${TRIPLE} --features tracing/release_max_level_trace --no-js -o native-xlto`.cwd(SWC).env(env);
const min = ((performance.now() - t0) / 60000).toFixed(1);
const node = join(SWC, "native-xlto/next-swc.win32-x64-msvc.node");
console.log(`built in ${min} min, ${node} = ${statSync(node).size} bytes`);
