#!/bin/sh
# Driving Berlin test suite: static checks, one headless start-up, drive + settings tests.
#   tools/test.sh               everything (the local server must run: python3 serve.py 8765)
#   tools/test.sh --list        test names
#   tools/test.sh --only drive.bridge --only static.imports
#   tools/test.sh --slow        also build_spots.py --dry-run (needs ../berlin_mesh_2025_wab)
# Exit code 0 = all passed (known failures listed, not counted), 1 = a failure.
cd "$(dirname "$0")/.." || exit 1
exec node tools/test.mjs "$@"
