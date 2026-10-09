import { describe, expect, it } from 'bun:test'
import { NextRequest } from './request'
import { NextResponse } from './response'
import {
  isHTMLRewriterAvailable,
  injectHeadWithHTMLRewriter,
  injectBodyWithHTMLRewriter,
  rewriteHtmlStream,
} from './html-rewriter'
import { signToken, verifyToken, hashToken } from './tokens'

describe('Bun Native Web Standard Exploitation', () => {
  describe('NextRequest and NextResponse with native Bun Request/Response', () => {
    it('creates NextRequest directly backed by Bun native Request', async () => {
      const req = new NextRequest('http://localhost:3000/api/hello', {
        headers: { 'x-custom': 'bun-accelerated' },
      })

      expect(req).toBeInstanceOf(Request)
      expect(req.toNativeRequest()).toBeInstanceOf(Request)
      expect(req.headers.get('x-custom')).toBe('bun-accelerated')
      expect(req.nextUrl.pathname).toBe('/api/hello')
    })

    it('creates NextResponse directly backed by Bun native Response', async () => {
      const res = NextResponse.json(
        { message: 'hello from Bun' },
        { status: 201 }
      )

      expect(res).toBeInstanceOf(Response)
      expect(res.toNativeResponse()).toBeInstanceOf(Response)
      expect(res.status).toBe(201)

      const json = await res.json()
      expect(json).toEqual({ message: 'hello from Bun' })
    })

    it('supports NextResponse.redirect and NextResponse.rewrite', () => {
      const redirect = NextResponse.redirect('http://localhost:3000/login', 307)
      expect(redirect.status).toBe(307)
      expect(redirect.headers.get('location')).toBe(
        'http://localhost:3000/login'
      )

      const rewrite = NextResponse.rewrite(
        'http://localhost:3000/internal-dest'
      )
      expect(rewrite.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3000/internal-dest'
      )
    })
  })

  describe('Bun native HTMLRewriter for streaming SSR rewrites', () => {
    it('detects native HTMLRewriter in Bun', () => {
      expect(isHTMLRewriterAvailable()).toBe(true)
    })

    it('injects scripts into <head> with streaming HTMLRewriter', async () => {
      const html =
        '<!DOCTYPE html><html><head><title>App</title></head><body><h1>Content</h1></body></html>'
      const stream = new Response(html).body!

      const transformed = injectHeadWithHTMLRewriter(
        stream,
        () => '<script src="/bundle.js"></script>'
      )
      const result = await new Response(transformed).text()

      expect(result).toContain('<script src="/bundle.js"></script></head>')
    })

    it('injects scripts into <body> with streaming HTMLRewriter', async () => {
      const html =
        '<!DOCTYPE html><html><head></head><body><h1>Content</h1></body></html>'
      const stream = new Response(html).body!

      const transformed = injectBodyWithHTMLRewriter(
        stream,
        () => '<script>window.__BOOTSTRAP=true</script>'
      )
      const result = await new Response(transformed).text()

      expect(result).toContain(
        '<script>window.__BOOTSTRAP=true</script></body>'
      )
    })

    it('rewrites attributes and elements dynamically', async () => {
      const html =
        '<html><head></head><body><div id="root">Initial</div></body></html>'
      const stream = new Response(html).body!

      const transformed = rewriteHtmlStream(stream, (rewriter) => {
        rewriter.on('#root', {
          element(el) {
            el.setAttribute('data-bun', 'accelerated')
            el.setInnerContent('Hydrated by Bun', { html: true })
          },
        })
      })

      const result = await new Response(transformed).text()
      expect(result).toContain(
        '<div id="root" data-bun="accelerated">Hydrated by Bun</div>'
      )
    })
  })

  describe('Web Standard SubtleCrypto for token signing and hashing', () => {
    it('signs and verifies tokens using globalThis.crypto.subtle (HMAC-SHA256)', async () => {
      const secret = 'super-secure-aphrody-bun-secret'
      const payload = {
        userId: '12345',
        role: 'admin',
        exp: Date.now() + 3600000,
      }

      const token = await signToken(payload, secret)
      expect(typeof token).toBe('string')
      expect(token.split('.').length).toBe(3)

      const verified = await verifyToken(token, secret)
      expect(verified.valid).toBe(true)
      expect(verified.payload.userId).toBe('12345')
      expect(verified.payload.role).toBe('admin')

      const invalid = await verifyToken(token, 'wrong-secret')
      expect(invalid.valid).toBe(false)
    })

    it('hashes tokens using globalThis.crypto.subtle.digest (SHA-256)', async () => {
      const data = 'cache-key-for-nextjs-page'
      const hash = await hashToken(data, 'SHA-256')

      expect(typeof hash).toBe('string')
      expect(hash.length).toBe(64) // SHA-256 hex length

      // Verify deterministic
      const hash2 = await hashToken(data, 'SHA-256')
      expect(hash).toBe(hash2)
    })
  })
})
