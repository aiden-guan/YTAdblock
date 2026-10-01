# Changelog

All notable changes to the `YouTube Clean` (YTAdblock) extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-10-01

### Summary
Implemented Alternate Player Response Substitution with bounded Innertube client races, local millisecond timing diagnostics, client-side preroll gate bypass, and surgical stream merging to completely eliminate preroll-length waiting periods.

### Architectural Highlights

| Subsystem | Previous Behavior | Enhanced Architecture |
| :--- | :--- | :--- |
| **Player Session Handling** | Stripped ad fields from ad-bound WEB responses, resulting in server-side media backoff (~5–30s wait). | Bounded race among healthy Innertube clients (`WEB_EMBEDDED_PLAYER`, `TVHTML5`, etc.) to substitute clean playback data before YouTube player consumes it. |
| **Zero-Latency Path** | Ad field sanitization checked on all responses without explicit preroll derivation. | Explicit known-structure inspection (`detectPrerollInfo`); videos with `hasPreroll === false` bypass alternate calls with 0 ms overhead. |
| **Player-Side Ad Gates** | Relying solely on DOM mutations when player entered ad countdown. | `PlayerDelayBypassManager` inspects player state and executes least-invasive gate transitions without touching global timers. |
| **Diagnostics & Telemetry** | Basic event counters without startup timing. | `PlaybackTimingManager` records exact millisecond milestones distinguishing `PLAYER_SIDE_WAIT` from `SERVER_PREROLL_BACKOFF`. |

### Added
- **`src/main/alternate-player/`**:
  - `client-pool.ts`: Client pool abstraction supporting `WEB_EMBEDDED_PLAYER`, `TVHTML5`, `ANDROID`, `IOS`, and `VISIONOS` with health scoring and 403 failure isolation.
  - `response-validator.ts`: Strict multi-point validation verifying `videoId` match, `playabilityStatus === "OK"`, playable `streamingData`, and absence of prerolls.
  - `response-merger.ts`: Surgical merging preserving original web metadata (captions, microformats, tracking) while cleanly substituting streaming data.
  - `alternate-player.ts`: Bounded race coordinator with ~800ms time budget, `AbortController` cancellation, and recursion immunity.
- **`src/main/playback-timing.ts`**: Millisecond timing telemetry tracking `PLAYER_REQUEST_STARTED`, `PLAYER_RESPONSE_RECEIVED`, `CONTENT_MEDIA_REQUEST_STARTED`, `CONTENT_MEDIA_FIRST_RESPONSE`, and `VIDEO_PLAYING`. Formats structured console output `[YTCLEAN:TIMING]`.
- **`src/main/preroll-detector.ts`**: Pure explicit inspector extracting `PrerollInfo` (`hasPreroll`, `estimatedDurationMs`, `adCount`) prior to sanitization.
- **`src/main/delay/player-delay.ts`**: Least-invasive bypass mechanism for stuck player-side preroll gates without monkey-patching `window.setTimeout`.
- **UI Diagnostics**: Added collapsible `Playback startup >` card in popup and export report detailing preroll detection, selected candidate, and avoided delay.
- **Test Suites**:
  - `tests/end-to-end-substitution.test.ts`: 12 comprehensive integration tests covering all substitution edge cases.
  - `tests/alternate-player.test.ts`: Unit tests for pool rotation, validation, merging, and race execution.
  - `tests/playback-timing.test.ts`: Delay cause classification and token safety tests.
  - `tests/preroll-detector.test.ts`: Explicit preroll vs midroll discrimination tests.
  - `tests/player-delay.test.ts`: Player state assessment and bypass signal tests.

### Changed / Refactored
- **`src/main/fetch-interceptor.ts`**: Integrated preroll detection, candidate race execution, GoogleVideo 403 error tracking, and recursion protection via `X-YTClean-Internal`.
- **`src/main/xhr-interceptor.ts`**: Added timing milestone recording and media endpoint tracking for XHR-based player requests.
- **`src/main/initial-response.ts`**: Preserves preroll metrics during initial SSR response interception.
- **`src/main/index.ts`**: Connected window-level media event capturing and SPA navigation cancellation (`yt-navigate-start`).
- **`src/types/events.ts`**: Added `PLAYER_RESPONSE_SUBSTITUTED` and `TIMING_UPDATE` event types, and expanded `DiagnosticsExportReport`.

### Fixed
- Fixed long buffering delays where YouTube made users wait the full duration of a blocked preroll ad before beginning playback.
- Fixed stream incompatibility and 403 failures by enforcing atomic compatibility units on `streamingData`.

---

## [1.0.0] - 2026-09-30

### Initial Release
- Multi-layer ad prevention architecture featuring `MAIN` world `/youtubei/v1/player` response sanitization.
- `window.ytInitialPlayerResponse` descriptor hook.
- Declarative Net Request ruleset for ad beacon suppression.
- Progressive DOM ad fallback state machine (skip click, 16x acceleration, mute, and restore).
- Targeted cosmetic stylesheet suppressing promoted shelf units.
- Health monitor ring buffer and popup dashboard with diagnostic export.
