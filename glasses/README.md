# Haltline glasses app

Even G2 app (576x288, monochrome green). It shows one giant number: how much you can still
lose today before your own daily limit, with a gauge line that fills as the limit gets closer.
The account is a **PAPER** account (simulated, priced from public market data); every screen
says so.

| State | What the glasses show |
|---|---|
| CALM | `$437`, "left to lose today", low gauge |
| CLOSING IN (80%+ used) | `$11`, "left to lose today · CLOSE" |
| TRIPPED | `LIMIT REACHED`, `■ CUT HALF?  □ cut all  □ dismiss`, "swipe: change · press: confirm", pulsing gauge |

Also handled: not paired (6-digit pairing code), loading, offline (live numbers are replaced,
never shown stale), prices unavailable, no limit set, no open positions, cooldown, writes off.

## Verification status (read this first)

**Tested in the official Even Hub simulator. Not yet verified on physical glasses.** Hardware-unverified:

- **Swipe direction.** The SDK does not document how `SCROLL_TOP_EVENT` / `SCROLL_BOTTOM_EVENT` map to swipe up / swipe down. The app therefore ignores direction: any swipe advances to the next option, and a swipe on the confirm screen only cancels, so a wrong guess cannot select or confirm anything.
- **BLE timing.** How fast the images and text updates reach real glasses, and how the pulse and gauge animation look, have not been measured. Updates are coalesced and only changed containers are sent.
- Font rendering and exact text widths (the simulator's fonts differ from the hardware's), and the microphone PCM format on hardware.

## Controls

- **Swipe (either direction)**: advance through cut half / cut all / dismiss.
- **Press**: open the action menu; select; confirm.
- A confirm step always follows (20 s to answer, a press in the first 0.9 s is ignored as a
  stray press), and the server enforces a 60 s cooldown and the kill switch.
- Double press is **never** used as an action: the platform uses it to exit the app.

## Voice (optional bonus; the core works without it)

On an idle screen, **any swipe** starts listening for up to 4.5 s (or press/swipe again to finish). Say
"set limit five hundred". The recording is sent to the `transcribe` Edge Function (Groq Whisper, free tier:
about 20 requests/min and 2,000/day, no SLA), parsed ("five hundred", "1,200", "twelve hundred"), and shown as
`LIMIT $500 · heard: "Set limit 500."`. Nothing is written until you press to confirm (a press in the first
0.9 s is ignored), and swipe cancels. If Groq is down or rate limited, or the microphone is unavailable, the screen
says so ("VOICE UNAVAILABLE") and **press** opens a gesture fallback: any swipe steps through $100 / $250 / $500 /
$1,000 / $2,500, press chooses, then the same confirm. Raising the limit from the glasses is refused by the server
while you are close to it or past it (use the website).

Verified: the live `transcribe` function with synthesized speech ("Set limit five hundred" -> 500, "twelve
hundred dollars" -> 1200, unrelated speech -> unclear), and in the simulator the full microphone path (listening
screen, PCM events, WAV upload, transcript, "didn't catch that" with the heard text). **Not verified:** a spoken
command taking the success path through the simulator microphone (the simulator uses the PC microphone and I could
not inject speech into it), and the microphone PCM format on real glasses.

## Structure

- `src/model.ts`: pure state machine and screen builder (unit-tested, no DOM or SDK).
- `src/gauge.ts`: gauge line and its smooth-fill animation.
- `src/api.ts`: client for the Haltline Edge Functions (device-token auth, no keys).
- `src/render.ts`, `src/canvas.ts`: draws the layout; only changed containers are sent over BLE.
- `src/main.ts`: wiring (pairing, polling, input events).

## Run

```bash
cp ../.env.example .env   # fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public values)
npm install
npm test                  # model tests
npm run dev               # Vite on 5173
npm run simulate          # evenhub-simulator (restart it after every edit)
npm run pack              # builds the .ehpk
```
