import { BunBuildUnsupportedError, bunBuild, parseLoaderRequest } from '.'

describe('bun-build', () => {
  it('parses the loader requests of createEntrypoints', () => {
    expect(
      parseLoaderRequest(
        'next-client-pages-loader?absolutePagePath=private-next-pages%2Findex.tsx&page=%2F!'
      )
    ).toEqual({
      loader: 'next-client-pages-loader',
      options: { absolutePagePath: 'private-next-pages/index.tsx', page: '/' },
    })
    expect(parseLoaderRequest('private-next-pages/_app.tsx')).toBeNull()
  })

  it('refuses to run outside Bun', async () => {
    if (typeof (globalThis as any).Bun !== 'undefined') return
    await expect(bunBuild(null)).rejects.toThrow('not running on Bun')
  })

  it('names unsupported features', () => {
    expect(new BunBuildUnsupportedError('The App Router').message).toBe(
      'The App Router is not supported by the Bun bundler yet.'
    )
  })
})
