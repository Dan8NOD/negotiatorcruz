# Rocketman on iOS — prompt for a fresh session

Copy everything below the line into a new Claude Code session on this
repository. It is written to be read cold, by someone with no memory of this
conversation.

---

## The task

Ship Rocketman on the iOS App Store. I have paid for an Apple Developer account
($99) and iOS is the near-term target; Google Play comes after.

Work on branch `claude/rocketman-ios-shell`. Commit and push there, open a draft
PR, and do not touch `main`.

## What already exists — read before proposing anything

- **`rocketman/web/`** — the whole game. Hand-written JavaScript on Canvas: ES
  modules, no engine, no framework. `engine/` is the deterministic simulation
  (8,000 lines, 17 files); `web/` is the renderer, input, and audio. It is
  complete and shipping-quality: ~600 simulation tests and 65 browser tests,
  all green.
- **`rocketman/android/`** — a working WebView shell that wraps that same web
  build for Google Play. A local asset server (`GameAssetServer.java`), a
  hardened `MainActivity`, a Gradle task that syncs `engine/`, `web/` and the
  audio pack into the APK. **This is the design to mirror.** It is already
  debugged.
- **`rocketman/swift/`** — `RocketmanKit`, a Swift port of the simulation. Real
  and well-tested, but **only 3 of 17 engine files** (`Grid`, `Numeric`, `RNG`,
  ~1,370 of 8,000 lines). No renderer, no input, no audio, no content, no AI,
  no campaign. `Package.swift` declares `.iOS(.v16)` and notes that the app
  target lives outside the package and does not yet exist.
- **`rocketman/audio/`** — the recorded-audio pipeline. Cue catalogue, ffmpeg
  pack tool, cue sheet. Read `rocketman/audio/README.md`.

## What I want you to decide first, and check with me

Two paths, and they are not close in cost:

1. **WKWebView shell**, mirroring `rocketman/android/`. Reuses 100% of the
   game, including the audio layer. Weeks, not months.
2. **Native Swift** on RocketmanKit, with a SpriteKit or Metal renderer. That
   means porting 14 more engine files plus a renderer and an input layer from
   scratch. Months.

I expect (1) is right for getting on the store. Tell me if you disagree, and
say why, before writing code.

## If we go with the WKWebView shell

Mirror the Android shell's structure rather than inventing a new one. Then
these specifics, which are the ones that bite:

- **`AVAudioSession` must be configured, or the game is silent.** WKWebView
  audio obeys the hardware ring/silent switch by default. A reviewer with their
  ringer off gets a completely silent game. Set the category to `.playback` and
  activate the session, and handle interruptions (a phone call must not deafen
  the app permanently). This is three lines and it is the single most likely
  thing to be discovered too late.
- **Bundle everything; load nothing remotely.** App Store guideline 4.2 rejects
  thin web wrappers. A fully offline HTML5 game bundled in the app is not that
  and ships routinely — but it must load from the app bundle, never a URL. The
  Android shell already works this way.
- **Audio format.** The pack emits Opus/WebM *and* AAC/M4A because Safari
  before 17 cannot decode Opus. `web/samples.js` picks per-browser via
  `pickFormat()`. Verify it chooses M4A on an older iPad simulator — do not
  assume.
- **Copy the audio pack into the bundle** the way `android/app/build.gradle`
  does. Note the path: the page fetches `../audio/`, so `audio/` must be a
  sibling of `web/` in the bundle, not a child.
- **Safe areas, notch, and home indicator.** The game is landscape and
  full-bleed.
- **Verify the game actually renders**, not just that it launched. Take a
  screenshot in the simulator and look at it. A canvas sized while hidden
  measures zero and draws nothing while throwing no errors.

## Definition of done

- An iOS app target that builds, launches, and plays a full mission.
- Audio working with the silent switch on.
- Screenshots from the simulator proving it renders.
- The existing suites still green: `npm run test:rocketman` and
  `npm run test:rocketman:e2e`.
- Notes in `rocketman/ios/README.md` covering signing, bundle id, and what is
  left before submission.

## Ground rules

- Do not modify `rocketman/engine/` or `rocketman/web/` unless a real iOS bug
  requires it. If one does, say so explicitly — those files are shared with the
  Android build and the browser build.
- Do not add dependencies to the web game.
- Ask me before anything outward-facing: App Store Connect, certificates,
  bundle identifiers.

---

## Context I should not have to re-explain

`rocketman/HANDOFF.md` says the platform target changed from iOS to Google
Play. That is now out of date — iOS is first. Update that line as part of your
first commit so the next person is not misled.
