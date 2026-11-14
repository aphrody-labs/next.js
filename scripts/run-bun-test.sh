#!/usr/bin/env bash
#
# Set up environment variables for a Next.js test run and exec bun test
# in a single hop, replacing this shell process.
#
# Usage:
#   scripts/run-jest.sh \
#     [--mode=<dev|start|deploy>] \
#     [--bundler=<webpack|turbo|rspack>] \
#     [--experimental] \
#     [--headless] \
#     -- [bun test args...]
#
# All arguments after `--` are forwarded verbatim to bun test.

set -eo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    --mode=dev|--mode=start|--mode=deploy)
      export NEXT_TEST_MODE="${1#--mode=}"
      ;;
    --mode=*)
      echo "run-jest.sh: unknown mode: ${1#--mode=}" >&2
      exit 1
      ;;
    --bundler=webpack)
      export IS_WEBPACK_TEST=1
      ;;
    --bundler=turbo)
      export IS_TURBOPACK_TEST=1
      ;;
    --bundler=rspack)
      export NEXT_RSPACK=1
      export NEXT_TEST_USE_RSPACK=1
      ;;
    --bundler=*)
      echo "run-jest.sh: unknown bundler: ${1#--bundler=}" >&2
      exit 1
      ;;
    --experimental)
      export __NEXT_CACHE_COMPONENTS=true
      ;;
    --headless)
      export HEADLESS=true
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "run-jest.sh: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

exec bun test --isolate --max-concurrency=1 "$@"
