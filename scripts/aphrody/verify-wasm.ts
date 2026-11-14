#!/usr/bin/env bun
// aphrody-labs/next.js: prove the wasm package built by build-wasm.ts loads and transforms under Bun.
// nodejs target: `import wasm.js` (what NEXT_TEST_WASM_DIR does); web target: default() init with the .wasm bytes.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CRATE = join(import.meta.dir, "../../crates/wasm");
const src = "export default function A({x}: {x: number}) { return <div className='a'>{x}</div> }";
const opts = { jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } }, filename: "a.tsx" };
const check = (name: string, out: any) => {
  if (!/jsx|createElement/.test(out.code) || /: \{x: number\}/.test(out.code)) throw new Error(`${name}: unexpected output ${out.code}`);
  console.log(`${name}: ok (${out.code.length} bytes out)`);
};

const node = await import(pathToFileURL(join(CRATE, "pkg-nodejs/wasm.js")).href);
check("nodejs transformSync", node.transformSync(src, opts));
check("nodejs transform (async)", await node.transform(src, opts));
console.log("nodejs parseSync:", JSON.stringify(node.parseSync("let a = 1", { syntax: "ecmascript", target: "es2022" })).slice(0, 60));
console.log("nodejs minifySync:", node.minifySync("function f(longName) { return longName + 1 }", { compress: true, mangle: true }).code);

const web = await import(pathToFileURL(join(CRATE, "pkg-web/wasm.js")).href);
await web.default({ module_or_path: await Bun.file(join(CRATE, "pkg-web/wasm_bg.wasm")).arrayBuffer() });
check("web transformSync", web.transformSync(src, opts));
