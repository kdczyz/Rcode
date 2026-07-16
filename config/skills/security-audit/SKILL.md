---
name: security-audit
description: Audit application code and configuration for exploitable security weaknesses and unsafe trust assumptions. Use for 安全审计 security review threat modeling authentication authorization secrets injection SSRF XSS or dependency exposure analysis.
---

# Security Audit

Review security by tracing untrusted input to sensitive effects.

## Workflow

1. Map assets, actors, entry points, trust boundaries, and privileged operations.
2. Trace authentication, authorization, data validation, storage, network calls, and command execution.
3. Look for realistic abuse paths: injection, path traversal, SSRF, XSS, CSRF, broken access control, secret leakage, unsafe deserialization, and race conditions.
4. Confirm each finding against reachable code and existing mitigations.
5. Rank by exploitability and impact, then propose a defense at the earliest reliable boundary.

## Guardrails

- Do not expose live credentials or sensitive user data in findings.
- Distinguish confirmed vulnerabilities from hardening suggestions.
- Avoid destructive proof-of-concept actions against real systems.
- Prefer primary platform guidance when a recommendation depends on current security behavior.
