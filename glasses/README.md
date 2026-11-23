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

## Controls

- **Swipe up / down**: cycle cut half / cut all / dismiss.
- **Press**: open the action menu; select; confirm.
- A confirm step always follows (20 s to answer, a press in the first 0.9 s is ignored as a
  stray press), and the server enforces a 60 s cooldown and the kill switch.
- Double press is **never** used as an action: the platform uses it to exit the app.

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
