// Parses the two Big Brain xlsx workbooks and produces typed fixtures
// for the Flare Fitness and Macro workspaces. Run:
//   node apps/api/scripts/build-fixtures.mjs
// It rewrites /api/_fixtures.ts with MODULES + ENTRIES_BY_SLUG containing
// both workspaces; the seed script picks it up on the next dev restart.

import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const FLARE_PATH = join(repoRoot, "Big Brain - Flare Fitness.xlsx");
const MACRO_PATH = join(repoRoot, "Big Brain Macro .xlsx");

// ---------- helpers ----------
// Deterministic UUID (RFC 4122 v5-shaped) so regenerating fixtures yields
// stable externalIds — the seed's upsert-by-externalId stays idempotent and
// orphan cleanup can actually identify stale rows.
function stableId(seed) {
  const h = createHash("sha1").update(seed).digest("hex");
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// Fixed timestamp keeps the generated file byte-stable across runs.
const FIXTURE_TIMESTAMP = "2026-04-18T13:44:43.504Z";
const now = () => FIXTURE_TIMESTAMP;
const s = (v) => (v == null ? "" : String(v).trim());
const clean = (v) => {
  const str = s(v);
  return str.length ? str : null;
};
function excelDateToIso(v) {
  if (typeof v !== "number") return s(v);
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const d = new Date(epoch.getTime() + v * 86400000);
  return d.toISOString().slice(0, 10);
}
function loadRows(path, sheetName) {
  const wb = XLSX.read(readFileSync(path));
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`sheet not found: ${sheetName}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
}
function entry(data, status = "active") {
  return { id: null, data, status, updatedAt: now() };
}
function module(slug, label, icon, fieldDefinitions) {
  return { id: stableId(`module:${slug}`), slug, label, icon, fieldDefinitions };
}

const MODULES = [];
const ENTRIES_BY_SLUG = {};
function add(mod, entries) {
  MODULES.push(mod);
  const seen = new Set();
  ENTRIES_BY_SLUG[mod.slug] = entries.map((e, i) => {
    const base = `${mod.slug}:${JSON.stringify(e.data)}`;
    let id = stableId(base);
    // Guard against the (unlikely) case of two entries with identical data:
    // salt the seed with the index so upserts don't collapse into one row.
    while (seen.has(id)) id = stableId(`${base}#${i}`);
    seen.add(id);
    return { ...e, id };
  });
}

// ========== FLARE ==========

// -- flare_branches
{
  const rows = loadRows(FLARE_PATH, "Branches & Facilities");
  // r0: title; r1: headers; r2..: data
  const body = rows.slice(2).filter((r) => clean(r[0]) && clean(r[1]));
  const entries = body.map((r) =>
    entry({
      branch_id: s(r[0]),
      name: s(r[1]),
      area: s(r[2]),
      type: s(r[3]),
      gender: s(r[4]),
      phone: s(r[5]),
      hours: s(r[6]),
      amenities: s(r[7]),
      coaches: s(r[8]),
      pdf: clean(r[10]),
    }),
  );
  add(
    module("flare_branches", "Branches & Facilities", "map-pin", [
      { key: "branch_id", label: "Branch ID", type: "text" },
      { key: "name", label: "Name", type: "text", required: true },
      { key: "area", label: "Area", type: "text" },
      { key: "type", label: "Type", type: "text" },
      { key: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Mixed"] },
      { key: "phone", label: "Phone", type: "text" },
      { key: "hours", label: "Working hours", type: "textarea" },
      { key: "amenities", label: "Amenities", type: "textarea" },
      { key: "coaches", label: "Coaches", type: "textarea" },
      { key: "pdf", label: "PDF", type: "file" },
    ]),
    entries,
  );
}

// -- flare_coaches
{
  const rows = loadRows(FLARE_PATH, "Coaches");
  const body = rows.slice(2).filter((r) => clean(r[0]));
  const entries = body.map((r) =>
    entry({
      name: s(r[0]),
      experience: s(r[1]),
      specialization: s(r[2]),
      nationality: s(r[3]),
      pt_link: clean(r[4]),
      burn_link: clean(r[5]),
    }),
  );
  add(
    module("flare_coaches", "Coaches", "users", [
      { key: "name", label: "Coach Name", type: "text", required: true },
      { key: "experience", label: "Experience", type: "textarea" },
      { key: "specialization", label: "Specialization", type: "textarea" },
      { key: "nationality", label: "Nationality", type: "text" },
      { key: "pt_link", label: "PT Link", type: "url" },
      { key: "burn_link", label: "Burn Link", type: "url" },
    ]),
    entries,
  );
}

// -- flare_offers
{
  const rows = loadRows(FLARE_PATH, "Offers");
  // r0 title, r1 subtitle, r2 headers, r3+ data
  const body = rows.slice(3).filter((r) => clean(r[3]) || clean(r[4]));
  let lastCategory = "";
  let lastStart = "";
  let lastEnd = "";
  const entries = body.map((r) => {
    lastCategory = clean(r[0]) ?? lastCategory;
    lastStart = clean(r[1]) != null ? excelDateToIso(r[1]) : lastStart;
    lastEnd = clean(r[2]) != null ? excelDateToIso(r[2]) : lastEnd;
    return entry({
      category: lastCategory,
      start_date: lastStart,
      end_date: lastEnd,
      membership: s(r[3]),
      regular_price: typeof r[4] === "number" ? r[4] : Number(r[4]) || null,
      discounted_price: typeof r[5] === "number" ? r[5] : Number(r[5]) || null,
      discount_pct: typeof r[6] === "number" ? Math.round(r[6] * 100) : null,
    });
  });
  add(
    module("flare_offers", "Offers", "tag", [
      { key: "category", label: "Category", type: "text" },
      { key: "start_date", label: "Start Date", type: "date" },
      { key: "end_date", label: "End Date", type: "date" },
      { key: "membership", label: "Membership", type: "text", required: true },
      { key: "regular_price", label: "Regular Price (KD)", type: "number" },
      { key: "discounted_price", label: "Discounted Price (KD)", type: "number" },
      { key: "discount_pct", label: "Discount %", type: "number" },
    ]),
    entries,
  );
}

// -- flare_burn (programs)
{
  const rows = loadRows(FLARE_PATH, "Burn");
  // r0 title, r1 link, r2+ data
  const body = rows.slice(2).filter((r) => clean(r[0]));
  const entries = body.map((r) =>
    entry({
      name: s(r[0]),
      category: s(r[1]),
      description_en: s(r[2]),
      description_ar: s(r[3]),
      price: typeof r[4] === "number" ? r[4] : Number(r[4]) || null,
    }),
  );
  add(
    module("flare_burn", "Burn Programs", "flame", [
      { key: "name", label: "Program", type: "text", required: true },
      { key: "category", label: "Category", type: "text" },
      { key: "description_en", label: "Description (EN)", type: "textarea" },
      { key: "description_ar", label: "Description (AR)", type: "textarea" },
      { key: "price", label: "Price (KD)", type: "number" },
    ]),
    entries,
  );
}

// -- flare_burn_academy
{
  const rows = loadRows(FLARE_PATH, "Burn Academy");
  // r0 title, r1 COURSES, r2 headers, r3+ data
  const body = rows.slice(3).filter((r) => clean(r[0]));
  const entries = body.map((r) =>
    entry({
      course: s(r[0]),
      mix: s(r[1]),
      details: s(r[2]),
    }),
  );
  add(
    module("flare_burn_academy", "Burn Academy", "graduation-cap", [
      { key: "course", label: "Course", type: "text", required: true },
      { key: "mix", label: "Edu / Practical Mix", type: "text" },
      { key: "details", label: "Details", type: "textarea" },
    ]),
    entries,
  );
}

// -- flare_classes (with sub-section heading as category)
{
  const rows = loadRows(FLARE_PATH, "Classes");
  const entries = [];
  let category = "";
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const a = clean(r[0]);
    const b = clean(r[1]);
    if (a && !b) {
      category = a;
      continue;
    }
    if (a && b) {
      entries.push(entry({ category, name: a, description: b }));
    }
  }
  add(
    module("flare_classes", "Classes", "activity", [
      { key: "category", label: "Category", type: "text" },
      { key: "name", label: "Class", type: "text", required: true },
      { key: "description", label: "Description", type: "textarea" },
    ]),
    entries,
  );
}

// -- flare_pt (PT pricing — flatten sub-sections into "segment" field)
{
  const rows = loadRows(FLARE_PATH, "Personal Training (PT)");
  const entries = [];
  let segment = "";
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const a = clean(r[0]);
    const b = clean(r[1]);
    const c = clean(r[2]);
    if (a && !b && !c) {
      segment = a;
      continue;
    }
    if (a && /^sessions?$/i.test(a)) continue; // header row "Sessions | Member Price | ..."
    if (a && (typeof r[1] === "number" || typeof r[2] === "number")) {
      entries.push(
        entry({
          segment,
          sessions: a,
          member_price: typeof r[1] === "number" ? r[1] : Number(r[1]) || null,
          non_member_price: typeof r[2] === "number" ? r[2] : Number(r[2]) || null,
        }),
      );
    }
  }
  add(
    module("flare_pt", "Personal Training", "dumbbell", [
      { key: "segment", label: "Segment", type: "text" },
      { key: "sessions", label: "Sessions", type: "text", required: true },
      { key: "member_price", label: "Member Price (KD)", type: "number" },
      { key: "non_member_price", label: "Non-Member Price (KD)", type: "number" },
    ]),
    entries,
  );
}

// -- flare_memberships (flatten sections into entries keyed by tier/plan/duration)
{
  const rows = loadRows(FLARE_PATH, "Memberships & Pricing");
  const entries = [];
  let tier = "";
  let planContext = "";
  let headers = [];
  const toNumberKD = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = v.trim();
      if (/^-?[\d.]+$/.test(t)) return Number(t);
      const m = t.match(/^([\d.]+)\s*KD$/i);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const SKIP_LABEL = /^(soul sessions?|burn programs?|breathe sessions?|free weeks|black kit)/i;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const a = clean(r[0]);
    const b = clean(r[1]);
    const filled = r.map(clean).filter(Boolean);
    if (a && filled.length === 1 && a === a.toUpperCase() && /[A-Z]/.test(a)) {
      tier = a;
      planContext = "";
      headers = [];
      continue;
    }
    if (a && filled.length === 1) {
      planContext = a;
      continue;
    }
    if (!a && b) {
      headers = r.slice(1).map(clean).filter(Boolean);
      continue;
    }
    if (a && /^(duration|package|program|location|category)/i.test(a)) {
      headers = r.slice(1).map(clean).filter(Boolean);
      continue;
    }
    if (a && headers.length) {
      if (SKIP_LABEL.test(a)) continue;
      const isPriceRow = /^price/i.test(a);
      const plan = isPriceRow ? planContext || "Price" : a;
      for (let j = 0; j < headers.length; j++) {
        const price = toNumberKD(r[1 + j]);
        if (price == null) continue;
        // The column header is only a real duration when it isn't a price/size
        // tier label. Price-matrix headers ("Price (KD)", "Member Price (KD)",
        // "Large Size (KD)") must not leak into the duration field — fold the
        // meaningful qualifier into the plan instead and leave duration blank.
        const header = headers[j];
        const qual = /member/i.test(header)
          ? /non-?member/i.test(header)
            ? " (Non-Member)"
            : " (Member)"
          : /large/i.test(header)
            ? " (Large)"
            : /small/i.test(header)
              ? " (Small)"
              : "";
        const isPriceHeader = /price|size/i.test(header);
        entries.push(
          entry({
            tier,
            plan: qual ? plan + qual : plan,
            duration: isPriceHeader ? "" : header,
            price,
          }),
        );
      }
    }
  }
  add(
    module("flare_memberships", "Memberships & Pricing", "crown", [
      { key: "tier", label: "Tier", type: "text" },
      { key: "plan", label: "Plan", type: "text" },
      { key: "duration", label: "Duration", type: "text", required: true },
      { key: "price", label: "Price (KD)", type: "number" },
    ]),
    entries,
  );
}

// -- flare_festival
{
  const rows = loadRows(FLARE_PATH, "Festival");
  const entries = [];
  for (let i = 2; i < rows.length; i++) {
    const k = clean(rows[i][0]);
    const v = clean(rows[i][1]);
    if (k && v) entries.push(entry({ key: k, value: v }));
  }
  add(
    module("flare_festival", "Flare Festival 2025", "calendar", [
      { key: "key", label: "Field", type: "text", required: true },
      { key: "value", label: "Value", type: "textarea" },
    ]),
    entries,
  );
}

// -- flare_loyalty
{
  const rows = loadRows(FLARE_PATH, "Loyalty & Referral Program");
  const entries = [];
  let section = "";
  for (let i = 1; i < rows.length; i++) {
    const a = clean(rows[i][0]);
    const b = clean(rows[i][1]);
    if (a && !b && a.toUpperCase() === a) {
      section = a;
      continue;
    }
    if (a) entries.push(entry({ section, heading: a, detail: b ?? "" }));
  }
  add(
    module("flare_loyalty", "Loyalty & Referral", "heart", [
      { key: "section", label: "Section", type: "text" },
      { key: "heading", label: "Heading", type: "text", required: true },
      { key: "detail", label: "Detail", type: "textarea" },
    ]),
    entries,
  );
}

// -- flare_jobs
{
  const rows = loadRows(FLARE_PATH, "Jobs - Flare ");
  const entries = [];
  for (let i = 2; i < rows.length; i++) {
    const v = clean(rows[i][0]);
    if (v) entries.push(entry({ label: "Apply for vacancies", url: v }));
  }
  add(
    module("flare_jobs", "Careers", "briefcase", [
      { key: "label", label: "Label", type: "text", required: true },
      { key: "url", label: "URL", type: "url" },
    ]),
    entries,
  );
}

// -- flare_agent_config
{
  const rows = loadRows(FLARE_PATH, "Agent Config");
  const entries = [];
  let section = "";
  for (let i = 1; i < rows.length; i++) {
    const a = clean(rows[i][0]);
    const b = clean(rows[i][1]);
    if (a && !b && a.toUpperCase() === a) {
      section = a;
      continue;
    }
    if (a) entries.push(entry({ section, key: a, value: b ?? "" }));
  }
  add(
    module("flare_agent_config", "Agent Config", "cpu", [
      { key: "section", label: "Section", type: "text" },
      { key: "key", label: "Key", type: "text", required: true },
      { key: "value", label: "Value", type: "textarea" },
    ]),
    entries,
  );
}

// ========== MACRO ==========

// -- macro_packages
{
  const rows = loadRows(MACRO_PATH, "PACAKGES & PRICES ");
  // Rows 43+ are a side-by-side calorie-guidance layout (no prices). Require a
  // numeric 26-day price so those junk rows don't leak in as empty entries.
  const body = rows
    .slice(1)
    .filter((r) => clean(r[0]) && clean(r[1]) && typeof r[2] === "number");
  const entries = body.map((r) =>
    entry({
      target: s(r[0]),
      package_name: s(r[1]),
      price_26d: typeof r[2] === "number" ? r[2] : Number(r[2]) || null,
      price_20d: typeof r[3] === "number" ? r[3] : Number(r[3]) || null,
      price_14d: typeof r[4] === "number" ? r[4] : Number(r[4]) || null,
      price_7d: typeof r[5] === "number" ? r[5] : Number(r[5]) || null,
      price_5d: typeof r[6] === "number" ? r[6] : Number(r[6]) || null,
      price_1d: typeof r[7] === "number" ? r[7] : Number(r[7]) || null,
    }),
  );
  add(
    module("macro_packages", "Packages & Pricing", "package", [
      { key: "target", label: "Target", type: "text" },
      { key: "package_name", label: "Package", type: "text", required: true },
      { key: "price_26d", label: "26 days (KD)", type: "number" },
      { key: "price_20d", label: "20 days (KD)", type: "number" },
      { key: "price_14d", label: "14 days (KD)", type: "number" },
      { key: "price_7d", label: "7 days (KD)", type: "number" },
      { key: "price_5d", label: "5 days (KD)", type: "number" },
      { key: "price_1d", label: "1 day (KD)", type: "number" },
    ]),
    entries,
  );
}

// -- macro_origins
{
  const rows = loadRows(MACRO_PATH, "coutnry origin ");
  const body = rows.slice(1).filter((r) => clean(r[0]) && clean(r[1]));
  const entries = body.map((r) =>
    entry({
      meat_type: s(r[0]),
      source: s(r[1]),
    }),
  );
  add(
    module("macro_origins", "Meat Origins", "globe", [
      { key: "meat_type", label: "Meat Type", type: "text", required: true },
      { key: "source", label: "Source", type: "text" },
    ]),
    entries,
  );
}

// -- macro_delivery_areas
{
  const rows = loadRows(MACRO_PATH, "Delivery Areas ");
  const body = rows.slice(1).filter((r) => clean(r[1]) && clean(r[2]));
  const entries = body.map((r) =>
    entry({
      no: typeof r[0] === "number" ? r[0] : Number(r[0]) || null,
      governorate_en: s(r[1]),
      area_en: s(r[2]),
      governorate_ar: s(r[5]),
      area_ar: s(r[6]),
    }),
  );
  add(
    module("macro_delivery_areas", "Delivery Areas", "truck", [
      { key: "no", label: "No.", type: "number" },
      { key: "governorate_en", label: "Governorate (EN)", type: "text" },
      { key: "area_en", label: "Area (EN)", type: "text", required: true },
      { key: "governorate_ar", label: "Governorate (AR)", type: "text" },
      { key: "area_ar", label: "Area (AR)", type: "text" },
    ]),
    entries,
  );
}

// -- macro_general_info
{
  const rows = loadRows(MACRO_PATH, "Genral information ");
  const lines = rows.map((r) => clean(r[0])).filter(Boolean);
  const entries = lines.map((line, idx) => entry({ order: idx + 1, note: line }));
  add(
    module("macro_general_info", "General Info", "info", [
      { key: "order", label: "Order", type: "number" },
      { key: "note", label: "Note", type: "textarea", required: true },
    ]),
    entries,
  );
}

// -- macro_agent_config
{
  const rows = loadRows(MACRO_PATH, "Agent Config ");
  const body = rows.slice(1).filter((r) => clean(r[0]));
  const entries = body.map((r) =>
    entry({
      question: s(r[0]),
      answer: s(r[1]),
    }),
  );
  add(
    module("macro_agent_config", "Agent Config", "cpu", [
      { key: "question", label: "Question", type: "text", required: true },
      { key: "answer", label: "Answer", type: "textarea" },
    ]),
    entries,
  );
}

// -- macro_loyalty
{
  const rows = loadRows(MACRO_PATH, "Loyalty ");
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const a = clean(rows[i][0]);
    const b = clean(rows[i][1]);
    const c = clean(rows[i][2]);
    if (b || a) {
      entries.push(entry({ label: a ?? b ?? "", detail_en: b ?? "", detail_ar: c ?? "" }));
    }
  }
  add(
    module("macro_loyalty", "Loyalty", "heart", [
      { key: "label", label: "Label", type: "text", required: true },
      { key: "detail_en", label: "Detail (EN)", type: "textarea" },
      { key: "detail_ar", label: "Detail (AR)", type: "textarea" },
    ]),
    entries,
  );
}

// -- macro_links
{
  const rows1 = loadRows(MACRO_PATH, "Macro Talabat ");
  const rows2 = loadRows(MACRO_PATH, "Mobile Application ");
  const entries = [];
  // Talabat header row: ["Macro on Talabat ", "https://..."]
  if (rows1[0]) entries.push(entry({ label: s(rows1[0][0]), url: s(rows1[0][1]) }));
  if (rows1[1]) entries.push(entry({ label: s(rows1[1][0]), url: s(rows1[1][1]) }));
  // Mobile: header r0 has iOS label & url, r1 has Android label & url
  if (rows2[0]) entries.push(entry({ label: `iOS — ${s(rows2[0][0])}`, url: s(rows2[0][2]) }));
  if (rows2[1]) entries.push(entry({ label: `Android — ${s(rows2[1][0])}`, url: s(rows2[1][2]) }));
  add(
    module("macro_links", "Apps & Links", "link", [
      { key: "label", label: "Label", type: "text", required: true },
      { key: "url", label: "URL", type: "url" },
    ]),
    entries.filter((e) => e.data.url),
  );
}

// ---------- emit ----------
const out = `// AUTO-GENERATED by apps/api/scripts/build-fixtures.mjs — do not edit by hand.
// Source: "Big Brain - Flare Fitness.xlsx" + "Big Brain Macro .xlsx"
// Regenerate with: node apps/api/scripts/build-fixtures.mjs
export const MODULES = ${JSON.stringify(MODULES, null, 2)};

export const ENTRIES_BY_SLUG = ${JSON.stringify(ENTRIES_BY_SLUG, null, 2)};
`;

const outPath = join(repoRoot, "api", "_fixtures.ts");
writeFileSync(outPath, out);

const total = Object.values(ENTRIES_BY_SLUG).reduce((a, b) => a + b.length, 0);
console.log(`wrote ${outPath}`);
console.log(`modules: ${MODULES.length}, entries: ${total}`);
for (const m of MODULES) {
  console.log(`  ${m.slug.padEnd(28)}  ${String(ENTRIES_BY_SLUG[m.slug].length).padStart(4)}`);
}
