import type { NutrientKey } from "../domain/nutrients.ts";
import { agreesStrongly, agreesWeakly } from "./tolerance.ts";
import type { NutrientDecision, Vote } from "./types.ts";

interface Ballot extends Vote {
  independenceKey: string;
}

interface Cluster {
  ballots: Ballot[];
  anchor: Ballot;
  weight: number;
  merged: boolean;
}

const byWeightDesc = (a: Ballot, b: Ballot) => b.weight - a.weight;

/**
 * The published value with the most total weight among agreeing ballots (ties: the most trustworthy single ballot),
 * so the result does not depend on the order in which sources answered.
 */
function representativeValue(ballots: Ballot[]): number {
  const totals = new Map<number, { weight: number; best: number }>();
  for (const b of ballots) {
    const t = totals.get(b.value) ?? { weight: 0, best: 0 };
    totals.set(b.value, { weight: t.weight + b.weight, best: Math.max(t.best, b.weight) });
  }
  const [best] = [...totals.entries()].sort((a, b) => b[1].weight - a[1].weight || b[1].best - a[1].best);
  return best ? best[0] : (ballots[0]?.value ?? 0);
}

/** Copies of the same label (same independence key) count once, with the best weight among them. */
function dedupe(ballots: Ballot[]): { unique: Ballot[]; collapsed: boolean } {
  const best = new Map<string, Ballot>();
  for (const b of ballots) {
    const current = best.get(b.independenceKey);
    if (!current || b.weight > current.weight) best.set(b.independenceKey, b);
  }
  return { unique: [...best.values()], collapsed: best.size < ballots.length };
}

function clusterStrong(key: NutrientKey, ballots: Ballot[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const ballot of [...ballots].sort(byWeightDesc)) {
    const home = clusters.find((c) => agreesStrongly(key, c.anchor.value, ballot.value));
    if (home) {
      home.ballots.push(ballot);
      home.weight += ballot.weight;
    } else {
      clusters.push({ ballots: [ballot], anchor: ballot, weight: ballot.weight, merged: false });
    }
  }
  return clusters;
}

function mergeWeak(key: NutrientKey, clusters: Cluster[]): Cluster[] {
  const sorted = [...clusters].sort((a, b) => b.weight - a.weight);
  const out: Cluster[] = [];
  for (const cluster of sorted) {
    const home = out.find((c) => agreesWeakly(key, c.anchor.value, cluster.anchor.value));
    if (home) {
      home.ballots.push(...cluster.ballots);
      home.weight += cluster.weight;
      home.merged = true;
    } else {
      out.push({ ...cluster, ballots: [...cluster.ballots] });
    }
  }
  return out.sort((a, b) => b.weight - a.weight || b.ballots.length - a.ballots.length);
}

/**
 * Decides one nutrient from independent votes. The chosen value is a published value (never an average),
 * taken from the most trustworthy source in the winning cluster.
 */
export function decideNutrient(
  key: NutrientKey,
  votes: Array<Vote & { independenceKey: string }>,
): NutrientDecision & { collapsed: boolean } {
  const { unique, collapsed } = dedupe(votes);
  const total = unique.length;
  const base = { key, sourcesTotal: total, collapsed };

  if (total === 0) {
    return {
      ...base,
      value: null,
      agreement: "conflict",
      sourcesAgree: 0,
      supporting: [],
      weakOnly: [],
      dissent: [],
    };
  }
  const [only] = unique;
  if (total === 1 && only) {
    return {
      ...base,
      value: only.value,
      agreement: "single",
      sourcesAgree: 1,
      supporting: [only.source],
      weakOnly: [],
      dissent: [],
    };
  }

  const strong = clusterStrong(key, unique);
  const clusters = strong.length > 1 ? mergeWeak(key, strong) : strong;
  const [winner, runnerUp] = clusters;
  if (!winner) {
    return {
      ...base,
      value: null,
      agreement: "conflict",
      sourcesAgree: 0,
      supporting: [],
      weakOnly: [],
      dissent: [],
    };
  }

  const supporting = winner.ballots.map((b) => b.source);
  const weakOnly = winner.ballots
    .filter((b) => !agreesStrongly(key, winner.anchor.value, b.value))
    .map((b) => b.source);
  const dissent: Vote[] = clusters
    .slice(1)
    .flatMap((c) => c.ballots)
    .map(({ source, value, weight }) => ({ source, value, weight }));
  const value = representativeValue(winner.ballots);

  if (winner.ballots.length === total) {
    return {
      ...base,
      value,
      agreement: winner.merged ? "weak" : "strong",
      sourcesAgree: total,
      supporting,
      weakOnly,
      dissent: [],
    };
  }

  const beatsRunnerUp = !runnerUp || winner.ballots.length >= runnerUp.ballots.length + 1;
  if (winner.ballots.length >= 2 && beatsRunnerUp) {
    return {
      ...base,
      value,
      agreement: "majority",
      sourcesAgree: winner.ballots.length,
      supporting,
      weakOnly,
      dissent,
    };
  }

  const all = clusters.flatMap((c) => c.ballots).sort(byWeightDesc);
  return {
    ...base,
    value: null,
    agreement: "conflict",
    sourcesAgree: 0,
    supporting: [],
    weakOnly: [],
    dissent: all.map(({ source, value: v, weight }) => ({ source, value: v, weight })),
    bestGuess: all[0]?.value,
  };
}
