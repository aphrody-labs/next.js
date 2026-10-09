import type { I18NConfig } from '../../config-shared'
import { NextURL } from '../next-url'
import { toNodeOutgoingHttpHeaders, validateURL } from '../utils'
import { RemovedUAError, RemovedPageError } from '../error'
import { RequestCookies } from './cookies'

export const INTERNALS = Symbol('internal request')

/**
 * This class extends the [Web `Request` API](https://developer.mozilla.org/docs/Web/API/Request) with additional convenience methods.
 *
 * Read more: [Next.js Docs: `NextRequest`](https://nextjs.org/docs/app/api-reference/functions/next-request)
 */
export class NextRequest extends Request {
  /** @internal */
  [INTERNALS]: {
    cookies: RequestCookies
    url: string
    nextUrl: NextURL
  }

  constructor(input: URL | RequestInfo, init: RequestInit = {}) {
    const url =
      typeof input !== 'string' && 'url' in input ? input.url : String(input)

    validateURL(url)

    // node Request instance requires duplex option when a body
    // is present or it errors, we don't handle this for
    // Request being passed in since it would have already
    // errored if this wasn't configured. Bun does not require duplex: 'half'.
    if (process.env.NEXT_RUNTIME !== 'edge' && !process.versions?.bun) {
      if (init.body && init.duplex !== 'half') {
        init.duplex = 'half'
      }
    }

    // On Bun, directly leverage underlying native Request if input wraps one
    const nativeReq =
      Boolean(process.versions?.bun) &&
      input &&
      typeof input === 'object' &&
      ('_nativeRequest' in input
        ? (input as any)._nativeRequest
        : 'request' in input && (input as any).request instanceof Request
          ? (input as any).request
          : undefined)

    const effectiveInput = nativeReq instanceof Request ? nativeReq : input
    if (effectiveInput instanceof Request) super(effectiveInput, init)
    else super(url, init)

    const nextUrl = new NextURL(url, {
      headers: toNodeOutgoingHttpHeaders(this.headers),
      nextConfig: init.nextConfig,
    })
    this[INTERNALS] = {
      cookies: new RequestCookies(this.headers),
      nextUrl,
      url: process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE
        ? url
        : nextUrl.toString(),
    }
  }

  [Symbol.for('edge-runtime.inspect.custom')]() {
    return {
      cookies: this.cookies,
      nextUrl: this.nextUrl,
      url: this.url,
      // rest of props come from Request
      bodyUsed: this.bodyUsed,
      cache: this.cache,
      credentials: this.credentials,
      destination: this.destination,
      headers: Object.fromEntries(this.headers),
      integrity: this.integrity,
      keepalive: this.keepalive,
      method: this.method,
      mode: this.mode,
      redirect: this.redirect,
      referrer: this.referrer,
      referrerPolicy: this.referrerPolicy,
      signal: this.signal,
    }
  }

  public get cookies() {
    return this[INTERNALS].cookies
  }

  public get nextUrl() {
    return this[INTERNALS].nextUrl
  }

  /**
   * @deprecated
   * `page` has been deprecated in favour of `URLPattern`.
   * Read more: https://nextjs.org/docs/messages/middleware-request-page
   */
  public get page() {
    throw new RemovedPageError()
  }

  /**
   * @deprecated
   * `ua` has been removed in favour of \`userAgent\` function.
   * Read more: https://nextjs.org/docs/messages/middleware-parse-user-agent
   */
  public get ua() {
    throw new RemovedUAError()
  }

  public get url() {
    return this[INTERNALS].url
  }

  /**
   * Returns this request as a native Web Request instance.
   * On Bun, this directly exposes the native C++ Request.
   */
  public toNativeRequest(): Request {
    return this
  }

  /**
   * Constructs a NextRequest directly from an input or native Request.
   */
  public static from(
    input: URL | RequestInfo | NextRequest,
    init?: RequestInit
  ): NextRequest {
    if (input instanceof NextRequest && !init) {
      return input
    }
    return new NextRequest(input, init)
  }
}

export interface RequestInit extends globalThis.RequestInit {
  nextConfig?: {
    basePath?: string
    i18n?: I18NConfig | null
    trailingSlash?: boolean
  }
  signal?: AbortSignal
  // see https://github.com/whatwg/fetch/pull/1457
  duplex?: 'half'
}
