import {
  Bundler,
  finalizeBundlerFromConfig,
  isBunBundler,
  parseBundlerArgs,
} from './bundler'

describe('Bun bundler selection', () => {
  const saved = {
    NEXT_BUN: process.env.NEXT_BUN,
    NEXT_RSPACK: process.env.NEXT_RSPACK,
    NEXT_TEST_USE_RSPACK: process.env.NEXT_TEST_USE_RSPACK,
    TURBOPACK: process.env.TURBOPACK,
    IS_TURBOPACK_TEST: process.env.IS_TURBOPACK_TEST,
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

  it('maps --bun to the webpack pipeline and sets NEXT_BUN', () => {
    delete process.env.NEXT_BUN
    for (const key of [
      'NEXT_RSPACK',
      'NEXT_TEST_USE_RSPACK',
      'TURBOPACK',
      'IS_TURBOPACK_TEST',
    ]) {
      delete process.env[key]
    }
    expect(parseBundlerArgs({ bun: true })).toBe(Bundler.Webpack)
    expect(isBunBundler()).toBe(true)
    expect(parseBundlerArgs({ bun: true, webpack: true })).toBe(Bundler.Webpack)
  })
})
