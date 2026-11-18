#!/bin/bash
# Prove automatiche. Uso, dalla cartella principale del repository:
#   python3 src/build.py && bash src/test/run.sh            (tutte)
#   bash src/test/run.sh v24test.py hrtest.py               (solo alcune)
# Serve Python 3 con Playwright (pip install playwright) e Node.js.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
python3 -m http.server 8765 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f "$ROOT/index_t.html"' EXIT
sleep 1
cd "$ROOT/src/test"
TESTS=("$@")
[ ${#TESTS[@]} -eq 0 ] && TESTS=(test_core.js bletest.py guidetest.py hrtest.py nocad.py v2test.py fulltest.py v23test.py v24test.py)
for t in "${TESTS[@]}"; do
  echo "== $t"
  if [[ $t == *.js ]]; then node "$t" 2>&1 | tail -30; else timeout 200 python3 "$t" 2>&1 | tail -40; fi
done
