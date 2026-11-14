#!/usr/bin/env bun
// aphrody-labs/next.js: build crates/wasm without wasm-pack or node.
//   cargo (wasm32-unknown-unknown, release) -> wasm-bindgen CLI (fork, version == Cargo.lock) -> wasm-opt (Binaryen)
// Usage: bun scripts/aphrody/build-wasm.ts [--target nodejs|web|bundler] [--dev] [--no-opt] [--types]
//   --target T  one target, written to crates/wasm/pkg (wasm-pack layout, what CI and NEXT_TEST_WASM_DIR expect)
//   (default)   nodejs + web, written to crates/wasm/pkg-nodejs and crates/wasm/pkg-web
//   --types     also copy wasm.d.ts to packages/next/src/build/swc/generated-wasm.d.ts (as the old script did)
// The wasm-bindgen CLI is resolved from $WASM_BINDGEN, then ~/.local/share/ay/tools/wasm-bindgen-<ver>/,
// and otherwise built from the aphrody-labs fork (C:\src\third_party\wasm-bindgen) at the tag matching Cargo.lock.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CRATE = join(ROOT, "crates/wasm");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => args.find((a) => a.startsWith(`${n}=`))?.split("=")[1] ?? (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dev = flag("--dev");
const targets = opt("--target") ? [opt("--target")!] : ["nodejs", "web"];
const env = { ...process.env } as Record<string, string>;
delete env.RUSTC_WRAPPER; // sccache breaks long rustc command lines on Windows

const lock = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
const version = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
if (!version) throw new Error("wasm-bindgen not found in Cargo.lock");
const exe = process.platform === "win32" ? ".exe" : "";

async function resolveCli(): Promise<string> {
  const toolDir = join(homedir(), ".local/share/ay/tools", `wasm-bindgen-${version}`);
  const candidates = [process.env.WASM_BINDGEN, join(toolDir, `wasm-bindgen${exe}`)].filter(Boolean) as string[];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const v = (await $`${c} --version`.text()).trim();
    if (v === `wasm-bindgen ${version}`) return c;
    console.warn(`skip ${c}: ${v} != ${version}`);
  }
  // Build from the fork at the commit whose subject is exactly the version (partial clone: fetch from remote).
  const fork = "C:/src/third_party/wasm-bindgen";
  const url = (await $`git -C ${fork} remote get-url origin`.text()).trim();
  const sha = (await $`git -C ${fork} log --all --format=%H -1 --grep=${"^" + version + "$"}`.text()).trim();
  if (!sha) throw new Error(`no commit "${version}" in ${fork}`);
  const work = join(tmpdir(), `wbg-${version}`);
  rmSync(work, { recursive: true, force: true });
  await $`git clone -q --filter=blob:none --no-checkout ${url} ${work}`;
  await $`git -C ${work} checkout -q ${sha}`;
  await $`cargo build --release -p wasm-bindgen-cli --bin wasm-bindgen`.cwd(work).env(env);
  mkdirSync(toolDir, { recursive: true });
  const out = join(toolDir, `wasm-bindgen${exe}`);
  copyFileSync(join(work, `target/release/wasm-bindgen${exe}`), out);
  return out;
}

const cli = await resolveCli();
console.log(`wasm-bindgen CLI: ${cli} (${version})`);

// Explicit stable feature set: --all-features makes Binaryen emit experimental encodings (compact imports) that Bun/V8 reject.
const FEATURES = ["bulk-memory", "bulk-memory-opt", "sign-ext", "mutable-globals", "nontrapping-float-to-int", "multivalue", "reference-types", "extended-const"].map((f) => `--enable-${f}`);
const profile = dev ? "debug" : "release";
// Cargo here unifies features across the whole workspace, which turns on turbo-rcstr/napi (tokio -> mio, not wasm-buildable); build the package alone.
env.CARGO_RESOLVER_FEATURE_UNIFICATION = "selected";
await $`cargo build -Zfeature-unification --lib ${dev ? [] : ["--release"]} --target wasm32-unknown-unknown -p wasm`.cwd(ROOT).env(env);
const wasmIn = join(ROOT, `target/wasm32-unknown-unknown/${profile}/wasm.wasm`);

const outs: string[] = [];
for (const t of targets) {
  const out = join(CRATE, targets.length === 1 ? "pkg" : `pkg-${t}`);
  rmSync(out, { recursive: true, force: true });
  await $`${cli} ${wasmIn} --out-dir ${out} --out-name wasm --target ${t} --typescript ${dev ? ["--debug"] : []}`.env(env);
  if (!dev && !flag("--no-opt")) {
    const f = join(out, "wasm_bg.wasm");
    const before = statSync(f).size;
    await $`wasm-opt ${f} -o ${f} -O3 ${FEATURES}`.env(env);
    console.log(`wasm-opt ${t}: ${before} -> ${statSync(f).size} bytes`);
  }
  const files = ["wasm_bg.wasm", "wasm_bg.wasm.d.ts", "wasm.js", "wasm.d.ts"];
  writeFileSync(join(out, "package.json"), JSON.stringify({
    name: t === "web" ? "@next/swc-wasm-web" : "@next/swc-wasm-nodejs",
    version: "0.0.0",
    files,
    main: "wasm.js",
    types: "wasm.d.ts",
    ...(t === "nodejs" ? {} : { sideEffects: ["./snippets/*"] }),
  }, null, 2));
  outs.push(out);
}

if (flag("--types")) {
  const dts = readFileSync(join(outs[0], "wasm.d.ts"), "utf8");
  const notice = "// DO NOT MANUALLY EDIT THESE TYPES\n// You can regenerate this file by running `bun scripts/aphrody/build-wasm.ts --types` in the root of the repo.\n\n";
  writeFileSync(join(ROOT, "packages/next/src/build/swc/generated-wasm.d.ts"), notice + dts);
}
console.log("wasm outputs:", outs.join(", "));
