/**
 * Rebuilds src/data/ciqual.json from the latest Ciqual table (ANSES, Licence Ouverte / Etalab 2.0), published on
 * recherche.data.gouv.fr. Run when ANSES publishes a new version: npm run ciqual
 */
import { writeFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { CIQUAL_DOI, type CiqualData, type CiqualFood, type CiqualValue } from "../src/sources/ciqual.ts";

const SITE = "https://entrepot.recherche.data.gouv.fr";
const OUTPUT = new URL("../src/data/ciqual.json", import.meta.url);

/** Ciqual constituent codes for each nutrient, preferred first (protein N × 6.25 and salt as on EU labels). */
const CONSTITUENTS: Record<string, number[]> = {
  energy_kj: [327],
  energy_kcal: [328],
  fat_g: [40000],
  saturated_fat_g: [40302],
  carbohydrates_g: [31000],
  sugars_g: [32000],
  fiber_g: [34100],
  protein_g: [25003, 25000],
  salt_g: [10004],
};
const SODIUM_MG = 10110;

interface DatasetFile {
  dataFile: { id: number; filename: string };
}

async function datasetFiles(): Promise<DatasetFile[]> {
  const res = await fetch(`${SITE}/api/datasets/:persistentId/?persistentId=doi:${CIQUAL_DOI}`);
  if (!res.ok) throw new Error(`dataset: HTTP ${res.status}`);
  const body = (await res.json()) as { data: { latestVersion: { files: DatasetFile[] } } };
  return body.data.latestVersion.files;
}

async function download(files: DatasetFile[], prefix: string): Promise<{ xml: string; date: string }> {
  const file = files.find((f) =>
    new RegExp(`^${prefix}_(\\d{4})_(\\d{2})_(\\d{2})\\.xml$`).test(f.dataFile.filename),
  );
  if (!file) throw new Error(`no ${prefix} file in the dataset`);
  const res = await fetch(`${SITE}/api/access/datafile/${file.dataFile.id}`);
  if (!res.ok) throw new Error(`${file.dataFile.filename}: HTTP ${res.status}`);
  const date =
    file.dataFile.filename
      .match(/(\d{4})_(\d{2})_(\d{2})/)
      ?.slice(1)
      .join("-") ?? "";
  return { xml: await res.text(), date };
}

const parser = new XMLParser({ parseTagValue: false, trimValues: true, ignoreAttributes: true });
const rows = (xml: string, tag: string) =>
  (parser.parse(xml) as { TABLE: Record<string, Array<Record<string, string>>> }).TABLE[tag] ?? [];
const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** "12,5" / "< 0,5" / "traces" / "-" (no value). */
function parseValue(raw: string, confidence: string): CiqualValue | null {
  const t = raw.trim();
  if (t === "traces") return { v: 0, q: "traces", ...(confidence ? { c: confidence } : {}) };
  const m = /^(<)?\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (!m?.[2]) return null;
  const v = Number(m[2].replace(",", "."));
  return { v, ...(m[1] ? { q: "lt" as const } : {}), ...(confidence ? { c: confidence } : {}) };
}

async function main(): Promise<void> {
  const files = await datasetFiles();
  const [alim, compo, groups] = await Promise.all([
    download(files, "alim"),
    download(files, "compo"),
    download(files, "alim_grp"),
  ]);

  const groupNames = new Map<string, string>();
  for (const g of rows(groups.xml, "ALIM_GRP")) {
    groupNames.set(text(g.alim_grp_code), text(g.alim_grp_nom_fr));
    groupNames.set(text(g.alim_ssgrp_code), text(g.alim_ssgrp_nom_fr));
    groupNames.set(text(g.alim_ssssgrp_code), text(g.alim_ssssgrp_nom_fr));
  }

  const values = new Map<number, Map<number, CiqualValue>>();
  for (const r of rows(compo.xml, "COMPO")) {
    const value = parseValue(text(r.teneur), text(r.code_confiance));
    if (!value) continue;
    const food = Number(text(r.alim_code));
    if (!values.has(food)) values.set(food, new Map());
    values.get(food)?.set(Number(text(r.const_code)), value);
  }

  const foods: CiqualFood[] = rows(alim.xml, "ALIM").map((a) => {
    const code = Number(text(a.alim_code));
    const own = values.get(code) ?? new Map<number, CiqualValue>();
    const nutrients: CiqualFood["values"] = {};
    for (const [key, codes] of Object.entries(CONSTITUENTS)) {
      const value = codes.map((c) => own.get(c)).find(Boolean);
      if (value) nutrients[key as keyof CiqualFood["values"]] = value;
    }
    const sodium = own.get(SODIUM_MG);
    if (!nutrients.salt_g && sodium) nutrients.salt_g = { ...sodium, v: Math.round(sodium.v * 2.5) / 1000 };
    const group = [a.alim_ssssgrp_code, a.alim_ssgrp_code, a.alim_grp_code]
      .map((c) => groupNames.get(text(c)))
      .find((n) => n && n !== "-");
    return {
      code,
      name: text(a.alim_nom_fr),
      name_en: text(a.alim_nom_eng),
      group: group ?? null,
      values: nutrients,
    };
  });

  const data: CiqualData = { version: alim.date, doi: CIQUAL_DOI, foods };
  writeFileSync(OUTPUT, `${JSON.stringify(data)}\n`);
  console.log(`Ciqual ${data.version}: ${foods.length} foods written to ${OUTPUT.pathname}`);
}

await main();
