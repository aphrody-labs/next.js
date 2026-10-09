/**
 * Native Web Crypto token signing and hashing implementation.
 * Replaces legacy Node crypto with high-performance Web Standard `globalThis.crypto.subtle`.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replaceAll('-', '+').replaceAll('_', '/')
  while (b64.length % 4) {
    b64 += '='
  }
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Signs a payload using HMAC-SHA256 via Web Crypto (`globalThis.crypto.subtle`).
 * Returns a compact JWT token (header.payload.signature).
 */
export async function signToken(
  payload: string | Record<string, any>,
  secret: string | Uint8Array
): Promise<string> {
  const secretKey =
    typeof secret === 'string' ? textEncoder.encode(secret) : secret
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    secretKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const headerObj = { alg: 'HS256', typ: 'JWT' }
  const headerEncoded = base64UrlEncode(
    textEncoder.encode(JSON.stringify(headerObj))
  )

  const payloadString =
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  const payloadEncoded = base64UrlEncode(textEncoder.encode(payloadString))

  const dataToSign = textEncoder.encode(`${headerEncoded}.${payloadEncoded}`)
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, dataToSign)

  const signatureEncoded = base64UrlEncode(new Uint8Array(signature))
  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`
}

/**
 * Verifies a JWT token signed with HMAC-SHA256 via Web Crypto (`globalThis.crypto.subtle`).
 */
export async function verifyToken<T = any>(
  token: string,
  secret: string | Uint8Array
): Promise<{ valid: boolean; payload?: T }> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return { valid: false }
    }

    const [headerEncoded, payloadEncoded, signatureEncoded] = parts
    const secretKey =
      typeof secret === 'string' ? textEncoder.encode(secret) : secret
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      secretKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const dataToVerify = textEncoder.encode(
      `${headerEncoded}.${payloadEncoded}`
    )
    const signature = base64UrlDecode(signatureEncoded)

    const isValid = await globalThis.crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      dataToVerify
    )

    if (!isValid) {
      return { valid: false }
    }

    const payloadJson = textDecoder.decode(base64UrlDecode(payloadEncoded))
    const payload = JSON.parse(payloadJson) as T
    return { valid: true, payload }
  } catch {
    return { valid: false }
  }
}

/**
 * Hashes data using `globalThis.crypto.subtle.digest` and returns a hex string.
 */
export async function hashToken(
  data: string | Uint8Array,
  algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'
): Promise<string> {
  const bytes = typeof data === 'string' ? textEncoder.encode(data) : data
  const hashBuffer = await globalThis.crypto.subtle.digest(algorithm, bytes)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
