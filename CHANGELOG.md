# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Initial public release candidate for local DSH development.
- Automatic source discovery and change classification.
- Config, server, and client HMR routing plus full build-and-restart recovery.
- Activity-gated restarts, crash recovery, authenticated local IPC, and Web controls.
- Linux, macOS, and Windows CI with Node.js 22 and 24.
- Precompiled GitHub distribution artifacts, avoiding dependency build-script authorization during installation.
- Complete staged Web settings form with all supervisor fields, Save/Reset validation, and a loopback-only rc.6 compatibility transport that preserves DSH settings ownership.

### Fixed

- Ship the browser artifact in DSH factory-loader format so GitHub installations register the Web plugin without a local rebuild.
- Resolve the canonical DSH home when `DSH_HOME` is unset, retire stale Unix supervisor sockets only after lock acquisition, and close the old bridge endpoint before a handoff standby binds it.
- Keep projected settings snapshots referentially stable so the reload card renders without a React update loop.
- Keep the reload card usable when an rc.6 Web settings bridge does not expose its third-party namespace, prefer the official scope whenever available, and explicitly synchronize supervisor status after IPC authentication.
- Restrict the host-shared `@deepseek-ai/cordis` and `@deepseek-ai/cordis-plugin-hmr` packages to build-time `devDependencies`, so the plugin resolves the DSH host's Cordis instance instead of shipping a shadowing copy.
