import { fileURLToPath } from "node:url";
export default { plugins: { [fileURLToPath(new URL("./postcss-mark.cjs", import.meta.url))]: {} } };
