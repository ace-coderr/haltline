# Audit

A hostile review of Haltline: try to break it, fix what breaks, and say plainly what was not tested. Performed on 23 Nov 2026 against the deployed backend (Supabase project, Frankfurt), the published site and the glasses app in the official simulator.

**Headline.** The hostile live suite went from **118 of 121 passed (3 failed)** before the fixes to **124 of 124 passed** after. Of the three failures, one was a real defect and two were flaws in my test. Beyond the suite, review, accessibility, layout, dependency and secret scans found 10 more issues; all are fixed. The open risks are listed at the end.

## Method

1. `supabase/scripts/audit-live.ts`: a scripted attacker that creates throwaway anonymous users and attacks the live API the way a malicious or buggy client would (hostile inputs, forged requests through the REST API, races with real concurrency, cross-user theft, floods). Re-runnable: `node scripts/audit-live.ts`. It creates test users and uses up your pairing quota for an hour (see finding 3).
2. Code review of the money path: propose, confirm, cooldown, paper fills, pairing.
3. Frontend: axe-core (WCAG 2.1 A and AA plus best practices) on all nine routes, layout at 320 px, link and image crawl, console errors, a production build checked under its Content-Security-Policy.
4. `npm audit` in all three packages, and a scan of the full git history (16 commits).

## Results of the attack suite

| Area | Before | After |
|---|---|---|
| Authentication and sessions (no, garbage, expired-looking, wrong-kind and SQL-ish credentials) | 9 of 9 held | 9 of 9 held |
| Row-level security through the REST API (anonymous and signed-in reads, forged limits, fills, PnL and balances, calls to internal functions) | 28 of 28 held | 28 of 28 held |
| Malformed and hostile inputs (bodies, limits, sizes, symbols, ids, audio, preflight, headers) | 52 of 53 held, **1 failed** | 53 of 53 held |
| Empty account and huge positions | 4 of 4 held | 4 of 4 held |
| Double actions and races on real Postgres | 5 of 7 held, **2 failed (test flaw)** | 9 of 9 held |
| Cross-user isolation, kill switch, limit-raise rule, device revoke | 13 of 13 held | 13 of 13 held |
| Pairing brute force and floods | 5 of 5 held | 6 of 6 held |
| Request flooding (80 and 40 parallel requests) | 2 of 2 held | 2 of 2 held |
| **Total** | **118 of 121 held** | **124 of 124 held** |

The suite grew by three checks between runs (the stray-press section now checks that the proposal survives a stray press and can still be confirmed, and the pairing section checks which limit fired).

## Findings and fixes

| # | Finding | Severity | How found | Status | Evidence after the fix |
|---|---|---|---|---|---|
| 1 | An oversized upload (over 1 MB audio) returned **503** instead of 413: the server answered before the client finished uploading and the proxy turned it into an error. | Low | Live attack | Fixed: the body is drained up to a bound, then 413 | Live: oversized body and oversized audio are both 413 |
| 2 | "Immediate confirm is refused as a stray press" failed. **Test flaw, not a defect:** my round trip exceeded the server's 0.8 s window, so the confirm legitimately executed. | None | Live attack | Test rewritten to accept either outcome and to cover the survive-then-confirm path | Live: 425, then the same proposal confirmed (200) |
| 3 | "Six parallel confirms execute exactly once" failed as a knock-on of 2 (the proposal had already been used). **Test flaw.** | None | Live attack | Test restructured | Live: six parallel confirms gave statuses 200, 409 x5, exactly one order |
| 4 | Refusals at the **propose** step (kill switch, cooldown, no positions, no prices) were not written to the actions log, so the record showed executions but not attempts. | Medium | Review (also requested) | Fixed: logged with `reason` and `stage: propose`; malformed input (400) is not logged | Live: the log shows `cut_half rejected no_positions` and `cut_all rejected kill_switch`, both with `stage: propose` |
| 5 | One account could hammer `act`, limit writes and reads, bloating the log and loading the database. | Medium | Review | Fixed: per-user ceilings (30 per minute for act and limit writes, 120 for reads) | Unit tests; limits are per server instance (see open risks) |
| 6 | **Pairing flood:** one client could fill all 200 pending codes and block pairing for everyone for ten minutes. | Medium | Review | Fixed: a per-client-address limit of 10 per hour, stored as a SHA-256 hash (migration `20261123040000`) | Live: 25 starts gave 7 OK and 18 refused, with the "your network" message (3 earlier starts in the same run completed the 10) |
| 7 | The price feed trusted one public source blindly: a bogus quote could trip a limit or fill an order at a nonsense price. | Medium | Review | Fixed: a spread over 5% or a 25% jump from a recent quote is rejected; the stale old quote then fails closed | Unit tests only; I did not feed bad prices to production |
| 8 | The published site had no Content-Security-Policy. | Low | Review | Fixed: a meta CSP on production builds | Checked on the production build: an injected inline script did not run, a fetch to a foreign host was blocked, and live data still loaded |
| 9 | Accessibility: four problem groups, namely invalid list structure on the Home steps, low-contrast step numbers, scrollable code and tables not keyboard-focusable, duplicate region labels, and heading order on pages without a second-level heading. | Medium | axe-core | Fixed | axe reports **0 violations on all nine routes** (WCAG 2.1 A/AA and best practices) |
| 10 | Horizontal overflow at 320 px on Home, Positions and Docs. | Low | Layout probe | Fixed | No overflow on any route at 320 px |
| 11 | Glasses dev dependency (esbuild via Vite 5) allowed any website to read the dev server's responses. Dev-time only. | Moderate | `npm audit` | Fixed: Vite 8 | `npm audit` shows 0 vulnerabilities in all three packages; simulator still renders |
| 12 | **Renderer:** image updates did not check each call's result, so a dropped half could be recorded as shown and the giant number would disagree with itself ("DIDN'T CA" next to "RING"). | Medium | Found while testing voice | Fixed earlier: each result is checked, a failure forces a full resend after a back-off | Rapid-switching stress run across five screens was consistent; I could not reproduce the original glitch |
| 13 | Local `vite preview` used the wrong base path (a config bug; the published site was unaffected). | Low | Testing the CSP | Fixed | Preview serves the production build |

### Verified to hold (live, no change needed)

- **Double actions.** Six parallel opens with the same idempotency key created exactly one fill. Six parallel confirms of one proposal executed exactly once. A second proposal made before the first cut was refused by the cooldown (429). Every guard fill was reduce-only.
- **Cooldown bypass, kill switch, limit-raise rule.** The kill switch blocks proposals (403). The glasses cannot touch the kill switch or open paper trades. The glasses cannot raise the limit while TRIPPED (403 `raise_blocked`), and can lower it.
- **Bad inputs never reach a 5xx.** Sixteen hostile order shapes, including a size of 1e300, a size of 1e15, negative, string, null, array and object sizes, SQL in a symbol, and a 5,000-character symbol, all returned clean 4xx errors. Six malformed idempotency keys were refused. A position far beyond 5x equity was refused with `insufficient_margin` and changed nothing.
- **Row-level security.** Anonymous users cannot read any private table. Signed-in users cannot read server-only tables or the `token_hash` column, cannot write limits, the actions log, fills or balances through REST, and cannot call any internal database function. User B cannot see, confirm or revoke user A's proposals, rows or devices.
- **Pairing.** Five wrong codes give 400 and the sixth gives 429, and a locked-out user cannot claim even the correct code while another user can. A revoked device token stops working at once.
- **Empty account.** A brand-new account's snapshot is honest (no limit, no positions) and cutting with nothing open is a clean 409.
- **Flooding.** 80 parallel snapshot requests and 40 parallel price requests produced no 5xx.
- **CORS.** The preflight answers 204 without allowing credentials, and `*` is deliberate: authentication is by bearer token or device header, never by cookie. Responses are `no-store` and `nosniff`, and an error never leaks internals.

### The client-address header (requested check)

The per-address pairing limit needs the real client address. On production it works: the refusals carried the address-specific message, so the database counted the address. I also tested spoofing from the same machine after the per-instance limit had expired:

- A forged `X-Forwarded-For` (including a two-entry value) did **not** reset the limit. The function reads `cf-connecting-ip`, which the edge sets.
- A forged `cf-connecting-ip` sent by the client is rejected by the edge itself with HTTP 403.

So neither header could be used to evade the limit in my tests.

### Secrets and attribution

All 16 commits were scanned for Supabase secret and access-token prefixes, speech-service keys, GitHub tokens, JWTs, private keys, cloud keys, connection strings, email addresses and the publishable key. There were no hits. No `.claude` folder or `CLAUDE.md` has ever been committed, and no commit contains an AI attribution line. The two values in the repository variables (project URL and publishable key) are public by design.

## Open risks and not tested

- **Anonymous sign-in abuse.** Accounts are created only on request, but anyone can create them, and the cap relies on Supabase's defaults. I did not mass-create accounts to measure it. Recommended: tighten Authentication rate limits in the dashboard, and consider a CAPTCHA.
- **Rate limits are per server instance, not global.** The per-user ceilings and the 20-per-minute start limit reset per Edge Function instance. The per-address pairing limit is global (in the database).
- **Price guards were not exercised against production.** They are covered by unit tests with fake feeds.
- **Supabase paused, Groq down, exchange feed down, expired real tokens.** Covered by unit tests and the fail-closed design. Not simulated live. Garbage and expired-looking tokens were tested; a genuine expired session was not.
- **The glasses.** Everything glasses-side is simulator-only. Swipe direction mapping, BLE timing, fonts and the microphone format are unverified on hardware. A spoken command taking the success path through the simulator could not be driven.
- **Kill switch scope.** It stops cuts, not limit changes, by design.
- **A shared network address.** The 10-per-hour pairing limit applies per address, so several people behind one address (an office, a hackathon venue) share it. This audit itself used up my address's quota for an hour.
- **Dependencies.** Scanned with `npm audit` at the time of the audit only.
