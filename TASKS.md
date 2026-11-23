# Haltline task list

Deadline: 29 Nov 2026, 20:59 (UTC+1). Feature freeze 27 Nov. Audit + video 28 Nov. Submit 29 Nov morning.

- [x] 1. Repo hygiene + scaffold
- [x] 2. Backend (Supabase Edge Functions) + paper exchange (live-verified; voice transcription not yet run live)
  - [x] Pure logic + tests: limit/state maths, cooldown + confirm, reduce-only planner, testnet-only guard
  - [x] Schema migration + RLS + atomic cooldown/confirm helpers (verified in pglite)
  - [x] Pivot: Bybit/Binance testnets blocked by region -> PAPER exchange (own Postgres account, Bitstamp public prices)
  - [x] 8 Edge Functions deployed (Frankfurt) and live-checked: scripts/live-check.ts 31/31 (health, prices, pairing, limits, paper open/close, snapshot, propose/confirm cut-half, cooldown, kill switch, actions log)
  - [x] Bybit client, Groq client, voice parser, pairing brute-force protection (migration 2)
- [x] 3. Glasses app: states, swipe/press actions, pairing, offline/empty states (simulator-verified; real glasses untested; voice state comes in step 5)
- [x] 4. Pairing + settings (web): Pair, Limits (live + kill switch), Positions (paper panel), Activity (browser-tested against the live backend)
- [x] 5. Voice (Groq Whisper): live transcribe verified with synthesized speech; mic path verified in simulator (failure path); spoken success path and hardware mic untested
- [x] 6. Website: Home, How it works, Limits, Positions, Activity, Safety, Pair, Docs (live data; browser-checked desktop + mobile; no broken images or console errors)
- [ ] 7. Deploy (GitHub Pages for site, Supabase for backend), automatic
- [ ] 8. Audit (find holes, fix them) -> AUDIT.md
- [ ] 9. README + FEATURE_REQUESTS.md + submission pack
