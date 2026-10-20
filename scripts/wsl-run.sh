#!/usr/bin/env bash
# Repo tasks that need Node/Python and POSIX paths: setup, check, build.
#
# Called by scripts/dev.ps1 through `wsl.exe` when the repo lives inside WSL, or run directly on
# Linux/macOS/WSL:  bash scripts/wsl-run.sh <task>
#
# Why not Windows-native: __build__.py rewrites imports with `file.replace(f'{DIR_WEB}/', '')`
# (see __build__.py, "Cleaning Imports"), which only works with '/' path separators.
set -euo pipefail
cd "$(dirname "$0")/.."

# Non-interactive shells (wsl.exe -- bash ...) skip ~/.bashrc, so they miss nvm's Node and may find
# an older system Node instead (/usr/bin/node). Load nvm's default Node when nvm is installed.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' is not on PATH." >&2; exit 2; }
}

ensure_deps() {
  need node
  if [ ! -f node_modules/typescript/bin/tsc ]; then
    echo "ERROR: node_modules is missing. Run 'make setup' (npm ci) first." >&2
    exit 2
  fi
  # Idempotent: re-exports the LiteGraph types the published typings forget to export.
  node scripts/patch-frontend-types.mjs >/dev/null
}

step() { printf '\n== %s\n' "$1"; }

typecheck() {
  ensure_deps
  step "TypeScript type check (tsc --noEmit)"
  node ./node_modules/typescript/bin/tsc --noEmit -p .
  echo "OK: no type errors"
}

test_node() {
  need node
  step "Unit tests (node --test tests/node, Node $(node -v))"
  # The tests import TypeScript directly; Node strips the types itself from 23.6 on (22.6+ with a flag).
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  local flags=(--disable-warning=MODULE_TYPELESS_PACKAGE_JSON)
  if [ "$major" -lt 22 ]; then
    echo "ERROR: Node $(node -v) cannot run TypeScript tests; install Node 22.6+ (nvm install 24)." >&2
    exit 2
  elif [ "$major" -lt 24 ]; then
    flags+=(--experimental-strip-types)
  fi
  node "${flags[@]}" --test tests/node/*.test.ts
}

test_python() {
  need python3
  step "Python tests (unittest tests/python)"
  PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/python -v
}

pycompile() {
  need python3
  step "Python syntax check (py/, __init__.py, prestartup_script.py)"
  python3 - <<'PY'
import pathlib, sys
files = [pathlib.Path("__init__.py"), pathlib.Path("prestartup_script.py"), *sorted(pathlib.Path("py").rglob("*.py"))]
bad = 0
for f in files:
    try:
        compile(f.read_text(encoding="utf-8"), str(f), "exec")
    except SyntaxError as e:
        bad += 1
        print(f"SYNTAX ERROR {f}:{e.lineno}: {e.msg}")
print(f"OK: {len(files) - bad}/{len(files)} files compile" if not bad else f"FAILED: {bad} file(s)")
sys.exit(1 if bad else 0)
PY
}

case "${1:-}" in
  setup)
    need node; need npm
    step "npm ci (exact versions from package-lock.json)"
    npm ci --no-audit --no-fund
    node scripts/patch-frontend-types.mjs
    ;;
  typecheck) typecheck ;;
  test-node) test_node ;;
  test-python) test_python ;;
  pycompile) pycompile ;;
  check)
    typecheck
    test_node
    test_python
    pycompile
    printf '\nAll checks passed.\n'
    ;;
  build)
    need python3
    ensure_deps
    step "Build: python3 __build__.py --no-tests (src_web -> web)"
    # -B: do not write __pycache__ for the py/ modules __build__.py imports.
    python3 -B __build__.py --no-tests
    ;;
  *)
    echo "usage: bash scripts/wsl-run.sh {setup|check|build|typecheck|test-node|test-python|pycompile}" >&2
    exit 2
    ;;
esac
