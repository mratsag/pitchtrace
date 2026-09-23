# Production deployment preparation

This directory is a reusable example, not a performed deployment. Copy `env.production.example` to a protected `.env`, replace every placeholder, copy `Caddyfile.example` to `Caddyfile`, then validate with `docker compose --env-file .env -f compose.production.yml config`.

Only Caddy publishes ports. The sole analyzer route exposed by Caddy is `/artifact-previews/*`; API endpoints and both databases remain private. Caddy obtains HTTPS certificates and redirects HTTP automatically when real DNS points to the host. Protect the n8n editor with a VPN, IP allowlist, or an identity-aware proxy; if public Forms are needed, use separate hostnames/routes and deny editor/API paths on the public hostname.

Compose networks are segmentation, not a complete egress firewall. Before launch, validate actual interfaces/subnets and enforce host/cloud firewall or egress-proxy rules denying loopback, RFC1918, link-local, metadata and control-plane ranges while permitting DNS and public TCP 80/443. Do not paste generic nftables commands without adapting them to the host.
