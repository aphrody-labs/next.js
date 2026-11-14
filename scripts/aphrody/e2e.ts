#!/usr/bin/env bun
// aphrody-labs/next.js: prove the fork runs on Bun alone. Builds scripts/aphrody/e2e with the
// workspace `next` and the locally built @next/swc, with every `node` removed from PATH, then
// checks that Turbopack's Rust process pool ran PostCSS under Bun and that pages render under Bun.
import { $ } from "bun";
import { cpSync, mkdirSync, rmSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";

const ROOT = join(import.meta.dir, "../..");
// Inside the repository: Turbopack does not compile files outside its root (the workspace next).
const app = join(ROOT, "test", ".aphrody-e2e");
rmSync(app, { recursive: true, force: true });
cpSync(join(import.meta.dir, "e2e"), app, { recursive: true });
mkdirSync(join(app, "node_modules"));
symlinkSync(join(ROOT, "packages/next"), join(app, "node_modules/next"), "junction");

const PATH = (process.env.PATH ?? "").split(delimiter).filter((d) => !/nodejs|bun-node/i.test(d)).join(delimiter);
const env = { ...process.env, PATH, NEXT_TELEMETRY_DISABLED: "1" };
if (Bun.which("node", { PATH })) throw new Error("a node binary is still on PATH");

await $`${process.execPath} --bun node_modules/next/dist/bin/next build`.cwd(app).env(env);

const css = readdirSync(join(app, ".next/static/chunks")).filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(join(app, ".next/static/chunks", f), "utf8")).join("");
const html = readFileSync(join(app, ".next/server/app/index.html"), "utf8");
const postcss = css.match(/--runtime:([a-z0-9.-]+)/)?.[1];
const render = html.match(/bun e2e <!-- -->(\w+)/)?.[1];
console.log(`postcss pool: ${postcss}, render: ${render}`);
rmSync(app, { recursive: true, force: true });
if (!postcss?.startsWith("bun-") || render !== "bun") process.exit(1);
