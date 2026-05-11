#!/bin/bash
set -euo pipefail

# Keep the Mac usable as a remote desktop host.
# -d prevents display sleep, which avoids black/stalled screen capture.
# -i prevents idle system sleep.
# -m prevents disk sleep.
# -s prevents system sleep while on AC power.
exec /usr/bin/caffeinate -dims
