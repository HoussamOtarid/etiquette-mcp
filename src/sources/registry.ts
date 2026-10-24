import type { SourceId, Tier } from "../domain/types.ts";
import type { AdapterDeps, SourceAdapter } from "./adapter.ts";
import { BiocoopAdapter } from "./biocoop.ts";
import { ChronodriveAdapter } from "./chronodrive.ts";
import { KazidomiAdapter } from "./kazidomi.ts";
import { LaBelleVieAdapter } from "./laBelleVie.ts";
import { LaFourcheAdapter } from "./laFourche.ts";
import { LaVieClaireAdapter } from "./laVieClaire.ts";
import { NaturaliaAdapter } from "./naturalia.ts";
import { OpenFoodFactsAdapter, PRODUCT_URL } from "./openFoodFacts.ts";

export function createAdapters(deps: AdapterDeps): SourceAdapter[] {
  const all: SourceAdapter[] = [
    new OpenFoodFactsAdapter(deps),
    new LaFourcheAdapter(deps),
    new KazidomiAdapter(deps),
    new BiocoopAdapter(deps),
    new LaVieClaireAdapter(deps),
    new NaturaliaAdapter(deps),
    new LaBelleVieAdapter(deps),
    new ChronodriveAdapter(deps),
  ];
  return all.filter((a) => !deps.config.disabledSources.includes(a.id));
}

/** Per-host politeness limits (requests are spaced; a few run concurrently at most). */
export const HOST_LIMITS = {
  // Documented quotas: 15 product reads and 10 searches per minute per IP.
  [PRODUCT_URL.replace(/^https:\/\//, "")]: { intervalMs: 4200, concurrency: 1 },
  "world.openfoodfacts.org": { intervalMs: 6500, concurrency: 1 },
  "search.openfoodfacts.org": { intervalMs: 6500, concurrency: 1 },
  "lafourche.fr": { intervalMs: 2000, concurrency: 1 },
  "*.algolia.net": { intervalMs: 1000, concurrency: 2 },
  "api.kazidomi.com": { intervalMs: 1000, concurrency: 2 },
  "www.kazidomi.com": { intervalMs: 2000, concurrency: 1 },
  "www.biocoop.fr": { intervalMs: 2000, concurrency: 2 },
  "www.lavieclaire.com": { intervalMs: 1000, concurrency: 2 },
  "www.naturalia.fr": { intervalMs: 2000, concurrency: 2 },
  "search.deleev.com": { intervalMs: 1000, concurrency: 2 },
  "www.labellevie.com": { intervalMs: 2000, concurrency: 2 },
  "www.chronodrive.com": { intervalMs: 2000, concurrency: 1 },
} as const;

export const DEFAULT_LIMIT = { intervalMs: 2000, concurrency: 1 } as const;

export function tierMap(adapters: SourceAdapter[]): (source: SourceId) => Tier {
  const tiers = new Map(adapters.map((a) => [a.id, a.tier]));
  return (source) => tiers.get(source) ?? "C";
}
