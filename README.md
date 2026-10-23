# nutrition-mcp

An [MCP](https://modelcontextprotocol.io) server that looks a food product up by **barcode, name or keywords** across
several French grocery sources, self-checks each nutrition label it finds, and returns the **best-supported label**
together with how strongly the sources agree, per-store prices and the raw labels.

## Tools

| Tool           | Purpose                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_product` | Search by barcode, name or keywords (optional brand and size). Returns up to 5 products, each grouped across the stores selling it, with prices, unit prices, stock and links. |
| `get_label`    | Best nutrition label for one product, from a `product_ref`, a barcode or a description (returns candidates when ambiguous).                                                    |
| `list_sources` | Sources, their capabilities and recent health.                                                                                                                                 |

A `get_label` answer contains:
- `label.nutrients`: per nutrient, the chosen value with its agreement (`strong`, `weak`, `majority`, `single`
  or `conflict`), how many sources agree, and any dissenting values
- `confidence`: overall level (`high` / `medium` / `low` / `none`), independent source count, missing nutrients,
  per-source self-check results and flags
- `advice`: a short instruction for the calling model
- `ingredients`, `allergens`, `traces`, `nutriscore`, and `offers` with prices per store
- `per_source`: each source's structured label, raw label text and unmapped extra nutrients (vitamins, minerals, …)

All values are per 100 g or per 100 ml (`label.basis`).

## How a label is decided

1. **Identity**: offers from different sources are the same product when they share a barcode, or, without one,
   the same brand, pack size and name.
2. **Normalisation**: sodium is converted to salt, swapped kJ/kcal values are repaired, zeros from sources that
   use 0 for "unknown" are ignored, and impossible values are dropped.
3. **Self-check**: energy is compared with fat, carbohydrates, protein and fibre, and kJ with kcal. Inconsistent labels
   count less, and an identifiable decimal slip removes the faulty value.
4. **Voting**: per nutrient, values agreeing within label rounding (or within EU declared-value tolerances) are
   clustered and weighted by source quality. The chosen value is always a published value, never an average.
   Copies of another source's label count once.

## Sources

Open Food Facts, La Fourche, Kazidomi, Biocoop, La Vie Claire, Naturalia and La Belle Vie. Requests are anonymous:
fixed neutral user agent, no cookies, no accounts. Each host is rate limited, and results are cached in SQLite.

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

| Variable            | Default             |                                                               |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`    | (required)          | Bearer token, at least 32 characters                          |
| `PORT`              | `3000`              |                                                               |
| `DATA_DIR`          | `./data`            | SQLite cache location                                         |
| `SOURCE_TIMEOUT_MS` | `8000`              | Time limit per source call                                    |
| `REQUEST_BUDGET_MS` | `20000`             | Time limit per tool call; late sources keep filling the cache |
| `LOG_LEVEL`         | `info`              | `debug`, `info`, `warn`, `error`                              |
| `LBV_ALTERNATE`     | `1-9`               | La Belle Vie price/stock zone                                 |
| `DISABLED_SOURCES`  |                     | Comma-separated source ids                                    |
| `USER_AGENT`        | `nutrition-mcp/0.1` |                                                               |

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
