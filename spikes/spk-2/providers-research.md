# SPK-2 Step 4 — Provider research: OpenAI-compatible base URLs and free model IDs

Retrieved: 2026-10-18. Scope: offline research only (plan steps 1–2 and 4 of `docs/superpowers/plans/2026-10-18-phase-0-spikes.md`, Task 4). No API keys were created, used, or stored; this file contains URLs and model IDs only.

Convention: `[I]` = not documented on an official page fetched today; must be observed or confirmed later (probe Step 5 / account creation Step 3).

## Summary table

| Provider (env var) | OpenAI-compatible base URL | Free model IDs | Context (documented) | Documented limits | Primary source |
|---|---|---|---|---|---|
| OpenCode Zen (`AIK_ZEN_KEY`) | `https://opencode.ai/inference/openai/v1` (current official docs table); `/zen/v1` variant also published — see note | `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `space-bunny-free`, `beam-free`, `ll-alpha-free`, `longcat-2.5-preview-free`, `exo-free`, `mimo-v2.6-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `big-pickle` | not documented `[I]` | none published `[I]` | https://opencode.ai/docs/zen/ |
| Ollama Cloud (`AIK_OLLAMA_KEY`) | `https://ollama.com/v1` (direct cloud) | Free plan includes "starter models"; exact starter subset undocumented `[I]` — full cloud list below | per model on ollama.com/library `[I]` | Free plan: 1 concurrent request, starter usage credits, monthly reset | https://docs.ollama.com/api/openai-compatibility , https://ollama.com/pricing |
| Cloudflare Workers AI (`AIK_CF_KEY`) | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` | every `@cf/...` model is free up to the daily Neuron allocation, except the paid-only list below; plan's pick `@cf/zai-org/glm-4.7-flash` is free-eligible | `@cf/zai-org/glm-4.7-flash`: 131,072 tokens | 10,000 Neurons/day (resets 00:00 UTC); Text Generation 300 req/min | https://developers.cloudflare.com/workers-ai/platform/pricing/ , .../platform/limits/ |
| OpenRouter free tier (`AIK_OPENROUTER_KEY`) | `https://openrouter.ai/api/v1` | IDs ending in `:free` (16 live today — full list below); plus router id `openrouter/free` | per model, 65k–1M (list below) | free variants: 20 req/min; 50 req/day (<$10 lifetime credits) or 1,000 req/day (≥$10) | https://openrouter.ai/docs/api-reference/limits |

---

## 1. OpenCode Zen (`AIK_ZEN_KEY`)

**Base URL — two published forms (verify with the probe in Step 5):**

1. Current official OpenCode Console/Zen docs model table lists the OpenAI-compatible chat models at
   `https://opencode.ai/inference/openai/v1/chat/completions` → probe `--base-url=https://opencode.ai/inference/openai/v1`.
   Source: https://opencode.ai/docs/zen/ (same page as https://opencode.ai/v2/docs/console/models/). A model-list endpoint exists: `GET https://opencode.ai/inference/v1/models`.
2. The plan's candidate `https://opencode.ai/zen/v1` is still what third-party integrations document (Docker's agent docs:
   "Base URL: `https://opencode.ai/zen/v1`; Token Variable: `OPENCODE_API_KEY`" — https://docs.docker.com/ai/docker-agent/providers/opencode-zen/).
   It was not found on the OpenCode pages fetched today. Deviation risk for Step 5: try `/zen/v1` first (plan), fall back to `/inference/openai/v1` (current docs).

**Free model IDs** (all priced "Free" per 1M tokens, served via OpenAI-compatible chat completions unless noted; source: the pricing/free-models sections of https://opencode.ai/docs/zen/):

| Model ID | Family | Data use per Zen docs |
|---|---|---|
| `glm-5.3-flash-free` | glm | zero-retention, no training |
| `deepseek-v4.1-flash-free` | deepseek | zero-retention, no training |
| `space-bunny-free` | stealth | zero-retention, no training |
| `beam-free` | beam | no training, retained 30 days for safety; geo-blocked (incl. China, Russia, and others) |
| `ll-alpha-free` | stealth | "collected data may be used to improve the model"; retained 30 days |
| `longcat-2.5-preview-free` | longcat | zero-retention, no training |
| `exo-free` | exo | may be used to improve the model |
| `mimo-v2.6-flash-free` | mimo | may be used to improve the model |
| `mimo-v2.5-free` | mimo | may be used to improve the model |
| `nemotron-3-ultra-free` | nvidia | NVIDIA trial terms: use is logged to improve products |
| `nemotron-3.5-lightning-free` | nvidia | NVIDIA trial terms: use is logged to improve products |
| `nemotron-3.5-super-vl-free` | nvidia | NVIDIA trial terms: use is logged to improve products |
| `big-pickle` | stealth | collected data may be used to improve the model |

(`jev-1.13-free` is also free but uses a non-chat "System One" protocol at `https://opencode.ai/inference/systemone/v1/systemone` — not OpenAI-compatible, out of scope for the probe.)

Default-eligible per the spec's `no_training` bar: `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `space-bunny-free`, `longcat-2.5-preview-free`. These match the plan's Step 5 picks ("Zen GLM-5.3-Flash Free, Zen DeepSeek V4.1 Flash Free").

**Context windows:** not published on the Zen/Console pages fetched `[I]`. Verify from `GET https://opencode.ai/inference/v1/models` or empirically in Step 5.

**Rate limits:** none published for free models `[I]`.

**Card/billing (input for Q-1):** the Zen page's call to action is "Add $20 Pay as you go balance (+$1.23 card processing fee)" and Console setup says "add your billing details and credits" — card details are likely requested even though the free models cost $0 `[I]`; confirm during Step 3 account creation.

**Data-use quote (Zen privacy section, exact):** "All our models are hosted in the US and EU. Our providers follow a zero-retention policy and do not use your data for model training, with the following exceptions: …" — the free-model exceptions are the table above. Source: https://opencode.ai/docs/zen/#privacy.

### Related: Z.ai direct API (not the Zen gateway)

The underlying GLM vendor also sells direct API access (the plan's Step 4 starting point `developers.z.ai`/`docs.z.ai`):

- OpenAI-compatible base URL: `https://api.z.ai/api/paas/v4/` (Chat Completions); GLM Coding Plan endpoint: `https://api.z.ai/api/coding/paas/v4/`; Bearer auth. Sources: https://docs.z.ai/guides/develop/http/introduction , https://docs.z.ai/guides/develop/openai/python .
- Models: `glm-5.3`, `glm-5.3-flash`, `glm-5.2` (context 1,000,000 tokens; max output 131,072 — per https://docs.z.ai/.well-known/agent-skills/zhipu/skill.md and model docs).
- **No free tier documented**: standard API is pay-as-you-go with prepaid top-up (`glm-5.3-flash` ≈ "1/40 of Claude Opus 4.8" pricing, https://z.ai/model-api). Conclusion: Z.ai direct is not a free-provider candidate; free GLM-5.3-Flash access is via Zen's `glm-5.3-flash-free`.

## 2. Ollama Cloud (`AIK_OLLAMA_KEY`)

**Base URL (answers Q-2):** direct cloud OpenAI-compatibility endpoint is `https://ollama.com/v1` (the probe appends `/chat/completions`). Local server equivalent: `http://localhost:11434/v1`. Auth: `Authorization: Bearer <OLLAMA_API_KEY>`.
Sources: https://docs.ollama.com/api/introduction (Base URLs table), https://docs.ollama.com/api/openai-compatibility , https://docs.ollama.com/api/authentication .

**Free tier (ollama.com/pricing, "Free $0"):** "Use any cloud model with pay-as-you-go usage credits." — includes "Starter usage credits included", "Includes access to starter models", "Add credits to unlock all models", "No service fees". Usage resets monthly from signup date. Which models are "starter models" is not published `[I]`.

**Cloud model IDs** (from `GET https://ollama.com/api/tags`, fetched 2026-10-18 — use these names verbatim for cloud API requests):
`deepseek-v4.1-flash:1017`, `nemotron-3-nano:30b`, `mistral-large-4`, `nemotron-3-super`, `glm-5.2`, `kimi-k2.6`, `minimax-m3`, `gemma4:31b`, `muse-spark-open`, `kimi-k2.7-code`, `deepseek-v4-pro:0813`, `mistral-large-3:675b`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `gpt-oss:20b`, `nemotron-3-ultra`, `glm-5.3`, `gpt-oss:120b`, `clef:27b`, `beam`, `kimi-k3`, `minimax-m2.7`.
(Cheap candidates for the probe if free-tier eligible: `gpt-oss:20b` $0.07/M in + $0.30/M out, `gemma4:31b` $0.14/$0.40, `nemotron-3-super` $0.015/$0.60, `glm-5.3-flash` $0.15/$0.50 — prices from https://ollama.com/pricing ; off-peak = weekends + weekdays outside 12:00–18:00 UTC at 50%.)

**Limits (ollama.com/pricing FAQ):** concurrency-based — "Free includes 1 concurrent request, Pro 3, and Max and Team 10". Requests beyond the concurrency limit are queued (queue-full requests rejected). No per-minute/per-day request caps published; the older "5-hour and weekly limits" were removed by the 2026 re-pricing (https://ollama.com/blog/transparent-pricing). Effective stories/day is therefore credit/token-bound, not request-bound `[I]`.

**Context windows:** per model on `https://ollama.com/library/<model>` pages; not centralized on the pricing/docs pages `[I]`.

**Data handling (exact, https://docs.ollama.com/cloud):** "Ollama processes cloud prompts and responses to answer your requests. We do not use them to train models." Pricing FAQ adds: "Prompt or response data is never logged or trained on." Hosting: primarily US, may route to EU; partners are NVIDIA Cloud Providers under no-logging/zero-retention terms.

**Card (Q-1 input):** pricing page does not mention a card for the Free plan `[I]`; confirm at account creation.

## 3. Cloudflare Workers AI (`AIK_CF_KEY`)

**Base URL (confirmed as in the plan):** `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` — Chat Completions at `.../ai/v1/chat/completions`, Bearer API token with Account > Workers AI > Read.
Source: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/ (page dated 2026-09-18).

**Free allocation (pricing page, updated 2026-10-15):** "Our free allocation allows anyone to use a total of 10,000 Neurons per day at no charge." Available on both Workers Free and Workers Paid; overage $0.011 per 1,000 Neurons; "All limits reset daily at 00:00 UTC."

**Rate limits (limits page, updated 2026-09-17):** Text Generation = 300 requests/minute by default; models that require Workers Paid get 20 req/min (50 req/min with prepaid AI Gateway credits) per account per model.

**Free-eligible models:** every `@cf/...` model consumes the free 10,000 Neurons/day allocation — **except** these that require a paid billing method: `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`, `@cf/zai-org/glm-5.3`, `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731`, `@cf/deepseek-ai/deepseek-v4-pro-0813` (pricing-page note). Note for the catalog: the plan's pick `@cf/zai-org/glm-4.7-flash` is free-eligible; the newer GLMs are not.

**Plan's probe model — `@cf/zai-org/glm-4.7-flash`** (model page https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/):
- Context window: 131,072 tokens; function calling: yes; reasoning: yes.
- Unit pricing: $0.060/M input, $0.400/M output (= 5,500 neurons/M input, 36,400 neurons/M output) — at 10,000 free Neurons/day, roughly 275k free output tokens/day (or ~1.8M input tokens) → stories/day is token-bound, estimate in Step 6.
- Other free-eligible function-calling candidates: `@cf/meta/llama-3.1-8b-instruct`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/openai/gpt-oss-20b`, `@cf/ibm-granite/granite-4.0-h-micro` (all on the pricing-page LLM table).

**Data use (Q-3, exact sentences from https://developers.cloudflare.com/workers-ai/platform/data-usage/, updated 2026-10-16):**
- "**No training:** Cloudflare does not use Customer Content processed by Workers AI to train AI models."
- "**Zero data retention:** Workers AI processes Customer Content only for as long as needed to provide the service. For standard inference requests that do not invoke a stateful feature, Cloudflare does not retain inputs or outputs after they are no longer needed to process the request and deliver the response, subject to the limited exceptions below."
- Scope caveat from the same page: it covers Workers AI only; routing through AI Gateway to third-party providers is under those providers' terms.

**Card (Q-1 input):** Workers AI free allocation is available on the Free plan; whether Cloudflare asks for a card at signup `[I]` — confirm at account creation. (No card needed to stay free per the pricing page: free allocation is unconditional.)

## 4. OpenRouter free tier (`AIK_OPENROUTER_KEY`)

**Base URL:** `https://openrouter.ai/api/v1` (chat completions at `/chat/completions`; key info at `GET /api/v1/key`). Sources: https://openrouter.ai/docs/api-reference/limits , https://openrouter.ai/docs/guides/routing/routers/free-router .

**Free model IDs — the `:free` suffix set.** Live list from `GET https://openrouter.ai/api/v1/models` on 2026-10-18 (16 models, all $0 prompt/$0 completion; context lengths as returned by the API):

| Model ID | Context |
|---|---|
| `google/gemma-4-26b-a4b-it:free` | 262,144 |
| `google/gemma-4-31b-it:free` | 262,144 |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 |
| `nvidia/nemotron-3.5-content-safety:free` | 128,000 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 |
| `liquid/lfm-2.5-2.6b:free` | 65,536 |
| `thinkingmachines/inkling:free` | 1,048,576 |
| `thinkingmachines/inkling-small:free` | 1,048,576 |
| `poolside/laguna-s-2.1:free` | 262,144 |
| `poolside/laguna-xs-2.1:free` | 262,144 |
| `cohere/north-mini-code:free` | 256,000 |
| `dots-studio/dots-3-note-preview:free` | 512,000 |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262,144 |

Availability "changes frequently" (free-router guide); the canonical filter is https://openrouter.ai/models?pricing=free . The router model id `openrouter/free` picks a random compatible free model per request (not suitable for the probe, which needs a fixed id).

**Rate limits (official, https://openrouter.ai/docs/api-reference/limits):** for models "with an ID ending in `:free`":
- < $10 credits purchased (all time): 20 requests/minute, **50 requests/day**.
- ≥ $10 credits purchased (all time): 20 requests/minute, **1,000 requests/day**.
- At the plan's 50 calls/story: 1 story/day on a fresh account, or 20 stories/day after a one-time $10 top-up.
- Probe note: "Successful inference responses do not include `X-RateLimit-*` headers" — headers only appear on 429 responses — so `burst.rateLimitHeaders` may legitimately be empty. Daily counter is queryable via `GET https://openrouter.ai/api/v1/key` → `free_model_daily_requests`.

**Data use:** not stated on the limits/free-router pages fetched; OpenRouter's terms for free variants are per-model/provider (the FAQ covers limits, not training). Treat all `:free` models as data-use `unknown` until each model's page/terms are checked `[I]` — relevant to default-eligibility (spec's `no_training` bar).

**Card (Q-1 input):** account and API key creation are free; the ≥$10-credit threshold is what raises the daily cap `[I]` whether a card is requested at signup.

## Inputs this hands to later steps

- Step 5 probe targets: Zen `glm-5.3-flash-free` + `deepseek-v4.1-flash-free` (base URL open question above), Cloudflare `@cf/zai-org/glm-4.7-flash`, one OpenRouter `:free` model (suggest `google/gemma-4-26b-a4b-it:free`, 262k context), Ollama starter-model subset TBD.
- Step 6 stories/day arithmetic: Zen `[I]`, Ollama credit/token-bound `[I]`, Cloudflare Neuron-bound (≈275k output tokens/day on glm-4.7-flash), OpenRouter request-bound (50 or 1,000 req/day).
- Q-1 (card requested?): to be recorded at account creation for each provider.
- Q-3 (Cloudflare data use): answered above with exact quote and URL.
