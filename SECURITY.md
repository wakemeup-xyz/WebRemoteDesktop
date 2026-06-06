# Security Policy

## Supported Use

This repository is intended for controlled self-hosted use. Before any public deployment or open-source release:

- rotate all previously used secrets
- review tunnel and TURN exposure
- verify host macOS permissions and local-network assumptions
- confirm no runtime `.env`, logs, or diagnostics are tracked

## Reporting a Vulnerability

Please do not open a public issue for sensitive findings.

Instead, report with:

- affected component
- impact
- reproduction steps
- suggested mitigation if available

If a report includes credentials or personal data, redact them before sharing.

## Release Checklist

Security-sensitive releases should verify:

- `signal-server/.env` is present locally but ignored by git
- `signal-server/.env.example` contains placeholders only
- `JWT_SECRET`, viewer password, host secret, and TURN credentials have all been rotated
- history-rewrite and force-push steps are complete if leaked files ever entered git history
- diagnostic persistence is disabled unless explicitly needed
