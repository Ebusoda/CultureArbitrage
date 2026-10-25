# Culture Arbitrage

Find what your city is missing that its taste twin already loves, with the Qloo evidence behind every gap.

Boba was proven in Taipei, and malatang in Seoul, years before either one took over Tokyo. Chains pay consultants to look for gaps like these. Someone opening one shop can't, so they find out last. Culture Arbitrage is an agent that pairs each neighbourhood with its taste twin in another city using Qloo, compares what each one already supports, and argues against its own ideas before it shows you anything.

> Status: running on **live Qloo data** (Tokyo, New York, Seoul). Scans cover eight categories across dining, nightlife and retail; "check one business" covers 176 business types Qloo lists in these cities, plus anything else Qloo's tag search can match.

## What it does

Pick a city, then either let the agent scan (optionally with a focus: dining, nightlife or retail) or **check one business**: type the kind of place you want to open, such as "yoga studio", "ramen shop" or "瑜伽", and the agent checks only that (see [Checking one business](#checking-one-business)). A Claude agent, using Qloo as its tools:

1. Profiles the taste of each neighbourhood (Qloo `/v2/insights`: `urn:tag` with a location signal, and the taste tags Qloo attaches to each locality, such as "trendy", "vintage stores", "cafe hopping", "young professionals")
2. Finds its "taste twin" neighbourhood in other cities: Qloo ranks the other city's localities with the home neighbourhood as the signal, and the agent scores each by the share of Qloo taste tags the two have in common, listing the tastes they share
3. Compares how many places Qloo lists for each category in the twin and at home (Qloo places), within the same 2.5 km radius of each neighbourhood's centre (about the size of a Tokyo ward), so both sides cover the same area. A gap needs at least 4 in the twin and 3 times the home count
4. Doubts its own findings: does the rest of the city already cover it? does the category's audience match the people there (Qloo demographics of the category's fans, against official resident statistics for Tokyo wards)? is interest fading (Qloo `/v2/trending`)? is the evidence thin, or cut off by Qloo's page size? With a Google Maps key, it also asks a second, independent index whether it sees the same gap, and rules the gap out if it doesn't
5. Submits the gaps that survive, each with a six-part score and the evidence behind it. If nothing convincing turns up, it says so: that is a valid answer

Every step, Claude's reason for it, and every Qloo call are shown live in the UI. After each Qloo lookup the gaps found so far are scored again, so you can watch a score fall (or rise) as the agent's own checks come in. Each opportunity keeps that score trail, one line per check, with the Qloo calls behind it. Each number on an opportunity carries a `Q<n>` chip that jumps to the Qloo call it came from. A world route map draws each taste twin and each opportunity as an arc from the city where the demand is proven to the city that lacks it.

If Claude is unavailable (no key, no credit, a network error), the same tools run as a fixed pipeline, so the app always produces a result.

### Checking one business

A scan answers "what is this city missing?". Someone who already knows what they want to open asks the other question: "where in this city is my kind of business missing, if anywhere?"

- **176 business types** (`src/data/categories.json`), from cafés, ramen shops and natural wine bars to yoga studios, record stores and climbing gyms. They were chosen from about 350 candidates by counting, on live Qloo, the places listed for each in Tokyo, New York City and Seoul (2026-10-25). A type is in the list when Qloo lists at least 5 places in at least two of the three cities, so a taste twin can have the 4 places a gap needs. Each keeps those counts, and the page shows them next to the type, with a warning when the home city lists so few that a "gap" there may be missing data rather than missing shops.
- **Anything else**: text that matches no listed type is looked up with Qloo's tag search (`/v2/tags`), keeping only tags that name a kind of place (not "store" or "restaurant"). Text in another script ("猫カフェ", "요가") is first put into English by one small Claude call. The matched tag is counted once in each city, and if no other city lists enough of it for a twin to show a gap, the agent says so up front instead of spending the run. Either way, the first lines of the agent log say what the text was matched to and which Qloo calls it took.
- The agent then runs the same method with that one category: each supply count is exact (no shared page), it looks at more neighbourhoods, and it skips twin cities where Qloo lists fewer than 4 of the type. "No neighbourhood is short of it" is a real answer: for this type, the city looks well supplied for its tastes.
- Without a business type, a scan runs exactly as before.

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

Confidence = average of the measured scores × (1 − 0.05 × open doubts, at most 0.4 off). A check the agent skipped (or whose lookup failed) counts as its worst possible result plus an open doubt ("Not checked: ..."): a skipped audience, bridge or durability score enters the average as 0, and a skipped city-wide check is counted as a crowded city (local undersupply × 0.6). So skipping work never raises confidence, whatever the check would have found. A check that ran but found no data (no age data for a category's fans) is an open doubt, not a skipped check, and Durability on live data is not counted at all. A submission that fails the gap rule is sent back to the agent. One that lands below 55% confidence (unrounded: 54.6% is shown as 54%) is ruled out: the agent gets the reasons back, and the page keeps it greyed out with its score trail instead of counting it as an opportunity. The fixed pipeline rules out weak gaps the same way.

### What the agent can't know

- A place missing from Qloo may be missing from the index, not from the street. Counts are places Qloo lists, not a census. The city-wide check, the thin-data flag and the Google Maps cross-check catch some of these cases, not all. Google Maps counts are approximate too: a 4.4 km square around each neighbourhood's centre (the same area as Qloo's circle), a keyword search, at most 60 results.
- Results are a snapshot of today's taste data, not a historical backtest.
- Boba and malatang are survivors. Tapioca shows a real gap can fade, which is why Durability is scored.
- Similarity is between audiences, not streets. Rent, regulation and footfall are out of scope.
- Qloo's coverage is uneven by city and kind of place. Seoul is well covered for food and drink but thin for many shops, gyms and salons (often 0 to 3 places city-wide), which the page flags when you pick such a type.

### What's next

- More cities, starting with US cities where Qloo's coverage is deepest.
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

### Recorded runs (fallback)

So the public demo never shows an empty page, `POST /api/explore` streams a run recorded earlier for the city instead of a live one when:

- the live run can't start: too many explorations are running (`EXPLORE_MAX_CONCURRENT`) or the visitor has used up the hour (`EXPLORE_RUNS_PER_IP_PER_HOUR`). The answer is a 200 that keeps the `Retry-After` header;
- the live run fails (an exception or an `error` event) before it submitted any opportunity. Cards already shown stay, with the error after them, and a run that finishes with no opportunities is a real answer, never replaced;
- `EXPLORE_FORCE_REPLAY=1` or `EXPLORE_LIVE_ENABLED=false` is set (testing, or an emergency switch).

The stream starts with a `replay` event (`recordedAt`, `reason`); the page drops whatever the live run showed and keeps a "Recorded run from …, not live: …" banner over the map and in the agent log for as long as the recording is on screen. The recording's own `start` event says which modes it really ran in. It plays in its original order, with its pauses scaled to about `EXPLORE_REPLAY_SECONDS` (never slower than it ran live). A city without a recording behaves as before (429, or the error).

Recordings live in `src/data/replays/<slug>.json` (`tokyo`, `new-york`, `seoul`) and are bundled with the server code (`src/lib/replay.ts`). A file with no events is a placeholder; Tokyo falls back to `src/data/sample-run.json`. To record one, keep `npm run dev` running (Google Maps key unset) and run, for example:

```bash
node scripts/record-sample.mjs "New York" all --out src/data/replays/new-york.json
```

The script refuses runs that failed, used Google Maps, or were themselves replays.

## Modes

| Variable | Values | Default |
|---|---|---|
| `QLOO_MODE` | `mock`, `live` (needs `QLOO_API_KEY`) | `mock` |
| `LLM_MODE` | `mock` (fixed pipeline, no model), `claude` (Claude agent, needs `ANTHROPIC_API_KEY`) | `mock` |
| `ANTHROPIC_MODEL` | Claude model id | `claude-opus-5-5` |
| `QLOO_CALL_BUDGET` | max Qloo calls per exploration | `40` |
| `EXPLORE_TIME_BUDGET_MS` | no new lookups after this long; the run finishes with what it has | `150000` |
| `MOCK_DELAY_MS` | pause per mock Qloo call | `350` |
| `QLOO_API_URL` | Qloo address, may include a path prefix (hackathon keys: `https://hackathon.api.qloo.com`) | `https://api.qloo.com` |
| `QLOO_TIMEOUT_MS` | per-request timeout for live Qloo calls | `10000` |
| `QLOO_RETRIES` | extra attempts on 429 / 5xx / timeout / network errors | `2` |
| `QLOO_CACHE_TTL_MS` | how long identical live Qloo requests are answered from memory (`0` = off) | `21600000` (6 h) |
| `QLOO_CATEGORY_TAGS` | overrides the Qloo tag id of a category, e.g. `malatang=urn:tag:...,bubble_tea=urn:tag:...` | unset (ids in `categories.ts`) |
| `GOOGLE_MAPS_API_KEY` | optional, enables the Google Maps cross-check (Places API (New)); only used with `QLOO_MODE=live` | unset |
| `GOOGLE_CALL_BUDGET` | max Google Maps requests (result pages) per exploration | `24` |
| `GOOGLE_DAILY_LIMIT` | max Google Maps requests per UTC day, per server instance | `300` |
| `EXPLORE_MAX_CONCURRENT` | explorations allowed to run at once | `3` |
| `EXPLORE_RUNS_PER_IP_PER_HOUR` | per-visitor limit, production only | `20` |
| `EXPLORE_FORCE_REPLAY` | `1`: every exploration plays the city's recorded run instead of running live (testing, or an emergency switch); a city with no recording answers 503 | unset |
| `EXPLORE_LIVE_ENABLED` | kill switch: `false` (or `0`, `off`, `no`) turns live runs off entirely, every exploration plays the city's recording, as with `EXPLORE_FORCE_REPLAY=1` | unset (live on) |
| `EXPLORE_REPLAY_SECONDS` | how long a recorded run takes to play back (never slower than it ran live; `0` = at once) | `20` |

API keys are read only on the server and never sent to the browser.

## Checks

```bash
npm run typecheck    # generates Next.js route types, then runs tsc
npm run verify       # offline tests: Qloo client, cache, input checks, full mock runs, scripted Claude loop, recorded-run fallback
npm run qloo:check   # one live Qloo request with the key in .env.local (add -- --tags to test category tag ids)
npm run google:check # one Google Maps search with GOOGLE_MAPS_API_KEY (place ids only, free tier)
```

`npm run verify` needs no keys and sends no network requests.

## Backend notes

- **Qloo client** (`src/lib/qloo/live.ts`): server-only, key sent as `X-Api-Key`. Each request has a timeout. 429, 5xx, timeouts and network errors are retried with backoff (honouring `Retry-After`); other 4xx are not, because the same request would fail again and waste quota. Errors are typed (`auth`, `bad_request`, `rate_limit`, `server`, `timeout`, `network`, `bad_response`), and the key is redacted from every message. A rejected key or a wrong address stops the run at once instead of failing every lookup in turn.
- **Budget** (`src/lib/qloo/index.ts`): every exploration has a hard cap on Qloo calls (`QLOO_CALL_BUDGET`). Retries count against it.
- **Cache** (`src/lib/qloo/cache.ts`): live responses are kept in memory for `QLOO_CACHE_TTL_MS`, shared across explorations in the same server instance, and concurrent identical requests share one HTTP call. Failures are never cached. Calls answered from cache are marked `cached` in the agent log. Within a run, `src/lib/agent/evidence.ts` also memoises every lookup, so the agent never pays twice for the same question.
- **Input checks** (`src/lib/agent/request.ts`): `POST /api/explore` takes `{"city": "Tokyo", "focus": "all" | "dining" | "nightlife" | "retail"}`, optionally with `"category"` (a key from `src/data/categories.json`, e.g. `"yoga_studio"`) or `"query"` (free text, at most 60 characters) to check one business type, with `Content-Type: application/json` (anything else, or none, gets a 415, so another website can't start runs with a plain cross-site POST). In production the request must also come from the site's own page (`Sec-Fetch-Site: same-origin`, or an `Origin` matching the host), otherwise 403; `npm run dev` skips that check. Unknown cities or focuses, non-JSON bodies and bodies over 2 KB get a 4xx with a plain message. `GET /api/explore` returns the cities, focuses and modes (never keys).
- **Abuse limits** (`src/lib/limits.ts`): a cap on concurrent explorations and a per-visitor hourly limit protect the shared Qloo quota and Claude credit on the public demo. Both are in-memory, so on Vercel they are per instance, not global: more instances mean more runs. A visitor turned away gets the city's recorded run instead, when there is one (see "Recorded runs").
- **Global spend cap**: the app has no shared store, so the real cap on spend lives outside it. Before the demo is public, set spend limits at the providers (an Anthropic workspace spend limit, the Qloo quota, a Google Cloud quota on the Maps key) and a Vercel Firewall rate-limit rule on `/api/explore`. `EXPLORE_LIVE_ENABLED=false` switches live runs off at once (recordings only).
- **Viewer leaves** (`vercel.json`): `supportsCancellation` is on for `src/app/api/explore/route.ts`, so when a viewer closes the tab Vercel aborts `request.signal`, which stops the run's Claude stream and Qloo and Google requests, and frees its live slot at once; Vercel then ends the function. Without it, Vercel keeps the run going until its time budget ends. Check it on a preview deployment: start a live run, close the tab, and the function log should end within seconds.
- **Google Maps cross-check** (`src/lib/google/places.ts`): server-only, Places API (New) Text Search. It asks only for place ids (field mask `places.id,nextPageToken`), which Google bills as "Text Search Essentials (IDs Only)", free without a monthly limit, inside a hard `locationRestriction` rectangle. At most 3 pages (60 results) per search and `GOOGLE_CALL_BUDGET` requests per run. Nothing from Google is stored beyond the run. The key is redacted from every message, and a rejected key stops further Google requests for the run.
- **Tokyo ward statistics** (`src/data/tokyo-ward-ages.json`, `src/lib/agent/census.ts`): residents aged 20 and over in each of the 23 wards by age band, as of 1 January 2026, turned into a lean per band against the 23 wards as a whole.
- **Cities and categories**: the explorable cities are in `src/lib/cities.ts`; the scan's categories and their Qloo tag ids are in `src/lib/agent/categories.ts`, and the business types for "check one business" in `src/data/categories.json` (helpers in `src/lib/agent/catalog.ts`, matching in `src/lib/agent/target.ts`). The sample data only has the scan's 8, so the others need live Qloo data. Switching to real data means setting `QLOO_MODE=live` and `QLOO_API_KEY`; every category already has its real Qloo tag id (`QLOO_CATEGORY_TAGS` can override one of the scan's 8).

## Credits

Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via [world-atlas](https://github.com/topojson/world-atlas). Tokyo ward population by age: 東京都総務局統計部「住民基本台帳による東京都の世帯と人口」令和8年1月, 第7表 (Tokyo Metropolitan Government, Bureau of General Affairs, Statistics Division). Place counts in the cross-check: Google Maps. Fonts: Figtree, Geist Mono (SIL Open Font License, via Google Fonts).

## License

MIT
