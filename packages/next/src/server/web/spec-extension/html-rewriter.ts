/**
 * Bun native `HTMLRewriter` streaming HTML rewriting and script injection.
 * Powered by Bun's native C++ lol-html parser for zero-overhead HTML transforms.
 */

// Declare native Bun HTMLRewriter type
declare class HTMLRewriter {
  constructor()
  on(
    selector: string,
    handlers: {
      element?: (element: HTMLRewriterElement) => void | Promise<void>
      comments?: (comment: any) => void | Promise<void>
      text?: (text: any) => void | Promise<void>
    }
  ): this
  transform(response: Response): Response
}

interface HTMLRewriterElement {
  tagName: string
  attributes: Iterable<[string, string]>
  before(content: string, options?: { html?: boolean }): void
  after(content: string, options?: { html?: boolean }): void
  prepend(content: string, options?: { html?: boolean }): void
  append(content: string, options?: { html?: boolean }): void
  setInnerContent(content: string, options?: { html?: boolean }): void
  remove(): void
  removeAndKeepContent(): void
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Returns true if Bun's native HTMLRewriter is available in current runtime.
 */
export function isHTMLRewriterAvailable(): boolean {
  return typeof HTMLRewriter !== 'undefined'
}

/**
 * Rewrites a readable HTML stream using Bun's native HTMLRewriter.
 */
export function rewriteHtmlStream(
  stream: ReadableStream<Uint8Array>,
  setup: (rewriter: HTMLRewriter) => void
): ReadableStream<Uint8Array> {
  if (typeof HTMLRewriter === 'undefined') {
    return stream
  }

  const rewriter = new HTMLRewriter()
  setup(rewriter)
  const response = rewriter.transform(new Response(stream))
  return response.body ?? stream
}

/**
 * Injects scripts or tags into `<head>` using native HTMLRewriter streaming parser.
 */
export function injectHeadWithHTMLRewriter(
  stream: ReadableStream<Uint8Array>,
  getHeadContent: () => string | Promise<string>
): ReadableStream<Uint8Array> {
  if (typeof HTMLRewriter === 'undefined') {
    return stream
  }

  return rewriteHtmlStream(stream, (rewriter) => {
    rewriter.on('head', {
      async element(el) {
        const content = await getHeadContent()
        if (content) {
          el.append(content, { html: true })
        }
      },
    })
  })
}

/**
 * Injects scripts before `</body>` using native HTMLRewriter streaming parser.
 */
export function injectBodyWithHTMLRewriter(
  stream: ReadableStream<Uint8Array>,
  getBodyContent: () => string | Promise<string>
): ReadableStream<Uint8Array> {
  if (typeof HTMLRewriter === 'undefined') {
    return stream
  }

  return rewriteHtmlStream(stream, (rewriter) => {
    rewriter.on('body', {
      async element(el) {
        const content = await getBodyContent()
        if (content) {
          el.append(content, { html: true })
        }
      },
    })
  })
}
