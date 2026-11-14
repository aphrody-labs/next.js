const typecheckedRequire = require('./eslint-typechecked-require')
const noAmbiguousJSX = require('./eslint-no-ambiguous-jsx')

module.exports = {
  meta: { name: "@next/internal" },
  rules: {
    'no-ambiguous-jsx': noAmbiguousJSX,
    'typechecked-require': typecheckedRequire,
  },
}
