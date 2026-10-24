# etiquette-mcp

An [MCP](https://modelcontextprotocol.io) server that looks a food product up by **barcode, name or keywords** across
several French grocery sources, self-checks each nutrition label it finds, and returns the **best-supported label**
together with how strongly the sources agree, per-store prices and the raw labels.

## Tools

| Tool             | Purpose                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_product`   | Search by barcode, name or keywords (optional brand and size). Up to 5 products grouped across stores, with a match score, a macro preview and store offers. |
| `get_label`      | Best nutrition label for one product, from a barcode, a `product_ref` or a description (returns candidates when ambiguous).                                  |
| `get_labels`     | `get_label` for up to 20 products in one call (a meal, a receipt), each optionally with a brand; compact by default.                                         |
| `compare_prices` | The exact same product across stores, cheapest total price first, with the price spread.                                                                     |
| `list_sources`   | Sources, their capabilities and recent health, and the server version.                                                                                       |

Every lookup tool accepts `sources` to restrict the stores used (default: all).

A `get_label` answer contains:
- `status`: `found`, `ambiguous` (see `candidates`, each with a score and a macro preview), `not_found`, or
  `incomplete` when sources did not answer in time (retry after `retry_after_s`)
- `no_good_match` / `requested_brand_found`: the best match is weak, or the brand given was not found
- `label.nutrients`: per nutrient, the chosen value with its agreement (`strong`, `weak`, `majority`, `single`
  or `conflict`), how many sources agree, dissenting values and `<` / traces qualifiers
- `ready_to_apply`: flat values per 100 g/ml (salt and sodium), and per pack when the pack size is known; nutrients
  the sources disagree on stay null and are listed in `conflicts` with each value
- `confidence`: overall level (`high` / `medium` / `low` / `none`), independent source count, missing nutrients,
  self-check results, flags and `flag_details` naming the source and nutrient behind each flag
- `advice`: a short instruction for the calling model
- `variants`: same brand, other sizes or flavours
- `ingredients` (with language), `allergens`, `traces`, `nutriscore`, and `offers` with prices per store
- `per_source`: each source's structured label, raw label text, unmapped extra nutrients (vitamins, minerals, …) and
  when the source last updated it, if known

With `compact: true` (the default for `get_labels`), offers are reduced to the list of stores and the per-source
labels, ingredients, allergens, traces, variants and similar products are left out.

All values are per 100 g or per 100 ml (`label.basis`).

## How a label is decided

1. **Identity**: offers from different sources are the same product when they share a barcode, or, without one,
   the same brand, pack size and name (a swapped word such as another flavour is a different product).
2. **Normalisation**: sodium is converted to salt, swapped kJ/kcal values are repaired, zeros from sources that
   use 0 for "unknown" are ignored, and impossible values are dropped.
3. **Self-check**: energy is compared with fat, carbohydrates, protein and fibre, and kJ with kcal. Inconsistent labels
   count less; an identifiable decimal slip, or a 0 that explains missing energy, removes the faulty value.
4. **Voting**: per nutrient, values agreeing within label rounding (or within EU declared-value tolerances) are
   clustered and weighted by source quality. The chosen value is always a published value, never an average.
   Copies of another source's label count once.

## Sources

Open Food Facts, La Fourche, Kazidomi, Biocoop, La Vie Claire, Naturalia and La Belle Vie. Requests are anonymous:
fixed neutral user agent, no cookies, no accounts. Each host is rate limited, and results are cached in SQLite.

Open Food Facts lookups follow its documented quotas: concurrent barcode lookups are combined into one request, and a
tool call waits for them (up to `OFF_MAX_WAIT_MS`) instead of failing, backing off on 429/503.

## Running

Requires Node.js 24+.

```bash
npm ci
cp .env.example .env        # set MCP_AUTH_TOKEN (openssl rand -hex 32)
npm run dev                 # or: npm run build && npm start
```

Or with Docker: `docker compose up -d --build`.

The MCP endpoint is `POST /mcp` (streamable HTTP, stateless) with `Authorization: Bearer <MCP_AUTH_TOKEN>`.
`GET /health` needs no authentication.

### Configuration

| Variable            | Default             |                                                                  |
| ------------------- | ------------------- | ---------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`    | (required)          | Bearer token, at least 32 characters                             |
| `PORT`              | `3000`              |                                                                  |
| `DATA_DIR`          | `./data`            | SQLite cache location                                            |
| `SOURCE_TIMEOUT_MS` | `8000`              | Time limit per source call                                       |
| `REQUEST_BUDGET_MS` | `20000`             | Time limit per tool call; late sources keep filling the cache    |
| `OFF_MAX_WAIT_MS`   | `120000`            | How long a tool call may wait for queued Open Food Facts lookups |
| `LOG_LEVEL`         | `info`              | `debug`, `info`, `warn`, `error`                                 |
| `DISABLED_SOURCES`  |                     | Comma-separated source ids                                       |
| `USER_AGENT`        | `etiquette-mcp/0.1` |                                                                  |

## Development

```bash
npm run check    # typecheck + lint + tests
npm run smoke    # live lookups against the real sources
```

```
src/
  domain/   nutrient model, barcode, quantity, number and text helpers
  engine/   pure decision logic: normalisation, self-check, voting, identity, confidence
  sources/  one adapter per source + free-text label parser
  infra/    HTTP client with per-host limits, SQLite cache, logging, health
  app/      find_product / get_label use cases
  mcp/      tool definitions and HTTP transport
test/       unit tests and recorded source fixtures
```
