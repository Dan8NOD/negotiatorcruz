# Rocketman on Fire OS

The Amazon Kindle Fire HD build. One Activity, one WebView, and the same
`engine/` and `web/` the desktop game runs — no fork, no second copy of the
rules, no rewrite.

```bash
cd rocketman/android
cp local.properties.example local.properties   # point it at your Android SDK
./gradlew assembleDebug                        # → app/build/outputs/apk/debug/app-debug.apk
```

That APK is 188 KB, asks for **no permissions at all**, and runs offline.

---

## Why a WebView and not a rewrite

Because the expensive part of a port is the simulation, and Rocketman's
simulation is already portable: `engine/` is pure, deterministic, DOM-free
JavaScript with 397 tests behind it. Rewriting it in Kotlin would mean
maintaining the game's rules twice and diffing them forever — which is a real
project (that is what `rocketman/swift/` is, and it exists because Apple's store
has requirements this one does not).

Fire OS asks for none of that. It runs Chromium. The game is a canvas, a touch
control scheme it already has, and a save file in localStorage. So the port is
not a port of the game; it is four platform problems the browser was solving for
free:

| Problem | Where it is solved |
|---|---|
| localStorage and ES modules need a real origin | `GameAssetServer.java` |
| System bars over the battlefield | `MainActivity.goImmersive()` |
| Android's own gestures eating the game's | `MainActivity.configure()` |
| The hardware Back button | `MainActivity.onBackPressed()` ↔ `main.js handleBack()` |

Everything else is the game, unchanged.

### The origin problem is the one that matters

The obvious way to ship a web game in a WebView is
`file:///android_asset/index.html`. Do that here and the game **looks** like it
works, then loses every campaign.

A `file://` page gets an *opaque origin* in a modern WebView, and two things
follow:

- **localStorage is unavailable.** Pilots, levels, salvage, cleared missions and
  the five-second mid-match autosave all live there. `web/storage.js` is written
  to degrade quietly rather than crash — it falls back to an in-memory profile —
  so the failure is invisible until a player closes the app and finds their
  campaign gone.
- **ES modules are blocked.** `rocketman.html` loads `main.js` as
  `type="module"`, and module scripts are CORS-checked, which an opaque origin
  fails by definition. The page renders its shell and never boots.

`GameAssetServer` answers requests on `https://appassets.androidplatform.net`
out of the APK's own assets, which gives the page a real origin and fixes both.
That domain is the one Google reserves for this; it never resolves publicly, so
a request that somehow escaped the interceptor fails closed rather than reaching
a stranger's server.

`e2e/firetablet.spec.js` has a test named *the campaign profile survives a
reload*. That test is what this class is for.

---

## What changed in the game

Two things, both small, both in `web/main.js`:

1. **`handleBack()` and `window.rocketmanBack`.** A table of the back
   navigation each screen already had, returning whether it consumed the press.
   The title screen answers `false`, which is what lets the shell close the app
   — an app that traps Back on its home screen is one a Fire tablet user cannot
   leave, and it fails review for good reason.
2. **The idle hint now reads the pointer.** It said *"Left-drag to select.
   Right-click to order."* to everyone, including a tablet with neither. It is
   the first sentence a new player reads, and `input.isTouch` was already
   available three functions away. This also fixes the iOS build.

Nothing in `engine/` was touched. Nothing needed to be.

---

## Build it

**You need:** JDK 17+, and the Android SDK with `platforms;android-34` and
`build-tools;34.0.0`. Android Studio installs both; so does
`sdkmanager` if you would rather not.

```bash
cd rocketman/android
cp local.properties.example local.properties   # then edit sdk.dir
./gradlew assembleDebug
```

There is no `npm install` step and no bundler. The Gradle task `syncGameAssets`
copies `../engine` and `../web` into the APK, so the game in the APK is the game
in the repository — edit a file, rebuild, it is in there. Nothing is vendored
into this directory, which is the point.

### Release

```bash
keytool -genkeypair -v -keystore rocketman-upload.jks \
  -alias rocketman -keyalg RSA -keysize 2048 -validity 10000

cat > keystore.properties <<'EOF'
storeFile=/absolute/path/to/rocketman-upload.jks
storePassword=…
keyAlias=rocketman
keyPassword=…
EOF

./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

`keystore.properties` and `*.jks` are gitignored. **Back that keystore up
somewhere you will still have in five years.** Losing it does not mean
regenerating it; it means never being able to update the published app again,
because Amazon identifies an update by its signature.

Verify before you upload:

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --verbose app-release.apk
```

You want `v2 scheme … true`. Amazon rejects a Fire OS 8 app signed with v1
alone. `v1 … false` is correct and expected here — AGP drops JAR signing when
`minSdk` is 24 or higher, because nothing that new reads it.

---

## Put it on a Fire HD

1. On the tablet: **Settings → Device Options → tap Serial Number seven times**
   to reveal Developer Options, then enable **ADB debugging**.
2. Plug it in and accept the prompt on the tablet.

```bash
adb devices                 # confirm it is listed
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s Rocketman     # the game's console.log, in your terminal
```

The debug build is `com.negotiatorcruz.rocketman.debug`, so it installs
alongside a release build rather than replacing it. It is also
`chrome://inspect`-able from desktop Chrome, which gives you the real devtools
against the real device — profiler included, which is how you would answer the
frame-rate question below.

---

## Submitting to the Amazon Appstore

### The money, since it is the reason this store is first

| Store | To publish | Cut of sales |
|---|---|---|
| **Amazon Appstore** | **$0** | 70%, or **80%** under the Small Business Accelerator |
| Google Play | $25, once | 70% (85% on first $1M) |
| Apple App Store | $99/year | 70% (85% under the Small Business Program) |

There is no fee to open an Amazon developer account and no fee to submit an app.
The [Small Business Accelerator][sba] raises the developer's share from 70% to
80% for anyone under $1M of revenue in the previous calendar year, plus AWS
credits worth another 10% of app revenue — you qualify, and it is worth applying
before the first sale rather than after.

So this store does not need the funding the other two are waiting on.

### One thing to know about the Appstore's scope

Amazon **discontinued the Appstore on generic Android phones on 20 August
2025**. It continues on **Fire tablets and Fire TV**, which is exactly what this
build targets — but it does mean the Appstore is no longer a way to reach
non-Fire Android devices. Google Play remains the route for those, and that port
is already underway.

### Checklist

**Build**

- [ ] `versionCode` incremented in `app/build.gradle` — Amazon rejects a
      re-upload of an existing one
- [ ] `./gradlew assembleRelease` with `keystore.properties` in place
- [ ] `apksigner verify --verbose` shows v2 true
- [ ] Installed from the release APK on a real Fire HD and played end to end

**Listing** — assets are generated, see [store assets](#store-assets)

- [ ] Icon, 512×512 PNG → `store/icon-512.png`
- [ ] 3–10 screenshots, minimum 1024×600 → `store/screenshot-*.png` (1920×1200)
- [ ] Feature graphic, 1024×500 — **not generated; this one is a marketing
      composition, not a screenshot**
- [ ] Title, short description (max 80 chars) and long description
- [ ] Category. Rocketman is a real-time strategy game, so **Games → Strategy**;
      it is not an arcade or shooter title and miscategorising it buys refunds
      rather than players
- [ ] Content rating questionnaire. Stylised mech combat with no blood, no
      gore, no human figures — expect Everyone 10+ or Teen
- [ ] Privacy policy URL. Required whenever a listing collects anything; this
      app collects nothing, and a one-paragraph page saying so is the honest
      version

**Device targeting**

- [ ] Under *Device Support*, confirm the Fire HD models you intend. `minSdk 28`
      already excludes the Fire OS 5 generation — do not "enable all devices"
      without reading the list, because a one-star review from a 2015 tablet
      that cannot run the app counts the same as any other

**Privacy questionnaire**

The manifest answers most of it for you. There is no `<uses-permission>` block
at all: no INTERNET, no storage, no location, no identifiers. Nothing leaves the
tablet because nothing can.

[sba]: https://developer.amazon.com/apps-and-games/small-business-program

### If this app ever sells anything

It does not today, and that is why it is submittable as it stands: Rocketman on
Fire is a standalone game with no account, no balance and no purchase.

`mixmatch/` describes where this is going — a token arcade where a game round is
priced as a coin, on rails that already run through **Stripe** ($15 top-up,
$5/month). That model cannot cross onto a Fire tablet unchanged:

- **Amazon requires its own In-App Purchasing API for digital goods.** Selling
  tokens inside the Fire build through a Stripe Payment Link is not a supported
  route, and the store takes its cut through IAP.
- **Google Play Billing is not an alternative here.** It needs Google Mobile
  Services, which Fire tablets do not have — so the Play port and the Fire port
  will need two separate purchase paths regardless.
- The dependency block would stop being empty, and the manifest would need
  `INTERNET` — which costs this build the "no permissions at all" line that
  currently answers the privacy questionnaire on its own.

None of that is a reason to delay shipping the game. It is a reason to ship it
**now, free and standalone**, and treat token integration as a second version
with its own store review.

### Store assets

```bash
node rocketman/android/tools/store-assets.mjs
```

Drives the real game in Chromium at a Fire HD 10's native 1920×1200 and writes
`store/`. Re-run it after a UI change; a listing showing a HUD from three
versions ago is the normal state of an indie store page and it is avoidable in
one command.

---

## Decisions you cannot undo after the first submission

- **`applicationId` is `com.negotiatorcruz.rocketman`.** A package name is
  permanent: it is the app's identity in the store forever, and changing it
  later means a new listing with zero reviews and no upgrade path for existing
  players. `rocketman/README.md` says this game is meant to move out of this
  repository one day — if it should carry a different name when it does, change
  it **now**, in `app/build.gradle` (`namespace` and `applicationId`) and the
  Java package directory. After the first upload it is settled.
- **The signing key**, as above.
- **`versionCode` only ever goes up.**

## Decisions that are just decisions

- **`minSdk 28`** (Android 9 / Fire OS 7) covers the Fire HD 8 from 2018, the
  Fire HD 10 from 2019, and the Fire Max 11. It is set there because the game
  ships as ES modules, which need a Chromium 61+ WebView; Fire OS 7 tablets
  carry Amazon WebView 87 and newer, comfortably clear. Lowering it to reach the
  Fire OS 5 tablets means bundling the modules into one classic script first —
  `tools/build-single-file.mjs` already does exactly that, so it is a real
  option, just not a free one.
- **No minification.** One Activity is not worth shrinking, and R8 cannot see
  into the WebView, so it would be risk without benefit.
- **No `androidx` dependency.** `GameAssetServer` is the forty lines of
  `java.io` that `androidx.webkit`'s asset loader would have provided, and the
  dependency block stays empty — matching the no-runtime-dependency rule the
  rest of Rocketman is built under.

---

## What still needs a real device

Everything below is verified by `e2e/firetablet.spec.js` running Chromium at a
Fire HD 10's viewport, which is a good proxy and not the same thing. A Fire
tablet's Amazon WebView is a different Chromium build on much slower silicon.

- **Frame rate under load.** The renderer sizes its backing store to
  `devicePixelRatio`, so a Fire HD 10 draws 1920×1200 every frame on a MediaTek
  GPU. The simulation is fixed at 20 ticks/s and cannot be affected — a dropped
  frame changes nothing about the match — but a late-game skirmish is where you
  would find out whether the *renderer* needs a resolution cap. Attach
  `chrome://inspect` and watch a full skirmish before deciding; do not add the
  cap on suspicion.
- **Audio latency.** WebAudio is synthesised, not sampled, so there is nothing
  to load, but Fire tablets have historically had a long output path.
- **The long-press gesture.** `setOnLongClickListener` returning true is what
  keeps Android's text-selection popup off the battlefield. Confirm attack-move
  actually fires on hardware.
- **Memory.** `largeHeap` is on and the APK is 188 KB, but Fire tablets are
  memory-tight and `onRenderProcessGone` is handled for a reason.

---

## Where this sits

`rocketman/swift/` is the Apple port: the engine rewritten in Swift with a
bit-for-bit conformance harness, because that platform wanted a native binary.
This directory is the opposite bet — the platform runs the game as it is, so the
work was to stop getting in its way.

Both are downstream of the same property: `engine/` is deterministic and has no
idea what a screen is.
