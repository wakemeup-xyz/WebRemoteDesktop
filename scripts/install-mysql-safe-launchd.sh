#!/bin/bash
# Install the mysqld_safe LaunchDaemon. Must run as root.
# Does not re-enable com.oracle.oss.mysql.mysqld.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ID=/usr/bin/id
CP=/bin/cp
CHMOD=/bin/chmod
CHOWN=/usr/sbin/chown
LAUNCHCTL=/bin/launchctl
SLEEP=/bin/sleep
PGREP=/usr/bin/pgrep
GREP=/usr/bin/grep

if [ "$($ID -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_SRC="$SRC_DIR/mysqld-safe-launchd.sh"
PLIST_SRC="$SRC_DIR/com.local.mysql.mysqld-safe.plist"
WRAPPER_DST=/usr/local/mysql/support-files/mysqld-safe-launchd.sh
PLIST_DST=/Library/LaunchDaemons/com.local.mysql.mysqld-safe.plist
LABEL=system/com.local.mysql.mysqld-safe
ORACLE=system/com.oracle.oss.mysql.mysqld

echo "==== refuse to enable the Oracle dual-datadir daemon ===="
$LAUNCHCTL disable "$ORACLE" 2>/dev/null || true
$LAUNCHCTL bootout "$ORACLE" 2>/dev/null || true

echo "==== install wrapper + plist ===="
$CP "$WRAPPER_SRC" "$WRAPPER_DST"
$CHMOD 755 "$WRAPPER_DST"
$CP "$PLIST_SRC" "$PLIST_DST"
$CHMOD 644 "$PLIST_DST"
$CHOWN root:wheel "$PLIST_DST" "$WRAPPER_DST"

echo "==== bootstrap (safe while 51114 is already up: wrapper waits) ===="
$LAUNCHCTL bootout "$LABEL" 2>/dev/null || true
$LAUNCHCTL bootstrap system "$PLIST_DST"
$LAUNCHCTL enable "$LABEL"
$LAUNCHCTL kickstart -k "$LABEL"

$SLEEP 2
echo "==== launchd ===="
$LAUNCHCTL print "$LABEL" | $GREP -E 'state |pid |runs |last exit' || true
echo "==== mysqld processes ===="
$PGREP -lf mysqld || true
echo "==== oracle still disabled? ===="
$LAUNCHCTL print-disabled system | $GREP mysql || true
echo "==== 3306 ===="
python3 - <<'PY'
import socket
s=socket.socket(); s.settimeout(2)
try:
    s.connect(('127.0.0.1', 3306)); print('3306 accepting')
except Exception as e:
    print('3306 FAIL', e)
finally:
    s.close()
PY
