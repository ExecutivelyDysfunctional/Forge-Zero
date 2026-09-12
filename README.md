# Forge-Zero

**An AI prompt-generation engine that architects single-file HTML apps and
full-stack applications for zero-cost, free-tier LLM API keys.**

You describe an app. You flip one toggle — *single-file HTML* or *full-stack* — pick
the free model you actually have a key for, and Forge-Zero composes a **prompt pack**:
an ordered set of stage prompts, each sized to fit that model's per-response output
ceiling, hardened against the failure modes that model is known for, and paid for
within the requests-per-day your free key allows.

The pack is generated locally and deterministically. No model call is needed to
produce it; the key only matters if you let the workbench run a stage for you.

```bash
npm install
npm start          # http://localhost:3000
npm run doctor     # is this install sane? (runtime, db, module graph, catalogue, tests)
npm test           # 87 tests
```

---

## What it does

| | |
| --- | --- |
| **Complexity toggle** | `Single-file HTML` ⇄ `Full-stack app`. Not a label swap: each side selects a different blueprint — different stages, different capability ceilings, different file protocols, different acceptance criteria. |
| **Free-model targeting** | A catalogue of 29 current free-tier models across 10 providers (Google AI Studio, Groq, Cerebras, OpenRouter `:free`, Mistral, NVIDIA NIM, Cloudflare Workers AI, GitHub Models, Z.ai, Ollama) with context windows, output ceilings, RPM/TPM/RPD/TPD allowances, capability flags and behavioural quirks. |
| **Fit analysis** | Every pack is measured against the selected model: tokens per stage vs output ceiling, context pressure, % of daily requests, % of daily tokens, wall-clock ETA, required spacing between stages. |
| **Automatic optimisation** | When a plan does not fit, Forge-Zero changes it — splits stages, compresses the behaviour contract to core rules, drops the audit stage — and *tells you* what it changed and why. It never silently cuts scope from your brief. |
| **Mechanical reassembly** | Every prompt carries a file protocol (`// FILE:`, `PART:n OF:m`, `<<CONTINUE>>`, `@REPLACE`, `@MANIFEST`, `@BLOCKED`) so replies can be stitched by a script, and truncation can be detected instead of trusted. |
| **Verify + repair loop** | Paste a reply (or run a stage in the workbench) and it is checked for stubs, unbalanced braces, missing files, leaked credentials and protocol violations. Paste a failure and you get a bounded repair prompt for exactly that stage. |
| **Exports** | `prompt-pack.json`, `prompt-pack.md`, per-stage `.txt`, and `run-pack.sh` — a curl runner that pauses to respect your RPM limit and reads the key from the environment. |
| **Server-side keys** | AES-256-GCM encrypted in SQLite, masked in every response, never sent to the browser. A per-provider rate governor queues calls so a retry loop cannot burn your daily quota. |

## The two halves of the toggle

**Single-file HTML app** — one `index.html`, no build, no server, opens from
`file://`. The prompt therefore bans the things that break under `file://`
(module `src` imports, sibling `fetch`, CDN dependence without a fallback), pins
persistence to a versioned `localStorage` key with a migration path, and demands
inline SVG for every visual. Default pack: design contract → shell + design
system → state/storage/domain → render/events/boot → audit & patch.

**Full-stack application** — server, database, client, tests, README. The prompt
fixes a pinned stack (`package.json` versions included), freezes the DDL and the
API table in an architecture contract before any code is written, then emits
routes and views **in chunks sized from the model's output ceiling** — the trick
that makes a full-stack build feasible on an 8K-token model instead of only on
models with 32K–65K ceilings.

Same brief, different pack. Try it: load the *Standup board* preset, flip the
toggle, and watch the stage count, the per-stage budgets and the warnings move.

## Why prompts for free models have to be built differently

Free-tier models are not "worse paid models", they are a different shape of
constraint, and generic prompt templates ignore all of it:

- **The ceiling is silent.** Groq's `llama-3.1-8b-instant` stops at ~4K output
  tokens mid-function and then claims the file is complete. So the pack never asks
  it for a whole app: it asks for a slice that fits, with an explicit place to cut.
- **Rate limits end builds.** OpenRouter `:free` is 50 requests/day until you have
  ever bought $10 of credits. A 13-stage plan with repairs is 21 requests: fine for
  one build, not for five. The budget gauge says so before you start, not after stage 9.
- **Throughput, not intelligence, sets the clock.** On a free Groq key, TPM means a
  15K-token pack takes minutes of pure allowance even at 700 tok/s.
- **Small models need rails, not prose.** Rules like *no factories*, *no invented
  library APIs*, *no "for brevity"* are injected per-model based on the failure that
  model actually exhibits, and restated at the end of every prompt because drift is
  real at 128K context on a 70B instruct model.
- **Some free tiers train on your prompts** (Google AI Studio, Mistral Experiment).
  The pack flags that as a warning so nobody pastes a client's confidential brief
  into a training pipeline by accident.

Every one of those rules is data in `server/lib/catalog.js` + code in
`server/lib/composer.js`, so a new model is a catalogue row — not a rewrite.

## Layout

```
server/
  app.js  index.js  config.js  db.js
  lib/       catalog.js blueprint.js composer.js budget.js tokenizer.js
             verify-output.js providers.js governor.js crypto.js spec.js formats.js
  repo/      projects · packs · runs · keys · settings · artifacts
  routes/    meta · packs · projects · keys · generate
client/
  index.html  styles/app.css  src/{main,state,ui,api,brief,pack,rail,model-picker}.js
tests/        87 tests (unit + real-HTTP integration)
scripts/doctor.js
```

`DESIGN.md` is the long form: architecture, data model, prompt doctrine, the API
contract, the security model, and the trade-offs that were made on purpose.

## Configuration

Copy `.env.example` → `.env` (or just export what you need). Nothing is required:
without a `FORGE_SECRET` the server generates one at `data/.forge-secret` (0600);
without provider keys everything except live "run stage" works.

| var | default | why |
| --- | --- | --- |
| `PORT` / `FORGE_HOST` | `3000` / `0.0.0.0` | bind for containers and preview proxies |
| `FORGE_SECRET` | generated | encrypts stored API keys |
| `FORGE_ALLOW_GENERATE` | `1` | set `0` to run as a pure prompt-composer |
| `FORGE_HTTP_RATE` | `120`/min | per-IP limiter on `/api` |
| `FORGE_GENERATE_TIMEOUT_MS` | `180000` | ceiling for one streamed stage |
| `FORGE_*_API_KEY` | — | configure keys without touching the UI |

## Notes on honesty

- Token counts are a calibrated heuristic (±15%), never a billing figure. It exists
  to keep work inside ceilings, and it errs conservative on purpose.
- Provider limits were verified against vendor docs and independent measurements in
  **September 2026**. Free tiers are the most volatile numbers in this industry; the
  UI prints the verification date, and when the provider console disagrees, the
  console is right. Update `server/lib/catalog.js`.
- If this host has no egress to a provider, `run stage` fails with an explanation and
  a fallback path (`export run-pack.sh`). The pack itself never needed the network.
