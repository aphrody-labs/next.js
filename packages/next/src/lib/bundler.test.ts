import { Bundler, finalizeBundlerFromConfig, isBunBundler } from './bundler'

describe('Bun bundler selection', () => {
  const saved = {
    NEXT_BUN: process.env.NEXT_BUN,
    NEXT_RSPACK: process.env.NEXT_RSPACK,
  }
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('is off unless NEXT_BUN is set', () => {
    delete process.env.NEXT_BUN
    expect(isBunBundler()).toBe(false)
    process.env.NEXT_BUN = '0'
    expect(isBunBundler()).toBe(false)
    process.env.NEXT_BUN = '1'
    expect(isBunBundler()).toBe(true)
  })

  it('runs the webpack pipeline, whose compile step is Bun.build', () => {
    process.env.NEXT_BUN = '1'
    expect(finalizeBundlerFromConfig(Bundler.Turbopack)).toBe(Bundler.Webpack)
    expect(finalizeBundlerFromConfig(Bundler.Webpack)).toBe(Bundler.Webpack)
  })

  it('leaves the bundler alone without NEXT_BUN', () => {
    delete process.env.NEXT_BUN
    delete process.env.NEXT_RSPACK
    expect(finalizeBundlerFromConfig(Bundler.Turbopack)).toBe(Bundler.Turbopack)
  })
})
