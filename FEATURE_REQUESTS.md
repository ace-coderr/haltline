# Feature requests for the Even Hub SDK and platform

Five concrete requests, each from a gap I hit while building Haltline (a risk guard for Even G2 glasses). Everything below was observed with `@evenrealities/even_hub_sdk` 0.0.10, `@evenrealities/evenhub-simulator` 0.7.x and `@evenrealities/evenhub-cli` 0.1.x in November 2026. I have no physical glasses, so these are about the SDK, the docs and the simulator, not the hardware.

---

## 1. Document (and expose) how scroll events map to swipe up and swipe down

**What I hit.** The SDK defines `OsEventTypeList.SCROLL_TOP_EVENT` and `SCROLL_BOTTOM_EVENT`, and the simulator README says its supported inputs are "Up, Down, Click, Double Click". Nothing says which physical swipe produces which event. Over several `up` inputs in the simulator the app received both `eventType` 1 and `eventType` 2 (I could not rule out stray inputs from the simulator window), which suggests the names are "scroll reached the top/bottom" boundary events, not "the user swiped up/down". A menu that moves the highlight on `SCROLL_BOTTOM` may go backwards on hardware, and I cannot tell.

**Why it matters.** Any app with a list or a choice depends on it. A wrong guess can select the wrong option. Haltline works around it by ignoring direction (any swipe advances, and a swipe on a confirm screen only cancels), which costs usability: you can never go back.

**Request.** (a) Document the mapping per container type, including what happens at the ends of a list. (b) Add an explicit direction to the event payload, for example `swipe: "up" | "down"`, separate from boundary events. (c) Make the simulator emit exactly what the hardware emits.

---

## 2. Let the simulator accept injected audio (and say what the hardware sends)

**What I hit.** The simulator records from the PC's default microphone and emits 16 kHz, signed 16-bit little-endian, 100 ms PCM events. There is no way to feed it a file or a scripted utterance. I could verify my speech pipeline end to end up to the audio event, and I could verify the transcription service with synthesized speech, but I could not drive a spoken command through the real app path in the simulator. A script (or an AI agent) cannot test voice features at all, and a speaker next to a microphone is not a test.

**Why it matters.** Voice is the one input that is hard to demo and hard to regress. The simulator already has an automation port for screenshots and input; audio is the missing half.

**Request.** (a) An automation endpoint such as `POST /api/audio` (raw PCM or WAV, with timing options) and/or a `--audio-file` flag. (b) State in the SDK docs whether the hardware PCM format matches the simulator's, how long a capture can run, and what happens on microphone permission denial. `audioControl(true)` returns only a boolean.

---

## 3. Give text containers size, alignment and brightness controls

**What I hit.** A text container has no font size, no alignment and no brightness level. The one thing a glanceable app needs, one giant number, is not possible with text. I render the number into a canvas and send it as a PNG, split into two 288x144 images that sit side by side to fill the 576-pixel width. Centring a gauge line meant counting glyph widths by hand (the heavy block glyph is about 20 px wide) and sizing a container to fit it exactly. Dimmed secondary text, which the platform's own colours (`#2fb46a`, `#1f8a4d`) suggest, is only reachable through images.

**Why it matters.** Images cost BLE bandwidth and memory, must be sent one at a time, and need a canvas in the WebView. A large-text option would make the simplest, most useful screens cheap and reliable.

**Request.** Add `fontSize` (from a small set), `textAlign` and a brightness level to `TextContainerProperty`/`TextContainerUpgrade`. Publish the glyph set of the glasses font: I had to discover by trial that `█` and `━` render while `░`, `▮` and `✓` do not.

---

## 4. Make image updates atomic, verifiable and testable for timing

**What I hit.** Image containers are capped at 288x144, so a full-width element needs two containers updated by two calls that must not overlap. In one run the left half showed new text while the right half still showed the previous screen ("DIDN'T CA" next to "RING"). I could not reproduce it afterwards, and found that I had not been checking the `ImageRawDataUpdateResult` of each call. The simulator, by its own README, "does not enforce constraints such as hardware image-size limits", and it processes images faster than hardware, so BLE timing and dropped updates cannot be tested anywhere I have access to.

**Why it matters.** Mismatched halves would be a visible, confusing failure on a display people trust at a glance. For a risk tool, a stale half of a number is worse than a blank one.

**Request.** (a) Allow one image container at full width (576x144 or larger), or a documented way to update several containers atomically. (b) Document the expected transfer time per image and a recommended update rate. (c) Add an optional simulator mode that throttles image transfer and randomly fails some updates, so apps can test their retry and consistency logic before hardware.

---

## 5. Document the app lifecycle and the manifest, and make startup idempotent

**What I hit.** Three things I learned from errors and source code, not from the docs:

- `createStartUpPageContainer` works once per session. The README says a second call "will have no effect"; in practice, after a page reload (hot reload, or the simulator reloading the WebView) it returns `1` (invalid), and an app that treats that as fatal stays blank. The fix is to fall back to `rebuildPageContainer`, which the README mentions only in passing.
- The `app.json` `permissions` schema (names such as `network`, `g2-microphone`, and the `whitelist` array of origins for `network`) is not in the SDK README. I found it by reading the validation code inside the CLI package.
- Local storage: after restarting the simulator my app showed a new pairing code each time, so the stored device token did not appear to survive a restart. I did not establish whether that is the simulator, my code, or intended, and the docs do not say how durable `setLocalStorage` is.

**Why it matters.** Every app hits the first two, and the third decides whether pairing-style apps need re-pairing after each launch.

**Request.** (a) Make `createStartUpPageContainer` idempotent (second call behaves like `rebuildPageContainer`), or document the pattern prominently. (b) Publish the manifest schema, including permission descriptions and the network whitelist format, and what the whitelist actually enforces. (c) Document the persistence guarantees of `setLocalStorage`/`getLocalStorage` on device and in the simulator.
