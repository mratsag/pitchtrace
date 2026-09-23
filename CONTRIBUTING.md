# Contributing to PitchTrace

Thank you for helping improve PitchTrace.

1. Open an issue for significant behavioral or schema changes. Report security issues privately according to `SECURITY.md`.
2. Keep changes focused and preserve the evidence-linked claim invariant.
3. Do not add real company data, personal email addresses, credentials, screenshots, exports, or runtime artifacts.
4. Use `.invalid` domains or local fixture servers in tests.
5. Run `npm run build`, `npm run typecheck`, and `npm test` in `services/analyzer`, then `node --test tests/workflows/*.test.mjs` from the repository root before submitting a pull request.
6. Update documentation and tests when changing API, schema, security, or finding behavior.
7. Workflow exports must not contain credential IDs, secrets, personal data, automatic email nodes, embedded screenshots, or instance-specific values. Prove importability with the pinned n8n image.

Contributions are accepted under the repository's MIT License.
