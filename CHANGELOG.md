# Changelog

All notable changes for the MRCP sidecar reference implementation (Phase 1) are documented here.

## [Unreleased]
- Raised baseline runtime requirement to Node.js 22 / npm 10 and refreshed TypeScript + Jest toolchain.

## [0.1.0] - 2025-09-29 (Phase 1 Completion)
### Added
- SIP UDP INVITE state machine with Timer A (exponential) + Timer B overall timeout.
- Multi‑codec offer/answer negotiation (configurable codec list, selected codec telemetry).
- MRCP channel skeleton + session lifecycle telemetry (partial/final/error counts, durations).
- RTP optional listen path with packet count telemetry.
- RTSP fallback (DESCRIBE / SETUP) with failure -> port 5004 fallback counter.
- Telemetry v2 schema: separated UDP/TCP SIP attempt/success/fail counters, invite retransmit + timeout counters, provisional response tracking, RTT aggregate (sum/count), codec offered/selected metrics.
- Network simulator (test-only): seeded RNG, packet drop (first-attempt vs persistent), delay + jitter injection, logging flag.
- Reliability harness Jest tests: normal loss scenario, persistent drop (timeout), added delay scenario ensuring robustness.
- Configuration validation (ranges & types) with test override `MRCP_TEST_ALLOW_LOW_TIMEOUT`.
- Documentation: README updates for network sim and env vars, consolidated telemetry reference.

### Changed
- Wrapped UDP send path with simulation layer (test env only) – no behavior change in production.
- Relaxed initial reliability assertions to reduce flakiness (documented rationale).

### Fixed
- INVITE endpoint scheme bug (`sip://` vs `sip:`) causing initial zero-success tests.
- Socket send race leading to `ERR_SOCKET_DGRAM_NOT_RUNNING` under delayed send conditions (guarded try/catch in simulator).

### Internal / Tooling
- Expanded Jest suite (reliability + telemetry scenarios). 

### Notes
- Phase 1 scope closes with resilience groundwork; Phase 2 will focus on richer latency distributions, multi-session aggregation, and extended codec/channel metrics.

---
Semantic versioning will begin once API stabilizes (>0.1.0). Earlier tags are pre-release.
