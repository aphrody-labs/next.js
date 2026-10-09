// Preloaded by test-unit-bun.ts. Under Jest, next's SWC transformer loads
// server modules that run node-environment-baseline (globalThis.AsyncLocalStorage,
// WebSocket) in the worker before jest-environment-node snapshots the worker's
// globals into every test context. `bun test` has no transformer step, so the
// tests that rely on those globals get them here.
import '../../packages/next/src/server/node-environment-baseline'
