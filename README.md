# Culture Arbitrage

Find what your city is missing that its taste twin already loves, with the Qloo evidence behind every gap.

Boba was proven in Taipei, and malatang in Seoul, years before either one took over Tokyo. Chains pay consultants to look for gaps like these. Someone opening one shop can't, so they find out last. Culture Arbitrage is an agent that pairs each neighbourhood with its taste twin in another city using Qloo, compares what each one already supports, and argues against its own ideas before it shows you anything.

> Status: running on **live Qloo data** (Tokyo, New York, Seoul). Listening bars and K-beauty stores have no matching Qloo tag yet, so live runs skip them.

## What it does

Pick a city and, optionally, a focus (dining, nightlife or retail). A Claude agent, using Qloo as its tools:

1. Profiles the taste of each neighbourhood (Qloo `/v2/insights`: `urn:tag` with a location signal, and the taste tags Qloo attaches to each locality, such as "trendy", "vintage stores", "cafe hopping", "young professionals")
2. Finds its "taste twin" neighbourhood in other cities: Qloo ranks the other city's localities with the home neighbourhood as the signal, and the agent scores each by the share of Qloo taste tags the two have in common, listing the tastes they share
3. Compares how many places Qloo lists for each category in the twin and at home (Qloo places). A gap needs at least 4 in the twin and 3 times the home count
4. Doubts its own findings: does the rest of the city already cover it? does the category's audience match the people there (Qloo demographics of the category's fans, against official resident statistics for Tokyo wards)? is interest fading (Qloo `/v2/trending`)? is the evidence thin, or cut off by Qloo's page size? With a Google Maps key, it also asks a second, independent index whether it sees the same gap, and rules the gap out if it doesn't
5. Submits the gaps that survive, each with a six-part score and the evidence behind it. If nothing convincing turns up, it says so: that is a valid answer

Every step, Claude's reason for it, and every Qloo call are shown live in the UI. After each Qloo lookup the gaps found so far are scored again, so you can watch a score fall (or rise) as the agent's own checks come in. Each opportunity keeps that score trail, one line per check, with the Qloo calls behind it. Each number on an opportunity carries a `Q<n>` chip that jumps to the Qloo call it came from. A world route map draws each taste twin and each opportunity as an arc from the city where the demand is proven to the city that lacks it.

If Claude is unavailable (no key, no credit, a network error), the same tools run as a fixed pipeline, so the app always produces a result.

### Scores

| Score | Source |
|---|---|
| Proven elsewhere | Qloo: places in the twin neighbourhood |
| Bridge audience | Qloo: share of taste tags the two neighbourhoods have in common (half shared counts as a full match) |
| Core audience fit | Qloo: age profile of the category's fans (a broader tag's fans, labelled, where Qloo has none), compared by shape with the neighbourhood's residents (Tokyo: resident register; elsewhere: fans of the neighbourhood's Qloo tastes) |
| Local undersupply | Qloo: places here vs in the twin, and across the city |
| Product fit | **LLM judgment**, labelled as such |
| Durability | Qloo: trend of the category over time. Live Qloo `/v2/trending` covers artists, brands, films and TV but not places, so on live data it is shown as not measurable and not counted against the card |

Scores are computed in code from cached Qloo responses only. The model chooses what to look up and explains it, but cannot put a number on a card that did not come from Qloo. The exceptions are labelled on the card: Product fit is the model's judgment, and in Tokyo the residents' side of Core audience fit comes from the Tokyo Metropolitan Government's resident statistics, because Qloo describes the fans of a taste, not the people who live somewhere.

The Google Maps cross-check changes no score and no confidence. It can only rule a gap out (when Google Maps lists as many places around the home neighbourhood as around the twin), and its numbers are shown in their own box on the card, labelled "Google Maps", apart from the Qloo evidence. It runs on every submitted gap when a key is set; a card it could not check says so.

Confidence = average of the measured scores × (1 − 0.05 × open doubts, at most 0.4 off). A check the agent skipped counts as an open doubt, so skipping work never raises confidence. A submission that fails the gap rule is sent back to the agent. One that lands below 55% confidence is ruled out: the agent gets the reasons back, and the page keeps it greyed out with its score trail instead of counting it as an opportunity. The fixed pipeline rules out weak gaps the same way.

### What the agent can't know

- A place missing from Qloo may be missing from the index, not from the street. Counts are places Qloo lists, not a census. The city-wide check, the thin-data flag and the Google Maps cross-check catch some of these cases, not all. Google Maps counts are approximate too: a 3 km square around each neighbourhood's centre, a keyword search, at most 60 results.
- Results are a snapshot of today's taste data, not a historical backtest.
- Boba and malatang are survivors. Tapioca shows a real gap can fade, which is why Durability is scored.
- Similarity is between audiences, not streets. Rent, regulation and footfall are out of scope.

### What's next

- Live Qloo data for Tokyo, plus US cities where Qloo's coverage is deepest.
- A hold-out sanity check: hide one category from a city's supply and see whether the agent still points to where it really clusters (a consistency check on today's snapshot, not a historical backtest).
- The same taste-twin engine works for people too: tell it the neighbourhood you love, and it finds the one in your new city whose people love the same things. Taste match only, no listings or rent.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env.local   # Windows PowerShell: Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000.

The "Example from a recorded run" section on the page comes from `src/data/sample-run.json`. To re-record it, keep `npm run dev` running and run `node scripts/record-sample.mjs` in a second terminal. Record it with `GOOGLE_MAPS_API_KEY` unset: Google's terms don't allow storing Places results.

## Modes

| Variable | Values | Default |
|---|---|---|
| `QLOO_MODE` | `mock`, `live` (needs `QLOO_API_KEY`) | `mock` |
| `LLM_MODE` | `mock` (fixed pipeline, no model), `claude` (Claude agent, needs `ANTHROPIC_API_KEY`) | `mock` |
| `ANTHROPIC_MODEL` | Claude model id | `claude-opus-5-5` |
| `QLOO_CALL_BUDGET` | max Qloo calls per exploration | `40` |
| `EXPLORE_TIME_BUDGET_MS` | no new lookups after this long; the run finishes with what it has | `150000` |
| `MOCK_DELAY_MS` | pause per mock Qloo call | `350` |
| `QLOO_API_URL` | Qloo address, may include a path prefix | `https://api.qloo.com` |
| `QLOO_TIMEOUT_MS` | per-request timeout for live Qloo calls | `10000` |
| `QLOO_RETRIES` | extra attempts on 429 / 5xx / timeout / network errors | `2` |
| `QLOO_CACHE_TTL_MS` | how long identical live Qloo requests are answered from memory (`0` = off) | `21600000` (6 h) |
| `QLOO_CATEGORY_TAGS` | real Qloo tag ids per category, e.g. `malatang=urn:tag:...,bubble_tea=urn:tag:...` | unset (mock ids) |
| `GOOGLE_MAPS_API_KEY` | optional, enables the Google Maps cross-check (Places API (New)); only used with `QLOO_MODE=live` | unset |
| `GOOGLE_CALL_BUDGET` | max Google Maps requests (result pages) per exploration | `24` |
| `EXPLORE_MAX_CONCURRENT` | explorations allowed to run at once | `3` |
| `EXPLORE_RUNS_PER_IP_PER_HOUR` | per-visitor limit, production only | `20` |

API keys are read only on the server and never sent to the browser.

## Checks

```bash
npm run verify       # offline tests: Qloo client, cache, input checks, full mock runs, scripted Claude loop
npm run qloo:check   # one live Qloo request with the key in .env.local (add -- --tags to test category tag ids)
npm run google:check # one Google Maps search with GOOGLE_MAPS_API_KEY (place ids only, free tier)
```

`npm run verify` needs no keys and sends no network requests.

## Backend notes

- **Qloo client** (`src/lib/qloo/live.ts`): server-only, key sent as `X-Api-Key`. Each request has a timeout. 429, 5xx, timeouts and network errors are retried with backoff (honouring `Retry-After`); other 4xx are not, because the same request would fail again and waste quota. Errors are typed (`auth`, `bad_request`, `rate_limit`, `server`, `timeout`, `network`, `bad_response`), and the key is redacted from every message. A rejected key or a wrong address stops the run at once instead of failing every lookup in turn.
- **Budget** (`src/lib/qloo/index.ts`): every exploration has a hard cap on Qloo calls (`QLOO_CALL_BUDGET`). Retries count against it.
- **Cache** (`src/lib/qloo/cache.ts`): live responses are kept in memory for `QLOO_CACHE_TTL_MS`, shared across explorations in the same server instance, and concurrent identical requests share one HTTP call. Failures are never cached. Calls answered from cache are marked `cached` in the agent log. Within a run, `src/lib/agent/evidence.ts` also memoises every lookup, so the agent never pays twice for the same question.
- **Input checks** (`src/lib/agent/request.ts`): `POST /api/explore` takes `{"city": "Tokyo", "focus": "all" | "dining" | "nightlife" | "retail"}`. Unknown cities or focuses, non-JSON bodies and bodies over 2 KB get a 4xx with a plain message. `GET /api/explore` returns the cities, focuses and modes (never keys).
- **Abuse limits** (`src/lib/limits.ts`): a cap on concurrent explorations and a per-visitor hourly limit protect the shared Qloo quota and Claude credit on the public demo. Both are in-memory, so on Vercel they are per instance.
- **Google Maps cross-check** (`src/lib/google/places.ts`): server-only, Places API (New) Text Search. It asks only for place ids (field mask `places.id,nextPageToken`), which Google bills as "Text Search Essentials (IDs Only)", free without a monthly limit, inside a hard `locationRestriction` rectangle. At most 3 pages (60 results) per search and `GOOGLE_CALL_BUDGET` requests per run. Nothing from Google is stored beyond the run. The key is redacted from every message, and a rejected key stops further Google requests for the run.
- **Tokyo ward statistics** (`src/data/tokyo-ward-ages.json`, `src/lib/agent/census.ts`): residents aged 20 and over in each of the 23 wards by age band, as of 1 January 2026, turned into a lean per band against the 23 wards as a whole.
- **Cities and categories**: the explorable cities are in `src/lib/cities.ts`; categories and their Qloo tag ids are in `src/lib/agent/categories.ts`. Switching to real data means setting `QLOO_MODE=live`, `QLOO_API_KEY`, and the real tag ids (in that file or `QLOO_CATEGORY_TAGS`).

## Credits

Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via [world-atlas](https://github.com/topojson/world-atlas). Tokyo ward population by age: 東京都総務局統計部「住民基本台帳による東京都の世帯と人口」令和8年1月, 第7表 (Tokyo Metropolitan Government, Bureau of General Affairs, Statistics Division). Place counts in the cross-check: Google Maps. Fonts: Figtree, Geist Mono (SIL Open Font License, via Google Fonts).

## License

MIT
