/**
 * Browser driver for the Next.js test harness, built on `Bun.WebView`
 * (Chrome DevTools Protocol backend). It replaces the former Playwright driver
 * and keeps the same chainable interface (`Playwright` class below) so that
 * `next-webdriver` and the tests do not change. A small Playwright-shaped
 * `Page` / `Request` / `Response` / `Route` / `Locator` layer sits on top of
 * the view for the tests that listen to network events or intercept requests.
 *
 * Differences from Playwright, all inherent to `Bun.WebView`:
 * - Chrome-family browsers only (BROWSER_NAME=chrome); WebKit only on macOS via
 *   `BROWSER_NAME=safari`. Firefox is not available.
 * - The browser is always headless, `HEADLESS` and `DEVICE_NAME` are ignored.
 * - `waitUntil: 'commit' | 'domcontentloaded'` navigations resolve on `load`.
 * - No trace files (`TRACE_PLAYWRIGHT` is a no-op).
 */
import { debugPrint } from 'next-test-utils'
import { PROXY_HOST_MAP_ENV_KEY, getBackend } from './launch'

type EventType = 'request' | 'response'
type PageLog = { source: string; message: string; args: unknown[] }

export type Permissions = string[] | undefined

let page: Page | undefined
let contextHasJSEnabled = true
let contextPermissions: Permissions = undefined
let setupArgs: {
  browserName: string
  locale: string
  javaScriptEnabled: boolean
  ignoreHTTPSErrors: boolean
  userAgent: string | undefined
} = {
  browserName: 'chrome',
  locale: 'en-US',
  javaScriptEnabled: true,
  ignoreHTTPSErrors: false,
  userAgent: undefined,
}
let pageLogs: Array<Promise<PageLog> | PageLog> = []
let websocketFrames: Array<{ payload: string | Buffer }> = []

const defaultTimeout = process.env.NEXT_E2E_TEST_TIMEOUT
  ? parseInt(process.env.NEXT_E2E_TEST_TIMEOUT, 10)
  : 60 * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const pendingTeardown: Array<() => Promise<void>> = []
export async function quit() {
  await Promise.all(pendingTeardown.map((fn) => fn()))
  await page?.close()
  page = undefined
  ;(Bun as any).WebView?.closeAll?.()
}

// ---------------------------------------------------------------------------
// Page-side helpers (injected as source text).
// ---------------------------------------------------------------------------

/** Playwright-flavoured query: pierces open shadow roots, `:visible`, `text=`. */
const PAGE_HELPERS = `(() => {
  if (window.__nextTestQA) return window.__nextTestQA;
  const splitTop = (s) => {
    const out = []; let depth = 0, quote = '', cur = '';
    for (const ch of s) {
      if (quote) { cur += ch; if (ch === quote) quote = ''; continue }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (/\\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const deepAll = (root, sel) => {
    const out = [];
    const walk = (r) => {
      try { r.querySelectorAll(sel).forEach((e) => out.push(e)) } catch (e) { throw e }
      if (r.shadowRoot) walk(r.shadowRoot);
      r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot) });
    };
    walk(root);
    return out;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const qa = (selector) => {
    let sel = selector.trim(), visibleOnly = false;
    if (sel.endsWith(':visible')) { visibleOnly = true; sel = sel.slice(0, -8) }
    let els;
    if (sel.startsWith('text=')) {
      const needle = sel.slice(5).replace(/^["']|["']$/g, '');
      els = deepAll(document, '*').filter((e) =>
        [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(needle)));
    } else {
      const parts = splitTop(sel);
      if (parts.some((p) => /^[>+~]$/.test(p))) els = deepAll(document, sel);
      else {
        let cur = [document];
        for (const p of parts) {
          const next = new Set();
          for (const r of cur) deepAll(r, p).forEach((e) => next.add(e));
          cur = [...next];
        }
        els = cur;
      }
    }
    return visibleOnly ? els.filter(isVisible) : els;
  };
  return (window.__nextTestQA = { qa, isVisible });
})()`

const looksLikeFunction = (s: string) =>
  /^\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(s)

function toExpression(
  fn: string | ((...args: any[]) => any),
  args: any[]
): string {
  const serialized = args.map((a) =>
    a === undefined ? 'undefined' : JSON.stringify(a)
  )
  if (typeof fn === 'string') {
    return looksLikeFunction(fn) ? `(${fn})(${serialized.join(',')})` : fn
  }
  return `(${fn.toString()})(${serialized.join(',')})`
}

// ---------------------------------------------------------------------------
// Playwright-shaped network objects.
// ---------------------------------------------------------------------------

export class Request {
  _response: Response | null = null
  _failure: string | null = null
  constructor(
    private _page: Page,
    readonly _id: string,
    private _url: string,
    private _method: string,
    private _headers: Record<string, string>,
    private _postData: string | undefined,
    private _resourceType: string,
    private _navigation: boolean
  ) {}
  url() {
    return this._url
  }
  method() {
    return this._method
  }
  headers() {
    return Object.fromEntries(
      Object.entries(this._headers).map(([k, v]) => [k.toLowerCase(), v])
    )
  }
  async allHeaders() {
    return this.headers()
  }
  async headerValue(name: string) {
    return this.headers()[name.toLowerCase()] ?? null
  }
  postData() {
    return this._postData ?? null
  }
  postDataBuffer() {
    return this._postData === undefined ? null : Buffer.from(this._postData)
  }
  resourceType() {
    return this._resourceType
  }
  isNavigationRequest() {
    return this._navigation
  }
  async response() {
    return this._response
  }
  failure() {
    return this._failure ? { errorText: this._failure } : null
  }
  frame() {
    return this._page
  }
}

export class Response {
  constructor(
    private _page: Page,
    private _request: Request,
    private _status: number,
    private _statusText: string,
    private _headers: Record<string, string>
  ) {}
  url() {
    return this._request.url()
  }
  status() {
    return this._status
  }
  statusText() {
    return this._statusText
  }
  ok() {
    return this._status === 0 || (this._status >= 200 && this._status <= 299)
  }
  headers() {
    return Object.fromEntries(
      Object.entries(this._headers).map(([k, v]) => [k.toLowerCase(), v])
    )
  }
  async allHeaders() {
    return this.headers()
  }
  async headerValue(name: string) {
    return this.headers()[name.toLowerCase()] ?? null
  }
  request() {
    return this._request
  }
  async body(): Promise<Buffer> {
    const res = await this._page._cdp('Network.getResponseBody', {
      requestId: this._request._id,
    })
    return Buffer.from(res.body, res.base64Encoded ? 'base64' : 'utf8')
  }
  async text() {
    return (await this.body()).toString('utf8')
  }
  async json() {
    return JSON.parse(await this.text())
  }
  frame() {
    return this._page
  }
}

/** Result of `page.request.fetch`, shaped like Playwright's `APIResponse`. */
export class APIResponse {
  constructor(
    private _res: globalThis.Response,
    private _body: Buffer
  ) {}
  url() {
    return this._res.url
  }
  status() {
    return this._res.status
  }
  statusText() {
    return this._res.statusText
  }
  ok() {
    return this._res.ok
  }
  headers() {
    return Object.fromEntries(this._res.headers.entries())
  }
  async body() {
    return this._body
  }
  async text() {
    return this._body.toString('utf8')
  }
  async json() {
    return JSON.parse(this._body.toString('utf8'))
  }
}

export class Route {
  private handled = false
  constructor(
    private _page: Page,
    private _request: Request,
    private _fetchId: string
  ) {}
  request() {
    return this._request
  }
  async continue(options?: {
    headers?: Record<string, string>
    url?: string
    method?: string
    postData?: string
  }) {
    if (this.handled) return
    this.handled = true
    const headers = options?.headers
    await this._page._cdp('Fetch.continueRequest', {
      requestId: this._fetchId,
      ...(options?.url ? { url: options.url } : {}),
      ...(options?.method ? { method: options.method } : {}),
      ...(options?.postData
        ? { postData: Buffer.from(options.postData).toString('base64') }
        : {}),
      ...(headers
        ? {
            headers: Object.entries(headers).map(([name, value]) => ({
              name,
              value,
            })),
          }
        : {}),
    })
  }
  async fallback() {
    return this.continue()
  }
  async abort(errorCode = 'Failed') {
    if (this.handled) return
    this.handled = true
    await this._page._cdp('Fetch.failRequest', {
      requestId: this._fetchId,
      errorReason: errorCode === 'aborted' ? 'Aborted' : 'Failed',
    })
  }
  async fulfill(options: {
    status?: number
    headers?: Record<string, string>
    contentType?: string
    body?: string | Buffer
    response?: APIResponse
  }) {
    if (this.handled) return
    this.handled = true
    let body = options.body
    let status = options.status
    let headers = { ...(options.headers ?? {}) }
    if (options.response) {
      body ??= await options.response.body()
      status ??= options.response.status()
      headers = { ...options.response.headers(), ...headers }
      // The body is already decoded and has its own length.
      delete headers['content-encoding']
      delete headers['content-length']
      delete headers['transfer-encoding']
    }
    if (options.contentType) headers['content-type'] = options.contentType
    await this._page._cdp('Fetch.fulfillRequest', {
      requestId: this._fetchId,
      responseCode: status ?? 200,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
      body: Buffer.from(body ?? '').toString('base64'),
    })
  }
}

// ---------------------------------------------------------------------------
// Elements and locators.
// ---------------------------------------------------------------------------

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  Space: 32,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
}

/** An element addressed by selector and index; resolved again on each call. */
export class ElementHandle {
  constructor(
    readonly _page: Page,
    readonly selector: string,
    readonly index = 0
  ) {}

  private pick() {
    return `__nextTestQA.qa(${JSON.stringify(this.selector)})[${this.index}]`
  }

  /** Runs `body` (an expression using `el`) page-side against this element. */
  async _run<T = any>(body: string): Promise<T> {
    return this._page.evaluate(
      `(() => { ${PAGE_HELPERS}; const el = ${this.pick()}; if (!el) throw new Error('element not found: ' + ${JSON.stringify(this.selector)}); return (${body}) })()`
    )
  }

  async evaluate<T = any>(fn: (el: any, ...args: any[]) => T, ...args: any[]) {
    const serialized = args.map((a) => JSON.stringify(a)).join(',')
    return this._run<T>(
      `(${fn.toString()})(el${serialized ? ',' + serialized : ''})`
    )
  }
  innerText() {
    return this._run<string>('el.innerText')
  }
  text() {
    return this.innerText()
  }
  textContent() {
    return this._run<string | null>('el.textContent')
  }
  inputValue() {
    return this._run<string>('el.value')
  }
  getAttribute(name: string) {
    return this._run<string | null>(`el.getAttribute(${JSON.stringify(name)})`)
  }
  isVisible() {
    return this._page
      .evaluate(
        `(() => { ${PAGE_HELPERS}; const el = ${this.pick()}; return !!el && __nextTestQA.isVisible(el) })()`
      )
      .catch(() => false)
  }
  getComputedCss(prop: string) {
    return this._run<string | null>(
      `getComputedStyle(el)[${JSON.stringify(prop)}] || null`
    )
  }
  async focus() {
    await this._run('el.focus()')
  }
  private async center() {
    return this._run<{ x: number; y: number }>(
      `(() => { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
    )
  }
  async hover() {
    const { x, y } = await this.center()
    await this._page._cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    })
  }
  async click(options?: { button?: 'left' | 'right'; clickCount?: number }) {
    if (this.index === 0 && /^[#.\w\[\]="'-]+$/.test(this.selector)) {
      // Plain CSS selector: let Bun wait for the element to be actionable.
      try {
        await this._page._run((v) => v.click(this.selector, options as any))
        return
      } catch {
        // Not found by Bun's matcher (e.g. inside a shadow root): fall through.
      }
    }
    const { x, y } = await this.center()
    await this._page._run((v) => v.click(x, y, options as any))
  }
  async type(text: string) {
    await this.focus()
    await this._page.typeText(text)
  }
  async fill(value: string) {
    await this._run(
      `(() => { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) })()`
    )
  }
  async dispatchEvent(type: string) {
    await this._run(
      `el.dispatchEvent(new Event(${JSON.stringify(type)}, { bubbles: true, cancelable: true }))`
    )
  }
  async press(key: string) {
    await this.focus()
    await this._page.keyboard.press(key)
  }
}

export class Locator {
  constructor(
    private _page: Page,
    private _selector: string,
    private _nth: number | null = null,
    private _hasText: string | RegExp | null = null
  ) {}

  private all() {
    const nth = this._nth
    const has = this._hasText
    const hasExpr =
      has === null
        ? 'true'
        : has instanceof RegExp
          ? `new RegExp(${JSON.stringify(has.source)}, ${JSON.stringify(has.flags)}).test(e.textContent || '')`
          : `(e.textContent || '').includes(${JSON.stringify(has)})`
    return `(() => { ${PAGE_HELPERS}; let els = __nextTestQA.qa(${JSON.stringify(this._selector)}).filter((e) => ${hasExpr}); ${
      nth === null
        ? ''
        : `els = ${nth < 0 ? `[els[els.length + (${nth})]]` : `[els[${nth}]]`}.filter(Boolean);`
    } return els })()`
  }
  private onFirst<T>(body: string, timeout = defaultTimeout): Promise<T> {
    return this._page.waitForExpression<T>(
      `(() => { const els = ${this.all()}; if (!els.length) return { __missing: true }; const el = els[0]; return { value: (${body}) } })()`,
      timeout,
      (v: any) => !v?.__missing,
      this._selector
    ).then((v: any) => v.value)
  }
  first() {
    return new Locator(this._page, this._selector, 0, this._hasText)
  }
  last() {
    return new Locator(this._page, this._selector, -1, this._hasText)
  }
  nth(n: number) {
    return new Locator(this._page, this._selector, n, this._hasText)
  }
  filter(opts: { hasText?: string | RegExp }) {
    return new Locator(
      this._page,
      this._selector,
      this._nth,
      opts.hasText ?? this._hasText
    )
  }
  locator(selector: string) {
    return new Locator(this._page, `${this._selector} ${selector}`)
  }
  async count(): Promise<number> {
    return this._page.evaluate(`${this.all()}.length`)
  }
  async isVisible(): Promise<boolean> {
    return this._page.evaluate(
      `(() => { const els = ${this.all()}; return els.length > 0 && __nextTestQA.isVisible(els[0]) })()`
    )
  }
  async isHidden() {
    return !(await this.isVisible())
  }
  textContent() {
    return this.onFirst<string | null>('el.textContent')
  }
  innerText() {
    return this.onFirst<string>('el.innerText')
  }
  inputValue() {
    return this.onFirst<string>('el.value')
  }
  getAttribute(name: string) {
    return this.onFirst<string | null>(
      `el.getAttribute(${JSON.stringify(name)})`
    )
  }
  async allTextContents(): Promise<string[]> {
    return this._page.evaluate(`${this.all()}.map((e) => e.textContent)`)
  }
  async evaluateAll<T = any>(fn: (els: any[], ...args: any[]) => T, ...args: any[]) {
    const serialized = args.map((a) => JSON.stringify(a)).join(',')
    return this._page.evaluate<T>(
      `(${fn.toString()})(${this.all()}${serialized ? ',' + serialized : ''})`
    )
  }
  async evaluate<T = any>(fn: (el: any, ...args: any[]) => T, ...args: any[]) {
    const serialized = args.map((a) => JSON.stringify(a)).join(',')
    return this.onFirst<T>(
      `(${fn.toString()})(el${serialized ? ',' + serialized : ''})`
    )
  }
  async waitFor(options?: {
    state?: 'attached' | 'detached' | 'visible' | 'hidden'
    timeout?: number
  }) {
    await this._page.waitForSelector(this._selector, {
      ...options,
      locator: this,
    } as any)
  }
  private async handle() {
    await this.waitFor({ state: 'attached' })
    const idx = await this._page.evaluate<number>(
      `(() => { const all = __nextTestQA.qa(${JSON.stringify(this._selector)}); const els = ${this.all()}; return all.indexOf(els[0]) })()`
    )
    return new ElementHandle(this._page, this._selector, idx)
  }
  async click(options?: any) {
    await (await this.handle()).click(options)
  }
  async hover() {
    await (await this.handle()).hover()
  }
  async focus() {
    await (await this.handle()).focus()
  }
  async fill(value: string) {
    await (await this.handle()).fill(value)
  }
  async press(key: string) {
    await (await this.handle()).press(key)
  }
  async type(text: string) {
    await (await this.handle()).type(text)
  }
  /** Condition used by `waitForSelector` for state checks. */
  async _state() {
    return this._page.evaluate<{ attached: boolean; visible: boolean }>(
      `(() => { ${PAGE_HELPERS}; const els = ${this.all()}; return { attached: els.length > 0, visible: els.length > 0 && __nextTestQA.isVisible(els[0]) } })()`
    )
  }
}

// ---------------------------------------------------------------------------
// Page: Playwright-shaped wrapper around one Bun.WebView tab.
// ---------------------------------------------------------------------------

type PageEvent =
  | 'request'
  | 'requestfinished'
  | 'requestfailed'
  | 'response'
  | 'console'
  | 'pageerror'
  | 'crash'
  | 'websocket'
  | 'framedetached'

export class Page {
  private view: any
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private requests = new Map<string, Request>()
  private routes: Array<{
    matcher: (url: string) => boolean
    handler: (route: Route, request: Request) => any
  }> = []
  private fetchEnabled = false
  private inflight = new Set<string>()
  private lastNetworkActivity = Date.now()
  private evalQueue: Promise<unknown> = Promise.resolve()
  private cdpQueue: Promise<unknown> = Promise.resolve()
  private websockets = new Map<string, any>()
  private defaultTimeout = defaultTimeout
  private closed = false

  readonly keyboard = {
    down: (key: string) => this.key('keyDown', key),
    up: (key: string) => this.key('keyUp', key),
    press: async (key: string) => {
      await this.key('keyDown', key)
      await this.key('keyUp', key)
    },
  }
  readonly request = {
    fetch: async (
      request: Request | string,
      options?: { headers?: Record<string, string>; method?: string }
    ) => {
      const isReq = typeof request !== 'string'
      const res = await fetch(isReq ? request.url() : request, {
        method: options?.method ?? (isReq ? request.method() : 'GET'),
        headers: options?.headers ?? (isReq ? request.headers() : undefined),
        body: isReq ? (request.postDataBuffer() ?? undefined) : undefined,
        redirect: 'manual',
      })
      return new APIResponse(res, Buffer.from(await res.arrayBuffer()))
    },
  }

  constructor(opts: {
    locale: string
    userAgent?: string
    onConsole: (type: string, args: unknown[]) => void
  }) {
    const backend = getBackend(setupArgs.browserName)
    this.view = new (Bun as any).WebView({
      width: 1280,
      height: 720,
      backend,
      console: (type: string, ...args: unknown[]) =>
        opts.onConsole(type, args),
    })
  }

  // --- low level -----------------------------------------------------------

  _run<T>(fn: (view: any) => Promise<T>): Promise<T> {
    const next = this.evalQueue.then(() => fn(this.view))
    this.evalQueue = next.catch(() => {})
    return next
  }

  _cdp(method: string, params?: Record<string, unknown>): Promise<any> {
    const next = this.cdpQueue.then(() => this.view.cdp(method, params))
    this.cdpQueue = next.catch(() => {})
    return next
  }

  async init(options: {
    locale: string
    userAgent?: string
    javaScriptEnabled: boolean
    ignoreHTTPSErrors: boolean
    extraHTTPHeaders?: Record<string, string>
    disableCache?: boolean
    cpuThrottleRate?: number
  }) {
    // The first navigation establishes the CDP session.
    await this._run((v) => v.navigate('about:blank'))
    await this._cdp('Network.enable')
    await this._cdp('Runtime.enable')
    await this._cdp('Page.enable')
    this.view.addEventListener('Network.requestWillBeSent', (e: any) =>
      this.onRequestWillBeSent(e.data)
    )
    this.view.addEventListener('Network.responseReceived', (e: any) =>
      this.onResponseReceived(e.data)
    )
    this.view.addEventListener('Network.loadingFinished', (e: any) => {
      this.inflight.delete(e.data.requestId)
      this.lastNetworkActivity = Date.now()
      const req = this.requests.get(e.data.requestId)
      if (req) this.emit('requestfinished', req)
    })
    this.view.addEventListener('Network.loadingFailed', (e: any) => {
      this.inflight.delete(e.data.requestId)
      this.lastNetworkActivity = Date.now()
      const req = this.requests.get(e.data.requestId)
      if (req) {
        req._failure = e.data.errorText
        this.emit('requestfailed', req)
      }
    })
    this.view.addEventListener('Network.webSocketCreated', (e: any) => {
      const ws = new WebSocketInfo(e.data.url)
      this.websockets.set(e.data.requestId, ws)
      this.emit('websocket', ws)
    })
    this.view.addEventListener('Network.webSocketFrameReceived', (e: any) => {
      this.websockets.get(e.data.requestId)?.emit('framereceived', {
        payload:
          e.data.response.opcode === 2
            ? Buffer.from(e.data.response.payloadData, 'base64')
            : e.data.response.payloadData,
      })
    })
    this.view.addEventListener('Network.webSocketClosed', (e: any) => {
      this.websockets.get(e.data.requestId)?.emit('close')
    })
    this.view.addEventListener('Runtime.exceptionThrown', (e: any) => {
      const d = e.data.exceptionDetails
      this.emit(
        'pageerror',
        new Error(d.exception?.description ?? d.text ?? 'page error')
      )
    })
    this.view.addEventListener('Page.frameDetached', () =>
      this.emit('framedetached', this)
    )
    this.view.addEventListener('Inspector.targetCrashed', () =>
      this.emit('crash')
    )
    this.view.addEventListener('Fetch.requestPaused', (e: any) =>
      this.onRequestPaused(e.data)
    )

    if (options.locale)
      await this._cdp('Emulation.setLocaleOverride', {
        locale: options.locale,
      }).catch(() => {})
    if (options.userAgent)
      await this._cdp('Emulation.setUserAgentOverride', {
        userAgent: options.userAgent,
      })
    if (!options.javaScriptEnabled)
      await this._cdp('Emulation.setScriptExecutionDisabled', { value: true })
    if (options.ignoreHTTPSErrors)
      await this._cdp('Security.setIgnoreCertificateErrors', { ignore: true })
    if (options.extraHTTPHeaders)
      await this.setExtraHTTPHeaders(options.extraHTTPHeaders)
    if (options.disableCache)
      await this._cdp('Network.setCacheDisabled', { cacheDisabled: true })
    if (options.cpuThrottleRate)
      await this._cdp('Emulation.setCPUThrottlingRate', {
        rate: options.cpuThrottleRate,
      })
  }

  // --- events --------------------------------------------------------------

  on(event: PageEvent, cb: (...args: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
    return this
  }
  off(event: PageEvent, cb: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(cb)
    return this
  }
  removeListener(event: PageEvent, cb: (...args: any[]) => void) {
    return this.off(event, cb)
  }
  once(event: PageEvent, cb: (...args: any[]) => void) {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped)
      cb(...args)
    }
    return this.on(event, wrapped)
  }
  private emit(event: PageEvent, ...args: any[]) {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        cb(...args)
      } catch (err) {
        console.error(`page "${event}" listener threw`, err)
      }
    }
  }

  private onRequestWillBeSent(d: any) {
    this.inflight.add(d.requestId)
    this.lastNetworkActivity = Date.now()
    const req = new Request(
      this,
      d.requestId,
      d.request.url,
      d.request.method,
      d.request.headers ?? {},
      d.request.postData,
      String(d.type ?? 'other').toLowerCase(),
      d.type === 'Document' && d.requestId === d.loaderId
    )
    this.requests.set(d.requestId, req)
    this.emit('request', req)
  }

  private onResponseReceived(d: any) {
    const req = this.requests.get(d.requestId)
    if (!req) return
    const res = new Response(
      this,
      req,
      d.response.status,
      d.response.statusText,
      d.response.headers ?? {}
    )
    req._response = res
    this.emit('response', res)
  }

  private async onRequestPaused(d: any) {
    const req =
      (d.networkId && this.requests.get(d.networkId)) ||
      new Request(
        this,
        d.networkId ?? d.requestId,
        d.request.url,
        d.request.method,
        d.request.headers ?? {},
        d.request.postData,
        String(d.resourceType ?? 'other').toLowerCase(),
        false
      )
    const route = new Route(this, req, d.requestId)
    const match = this.routes.find((r) => r.matcher(req.url()))
    if (!match) {
      await route.continue().catch(() => {})
      return
    }
    try {
      await match.handler(route, req)
    } catch (err) {
      console.error('route handler threw', err)
      await route.continue().catch(() => {})
    }
  }

  async route(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route, request: Request) => any
  ) {
    const matcher =
      typeof pattern === 'function'
        ? (u: string) => pattern(new URL(u))
        : pattern instanceof RegExp
          ? (u: string) => pattern.test(u)
          : (u: string) =>
              new RegExp(
                '^' +
                  pattern
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*\*/g, '\u0000')
                    .replace(/\*/g, '[^/]*')
                    .replace(/\u0000/g, '.*') +
                  '$'
              ).test(u)
    this.routes.push({ matcher, handler })
    if (!this.fetchEnabled) {
      this.fetchEnabled = true
      await this._cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    }
  }
  async unroute(_pattern?: unknown, handler?: (...a: any[]) => any) {
    this.routes = handler
      ? this.routes.filter((r) => r.handler !== handler)
      : []
    if (this.routes.length === 0 && this.fetchEnabled) {
      this.fetchEnabled = false
      await this._cdp('Fetch.disable')
    }
  }

  // --- navigation ----------------------------------------------------------

  setDefaultTimeout(ms: number) {
    this.defaultTimeout = ms
  }
  setDefaultNavigationTimeout(_ms: number) {}

  async goto(url: string, _options?: { waitUntil?: string }) {
    await this._run((v) => v.navigate(url))
    return null
  }
  async goBack(_options?: unknown) {
    await this._run((v) => v.goBack())
    return null
  }
  async goForward(_options?: unknown) {
    await this._run((v) => v.goForward())
    return null
  }
  async reload(_options?: unknown) {
    await this._run((v) => v.reload())
    return null
  }
  url(): string {
    return this.view.url
  }
  async title(): Promise<string> {
    return this.view.title
  }
  async setViewportSize({ width, height }: { width: number; height: number }) {
    await this._run((v) => v.resize(width, height))
  }
  async setExtraHTTPHeaders(headers: Record<string, string>) {
    await this._cdp('Network.setExtraHTTPHeaders', { headers })
  }
  async close() {
    if (this.closed) return
    this.closed = true
    try {
      this.view.close()
    } catch {}
  }

  // --- evaluation and waiting ---------------------------------------------

  async evaluate<T = any>(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Promise<T> {
    const expression = toExpression(fn, args)
    return this._run((v) => v.evaluate(expression))
  }

  async waitForExpression<T>(
    expression: string,
    timeout: number,
    ok: (value: any) => boolean,
    what: string
  ): Promise<T> {
    const deadline = Date.now() + timeout
    let last: unknown
    for (;;) {
      try {
        const value = await this.evaluate(
          `(() => { ${PAGE_HELPERS}; return ${expression} })()`
        )
        if (ok(value)) return value as T
      } catch (err) {
        last = err
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timeout ${timeout}ms exceeded waiting for ${what}${
            last ? `: ${(last as Error).message}` : ''
          }`
        )
      }
      await sleep(50)
    }
  }

  async waitForFunction(snippet: string, options?: { timeout?: number }) {
    const timeout = options?.timeout ?? this.defaultTimeout
    await this.waitForExpression(
      looksLikeFunction(snippet) ? `(${snippet})()` : `(${snippet})`,
      timeout,
      Boolean,
      'function'
    )
  }

  async waitForLoadState(state: string = 'load') {
    if (state === 'networkidle') {
      for (;;) {
        if (this.inflight.size === 0 && Date.now() - this.lastNetworkActivity > 500)
          return
        await sleep(50)
      }
    }
    await this.waitForExpression(
      `document.readyState === 'complete'`,
      this.defaultTimeout,
      Boolean,
      'load state'
    ).catch(() => {})
  }

  async waitForSelector(
    selector: string,
    options?: {
      timeout?: number
      state?: 'attached' | 'visible' | 'hidden' | 'detached'
      locator?: Locator
    }
  ): Promise<ElementHandle | null> {
    const state = options?.state ?? 'visible'
    const timeout = options?.timeout ?? this.defaultTimeout
    const locator = options?.locator ?? new Locator(this, selector)
    const deadline = Date.now() + timeout
    for (;;) {
      const s = await locator._state().catch(() => ({
        attached: false,
        visible: false,
      }))
      const done =
        state === 'attached'
          ? s.attached
          : state === 'visible'
            ? s.visible
            : state === 'hidden'
              ? !s.visible
              : !s.attached
      if (done) {
        return state === 'attached' || state === 'visible'
          ? new ElementHandle(this, selector)
          : null
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timeout ${timeout}ms exceeded waiting for selector "${selector}" to be ${state}`
        )
      }
      await sleep(50)
    }
  }

  locator(selector: string, options?: { hasText?: string | RegExp }) {
    return new Locator(this, selector, null, options?.hasText ?? null)
  }
  getByRole(role: string, options?: { name?: string | RegExp }) {
    return new Locator(this, `[role="${role}"]`, null, options?.name ?? null)
  }
  async $$(selector: string): Promise<ElementHandle[]> {
    const count = await new Locator(this, selector).count()
    return Array.from(
      { length: count },
      (_, i) => new ElementHandle(this, selector, i)
    )
  }

  // --- input ---------------------------------------------------------------

  private async key(type: 'keyDown' | 'keyUp', key: string) {
    const code = KEY_CODES[key]
    const printable = key.length === 1
    await this._cdp('Input.dispatchKeyEvent', {
      type: type === 'keyDown' && printable ? 'keyDown' : type,
      key,
      ...(code ? { windowsVirtualKeyCode: code } : {}),
      ...(printable && type === 'keyDown' ? { text: key } : {}),
    })
  }

  async typeText(text: string) {
    for (const ch of text) {
      await this.key('keyDown', ch)
      await this.key('keyUp', ch)
    }
  }

  // --- cookies -------------------------------------------------------------

  async addCookies(cookies: Array<{ name: string; value: string; domain?: string; path?: string }>) {
    for (const c of cookies) await this._cdp('Network.setCookie', c)
  }
  async clearCookies() {
    await this._cdp('Network.clearBrowserCookies')
  }
}

class WebSocketInfo {
  private cbs = new Map<string, Set<(...a: any[]) => void>>()
  constructor(private _url: string) {}
  url() {
    return this._url
  }
  on(event: string, cb: (...a: any[]) => void) {
    if (!this.cbs.has(event)) this.cbs.set(event, new Set())
    this.cbs.get(event)!.add(cb)
  }
  emit(event: string, ...args: any[]) {
    this.cbs.get(event)?.forEach((cb) => cb(...args))
  }
}

// ---------------------------------------------------------------------------
// The chainable test-facing interface (unchanged from the Playwright driver).
// ---------------------------------------------------------------------------

interface ElementHandleExt extends ElementHandle {}

export type ElementByCssOpts = {
  timeout?: number
  /** @default 'visible' */
  state?: 'attached' | 'visible' | 'hidden'
  /** @default 'load' */
  waitUntil?: false | 'load' | 'domcontentloaded' | 'networkidle'
}

export type PlaywrightNavigationWaitUntil =
  | 'load'
  | 'domcontentloaded'
  | 'networkidle'
  | 'commit'

export class Playwright<TCurrent = undefined> {
  private eventCallbacks: Record<EventType, Set<(...args: any[]) => void>> = {
    request: new Set(),
    response: new Set(),
  }

  on(event: 'request', cb: (request: Request) => void | Promise<void>): void
  on(event: 'response', cb: (request: Response) => void | Promise<void>): void
  on(event: EventType, cb: (...args: any[]) => void) {
    if (!this.eventCallbacks[event]) {
      throw new Error(
        `Invalid event passed to browser.on, received ${event}. Valid events are ${Object.keys(
          this.eventCallbacks
        )}`
      )
    }
    this.eventCallbacks[event]?.add(cb)
  }

  off(event: 'request', cb: (request: Request) => void | Promise<void>): void
  off(event: 'response', cb: (request: Response) => void | Promise<void>): void
  off(event: EventType, cb: (...args: any[]) => void) {
    this.eventCallbacks[event]?.delete(cb)
  }

  async setup(
    browserName: string,
    locale: string,
    javaScriptEnabled: boolean,
    ignoreHTTPSErrors: boolean,
    userAgent: string | undefined,
    permissions: Permissions
  ) {
    if (process.env.DEVICE_NAME) {
      throw new Error(
        `DEVICE_NAME=${process.env.DEVICE_NAME}: device emulation is not supported by the Bun.WebView driver`
      )
    }
    if (browserName === 'firefox') {
      throw new Error(
        'BROWSER_NAME=firefox is not supported by Bun.WebView (chrome, or safari on macOS)'
      )
    }
    setupArgs = {
      browserName,
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      userAgent,
    }
    contextHasJSEnabled = javaScriptEnabled
    contextPermissions = permissions
  }

  async close(): Promise<void> {
    await page?.close()
  }

  async get(url: string): Promise<void> {
    await page!.goto(url)
  }

  async loadPage(
    url: string,
    opts?: {
      disableCache?: boolean
      cpuThrottleRate?: number
      pushErrorAsConsoleLog?: boolean
      /**
       * Suppress the harness from echoing the browser's console output to the
       * test's terminal (the `Browser Log:` lines). Browser logs are still
       * collected and available via `browser.log()`.
       */
      disableBrowserLog?: boolean
      beforePageLoad?: (page: Page) => void | Promise<void>
      extraHTTPHeaders?: Record<string, string>
      waitUntil?: PlaywrightNavigationWaitUntil
    }
  ) {
    await this.close()

    // A host mapping for deploy tests is a Chromium launch argument, which
    // `getBackend` reads from the environment.
    void PROXY_HOST_MAP_ENV_KEY

    pageLogs = []
    websocketFrames = []

    page = new Page({
      locale: setupArgs.locale,
      userAgent: setupArgs.userAgent,
      onConsole: (type, args) => {
        const values = args.map((a: any) =>
          a && typeof a === 'object'
            ? 'value' in a
              ? a.value
              : (a.description ?? a.className ?? a.type)
            : a
        )
        const text = values
          .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
          .join(' ')
        if (!opts?.disableBrowserLog) {
          debugPrint('Browser Log:', text)
        }
        pageLogs.push({ source: type, message: text, args: values })
      },
    })
    await page.init({
      locale: setupArgs.locale,
      userAgent: setupArgs.userAgent,
      javaScriptEnabled: contextHasJSEnabled,
      ignoreHTTPSErrors: setupArgs.ignoreHTTPSErrors,
      extraHTTPHeaders: opts?.extraHTTPHeaders,
      disableCache: opts?.disableCache,
      cpuThrottleRate: opts?.cpuThrottleRate,
    })
    void contextPermissions

    page.on('crash', () => console.error('page crashed'))
    page.on('pageerror', (error: Error) => {
      console.error('page error', error)
      if (opts?.pushErrorAsConsoleLog) {
        pageLogs.push({ source: 'error', message: error.message, args: [] })
      }
    })
    page.on('request', (req: Request) => {
      this.eventCallbacks.request.forEach((cb) => cb(req))
    })
    page.on('response', (res: Response) => {
      this.eventCallbacks.response.forEach((cb) => cb(res))
    })
    page.on('websocket', (ws: WebSocketInfo) => {
      ws.on('framereceived', (frame: { payload: string | Buffer }) => {
        websocketFrames.push({ payload: frame.payload })
      })
    })

    await opts?.beforePageLoad?.(page)

    await page.goto(url, { waitUntil: opts?.waitUntil ?? 'load' })
  }

  back(options?: unknown) {
    return this.startChain(async () => {
      await page!.goBack(options)
    })
  }
  forward(options?: unknown) {
    return this.startChain(async () => {
      await page!.goForward(options)
    })
  }
  refresh(_opts?: { waitUntil?: PlaywrightNavigationWaitUntil }) {
    return this.startChain(async () => {
      await page!.reload()
    })
  }
  /** Evict the browser HTTP cache via CDP (`Network.clearBrowserCache`). */
  clearBrowserCache() {
    return this.startChain(async () => {
      await page!._cdp('Network.clearBrowserCache')
    })
  }
  setDimensions({ width, height }: { height: number; width: number }) {
    return this.startOrPreserveChain(() =>
      page!.setViewportSize({ width, height })
    )
  }
  addCookie(opts: { name: string; value: string }) {
    return this.startOrPreserveChain(async () =>
      page!.addCookies([
        {
          path: '/',
          domain: await page!.evaluate('window.location.hostname'),
          ...opts,
        },
      ])
    )
  }
  deleteCookies() {
    return this.startOrPreserveChain(async () => page!.clearCookies())
  }

  private wrapElement(selector: string): ElementHandleExt {
    return new ElementHandle(page!, selector)
  }

  elementByCss(selector: string, opts?: ElementByCssOpts) {
    return this.waitForElementByCss(selector, {
      timeout: 5_000,
      ...opts,
    })
  }

  /** A replacement for `elementByCss` that doesn't wait for the page to fire "load". */
  elementByCssInstant(selector: string, opts?: ElementByCssOpts) {
    return this.waitForElementByCss(selector, {
      timeout: 10,
      waitUntil: false,
      ...opts,
    })
  }

  hasElementByCss(selector: string) {
    return this.startChain(() => page!.locator(selector).isVisible())
  }

  elementById(id: string) {
    return this.elementByCss(`#${id}`)
  }

  getValue(this: Playwright<ElementHandleExt>) {
    return this.continueChain((el) => el.inputValue())
  }

  text(this: Playwright<ElementHandleExt>) {
    return this.continueChain((el) => el.innerText())
  }

  type(this: Playwright<ElementHandleExt>, text: string) {
    return this.continueChain(async (el) => {
      await el.type(text)
      return el
    })
  }

  moveTo(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.hover()
      return el
    })
  }

  async getComputedCss(this: Playwright<ElementHandleExt>, prop: string) {
    return this.continueChain((el) => el.getComputedCss(prop))
  }

  async getAttribute(this: Playwright<ElementHandleExt>, attr: string) {
    return this.continueChain((el) => el.getAttribute(attr))
  }

  hasElementByCssSelector(selector: string) {
    return this.eval<boolean>(`!!document.querySelector('${selector}')`)
  }

  keydown(key: string) {
    return this.startOrPreserveChain(() => page!.keyboard.down(key))
  }

  keyup(key: string) {
    return this.startOrPreserveChain(() => page!.keyboard.up(key))
  }

  click(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.click()
      return el
    })
  }

  touchStart(this: Playwright<ElementHandleExt>) {
    return this.continueChain(async (el) => {
      await el.dispatchEvent('touchstart')
      return el
    })
  }

  elementsByCss(selector: string) {
    return this.startChain(async () => {
      const els = await page!.$$(selector)
      return els.map((el) => {
        const origGetAttribute = el.getAttribute.bind(el)
        // ensure getAttribute defaults to empty string to match selenium
        el.getAttribute = (name: string) =>
          origGetAttribute(name).then((val) => val || '') as Promise<any>
        return el
      })
    })
  }

  waitForElementByCss(selector: string, opts: number | ElementByCssOpts = {}) {
    const {
      timeout = 10_000,
      waitUntil = 'load', // TODO: we should get rid of this and fix the tests that implicitly rely on it
      // Selected elements may be in a completed boundary that React hasn't
      // revealed yet, so wait for visibility, except for metadata tags.
      state = selector.startsWith('base') ||
      selector.startsWith('link') ||
      selector.startsWith('meta') ||
      selector.startsWith('script') ||
      selector.startsWith('source') ||
      selector.startsWith('style') ||
      selector.startsWith('title')
        ? 'attached'
        : 'visible',
    } = typeof opts === 'number' ? { timeout: opts } : opts

    return this.startChain(async () => {
      await page!.waitForSelector(selector, { timeout, state })
      if (waitUntil !== false) {
        // it seems selenium waits longer and tests rely on this behavior
        // so we wait for the load event fire before returning
        await page!.waitForLoadState(waitUntil)
      }
      return this.wrapElement(selector)
    })
  }

  waitForCondition(snippet: string, timeout?: number) {
    return this.startOrPreserveChain(async () => {
      await page!.waitForFunction(snippet, { timeout })
    })
  }

  // TODO: this should default to unknown, but a lot of tests use and rely on the result being `any`
  eval<TFn extends (...args: any[]) => any>(
    fn: TFn,
    ...args: Parameters<TFn>
  ): Playwright<ReturnType<TFn>> & Promise<ReturnType<TFn>>
  eval<T = any>(fn: string, ...args: any[]): Playwright<T> & Promise<T>
  eval<T = any>(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Playwright<T> & Promise<T>
  eval(
    fn: string | ((...args: any[]) => any),
    ...args: any[]
  ): Playwright<any> & Promise<any> {
    return this.startChain(async () =>
      page!
        .evaluate(fn, ...args)
        .catch((err) => {
          console.error('eval error:', err)
          return null!
        })
        .finally(async () => {
          await page!.waitForLoadState()
        })
    )
  }

  async log<T extends boolean = false>(options?: { includeArgs?: T }) {
    return this.startChain(() =>
      options?.includeArgs
        ? Promise.all(pageLogs)
        : Promise.all(pageLogs).then((logs) =>
            logs.map(({ source, message }) => ({ source, message }))
          )
    ) as Promise<
      T extends true
        ? { source: string; message: string; args: unknown[] }[]
        : { source: string; message: string }[]
    >
  }

  async websocketFrames() {
    return this.startChain(() => websocketFrames)
  }

  async url() {
    return this.startChain(() => page!.url())
  }

  async waitForIdleNetwork() {
    return this.startOrPreserveChain(() => page!.waitForLoadState('networkidle'))
  }

  getByRole(role: string, options?: { name?: string | RegExp }) {
    return page!.getByRole(role, options)
  }

  locateRedbox(): Locator {
    return page!.locator(
      'nextjs-portal [aria-labelledby="nextjs__container_errors_label"]'
    )
  }

  locateDevToolsIndicator(): Locator {
    return page!.locator('nextjs-portal [data-nextjs-dev-tools-button]:visible')
  }

  locator(selector: string, options?: { hasText?: string | RegExp }) {
    return page!.locator(selector, options)
  }

  /** A call that expects to be chained after a previous call, because it needs its value. */
  private continueChain<TNext>(nextCall: (value: TCurrent) => Promise<TNext>) {
    return this._chain(true, nextCall)
  }

  /** Start a chain. If continuing, it overwrites the current chained value. */
  private startChain<TNext>(nextCall: () => TNext | Promise<TNext>) {
    return this._chain(false, nextCall)
  }

  /** Either start or continue a chain. If continuing, it preserves the current chained value. */
  private startOrPreserveChain(nextCall: () => Promise<void>) {
    return this._chain(false, async (value) => {
      await nextCall()
      return value
    })
  }

  // necessary for the type of the function below
  readonly [Symbol.toStringTag]: string = 'Playwright'

  private _chain<TNext>(
    this: Playwright<TCurrent>,
    mustBeChained: boolean,
    nextCall: (current: TCurrent) => TNext | Promise<TNext>
  ): Playwright<TNext> & Promise<TNext> {
    const syncError = new Error('next-browser-base-chain-error')

    type MaybeChained<T> = Playwright<T> & {
      promise?: Promise<T>
    }
    const self = this as MaybeChained<TCurrent>

    let currentPromise = self.promise
    if (!currentPromise) {
      if (mustBeChained) {
        throw new Error(
          'Expected this call to be chained after a previous call'
        )
      } else {
        currentPromise = Promise.resolve(undefined as TCurrent)
      }
    }

    const promise = currentPromise.then(nextCall).catch((reason: unknown) => {
      if (reason && typeof reason === 'object' && 'stack' in reason) {
        const syncCallStack = syncError.stack!.split(syncError.message)[1]
        reason.stack += `\n${syncCallStack}`
      }
      throw reason
    })

    function get(target: Playwright<TCurrent>, p: string | symbol): any {
      switch (p) {
        case 'promise':
          return promise
        case 'then':
          return promise.then.bind(promise)
        case 'catch':
          return promise.catch.bind(promise)
        case 'finally':
          return promise.finally.bind(promise)
        default:
          return target[p]
      }
    }

    // @ts-expect-error: we're changing `TCurrent` into TNext via proxy hacks
    return new Proxy(this, {
      get,
    })
  }
}
