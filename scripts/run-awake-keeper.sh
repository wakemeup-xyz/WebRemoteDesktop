#!/bin/bash
set -euo pipefail

# Keep the Mac usable as a remote desktop host without forcing the panel on.
# -i prevents idle system sleep.
# -m prevents disk sleep.
# -s prevents system sleep while on AC power.
# Intentionally NO -d: display may sleep (saves power; capture may go black).
# Idle lock/password is a separate OS "Lock Screen" setting (prefer never require
# password after screensaver/display off). This script does not change that.
exec /usr/bin/caffeinate -ims
