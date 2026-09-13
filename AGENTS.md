# Project Rules for Devin

## Flight Deal Pipeline

- Build: `npm run build`
- Deploy: `npx vercel --prod` then alias to `flight-deals-dashboard.vercel.app`
- Refresh data: `npm run clear:db && npm run run:pipeline`
  - `clear:db` deletes all `flights` and `deals`.
  - `run:pipeline` runs the full scraping/evaluation pipeline.
- To refresh production data: set `DATABASE_URL` to the Vercel Postgres URL, then run the same commands. Vercel CLI does not expose sensitive env values locally, so the pipeline must run in GitHub Actions (where `DATABASE_URL` is a repo secret) or on a machine with the Vercel Postgres connection string.

## Cost & AI Guardrails

- **Heavy AI is on-demand only; the pipeline stays fast even with up to 1 year of data.**
  - `processFlights` uses AI-generated reasoning for the first `MAX_AI_REASONING` (250) `GOOD_DEAL`/`MAYBE_GOOD_DEAL` flights.
  - The pipeline no longer pre-generates or stores deterministic fallback itineraries.
  - Full agentic itineraries (live news, Open-Meteo weather, LangGraph AI loop, Wikipedia images) are generated on demand when a user opens a `GOOD_DEAL` in the modal and are then cached in PostgreSQL.
  - Flights and deals are inserted in 1,000-row batches for speed.
- **Deal quality is based on the standard CPP formula.**
  - `CPP = (Cash Price − Taxes & Fees) / Points Required × 100`.
  - `GOOD_DEAL` ≥ 2.0¢, `MAYBE_GOOD_DEAL` ≥ 1.5¢, `OKAY_DEAL` ≥ 1.0¢, otherwise `BAD_DEAL`.
  - Cash Price comes from Duffel (real one-way offers in any cabin) when configured, then the Travelpayouts affiliate API (real-time Flight Search when approved, otherwise the free Data API `prices_for_dates` for economy). It prefers the award airline, then falls back to the cheapest cash option for that exact route and date. If live lookup fails, the static estimate table is used.
- The scraper uses `order_by=lowest_mileage` and searches up to 365 days (1 year) out with a max of 12,000 records per run.
- `/api/deals` is paginated; the dashboard loads 20 deals per page on demand.

## Maintenance Mode

- Set the environment variable `MAINTENANCE_MODE=true` to put the site into maintenance.
- When enabled, all page requests (except `/maintenance` and static assets) are redirected to `/maintenance`, which shows "We are updating".
- To enable on Vercel: add `MAINTENANCE_MODE=true` in the project environment variables and redeploy (`npx vercel --prod`).
- To restore the site, change it to `MAINTENANCE_MODE=false` (or remove it) and redeploy.

## Testing (save Gemini tokens — test locally first!)

### Image quality test (NO Gemini tokens, NO server required)
```bash
npx tsx scripts/test-images.ts                          # full test (14 landmarks + 5 destinations + hydration)
npx tsx scripts/test-images.ts --landmarks "X" "Y"      # test specific landmarks
npx tsx scripts/test-images.ts --destination London     # test specific destination
npx tsx scripts/test-images.ts --full                   # hydration test only
```

### Weather alert test (NO Gemini tokens, NO network, NO database writes)
```bash
npx tsx scripts/test-weather-alerts.ts   # covers thresholds, WMO codes, cron auth, date targeting, and persistence
```
All external calls and Drizzle queries are mocked, so this is safe to run anywhere.

### Smoke tests (local first, then production)
```bash
# Step 1: Start dev server
npm run dev

# Step 2: Run smoke tests against localhost (uses Gemini tokens but catches bugs before deploying)
npx tsx scripts/smoke-test.ts --local

# Step 3: Skip chat tests to save tokens (only tests deals, logistics, itinerary API)
npx tsx scripts/smoke-test.ts --local --skip-chat

# Step 4: Run against production after deploying
npx tsx scripts/smoke-test.ts
```

- `--local` tests against `http://localhost:3000` (default for local dev)
- `--skip-chat` skips all chat tests (3 chat tests consume ~$0.05-0.10 in Gemini tokens per run)
- Cities are randomized from a pool of 15 destinations each run (Tokyo, Paris, London, Bangkok, Seoul, Barcelona, Rome, Istanbul, Singapore, Amsterdam, Dubai, Hong Kong, Madrid, Sydney, Lisbon)
- The football trip test always uses London (to verify stadium landmarks)

## Production Alias

- The primary production URL is `jalan-ai.vercel.app` (not `flight-deals-dashboard.vercel.app`).
- After `npx vercel --prod`, always run `npx vercel alias <deployment-url> jalan-ai.vercel.app`.
- Vercel auth token lives at `~/Library/Application Support/com.vercel.cli/auth.json`.

## Weather Alerts (Vercel Cron)

- `vercel.json` schedules `/api/cron/weather-check` daily at 08:00 UTC.
- Requires `CRON_SECRET` in the Vercel project environment variables. Vercel sends it automatically as `Authorization: Bearer $CRON_SECRET`; the route returns 401 when it is missing or wrong.
- The cron checks saved trips departing two calendar days ahead (UTC) and writes or clears `saved_trips.weather_alert`. Alerts appear as an amber banner at the top of the One Stop trip card.
- Weather lookups reuse saved route coordinates and fall back to Open-Meteo geocoding by destination name. A failed lookup leaves the existing alert untouched rather than clearing it.

## Known Bugs & Fixes (lessons learned)

### Date handling
- **Yearless dates resolve to past.** "October" without a year gets parsed as October of the current year, which may be in the past. Fixed with `normalizeImplicitPastDateRange()` in `conversation-graph.ts` — bumps the year forward until the date is >= today when no explicit year appears in the user's message.
- **Inclusive trip duration.** End date must be `start + (durationDays - 1)`, not `start + durationDays`. A 5-day trip starting June 1 ends June 5, not June 6.

### Images
- **Openverse API moved.** The old URL `api.openverse.engineering` returns a 301 redirect that hangs. The correct URL is `api.openverse.org`. Always check if external API endpoints have changed when requests start timing out.
- **Stateful regex flags cause wrong matches.** Using `/pattern/gi` (with the `g` flag) in a loop retains `lastIndex` state across calls, causing the same regex to skip valid matches on subsequent uses. This caused Santorini images to resolve to Ponta Delgada. Fix: create a new regex each time, or use `match()` instead of `test()` with global regexes.
- **Transliterations break relevance scoring.** "Colosseum" didn't match "Colosseo" (Italian name on Wikimedia). `scoreImageRelevance()` now uses Porter stemming plus a length-normalized Levenshtein distance (≤ 2 edits, ≤ 25% of the longer word) instead of the old 5-character prefix rule, which caused false positives (e.g. it is too loose for "austin"/"austria").
- **Portrait images are rejected.** `hasGoodDimensions()` rejects images where height > width * 2. This is correct for display layout, but it means some landmarks (e.g. Ubud Monkey Forest) have no landscape photo available. The system now removes the placeholder cleanly instead of showing broken italic text.
- **Failed image placeholders look broken.** When no image is found, the old code rendered `*landmark name*` as italic text. This looks like a formatting error. Now the placeholder is removed entirely — a missing image is cleaner than confusing italic text.
- **Pexels accepted zero-relevance images.** Pexels had no minimum relevance threshold, so any stock photo (even completely unrelated) would be accepted. A search for "Sacred Monkey Forest Sanctuary" could return a harbor photo from Taiwan. Fixed by enforcing `MIN_RELEVANCE_SCORE` on Pexels results, same as other providers.
- **URL cross-validation catches wrong-location images.** Even with title-based relevance scoring, providers can return images whose filenames reveal they depict a completely different place. Added `urlMatchesTerm()` which checks that the image URL contains at least one distinctive word from the search term — e.g. rejects a URL containing "Tamsui" for a "Monkey Forest" search.
- **Too many image term variants = slow.** `expandImageTerm()` used to generate ~12 variants per term (landmark, city, station, street, district, market, park, temple, photo, building...). Most never match. Reduced to 3 (base, stripped suffix, photo) — cuts API calls by ~75% with negligible quality loss.
- **Sequential image providers are slow.** Trying Wikimedia -> Wikipedia -> Openverse -> Pexels one at a time means waiting for each provider before trying the next. Now all providers (Wikimedia Commons, Openverse, Pexels — Wikipedia removed) are raced in parallel with `Promise.allSettled()`, and the single highest-relevance result across providers wins instead of first-in-order. ~4x faster per term.

### Transport
- **Nominatim rate limiting.** Batching days 2 at a time with hard 1-second delays was too conservative. Geocode results are now cached in-memory per place+city, and all days are processed in parallel. The 5s fetch timeout handles any 429 responses gracefully.
- **Invalid transport routes on islands.** OSRM returns mainland driving routes for island destinations (e.g. 100km+ driving routes on Santorini). Routes over 100km are now discarded with a fallback message.
- **Non-existent train routes.** OSRM sometimes suggests train/walking routes that don't exist on small islands. Walking speeds are validated (impossible speeds are rejected).

### Itinerary format
- **Packing tips merge into last day.** The packing list was appended with only a blank line after the itinerary, making it look like part of the last day's content. Fixed by adding a `---` horizontal rule and a `## Packing Tips` heading as a clear separator.
- **Economy cabin forced "budget-friendly" language.** The itinerary prompt used to inject "budget-friendly" style for all ECONOMY cabin requests, even luxury honeymoons. Now the style is based on the budget field, not the cabin class.

### RAG Evaluation
- **Zod `$ref` breaks Gemini structured output.** The RAG evaluator's zod schema used shared sub-schemas that generated `$ref` in the JSON schema. Gemini's API doesn't support `$ref`. Fixed by inlining each metric (contextRelevance, groundedness, answerRelevance) with explicit score/reasoning fields.

### Performance
- **No fetch timeouts anywhere.** All external API calls (Nominatim, OSRM, Wikimedia, Wikipedia, Openverse, Pexels) had no timeout. A single slow or unresponsive provider could block the entire request indefinitely. All fetches now use `AbortSignal.timeout(5000)`.
- **Transport and images ran sequentially.** Transport was computed in `enrichNode`, then images in `respondNode` — back to back. Now both run concurrently via `Promise.all()` in `enrichNode`.
- **Gather node repeated on retries.** When the Critic rejected an itinerary, the graph re-ran `Gather` (weather, news, deals, images) on every retry. Fixed by separating `Gather` (one-time) from `Generate` (retryable).
- **Progressive streaming.** The core itinerary is now streamed as a `preview` event as soon as the Critic approves it (~26s), before enrichment starts. The enriched version replaces it via `final_content` (~48s). Users see useful content much sooner.

## Architecture Overview

```
User message
  -> Extract (entity extraction, date normalization)
  -> Clarify (if missing fields) | Answer (if question) | Gather (if trip plan)

Gather (one-time: weather, news, deals, destination image)
  -> Generate (itinerary + packing tips, retryable)
  -> Guardrails (landmark verification, day count, image placeholders, past dates)
  -> Critic (RAG evaluation: groundedness + answer relevance >= 4/5)
     -> if approved: Enrich (transport + images in parallel)
     -> if rejected (up to 3 retries): back to Generate
     -> if 3 failures: Reject
  -> Respond (final assembly, SSE streaming)
```

### Enrichment pipeline (post-approval)
- **Transport:** Geocode stops via Nominatim (cached), route via OSRM (walking + driving in parallel), LLM transit tips.
- **Images:** Race 4 providers in parallel (Wikimedia Commons, Wikipedia, Openverse, Pexels) per term. 3 term variants per landmark. In-memory cache.
- Transport and images run concurrently via `Promise.all()`.
- All external fetches have 5s timeout (`AbortSignal.timeout`).

## Image Vector Search Service

A separate Python/FastAPI microservice lives in `image-search-service/` and provides CLIP-based semantic image search using `pgvector`.

- Start the local service: `cd image-search-service && docker compose up -d app`
- Default local URL: `http://127.0.0.1:8000`
- Pre-seed images for landmarks: `IMAGE_SEARCH_SERVICE_URL=http://127.0.0.1:8000 npx tsx scripts/ingest-vectors.ts "Eiffel Tower" "Mount Fuji" ...`
- Jalan will use `POST /search` automatically when `IMAGE_SEARCH_SERVICE_URL` is set and falls back to the lexical provider pipeline otherwise.
- Minimum similarity threshold is controlled by `VECTOR_IMAGE_MIN_SCORE` (default `0.15`).

