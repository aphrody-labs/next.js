import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

// `Bun` exists when Next.js runs on Bun; packages/next does not depend on bun-types.
declare const Bun: any

export type BunPlugin = {
  name: string
  setup(build: any): void | Promise<void>
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/

export class BunBuildUnsupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not supported by the Bun bundler yet.`)
  }
}

export function posix(p: string) {
  return p.replaceAll('\\', '/')
}

export function write(file: string, contents: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

export function contentHash(contents: string | Uint8Array) {
  return Bun.hash(contents).toString(16).padStart(16, '0')
}

/** The webpack layer next-swc-loader compiles a module for. */
export type SwcLayer = {
  isServer: boolean
  bundleLayer: string
  serverComponents: boolean
  isPageFile?: boolean
}
