#!/bin/bash
# Disable the official Oracle LaunchDaemon that crash-loops a second mysqld
# against the same datadir as the long-running mysqld_safe instance.
# Does NOT signal PID 51114 / mysqld_safe.
set -euo pipefail

LABEL=system/com.oracle.oss.mysql.mysqld

echo "==== before ===="
pgrep -lf mysqld || true
launchctl print "$LABEL" 2>/dev/null | grep -E 'state |pid |runs |last exit' || true

echo "==== bootout + disable ===="
launchctl bootout "$LABEL" 2>/dev/null || true
launchctl disable "$LABEL"

echo "==== after (2s) ===="
sleep 2
pgrep -lf mysqld || true
if launchctl print "$LABEL" >/tmp/wrd-mysql-daemon-print.txt 2>/dev/null; then
  grep -E 'state |pid |runs |disabled' /tmp/wrd-mysql-daemon-print.txt || true
else
  echo "daemon no longer printed (booted out)"
fi

echo "==== expect only mysqld_safe 51032 + mysqld 51114 ===="
SECOND=$(pgrep -f 'pid-file=/usr/local/mysql/data/mysqld.local.pid' || true)
if [ -n "$SECOND" ]; then
  echo "FAIL: second instance still present: $SECOND"
  exit 1
fi
if ! pgrep -f 'pid-file=/usr/local/mysql/data/MacStudio1deMacBook-Pro.local.pid' >/dev/null; then
  echo "FAIL: working mysqld 51114 lineage is gone"
  exit 1
fi
echo "OK: only the mysqld_safe instance remains"
python3 - <<'PY'
import socket
s=socket.socket(); s.settimeout(2)
try:
    s.connect(('127.0.0.1', 3306))
    print('3306 still accepting connections')
except Exception as e:
    print('3306 NOT accepting:', e)
finally:
    s.close()
PY
