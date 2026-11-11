#!/usr/bin/env sh
# Runs ESLint exactly like the GitHub action: WazeDev/Eslint-Config in ./lint,
# the scripts are copied there because ESLint ignores files outside the config dir.
# Usage: ./lint.sh [eslint options], e.g. ./lint.sh --fix (fixes are copied back)
set -e
cd "$(dirname "$0")"

[ -d lint ] || git clone -q --depth 1 https://github.com/WazeDev/Eslint-Config.git lint
git -C lint pull -q --ff-only
[ -d lint/node_modules ] || (cd lint && npm install --no-audit --no-fund)

cp ./*.js lint/
status=0
(cd lint && npx eslint ./*.js --config eslint.config.mjs "$@") || status=$?

case " $* " in
  *" --fix "*) for f in ./*.js; do cp "lint/$f" "$f"; done ;;
esac
exit $status
