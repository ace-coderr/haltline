# Haltline task list

Deadline: 29 Nov 2026, 20:59 (UTC+1). Feature freeze 27 Nov. Audit + video 28 Nov. Submit 29 Nov morning.

- [x] 1. Repo hygiene + scaffold
- [x] 2. Backend (Supabase Edge Functions) + paper exchange (live-verified; voice transcription not yet run live)
  - [x] Pure logic + tests: limit/state maths, cooldown + confirm, reduce-only planner, testnet-only guard
  - [x] Schema migration + RLS + atomic cooldown/confirm helpers (verified in pglite)
  - [x] Pivot: Bybit/Binance testnets blocked by region -> PAPER exchange (own Postgres account, Bitstamp public prices)
  - [x] 8 Edge Functions deployed (Frankfurt) and live-checked: scripts/live-check.ts 31/31 (health, prices, pairing, limits, paper open/close, snapshot, propose/confirm cut-half, cooldown, kill switch, actions log)
  - [x] Bybit client, Groq client, voice parser, pairing brute-force protection (migration 2)
- [ ] 3. Glasses app: three screens, swipe/press actions
- [ ] 4. Pairing + settings (web)
- [ ] 5. Voice (Groq Whisper) for hands-free limit setting
- [ ] 6. Website (multi-page, live data)
- [ ] 7. Deploy (GitHub Pages for site, Supabase for backend), automatic
- [ ] 8. Audit (find holes, fix them) -> AUDIT.md
- [ ] 9. README + FEATURE_REQUESTS.md + submission pack
