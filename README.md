# YouTube Clean (YTAdblock)

A focused, transparent Manifest V3 extension for Chrome/Chromium that eliminates YouTube advertising while preserving the authentic YouTube user experience, video playback metadata, and user controls—with zero preroll startup delay.

---

## 1. What It Is

`YouTube Clean` is a dedicated Chrome extension purpose-built to prevent and suppress YouTube ads without requiring third-party frontends (like Invidious or Piped), proxies, custom root certificates, secondary browsers, or intrusive DevTools debuggers.

The user experience is seamless:
1. Load the extension once in Chrome.
2. Navigate to `https://www.youtube.com/` normally.
3. Access user accounts, subscriptions, playlists, comments, Shorts, and theater/fullscreen modes as intended.
4. Video playback proceeds without advertising interruptions, black screens, or preroll-length waiting delays.

---

## 2. The Preroll Delay Problem & Architectural Solution

### The Problem
When ad blockers strip `adPlacements` and `adSlots` from standard YouTube web player responses, YouTube often stalls playback for approximately the full duration of the blocked preroll (e.g. 5–30 seconds of spinning/buffering).

This delay is caused by two distinct bottlenecks:
1. **Server/Media Backoff (`SERVER_PREROLL_BACKOFF`)**: YouTube's media servers bind the session's `streamingData` to the preroll ad workflow. Requests to GoogleVideo/SABR endpoints are server-side throttled until the ad timestamp elapses.
2. **Player-Side Wait (`PLAYER_SIDE_WAIT`)**: The YouTube HTML5 video player's internal state machine enters an ad-break gate countdown waiting for an ad-complete signal before requesting content media.

### The Solution: Alternate Player Response Substitution

Rather than letting YouTube consume an ad-bound player session or blindly waiting, `YouTube Clean` intercepts `/youtubei/v1/player` responses, detects prerolls before sanitization, and substitutes clean playback streams in a bounded candidate race:

```
User clicks video
        ↓
YouTube makes WEB player request
        ↓
Detect returned player session is ad-bound (PrerollInfo)
        ↓
BEFORE YouTube consumes it:
Bounded race (max 2–3 Innertube client profiles: WEB_EMBEDDED_PLAYER, TVHTML5, etc.)
        ↓
Validate candidate response (videoId, playabilityStatus, clean streams, no ads)
        ↓
Surgically merge clean streamingData into legitimate WEB response
        ↓
YouTube initializes its NORMAL player
        ↓
Content playback starts immediately (no preroll wait)
```

For organic videos without advertising (`hasPreroll === false`), the system adds **zero latency overhead**, returning the verified response immediately.

---

## 3. Multi-Layer Architecture

Rather than relying on fragile DOM selector hacking alone (`find ad element -> hide element`), `YouTube Clean` uses an in-depth defensive architecture where upstream network prevention is primary and DOM fallback is secondary:

```
YouTube Page / Runtime
   │
   ├── Layer A: Alternate Player Response Substitution (PRIMARY)
   │   Intercepts /youtubei/v1/player in the MAIN execution world.
   │   Runs bounded, parallelized race among healthy Innertube client profiles.
   │   Surgically merges clean streamingData into the WEB response.
   │   Uses unpatched nativeFetch with recursion protection (X-YTClean-Internal).
   │
   ├── Layer B: Player Response Sanitizer (FAIL-SAFE FALLBACK)
   │   Removes adPlacements, playerAds, adSlots, and heartbeat parameters.
   │   Preserves streamingData, videoDetails, captions, and playbackTracking.
   │   Fail-open: never mutates input or breaks normal playback.
   │
   ├── Layer C: Initial Player Response Hook
   │   Traps window.ytInitialPlayerResponse via property descriptors at document_start.
   │   Sanitizes pre-rendered player configurations before YouTube consumes them.
   │
   ├── Layer D: Conservative Network Rules (DNR)
   │   Declarative Net Request ruleset blocking verified ad-beacon and telemetry endpoints
   │   (e.g., /pagead/, /api/stats/ads, doubleclick).
   │   Strictly avoids blocking googlevideo.com or legitimate video media.
   │
   ├── Layer E: Player Delay Bypass
   │   Inspects player state for stuck preroll ad-gates.
   │   Safely transitions player back to normal content using least-invasive mechanisms
   │   without ever monkey-patching global timers (window.setTimeout is never touched).
   │
   ├── Layer F: Progressive Skip / Seek / Accelerate Fallback
   │   Executes only when ad prevention fails:
   │   1. Click visible skip button
   │   2. Mute ad audio and accelerate to 16x
   │   3. Near-end seek on confirmed ad video
   │   4. Full restoration of user volume, speed, and muted state upon exit.
   │
   ├── Layer G: Targeted Cosmetic Filtering
   │   Hides verified ad slot renderers, sponsored mastheads, and promoted feed units
   │   without affecting normal recommendations, chapters, or comments.
   │
   └── Layer H: Local Timing Diagnostics & SPA Lifecycle
       Tracks exact millisecond milestones from player request to first media data and playback.
       Aborts in-flight candidate races on SPA navigation (yt-navigate-start).
```

---

## 4. Innertube Client Pool & Session Cache

The candidate pool abstracts multiple YouTube player client profiles to avoid reliance on a single fragile fallback:

| Client Profile | Innertube Context | Purpose |
| :--- | :--- | :--- |
| **`WEB_EMBEDDED_PLAYER`** | `clientVersion: 1.20240901.01.00`, embed context | Serves clean, unbundled streaming formats with embed originalUrl |
| **`TVHTML5`** | `clientVersion: 7.20240901.12.00`, `clientScreen: WATCH` | High-compatibility HTML5 TV streaming formats |
| **`ANDROID`** | `clientVersion: 19.29.35`, Android 14 SDK 34 | Mobile Innertube endpoint |
| **`IOS`** | `clientVersion: 19.29.1`, iOS 17.5.1 | Mobile iOS Innertube endpoint |
| **`VISIONOS`** | `clientVersion: 1.0.0` | Spatial computing client profile |

### Adaptive Session Learning
- **Working Candidate Preference**: Once candidate profile $B$ succeeds for a video, $B$ is cached as `preferredCleanClient` and tried first for subsequent videos in the session.
- **403 Isolation**: If media requests receive HTTP 401, 403, or 410, `PlayerClientPool.markFailure(id, "MEDIA_403")` immediately rotates the preferred client and temporarily isolates unhealthy candidates.

---

## 5. Installation & Development

### Requirements
- Node.js >= 18 (Tested on Node v22)
- npm >= 9
- Google Chrome or Chromium >= 111 (Supports `world: "MAIN"` content scripts)

### Build Steps

```bash
# 1. Install dependencies
npm install

# 2. Build production output
npm run build

# 3. (Optional) Run in development watch mode
npm run dev
```

### Loading in Chrome / Chromium

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** via the toggle switch in the upper-right corner.
3. Click the **Load unpacked** button in the upper-left corner.
4. Select the `dist/` folder inside this repository:
   `/Users/aidenguan/Documents/YTAdblock/dist`
5. Navigate to `https://www.youtube.com/` and use YouTube normally.

---

## 6. Verification & Test Suite

The test suite runs with Vitest in an isolated DOM environment across 17 test files:

```bash
# Run all unit and integration tests (94 tests)
npm test

# Run tests in watch mode
npm run test:watch

# Check TypeScript types
npm run typecheck
```

### Test Coverage Highlights
- `end-to-end-substitution.test.ts`: Verifies all 12 core edge cases:
  1. Ad-bound response selects alternate clean response, substitutes `streamingData`, and strips ad fields.
  2. Clean response makes zero alternate requests and returns immediately.
  3. Rejection of candidate responses with mismatched `videoId`.
  4. Rejection of candidate responses with `playabilityStatus !== "OK"`.
  5. Rejection of candidate responses lacking playable `streamingData`.
  6. Rejection of candidate responses containing preroll ad placements.
  7. Detection of media 403 errors with automatic candidate rotation.
  8. Graceful timeout fallback within budget (~800ms) without freezing.
  9. Concurrent candidate race resolution where first valid winner aborts competitors.
  10. Absolute recursion prevention via `X-YTClean-Internal` tagging.
  11. Instant candidate race abort on SPA navigation.
  12. Strict immutability of original player response objects.
- `playback-timing.test.ts`: Millisecond timing diagnostics, delay cause classification (`PLAYER_SIDE_WAIT` vs `SERVER_PREROLL_BACKOFF`), and URL token stripping.
- `preroll-detector.test.ts`: Explicit known-structure detection for prerolls (offset 0) vs midrolls (offset > 0).
- `player-delay.test.ts`: Least-invasive transition mechanisms for stuck preroll ad-gates.
- `alternate-player.test.ts`: Client pool health scoring, response validation, and surgical merging.

---

## 7. Diagnostics & Timing Telemetry

### Local Console Output
When debug logging is active or when a playback session concludes, the timing manager outputs structured diagnostics:

```text
[YTCLEAN:TIMING] Video: dQw4w9WgXcQ
playerResponse: 0 ms
sanitized: +145 ms
contentRequest: +160 ms
firstMediaData: +310 ms
playing: +420 ms

suspectedCause: NONE
estimatedPreroll: 15.0 sec
avoidedPrerollWait: ~14.6 sec
selectedCandidate: web-embedded
```

### Extension Popup
Clicking the extension icon opens the popup dashboard:
- **Protection Toggle**: Instant ON / OFF switch.
- **Session Counters**: Cleaned responses, fallback-handled ads, hidden promotions.
- **Playback Startup Diagnostics (Collapsible)**:
  - Preroll detected (`YES` / `No`)
  - Estimated preroll duration
  - Selected clean client profile
  - Avoided preroll wait time
  - Suspected delay cause (`NONE` / `PLAYER_SIDE_WAIT` / `SERVER_PREROLL_BACKOFF`)
- **Export Diagnostics >**: Exports sanitized JSON report (containing non-sensitive startup timing, health telemetry, and counters) to clipboard or download.

---

## 8. Privacy & Security

`YouTube Clean` adheres to strict zero-telemetry and privacy-first principles:
- **No Remote Code**: All code is bundled locally. Zero external scripts or CDNs.
- **No Background Analytics**: Zero telemetry servers or tracking beacons.
- **Token Protection**: Diagnostics strictly strip all session query tokens, signatures (`expire`, `signature`, `lsig`), and auth credentials before logging or exporting.
- **Host Restrictions**: Permissions limited strictly to `*.youtube.com`.

---

## 9. License

MIT
