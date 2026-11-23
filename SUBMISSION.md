# DoraHacks submission text: Haltline

Track: **Track 3, Exchanges & Stocks** (Heads Up: Even Realities Hackathon).

## One line

Haltline puts your daily loss limit in front of you on Even G2 glasses: one giant number for how much you can still lose today, and one confirmed gesture to cut when you hit it.

## Short description (for the summary field)

Haltline is a risk guard for one trading session, shown on Even G2 glasses. A single number shows how much you can still lose today before your own daily loss limit, with a gauge that fills as you get close. At the limit, swipe and press to cut half or cut all, with a confirm step, a cooldown and a kill switch. Paper trading only, priced from live public data.

## Full description

**The problem.** Most traders have a daily loss limit and break it. The moment you most need to see your limit is the moment you least want to pick up a phone, and apps that tell you are tickers, portfolio trackers or stop-loss tools in a crowded space.

**What Haltline does.** One job, done well. The glasses show one giant number, the distance to your own daily loss limit (for example "$412 left to lose today"), with a gauge line that fills as the limit gets closer. There are three states:

- **Calm:** plenty of room.
- **Closing in:** about 80% used, shown as "$96 left to lose today · CLOSE".
- **Tripped:** "LIMIT REACHED", with the choices cut half, cut all or dismiss. Swipe to change, press to confirm.

**Read and write.**

- **Read:** live positions and PnL from a paper trading account, marked to live public market prices (Bitstamp's public ticker). Realised PnL (net of fees) and unrealised PnL are combined against your limit.
- **Write:** confirmed reduce-only orders on the paper account, and limit settings, by the website or by voice ("set limit five hundred", through Groq Whisper, with a swipe-only fallback).

**Safety, built for real.**

- Paper only, enforced in code: the backend can only reach a public price feed and a speech service, and a test scans the source for any real-exchange trading or payout path.
- Reduce-only cuts: a cut can close or shrink a position, never open or grow one.
- A confirm step (20 seconds, single use), a stray-press guard, a 60 second cooldown claimed atomically in the database, and a kill switch that only the website can switch back on. In a live test, six simultaneous confirms of one proposal executed exactly once.
- Fails closed: stale or implausible prices or a lost connection replace the number with NO PRICES or OFFLINE and block actions.
- Raising the limit from the glasses is refused while you are close to it or past it.
- Row-level security, hashed revocable device tokens, brute-force limits on pairing, and an actions log of everything the guard did, including refusals.
- A hostile audit of the live backend: 124 of 124 attack checks held after fixes. The audit is in the repository (`AUDIT.md`).

**Why paper.** Exchange testnet sign-ups were not available in my region, so I built a simulated account in the project's own database, priced from real public data, behind a small exchange-adapter interface. A real testnet adapter would plug into that interface without touching the limit maths, the confirm flow or the glasses app. The account's model (spread, 1 bp slippage, 0.05% fee, 5x exposure cap, no liquidation) is stated on the website and in the API.

**How it is built.** The glasses app (TypeScript, Vite, `@evenrealities/even_hub_sdk`) talks only to our backend: eight Supabase Edge Functions (Deno) over Postgres with row-level security. The website (React, Vite, TypeScript) on GitHub Pages is where you pair a device with a 6-digit code (no password), set the limit and kill switch, open and close paper positions, and read live positions and the actions log. Everything runs on free tiers, with automatic deploys through GitHub Actions and a keep-alive ping. 234 automated tests run the real SQL migrations in an in-memory Postgres.

**Honest status.** Tested in the official Even Hub simulator; not yet verified on physical glasses. Swipe direction mapping, BLE timing, font rendering and the microphone format on real hardware are unverified. The app ignores swipe direction (any swipe cycles; a swipe on a confirm only cancels), so a wrong guess cannot select or confirm anything.

**Business potential.** The same guard applies to any account with a loss limit: a real testnet or broker adapter, team-level limits (a desk head sees everyone's distance to limit), and cooldowns for prop-firm and challenge rules where breaking a daily limit ends the account. These are directions, not shipped features.

## Pre-existing work

The official Even Hub minimal template was first downloaded on 19 Nov 2026 to test the development environment (a tap-counter test, no Haltline code, not part of this repo). The /glasses scaffold in this repo was downloaded fresh from that template on 23 Nov 2026. All Haltline code was written from 23 Nov 2026.

## Links

- Live site: https://ace-coderr.github.io/haltline/
- Source: https://github.com/ace-coderr/haltline
- Audit: `AUDIT.md`. Feature requests for the Even Hub SDK: `FEATURE_REQUESTS.md`.
- Demo video: https://youtu.be/FE8zsHU2s8o (shows the official Even Hub simulator and a paper account; not tried on physical glasses).

## Built with

TypeScript, React, Vite, Node.js, Deno, Supabase (Postgres, Edge Functions, Auth), Even Hub SDK, Groq Whisper, Bitstamp public API, GitHub Actions and GitHub Pages.

## Disclaimer

Paper trading only. No real funds are held, nothing here is financial advice, and no order ever reaches a real exchange.
