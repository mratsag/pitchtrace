# ADR: n8n task runner

Status: accepted for this phase — no external runner sidecar.

The pinned image is `n8n:2.39.10`. The workflow has four small Code nodes: poll counter, imported-company selection, deterministic evidence draft construction, and (before this phase) UUID validation. The UUID-validation node was removed with the insecure preview webhook. The remaining code has no filesystem, network, package, or environment access.

Official n8n documentation recommends external runners as an isolation boundary for Code execution, but their broker/auth configuration and companion image must be kept exactly version-compatible. We did not add a sidecar because a complete, pinned, failure-tested configuration could not be proven from the version-specific official material during this change. Silencing warnings is not a mitigation.

Before production activation, either replace the remaining three Code nodes with declarative nodes or validate the official `n8nio/runners:2.39.10` topology in staging, including broker authentication, encryption, runner outage behavior, capability drop, no host ports, no Docker socket, and no database/analyzer secrets. Until then the workflow stays inactive by default and n8n is treated as a privileged internal control plane.
