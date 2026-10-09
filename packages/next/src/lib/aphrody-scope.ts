// The Aphrody fork of Next.js publishes its packages under the @aphrody scope
// (scripts/aphrody/scope.ts). Installed packages keep their upstream names
// through npm aliases, so only code that fetches a package from the registry
// by name needs the published one: the fork never falls back to upstream's
// binaries.

export const APHRODY_SCOPE = '@aphrody'

/** The registry name of a package of this repository: `@next/x` -> `@aphrody/next-x`. */
export function publishedPackageName(name: string): string {
  if (name.startsWith(`${APHRODY_SCOPE}/`)) return name
  if (name.startsWith('@next/')) {
    return `${APHRODY_SCOPE}/next-${name.slice('@next/'.length)}`
  }
  return `${APHRODY_SCOPE}/${name}`
}

/** The registry name of the SWC package for `variant` (`win32-x64-msvc`, `wasm-nodejs`, ...). */
export function swcPackageName(variant: string): string {
  return publishedPackageName(`@next/swc-${variant}`)
}
