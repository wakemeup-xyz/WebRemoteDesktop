# Open-Source Release Checklist

## Secrets

- Rotate `JWT_SECRET`
- Rotate `VIEWER_ACCESS_PASSWORD`
- Rotate `HOST_SHARED_SECRET`
- Rotate `TURN_USERNAME` / `TURN_CREDENTIAL`
- Remove deprecated compatibility secrets such as `ACCESS_PASSWORD` and `HOST_PASSWORD` from live environments

## Git Hygiene

- Remove leaked files from git history
- Force-push rewritten branches and tags
- Ask collaborators to re-clone or hard-reset after history rewrite
- Verify no `.env`, diagnostic dumps, or local logs remain tracked

## Runtime Safety

- Keep `WRD_INSECURE_SKIP_TLS_VERIFY` disabled outside localhost development
- Keep `WRD_ENABLE_DIAG_PERSIST` disabled by default
- Verify `/api/webrtc-config` requires a bearer token
- Verify Host authentication uses `/api/auth/login/host`

## Final Verification

- Run server and frontend tests
- Review `README.md` and runbook docs for consistency
- Confirm generated `.env.example` uses placeholders only
