# Security Policy

## Supported versions

Only the latest `0.1.x` release is supported while the project is in its initial development series.

## Reporting a vulnerability

Please do **not** open a public issue with vulnerability details. Use GitHub private vulnerability reporting from the repository Security tab. If private reporting is unavailable, open a minimal issue requesting a private contact channel and omit all technical details.

Include the affected version, operating system, DSH version, reproduction conditions, impact, and any suggested mitigation. Reports involving command execution, IPC authentication, loopback HTTP authorization, path traversal, credential exposure, or unsafe restart behavior are especially important.

## Scope

`dsh-dev-reloader` is intentionally a local-development tool. It executes trusted build commands from discovered or explicitly configured source checkouts and can stop and restart the local DSH process. Using it on shared or production hosts is unsupported and is not a security boundary promised by this project.
