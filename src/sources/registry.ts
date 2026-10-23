import type { SourceId, Tier } from "../domain/types.ts";
import type { AdapterDeps, SourceAdapter } from "./adapter.ts";
import { BiocoopAdapter } from "./biocoop.ts";
import { KazidomiAdapter } from "./kazidomi.ts";
import { LaBelleVieAdapter } from "./laBelleVie.ts";
import { LaFourcheAdapter } from "./laFourche.ts";
import { LaVieClaireAdapter } from "./laVieClaire.ts";
import { NaturaliaAdapter } from "./naturalia.ts";
import { OpenFoodFactsAdapter } from "./openFoodFacts.ts";

export function createAdapters(deps: AdapterDeps): SourceAdapter[] {
  const all: SourceAdapter[] = [
    new OpenFoodFactsAdapter(deps),
    new LaFourcheAdapter(deps),
    new KazidomiAdapter(deps),
    new BiocoopAdapter(deps),
    new LaVieClaireAdapter(deps),
    new NaturaliaAdapter(deps),
    new LaBelleVieAdapter(deps),
  ];
  return all.filter((a) => !deps.config.disabledSources.includes(a.id));
}

/** Per-host politeness limits (requests are spaced; a few run concurrently at most). */
export const HOST_LIMITS = {
  "world.openfoodfacts.org": { intervalMs: 6000, concurrency: 1 },
  "search.openfoodfacts.org": { intervalMs: 8000, concurrency: 1 },
  "lafourche.fr": { intervalMs: 2000, concurrency: 1 },
  "*.algolia.net": { intervalMs: 1000, concurrency: 2 },
  "api.kazidomi.com": { intervalMs: 1000, concurrency: 2 },
  "www.kazidomi.com": { intervalMs: 2000, concurrency: 1 },
  "www.biocoop.fr": { intervalMs: 2000, concurrency: 2 },
  "www.lavieclaire.com": { intervalMs: 2000, concurrency: 2 },
  "www.naturalia.fr": { intervalMs: 2000, concurrency: 2 },
  "search.deleev.com": { intervalMs: 1000, concurrency: 2 },
  "www.labellevie.com": { intervalMs: 2000, concurrency: 2 },
} as const;

export const DEFAULT_LIMIT = { intervalMs: 2000, concurrency: 1 } as const;

export function tierMap(adapters: SourceAdapter[]): (source: SourceId) => Tier {
  const tiers = new Map(adapters.map((a) => [a.id, a.tier]));
  return (source) => tiers.get(source) ?? "C";
}
