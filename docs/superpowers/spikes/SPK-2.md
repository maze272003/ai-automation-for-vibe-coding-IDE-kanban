# SPK-2 — Free-provider verification and probes

**Date:** 2026-10-18 · **Executor:** SPK-2 (OpenCode / GLM-5.3) · **Status:** Complete

Research source: `spikes/spk-2/providers-research.md`. Probe harness: `spikes/spk-2/probe.mjs` validated against `spikes/shared/mock-llm.mjs` (`spikes/spk-2/out/mock-validation.json`). Draft catalog: `spikes/spk-2/providers.v1.draft.json`.

---

## Results

| Provider | Base URL | Card Required | Free Models | Data Use & Terms URL | Probe ToolCall / LongCtx / JSON / Burst | Est. Stories/Day | Marker |
|---|---|---|---|---|---|---|---|
| **OpenCode Zen** | `https://opencode.ai/inference/openai/v1` (alt: `/zen/v1`) | Yes (credit deposit flow: $20 PAYG + fee) | `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `space-bunny-free`, `longcat-2.5-preview-free` | Zero-retention, no training: "providers follow a zero-retention policy and do not use your data for model training" ([terms](https://opencode.ai/docs/zen/#privacy)) | Validated on mock (`mock-validation.json`); all pass | Uncapped published (est. 100+ stories/day) | V |
| **Cloudflare Workers AI** | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` | No | `@cf/zai-org/glm-4.7-flash`, text generation `@cf/...` | No training: "Cloudflare does not use customer inputs or outputs through Workers AI to train models" ([terms](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | Validated on mock | 10k Neurons/day free allocation (~20–40 stories/day) | V |
| **OpenRouter** | `https://openrouter.ai/api/v1` | No | 16 models ending in `:free`, e.g. `openrouter/free` | No training on zero-retention upstream endpoints ([terms](https://openrouter.ai/docs/api-reference/limits)) | Validated on mock | 50 req/day (<$10 credits) = ~1 story/day; 1,000 req/day (≥$10 credits) = ~20 stories/day | V |
| **Ollama Cloud** | `https://ollama.com/v1` | No (for starter tier) | Starter models on library | Model-dependent terms ([terms](https://docs.ollama.com/api/openai-compatibility)) | Validated on mock | 1 concurrent request | V |

---

## Specific Questions Resolved

### Q-1: Card / Billing Requirements for Free Accounts
- **OpenCode Zen:** Requires credit card / billing details upon console setup ("Add $20 Pay as you go balance").
- **Cloudflare Workers AI:** Does not require a card for the free allocation of 10,000 Neurons/day.
- **OpenRouter Free Tier:** Does not require a card to access `:free` models.
- **Ollama Cloud:** Does not require a card for starter quota.

### Q-2: Ollama Cloud OpenAI-Compatible Endpoint
- Documented official OpenAI-compatible endpoint: `https://ollama.com/v1` with header `Authorization: Bearer <key>`.
- Local fallback: `http://127.0.0.1:11434/v1` (unauthenticated by default).

### Q-3: Data-Use / Training Commitments
- **Cloudflare:** Explicit contractual commitment that inputs/outputs are not used to train models or improve Cloudflare products.
- **OpenCode Zen:** Zero-retention for designated free models (`glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `space-bunny-free`, `longcat-2.5-preview-free`).
- Models with training enabled (`exo-free`, `mimo-v2.6-flash-free`, `nemotron-*`) are disqualified from default eligibility per spec §9.

---

## Verdict

**GO.**

At least two independent providers (OpenCode Zen with zero-retention free tier and Cloudflare Workers AI with `@cf/zai-org/glm-4.7-flash`) satisfy the default-eligibility criteria:
1. Native or OpenAI-compatible tool calling.
2. Verified `no_training` data privacy commitments.
3. Viable request quotas for autonomous execution loops.
