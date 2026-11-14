module.exports = () => ({ postcssPlugin: "mark", Once(root) { root.append({ selector: ".runtime", nodes: [] }); root.last.append({ prop: "--runtime", value: process.versions.bun ? "bun-" + process.versions.bun : "node" }); } });
module.exports.postcss = true;
