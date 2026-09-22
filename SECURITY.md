# Security Policy

## Reporting a vulnerability

Do not open a public issue for crawler escape, SSRF, credential exposure, sandbox escape, authentication bypass, or another vulnerability that could put operators or scanned networks at risk.

Use GitHub's private vulnerability reporting page:

https://github.com/mratsag/pitchtrace/security/advisories/new

Include the affected version, reproduction steps, observed impact, and any suggested mitigation. Do not include real credentials or personal data. If private vulnerability reporting is unavailable, wait for a private reporting channel to be published rather than disclosing an exploitable issue publicly.

## Supported version

Security fixes currently target the latest commit on `main`. The project is a public alpha and does not yet promise long-term support for older revisions.

## Scope reminder

PitchTrace includes application-level SSRF checks and IP-pinned requests. Operators should also enforce network-level egress policy around the analyzer container and keep it isolated from cloud metadata, private networks, control planes, and secrets.
