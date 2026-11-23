# Haltline task list

Deadline: 29 Nov 2026, 20:59 (UTC+1). Feature freeze 27 Nov. Audit + video 28 Nov. Submit 29 Nov morning.

- [x] 1. Repo hygiene + scaffold
- [ ] 2. Backend (Supabase Edge Functions) + testnet exchange connection (Bybit testnet)
  - [x] Pure logic + tests: limit/state maths, cooldown + confirm, reduce-only planner, testnet-only guard
  - [x] Schema migration + RLS + atomic cooldown/confirm helpers (verified in pglite)
  - [ ] Accounts from user: Supabase project, Groq key, Bybit testnet keys (no withdrawal)
  - [x] Edge Functions written + tested with fakes: health, limits, positions, act, pair, transcribe (not yet deployed)
  - [x] Bybit client, Groq client, voice parser, pairing brute-force protection (migration 2)
  - [ ] Live testnet read + reduce-only order verified
- [ ] 3. Glasses app: three screens, swipe/press actions
- [ ] 4. Pairing + settings (web)
- [ ] 5. Voice (Groq Whisper) for hands-free limit setting
- [ ] 6. Website (multi-page, live data)
- [ ] 7. Deploy (GitHub Pages for site, Supabase for backend), automatic
- [ ] 8. Audit (find holes, fix them) -> AUDIT.md
- [ ] 9. README + FEATURE_REQUESTS.md + submission pack
