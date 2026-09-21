#!/usr/bin/env bash
#
# Install the built wheel into a clean interpreter and use it.
#
# The suites run with `pythonpath = ["src"]`, so they never touch the wheel. A
# packaging mistake - a module left out of the build target, a broken
# `__init__` re-export - passes every test and fails on the first `pip install`.
set -euo pipefail

temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
consumer="${temp}/consumer-py"

rm -rf "${consumer}"
python -m venv "${consumer}"

# Windows runners put the executables in Scripts/, everything else in bin/.
if [ -x "${consumer}/bin/python" ]; then
  python_bin="${consumer}/bin/python"
else
  python_bin="${consumer}/Scripts/python"
fi

"${python_bin}" -m pip install --quiet --upgrade pip
"${python_bin}" -m pip install --quiet "${temp}"/pydist/*.whl

"${python_bin}" - <<'PY'
import uplytech_license

names = getattr(uplytech_license, "__all__", None)
assert names, "the package declares no __all__"

missing = [name for name in names if not hasattr(uplytech_license, name)]
assert not missing, f"__all__ advertises names that do not exist: {missing}"

print(f"ok - wheel {uplytech_license.__version__}, {len(names)} exported names")
PY
