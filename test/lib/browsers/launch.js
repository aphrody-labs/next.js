//@ts-check

/**
 * Tells the browser launcher which host to redirect, as `<hostname>=<address>`.
 * A deploy test sets this when it redirects the deployment host inside the test
 * process (`NEXT_TEST_PROXY_IN_PROCESS`), because the launcher runs in the same
 * process but has no access to the test instance. The `/etc/hosts` mode never
 * sets it, since that mode already covers every process on the machine.
 */
const PROXY_HOST_MAP_ENV_KEY = 'NEXT_TEST_PROXY_HOST_MAP'

/**
 * Maps a test browser name (`BROWSER_NAME`) to the `Bun.WebView` backend and the
 * launch options we always use for it. Used by `test/lib/browsers/bun-webview.ts`.
 *
 * - `chrome` (default): Chrome-family browser found by Bun (`BUN_CHROME_PATH`,
 *   `$PATH`, standard install locations; the preinstalled Edge on Windows).
 * - `safari`: the system WKWebView, macOS only.
 *
 * @param {string} browserName
 * @returns {object}
 */
function getBackend(browserName) {
  if (browserName === 'safari') {
    return 'webkit'
  }

  // A deploy test can redirect the deployment host to a proxy address inside
  // this process. The patched `dns.lookup` reaches only this process, so the
  // browser needs the same mapping through a launch argument.
  const [mappedHostname, mappedAddress] =
    process.env[PROXY_HOST_MAP_ENV_KEY]?.split('=') ?? []
  const argv =
    mappedHostname && mappedAddress
      ? [`--host-rules=MAP ${mappedHostname} ${mappedAddress}`]
      : []

  return {
    type: 'chrome',
    // Always spawn a private headless browser, never attach to a running one.
    url: false,
    ...(process.env.BUN_CHROME_PATH ? { path: process.env.BUN_CHROME_PATH } : {}),
    argv,
  }
}

module.exports = { getBackend, PROXY_HOST_MAP_ENV_KEY }
