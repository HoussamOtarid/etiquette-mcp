# etiquette-mcp

[![CI](https://github.com/HoussamOtarid/etiquette-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/HoussamOtarid/etiquette-mcp/actions/workflows/ci.yml)
[![Live sources](https://github.com/HoussamOtarid/etiquette-mcp/actions/workflows/live.yml/badge.svg)](https://github.com/HoussamOtarid/etiquette-mcp/actions/workflows/live.yml)
[![Version](https://img.shields.io/github/v/tag/HoussamOtarid/etiquette-mcp?sort=semver&label=version)](https://github.com/HoussamOtarid/etiquette-mcp/tags)
[![License: MIT](https://img.shields.io/github/license/HoussamOtarid/etiquette-mcp)](LICENSE)

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
- `variants`: same brand, other sizes or flavours; `product.other_sizes`: other pack sizes with the same label (a
  description matching only those is answered directly)
- `ingredients` (with language), `allergens`, `traces`, `nutriscore`, and `offers` with prices per store
- `sources`: the status of every source for this request (`ok`, `not_found`, `timeout`, `rate_limited`, `error`, or
  `skipped` when it was not needed or the answer came from the cache)
- `per_source`: each source's structured label, raw label text, unmapped extra nutrients (vitamins, minerals, …) and
  when the source last updated it, if known

With `compact: true` (the default for `get_labels`), offers are reduced to the list of stores and the per-source
labels, ingredients, allergens, traces, variants and similar products are left out.

All values are per 100 g or per 100 ml (`label.basis`).

## How a label is decided

1. **Identity**: offers from different sources are the same product when they share a barcode, or, without one,
   the same brand, pack size and name (a swapped word such as another flavour is a different product).
2. **Normalisation**: sodium is converted to salt, swapped kJ/kcal values are repaired, zeros from sources that
   use 0 for "unknown" and values a source marks as its own estimate are ignored, and impossible values are dropped.
3. **Self-check**: energy is compared with fat, carbohydrates, protein and fibre, and kJ with kcal. Inconsistent labels
   count less; an identifiable decimal slip, or a 0 that explains missing energy, removes the faulty value.
4. **Voting**: per nutrient, values agreeing within label rounding (or within EU declared-value tolerances) are
   clustered and weighted by source quality. The chosen value is always a published value, never an average.
   Copies of another source's label count once.

## Sources

Open Food Facts, La Fourche, Kazidomi, Biocoop, La Vie Claire, Naturalia, La Belle Vie and Chronodrive. Requests are
anonymous: no cookies, no accounts, and a user agent that only names the project (with its repository URL for Open Food
Facts, which asks API clients to identify themselves). Each source is paced to its documented limits or a polite rate,
and results are cached in SQLite.

With `OFF_LOCAL_DB=true`, barcodes are answered from a local copy of the whole Open Food Facts database kept in
`DATA_DIR` (about 4 GB, twice that while it is rebuilt), with the API as fallback for products added since the last
update. The server builds the copy itself on first start (about an hour, in the background, answering from the API
meanwhile), applies the daily updates and rebuilds it monthly; `list_sources` shows its state.

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
| `DATA_DIR`          | `./data`            | SQLite cache and the local Open Food Facts copy                  |
| `SOURCE_TIMEOUT_MS` | `8000`              | Time limit per source call                                       |
| `REQUEST_BUDGET_MS` | `20000`             | Time limit per tool call; late sources keep filling the cache    |
| `OFF_MAX_WAIT_MS`   | `120000`            | How long a tool call may wait for queued Open Food Facts lookups |
| `OFF_LOCAL_DB`      | `false`             | Keep a local copy of Open Food Facts (see Sources)               |
| `LOG_LEVEL`         | `info`              | `debug`, `info`, `warn`, `error`                                 |
| `DISABLED_SOURCES`  |                     | Comma-separated source ids                                       |
| `USER_AGENT`        | `etiquette-mcp/<v>` | Open Food Facts requests also carry the project URL              |

## Development

```bash
npm run check    # typecheck + lint + tests
npm run smoke    # live lookups against the real sources (-- --check: fail on missing products or source errors)
```

```
src/
  domain/   nutrient model, barcode, quantity, number and text helpers
  engine/   pure decision logic: normalisation, self-check, voting, identity, confidence
  sources/  one adapter per source + free-text label parser
  infra/    HTTP client with per-host limits, SQLite cache, logging, health
  app/      the use cases behind the tools, presentation of results
  mcp/      tool definitions and HTTP transport
test/       unit tests and recorded source fixtures
```

## License

MIT
