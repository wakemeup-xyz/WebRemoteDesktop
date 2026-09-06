#!/bin/sh
set -eu

: "${TURN_USERNAME:?temporary TURN username is required}"
: "${TURN_PASSWORD:?temporary TURN password is required}"
: "${TURN_REALM:?isolated TURN realm is required}"

case "$TURN_REALM" in
  turn-loss-lab-*) ;;
  *) echo "refusing a non-fixture TURN realm" >&2; exit 64 ;;
esac

exec turnserver -n \
  --realm="$TURN_REALM" \
  --external-ip=127.0.0.1 \
  --min-port=51000 --max-port=51009 \
  --lt-cred-mech --user="${TURN_USERNAME}:${TURN_PASSWORD}" \
  --no-cli --no-tcp-relay --no-tls --no-dtls
