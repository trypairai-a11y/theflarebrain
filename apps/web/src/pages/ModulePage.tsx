import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useParams, useOutletContext, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAutoTranslation } from "../lib/translate.js";
import { Icon } from "../components/Icon.js";
import { DatePicker } from "../components/DatePicker.js";
import {
  parseTrigger,
  serializeTrigger,
  hasEscalationTarget,
  slaUrgency,
} from "../lib/escalationRule.js";

type Entry = { id: string; data: Record<string, unknown>; status: string; updatedAt: string };
type FieldDef = {
  key: string;
  type: string;
  label: string;
  options?: string[];
  localized?: boolean;
  required?: boolean;
};
type ModuleInfo = { id: string; slug: string; label: string; fieldDefinitions?: FieldDef[] };

const STATUS_BADGE: Record<string, string> = {
  active: "badge-green",
  inactive: "badge-gray",
  draft: "badge-gray",
  scheduled: "badge-blue",
  expired: "badge-gray",
  archived: "badge-gray",
  closed: "badge-gray",
  "in progress": "badge-purple",
  completed: "badge-green",
  cancelled: "badge-gray",
};

const ARABIC_RE = /[\u0600-\u06FF]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const QUESTION_RE = /^q(uestion)?(_|$)/i;
const ANSWER_RE = /^a(nswer)?(_|$)/i;
const EN_RE = /(^|_)(en|english)(_|$)/i;
const AR_RE = /(^|_)(ar|arabic)(_|$)/i;
const NAME_RE = /^name(_|$)/i;

function orderKeys(keys: string[]): string[] {
  const rank = (k: string) => {
    if (QUESTION_RE.test(k)) return 0;
    if (NAME_RE.test(k)) return 1;
    if (EN_RE.test(k)) return 2;
    if (AR_RE.test(k)) return 3;
    if (ANSWER_RE.test(k)) return 4;
    return 5;
  };
  return [...keys]
    .map((k, i) => ({ k, i, r: rank(k) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.k);
}
// Strip emoji glyphs, ZWJ, variation selectors, the replacement char, and
// Unicode private-use codepoints. Also catch UTF-8/Latin-1 mojibake of 4-byte
// emojis: a leading `ð` (\u00F0) plus 1-3 continuation bytes (\u0080-\u00BF).
// Without the continuation match, fragments like `¼` and `¡` survive and
// look like garbage characters mid-text.
const ICON_STRIP_RE =
  /\u00F0[\u0080-\u00BF]{1,3}|[\p{Extended_Pictographic}\u200D\uFE0F\uFFFD\u00F0\uE000-\uF8FF]/gu;

const DATE_KEY_RE = /(date|deadline|expires?|published|start|end)/i;
const HOURS_KEY_RE = /(^|_)hours?($|_)/i;

const HIDDEN_EDIT_KEYS = new Set([
  "intent_id",
  "requires_crm",
  "escalation_check",
  "revenue_opportunity",
]);

type HoursEntry = { days: string; time: string };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const DAY_LOOKUP: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  DAY_LABELS.forEach((lbl, i) => {
    const low = lbl.toLowerCase();
    out[low] = i;
    out[low.slice(0, 2)] = i;
    out[low.slice(0, 3)] = i;
  });
  return out;
})();

function parseDaySelection(raw: string): boolean[] {
  const out = [false, false, false, false, false, false, false];
  const s = raw.trim().toLowerCase();
  if (!s) return out;
  if (s === "daily" || s === "everyday" || s === "every day") return out.map(() => true);
  const range = s.match(/^([a-z]+)\s*[-\u2013]\s*([a-z]+)$/);
  if (range) {
    const a = DAY_LOOKUP[range[1]!];
    const b = DAY_LOOKUP[range[2]!];
    if (a != null && b != null) {
      let i = a;
      for (let guard = 0; guard < 8; guard++) {
        out[i] = true;
        if (i === b) return out;
        i = (i + 1) % 7;
      }
    }
  }
  let matched = false;
  s.split(/[,;\s]+/).forEach((tok) => {
    const idx = DAY_LOOKUP[tok];
    if (idx != null) {
      out[idx] = true;
      matched = true;
    }
  });
  return matched ? out : [false, false, false, false, false, false, false];
}

function formatDaySelection(sel: boolean[]): string {
  if (sel.every((v) => v)) return "Daily";
  if (sel.every((v) => !v)) return "";
  const idxs: number[] = [];
  sel.forEach((v, i) => {
    if (v) idxs.push(i);
  });
  let contiguous = true;
  for (let k = 1; k < idxs.length; k++) {
    if (idxs[k]! - idxs[k - 1]! !== 1) {
      contiguous = false;
      break;
    }
  }
  if (contiguous && idxs.length >= 2) {
    return `${DAY_LABELS[idxs[0]!]}-${DAY_LABELS[idxs[idxs.length - 1]!]}`;
  }
  return idxs.map((i) => DAY_LABELS[i]).join(", ");
}

const TIME_OPTIONS: string[] = (() => {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const ampm = h < 12 ? "AM" : "PM";
      const hh = h === 0 || h === 12 ? 12 : h % 12;
      const mm = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
      opts.push(`${hh}${mm}${ampm}`);
    }
  }
  return opts;
})();

function normalizeTimeToken(t: string): string {
  const m = t
    .trim()
    .toUpperCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (!m) return "";
  const h = parseInt(m[1]!, 10);
  const mm = m[2] ? parseInt(m[2]!, 10) : 0;
  const snappedMm = mm < 15 ? 0 : mm < 45 ? 30 : 0;
  const carryHour = mm >= 45 ? 1 : 0;
  const h12 = ((h + carryHour - 1) % 12) + 1;
  const mmStr = snappedMm === 0 ? "" : `:${String(snappedMm).padStart(2, "0")}`;
  const candidate = `${h12}${mmStr}${m[3]}`;
  return TIME_OPTIONS.includes(candidate) ? candidate : "";
}

function parseShifts(raw: string): Array<[string, string]> {
  const shifts: Array<[string, string]> = [];
  const parts = raw.split(/\s*;\s*/).filter(Boolean);
  for (const p of parts) {
    const m = p.match(
      /^\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\s*[-\u2013]\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\s*$/i,
    );
    if (m) {
      shifts.push([normalizeTimeToken(m[1]!), normalizeTimeToken(m[2]!)]);
    } else {
      shifts.push(["", ""]);
    }
  }
  return shifts.length ? shifts : [["", ""]];
}

function formatShifts(shifts: Array<[string, string]>): string {
  return shifts.map(([a, b]) => `${a}-${b}`).join("; ");
}

function parseHoursValue(raw: unknown): HoursEntry[] {
  if (Array.isArray(raw)) return raw as HoursEntry[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as HoursEntry[];
    } catch {
      /* fall through */
    }
    return raw
      .split(/\r?\n|;\s*/)
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?):\s*(.+)$/);
        return m ? { days: m[1]!.trim(), time: m[2]!.trim() } : { days: line.trim(), time: "" };
      });
  }
  return [];
}

type FileValue = { mediaId: string | null; filename: string };

function parseFileValue(raw: unknown): FileValue | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const filename = typeof o.filename === "string" ? o.filename : "";
    const mediaId = typeof o.mediaId === "string" ? o.mediaId : null;
    if (!filename && !mediaId) return null;
    return { filename, mediaId };
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseFileValue(parsed);
      }
    } catch {
      /* fall through */
    }
    return { mediaId: null, filename: raw };
  }
  return null;
}

function FileFieldInput({
  value,
  onChange,
}: {
  value: FileValue | null;
  onChange: (v: FileValue | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError("Only PDF files are allowed");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("File must be ≤10MB");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await api<{ id: string; filename: string }>("/api/v1/media/upload", {
        method: "POST",
        body: fd,
      });
      onChange({ mediaId: data.id, filename: data.filename });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function openExisting() {
    if (!value?.mediaId) return;
    try {
      const data = await api<{ url: string }>(`/api/v1/media/${value.mediaId}/url`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open file");
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(ev) => handleFiles(ev.target.files)}
      />
      {value?.filename ? (
        <div className="flex items-center gap-2 rounded-apple border border-apple-separator-light bg-[#FAFAFA] px-3 py-2">
          <Icon name="file" size={14} />
          {value.mediaId ? (
            <button
              type="button"
              onClick={openExisting}
              className="flex-1 min-w-0 text-left text-[13px] text-pair hover:underline truncate"
              title={value.filename}
            >
              {value.filename}
            </button>
          ) : (
            <span
              className="flex-1 min-w-0 text-[13px] text-apple-text truncate"
              title={value.filename}
            >
              {value.filename}
            </span>
          )}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="btn-ghost !px-2 !py-1 text-[12px]"
          >
            {busy ? "Uploading…" : "Replace"}
          </button>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={busy}
            className="btn-ghost !px-2 !py-1 text-[12px] text-apple-tertiary hover:text-red-500"
            aria-label="Remove file"
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn-ghost w-full !py-2 text-[13px] border border-dashed border-apple-separator-light"
        >
          {busy ? "Uploading…" : "+ Upload PDF"}
        </button>
      )}
      {error && <div className="text-[12px] text-red-500">{error}</div>}
    </div>
  );
}

function HoursDisplay({ value }: { value: unknown }) {
  const entries = parseHoursValue(value);
  if (entries.length === 0) {
    return <div className="text-[13px] text-apple-text">-</div>;
  }
  return (
    <ul className="rounded-apple border border-apple-separator-light bg-[#F9F9F9] overflow-hidden divide-y divide-apple-separator-light">
      {entries.map((entry, i) => (
        <li key={i} className="flex items-center justify-between gap-4 px-3 py-1.5">
          <span className="text-[12px] font-medium text-apple-text">{entry.days}</span>
          <span className="text-[12px] tabular-nums text-apple-secondary">{entry.time}</span>
        </li>
      ))}
    </ul>
  );
}

function badgeFor(status?: string): string {
  if (!status) return "badge-gray";
  const k = status.toLowerCase();
  return STATUS_BADGE[k] ?? "badge-gray";
}

const KEY_LABEL_OVERRIDES: Record<string, string> = {
  rule: "Branch",
  name: "Type",
};

function humanizeKey(k: string): string {
  if (KEY_LABEL_OVERRIDES[k]) return KEY_LABEL_OVERRIDES[k];
  return k
    .replace(/_/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/^Ar$|^En$/i, (m) => (m.toUpperCase() === "AR" ? "(AR)" : "(EN)"));
}

// Special whitespace characters that survive `whitespace-pre-line` and produce
// the visible "gap" artifacts: NBSP, narrow NBSP, figure space, em/en spaces,
// thin space, hair space, ideographic space, zero-width space/joiner, BOM, tab.
const SPECIAL_SPACE_RE =
  /[\u00A0\u202F\u2007\u2003\u2002\u2009\u200A\u3000\u200B\u200C\u200D\uFEFF\t]/g;

function normalizeWhitespace(s: string): string {
  return s
    .replace(SPECIAL_SPACE_RE, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ ]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripIcons(s: string): string {
  // Replace icons with newlines so emoji-prefixed bullet items end up on
  // their own lines instead of running together as one wrapped paragraph.
  return normalizeWhitespace(s.replace(ICON_STRIP_RE, "\n"));
}

function formatDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function displayValue(key: string, raw: string): string {
  if (ISO_DATE_RE.test(raw)) return formatDate(raw);
  return stripIcons(raw);
}

function toDateInput(raw: unknown): string {
  if (raw == null) return "";
  const s = String(raw);
  if (ISO_DATE_RE.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

function toTimeInput(raw: unknown): string {
  if (raw == null) return "";
  const s = String(raw);
  const m = s.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return "";
}

function combineDateTime(dateVal: string, timeVal: string): string {
  if (!dateVal) return "";
  const time = /^\d{2}:\d{2}$/.test(timeVal) ? timeVal : "00:00";
  return `${dateVal}T${time}:00.000Z`;
}

const PROMOTIONS_SLUGS = new Set(["promotions", "active-promotions", "active_offers"]);

// The demo API is backed by static fixtures, so DELETE returns success but the
// entry reappears on reload. Track deleted IDs client-side so the UI state
// survives page refreshes during the demo session.
const DELETED_STORAGE_KEY = "brain-demo-deleted-entry-ids";

function getDeletedIds(slug: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(DELETED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return new Set(parsed[slug] ?? []);
  } catch {
    return new Set();
  }
}

function markEntryDeleted(slug: string, id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(DELETED_STORAGE_KEY);
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
    const list = parsed[slug] ?? [];
    if (!list.includes(id)) list.push(id);
    parsed[slug] = list;
    localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // localStorage full or unavailable; best-effort only
  }
}

// Demo-mode status overrides: PATCH to the fixture API does not persist, so
// keep deactivated IDs in localStorage and rewrite status on reload.
const INACTIVE_STORAGE_KEY = "brain-demo-inactive-entry-ids";

function getInactiveIds(slug: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(INACTIVE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return new Set(parsed[slug] ?? []);
  } catch {
    return new Set();
  }
}

function setEntryActive(slug: string, id: string, active: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(INACTIVE_STORAGE_KEY);
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
    const list = new Set(parsed[slug] ?? []);
    if (active) list.delete(id);
    else list.add(id);
    parsed[slug] = [...list];
    localStorage.setItem(INACTIVE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // best-effort only
  }
}

const TITLE_KEYS = ["name", "update_name", "title", "name_en", "update_name_en"];
const TYPE_KEYS = ["type", "category", "ai_category", "type_en"];
const START_KEYS = ["start_date", "starts_at", "publish_at", "start"];
const END_KEYS = ["end_date", "expires_at", "ends_at", "end"];
const MSG_EN_KEYS = ["message_en", "message_en_approved", "text_en", "body_en"];
const MSG_AR_KEYS = ["message_ar", "message_ar_approved", "text_ar", "body_ar"];

const LANG_SUFFIX_RE = /^(.+?)(?:_(en|english|ar|arabic))$/i;

function langOfKey(k: string): { base: string; lang: "en" | "ar" | null } {
  const m = k.match(LANG_SUFFIX_RE);
  if (!m) return { base: k, lang: null };
  const suffix = m[2]!.toLowerCase();
  return { base: m[1]!, lang: suffix.startsWith("a") ? "ar" : "en" };
}

type LangGroup =
  | { kind: "pair"; base: string; enKey: string | null; arKey: string | null }
  | { kind: "single"; key: string };

function groupLangKeys(keys: string[]): LangGroup[] {
  const baseIndex = new Map<string, { enKey?: string; arKey?: string; firstIdx: number }>();
  const singles: { key: string; idx: number }[] = [];
  keys.forEach((k, idx) => {
    const { base, lang } = langOfKey(k);
    if (!lang) {
      singles.push({ key: k, idx });
      return;
    }
    const entry = baseIndex.get(base) ?? { firstIdx: idx };
    if (lang === "en") entry.enKey = k;
    else entry.arKey = k;
    if (!baseIndex.has(base)) entry.firstIdx = idx;
    baseIndex.set(base, entry);
  });
  const groups: { idx: number; group: LangGroup }[] = [];
  for (const [base, info] of baseIndex.entries()) {
    groups.push({
      idx: info.firstIdx,
      group: { kind: "pair", base, enKey: info.enKey ?? null, arKey: info.arKey ?? null },
    });
  }
  for (const s of singles) {
    groups.push({ idx: s.idx, group: { kind: "single", key: s.key } });
  }
  return groups.sort((a, b) => a.idx - b.idx).map((g) => g.group);
}

function BilingualText({
  en,
  ar,
  className,
  enClassName,
  arClassName,
}: {
  en: string;
  ar: string;
  className?: string;
  enClassName?: string;
  arClassName?: string;
}) {
  const enClean = stripIcons(en);
  const arClean = stripIcons(ar);
  const needEn = !enClean && Boolean(arClean);
  const needAr = !arClean && Boolean(enClean);
  const [enRequested, setEnRequested] = useState(false);
  const [arRequested, setArRequested] = useState(false);
  const enAuto = useAutoTranslation(
    needEn && enRequested ? arClean : null,
    "en",
    needEn && enRequested,
  );
  const arAuto = useAutoTranslation(
    needAr && arRequested ? enClean : null,
    "ar",
    needAr && arRequested,
  );
  const englishText = enClean || enAuto.value;
  const arabicText = arClean || arAuto.value;
  const englishIsAuto = needEn && Boolean(enAuto.value);
  const arabicIsAuto = needAr && Boolean(arAuto.value);

  if (!enClean && !arClean) return null;

  return (
    <div className={`grid md:grid-cols-2 gap-4 ${className ?? ""}`}>
      <div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] font-semibold text-apple-tertiary mb-1.5">
          <span>English</span>
          {englishIsAuto && (
            <span className="badge badge-gray !text-[9px] !px-1.5 !py-0">auto</span>
          )}
        </div>
        {needEn && !enRequested ? (
          <button
            type="button"
            onClick={() => setEnRequested(true)}
            className="text-[12px] text-pair hover:underline inline-flex items-center gap-1"
          >
            <Icon name="sparkles" size={11} />
            Translate to English
          </button>
        ) : needEn && enAuto.loading ? (
          <div className="text-[12px] text-apple-tertiary italic">Translating…</div>
        ) : needEn && enAuto.error ? (
          <button
            type="button"
            onClick={() => setEnRequested(false)}
            className="text-[12px] text-apple-red hover:underline"
          >
            Translation failed, retry
          </button>
        ) : (
          <div
            dir="ltr"
            style={{ textAlign: "left", textAlignLast: "left" }}
            className={`text-[13px] leading-relaxed text-apple-text whitespace-pre-line break-words text-left ${
              enClassName ?? ""
            }`}
          >
            {englishText || "-"}
          </div>
        )}
      </div>
      <div>
        <div className="w-full flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-[0.08em] font-semibold text-apple-tertiary mb-1.5">
          {arabicIsAuto && <span className="badge badge-gray !text-[9px] !px-1.5 !py-0">auto</span>}
          <span>Arabic</span>
        </div>
        {needAr && !arRequested ? (
          <button
            type="button"
            onClick={() => setArRequested(true)}
            className="text-[12px] text-pair hover:underline inline-flex items-center gap-1"
          >
            <Icon name="sparkles" size={11} />
            Translate to Arabic
          </button>
        ) : needAr && arAuto.loading ? (
          <div className="text-[12px] text-apple-tertiary italic">Translating…</div>
        ) : needAr && arAuto.error ? (
          <button
            type="button"
            onClick={() => setArRequested(false)}
            className="text-[12px] text-apple-red hover:underline"
          >
            Translation failed, retry
          </button>
        ) : (
          <div
            dir="rtl"
            style={{ textAlign: "right", textAlignLast: "right" }}
            className={`text-[13px] leading-relaxed text-apple-text whitespace-pre-line break-words font-arabic text-right ${
              arClassName ?? ""
            }`}
          >
            {arabicText || "-"}
          </div>
        )}
      </div>
    </div>
  );
}

function CompactBilingual({ en, ar }: { en: string; ar: string }) {
  const enClean = stripIcons(en);
  const arClean = stripIcons(ar);
  if (!enClean && !arClean) return null;
  if (!arClean) {
    return (
      <div
        dir="ltr"
        className="text-[13px] leading-relaxed text-apple-text whitespace-pre-line break-words line-clamp-3 text-left"
      >
        {enClean}
      </div>
    );
  }
  if (!enClean) {
    return (
      <div
        dir="rtl"
        className="text-[13px] leading-relaxed text-apple-text whitespace-pre-line break-words line-clamp-3 font-arabic text-right"
      >
        {arClean}
      </div>
    );
  }
  return (
    <div>
      <div
        dir="ltr"
        className="text-[13px] leading-relaxed text-apple-text whitespace-pre-line break-words line-clamp-2 text-left"
      >
        {enClean}
      </div>
      <div
        dir="rtl"
        className="text-[12px] leading-relaxed text-apple-secondary whitespace-pre-line break-words line-clamp-2 font-arabic text-right mt-1"
      >
        {arClean}
      </div>
    </div>
  );
}

function pickField(data: Record<string, unknown>, candidates: readonly string[]): string {
  for (const k of candidates) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  for (const k of Object.keys(data)) {
    const lower = k.toLowerCase();
    if (
      candidates.some(
        (c) => lower === c || lower.startsWith(c + "_") || lower === c.replace(/_/g, ""),
      )
    ) {
      const v = data[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return "";
}

export function ModulePage() {
  const { slug = "" } = useParams();
  const { title: pageTitle } = useOutletContext<{ title?: string }>() ?? {};
  const [searchParams, setSearchParams] = useSearchParams();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [isNewEntry, setIsNewEntry] = useState(false);
  const [selectOptions, setSelectOptions] = useState<Record<string, string[]>>({});
  const [fieldDefs, setFieldDefs] = useState<FieldDef[]>([]);

  useEffect(() => {
    api<ModuleInfo[]>("/api/v1/modules")
      .then((mods) => {
        const mod = mods.find((m) => m.slug === slug);
        if (mod?.fieldDefinitions) {
          setFieldDefs(mod.fieldDefinitions);
          const opts: Record<string, string[]> = {};
          for (const f of mod.fieldDefinitions) {
            if (f.type === "select" && f.options?.length) {
              opts[f.key] = f.options;
            }
          }
          setSelectOptions(opts);
        }
      })
      .catch(() => {});
  }, [slug]);

  function reload() {
    setLoading(true);
    api<Entry[]>(`/api/v1/entries/${slug}`)
      .then((rows) => {
        const deleted = getDeletedIds(slug);
        const inactive = getInactiveIds(slug);
        setEntries(
          rows
            .filter((r) => !deleted.has(r.id))
            .map((r) => (inactive.has(r.id) ? { ...r, status: "inactive" } : r)),
        );
        setLoading(false);
      })
      .catch(() => {
        setEntries([]);
        setLoading(false);
      });
  }

  async function deleteEntry(e: Entry) {
    const label = pickField(e.data as Record<string, unknown>, TITLE_KEYS) || "this entry";
    const ok = window.confirm(`Delete "${label}"? This action cannot be undone.`);
    if (!ok) return;
    try {
      await api(`/api/v1/entries/${slug}/${e.id}`, { method: "DELETE" });
      markEntryDeleted(slug, e.id);
      setEntries((prev) => prev.filter((row) => row.id !== e.id));
    } catch (err) {
      window.alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function createNewEntry() {
    const emptyData: Record<string, unknown> = {};
    const now = new Date().toISOString();
    const typeByKey = Object.fromEntries((fieldDefs ?? []).map((f) => [f.key, f.type]));
    // Seed the field shape from an existing row's keys, but never copy its
    // values — a new entry must start blank. (Dates default to now.)
    if (entries[0] && slug !== "escalation_rules") {
      for (const k of Object.keys(entries[0].data as Record<string, unknown>)) {
        if (typeByKey[k] === "file") {
          emptyData[k] = null;
        } else if (DATE_KEY_RE.test(k)) {
          emptyData[k] = now;
        } else {
          emptyData[k] = "";
        }
      }
    } else if (slug !== "escalation_rules" && (fieldDefs?.length ?? 0) > 0) {
      // Empty module: no existing row to derive the shape from, so seed blank
      // fields straight from the schema — otherwise the first entry can't be created.
      for (const f of fieldDefs!) {
        const keys = f.localized ? [`${f.key}_en`, `${f.key}_ar`] : [f.key];
        for (const k of keys) {
          if (f.type === "file") emptyData[k] = null;
          else if (f.type === "hours" || HOURS_KEY_RE.test(k)) emptyData[k] = [];
          else if (f.type === "date" || DATE_KEY_RE.test(k)) emptyData[k] = now;
          else emptyData[k] = "";
        }
      }
    }
    const placeholder: Entry = {
      id: "",
      data: emptyData,
      status: "active",
      updatedAt: now,
    };
    setIsNewEntry(true);
    setEditing(placeholder);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const targetId = searchParams.get("entry");
    if (!targetId || loading) return;
    const match = entries.find((e) => e.id === targetId);
    if (match) {
      setEditing(match);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("entry");
          return next;
        },
        { replace: true },
      );
    }
  }, [entries, loading, searchParams, setSearchParams]);

  const keys = useMemo(
    () => (entries[0] ? orderKeys(Object.keys(entries[0].data)) : []),
    [entries],
  );

  const langGroups = useMemo(() => groupLangKeys(keys), [keys]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      const v = (e.data as Record<string, unknown>).category;
      if (typeof v === "string" && v.trim()) set.add(v.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const deleteCategory = useCallback(
    async (name: string): Promise<boolean> => {
      const affected = entries.filter((e) => (e.data as Record<string, unknown>).category === name);
      const others = affected.filter((e) => e.id !== editing?.id);
      const ok = window.confirm(
        others.length > 0
          ? `Delete category "${name}"? This will clear the category on ${others.length} other ${others.length === 1 ? "entry" : "entries"}.`
          : `Delete category "${name}"?`,
      );
      if (!ok) return false;
      try {
        await Promise.all(
          others.map((e) =>
            api(`/api/v1/entries/${slug}/${e.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                data: { ...(e.data as object), category: "" },
                changeSummary: `delete category "${name}"`,
              }),
            }),
          ),
        );
        setEntries((prev) =>
          prev.map((e) =>
            (e.data as Record<string, unknown>).category === name && e.id !== editing?.id
              ? { ...e, data: { ...(e.data as object), category: "" } }
              : e,
          ),
        );
        return true;
      } catch (err) {
        window.alert(
          `Failed to delete category: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },
    [entries, editing?.id, slug],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const haystack = (v: unknown): string => {
      if (v == null) return "";
      if (typeof v === "object") {
        if ("filename" in (v as object)) {
          return String((v as FileValue).filename ?? "");
        }
        return JSON.stringify(v);
      }
      return String(v);
    };
    return entries.filter((e) =>
      Object.values(e.data).some((v) => haystack(v).toLowerCase().includes(q)),
    );
  }, [entries, query]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] sm:text-[24px] font-semibold tracking-[-0.02em] text-apple-text">
            {pageTitle || slug.replace(/[-_]/g, " ")}
          </h1>
          <p className="text-[13px] text-apple-secondary mt-0.5">
            {loading
              ? "Loading..."
              : query.trim()
                ? `${filtered.length} matching of ${entries.length}`
                : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:flex-none">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-apple-tertiary">
              <Icon name="search" size={14} />
            </span>
            <input
              className="input-apple !py-2 !pl-9 !pr-3 w-full sm:w-64"
              placeholder="Filter entries..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn-primary shrink-0" onClick={createNewEntry}>
            <Icon name="plus" size={15} />
            <span className="hidden sm:inline">New entry</span>
          </button>
        </div>
      </div>

      {PROMOTIONS_SLUGS.has(slug) ? (
        <div className="space-y-3">
          {filtered.map((e) => (
            <PromotionCard
              key={e.id}
              entry={e}
              onEdit={() => setEditing(e)}
              onDelete={() => deleteEntry(e)}
            />
          ))}
          {!loading && filtered.length === 0 && (
            <div className="card p-10 text-center text-apple-tertiary text-[13px]">
              {entries.length === 0
                ? "No promotions yet. Add one via Brain Chat."
                : "No matches for your filter."}
            </div>
          )}
        </div>
      ) : slug === "escalation_rules" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((e) => (
            <EscalationRuleCard
              key={e.id}
              entry={e}
              onEdit={() => setEditing(e)}
              onDelete={() => deleteEntry(e)}
            />
          ))}
          {!loading && filtered.length === 0 && (
            <div className="card p-10 text-center text-apple-tertiary text-[13px] col-span-full">
              {entries.length === 0
                ? "No escalation rules yet. Add one via Brain Chat."
                : "No matches for your filter."}
            </div>
          )}
        </div>
      ) : (
        <EntryTable
          entries={filtered}
          totalCount={entries.length}
          loading={loading}
          langGroups={langGroups}
          onEdit={(e) => setEditing(e)}
        />
      )}

      {editing &&
        (slug === "escalation_rules" ? (
          <EscalationRuleEditModal
            slug={slug}
            entry={editing}
            isNew={isNewEntry}
            channelOptions={selectOptions.channel ?? ["human_chat", "whatsapp"]}
            onClose={() => {
              setEditing(null);
              setIsNewEntry(false);
            }}
            onSaved={() => {
              setEditing(null);
              setIsNewEntry(false);
              reload();
            }}
            onDelete={() => deleteEntry(editing)}
          />
        ) : (
          <EditEntryModal
            slug={slug}
            entry={editing}
            isNew={isNewEntry}
            selectOptions={selectOptions}
            fieldDefinitions={fieldDefs}
            categoryOptions={categoryOptions}
            onDeleteCategory={deleteCategory}
            onClose={() => {
              setEditing(null);
              setIsNewEntry(false);
            }}
            onSaved={() => {
              setEditing(null);
              setIsNewEntry(false);
              reload();
            }}
            onDelete={() => deleteEntry(editing)}
          />
        ))}
    </div>
  );
}

function PromotionCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: Entry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const d = entry.data as Record<string, unknown>;
  const title = pickField(d, TITLE_KEYS) || "(untitled offer)";
  const type = pickField(d, TYPE_KEYS);
  const startRaw = pickField(d, START_KEYS);
  const endRaw = pickField(d, END_KEYS);
  const messageEn = pickField(d, MSG_EN_KEYS);
  const messageAr = pickField(d, MSG_AR_KEYS);

  const now = Date.now();
  const endMs = endRaw ? new Date(endRaw).getTime() : NaN;
  const startMs = startRaw ? new Date(startRaw).getTime() : NaN;
  const arrowTone =
    !isNaN(endMs) && endMs < now
      ? "text-apple-red"
      : !isNaN(startMs) && startMs > now
        ? "text-pair"
        : "text-apple-secondary";

  return (
    <article className="card p-4 sm:p-5 hover:shadow-apple transition-shadow">
      <header className="flex items-start gap-2 sm:gap-3 flex-wrap">
        <h2 className="text-[15px] sm:text-[16px] font-semibold tracking-tight text-apple-text flex-1 min-w-0">
          {title}
        </h2>
        {type && <span className="badge badge-blue shrink-0">{type}</span>}
        <span className={`badge ${badgeFor(entry.status)} shrink-0`}>{entry.status}</span>
      </header>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between mt-2.5 gap-2 text-[12px]">
        <div className="inline-flex items-center gap-1.5 text-apple-secondary">
          <Icon name="calendar-check" size={12} />
          <span className="tabular-nums">{startRaw ? formatDate(startRaw) : "-"}</span>
          <span className={arrowTone}>→</span>
          <span className="tabular-nums">{endRaw ? formatDate(endRaw) : "-"}</span>
        </div>
        <div className="inline-flex items-center gap-1">
          <button
            onClick={onEdit}
            className="btn-ghost !px-2 !py-1 !text-[12px]"
            aria-label="Edit promotion"
            title="Edit"
          >
            <Icon name="pencil" size={12} />
            Edit
          </button>
          <button
            onClick={onDelete}
            className="btn-ghost !px-2 !py-1 !text-[12px] text-apple-red hover:!bg-red-50 hover:!text-red-700"
            aria-label="Delete promotion"
            title="Delete"
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </div>

      {(messageEn || messageAr) && (
        <BilingualText
          en={messageEn}
          ar={messageAr}
          className="mt-4 border-t border-apple-separator-light pt-4"
        />
      )}
    </article>
  );
}

function isBoolish(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "false" || s === "yes" || s === "no";
}

function boolValue(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes";
}

type Column = {
  key: string;
  label: string;
  shape: "id" | "bool" | "date" | "url" | "hours" | "bilingual" | "text";
  primary: boolean;
  enKey?: string | null;
  arKey?: string | null;
  dataKey?: string;
};

const HIDDEN_TABLE_KEYS = new Set([
  "governorate",
  "hours_ramadan",
  "status",
  "intent_id",
  "requires_crm",
  "revenue_opportunity",
  "escalation_check",
  "category",
]);

function deriveColumns(entries: Entry[], langGroups: LangGroup[]): Column[] {
  const cols: Column[] = [];
  const consumed = new Set<string>();

  let primaryAssigned = false;

  for (const g of langGroups) {
    if (g.kind === "pair") {
      if (consumed.has(g.enKey ?? "") || consumed.has(g.arKey ?? "")) continue;
      if (HIDDEN_TABLE_KEYS.has(g.base)) continue;
      const isPrimary = !primaryAssigned;
      if (isPrimary) primaryAssigned = true;
      cols.push({
        key: `pair:${g.base}`,
        label: humanizeKey(g.base),
        shape: "bilingual",
        primary: isPrimary,
        enKey: g.enKey,
        arKey: g.arKey,
      });
    } else {
      if (consumed.has(g.key)) continue;
      if (HIDDEN_TABLE_KEYS.has(g.key)) continue;
      const samples = entries
        .map((e) => (e.data as Record<string, unknown>)[g.key])
        .filter((v) => v !== undefined && v !== null && v !== "");
      const sample = samples[0];
      let shape: Column["shape"] = "text";
      if (samples.length > 0 && samples.every(isBoolish)) shape = "bool";
      else if (DATE_KEY_RE.test(g.key) || (typeof sample === "string" && ISO_DATE_RE.test(sample)))
        shape = "date";
      else if (HOURS_KEY_RE.test(g.key)) shape = "hours";
      else if (typeof sample === "string" && /^https?:\/\//.test(sample)) shape = "url";
      else if (
        samples.length > 0 &&
        samples.every(
          (v) =>
            typeof v === "string" && (v as string).length <= 24 && !(v as string).includes("\n"),
        )
      )
        shape = "id";

      const isPrimary = !primaryAssigned && shape === "text";
      if (isPrimary) primaryAssigned = true;

      cols.push({
        key: `single:${g.key}`,
        label: humanizeKey(g.key),
        shape,
        primary: isPrimary,
        dataKey: g.key,
      });
    }
  }

  return cols;
}

function BoolPill({ v }: { v: unknown }) {
  const t = boolValue(v);
  return <span className={`badge ${t ? "badge-green" : "badge-gray"}`}>{t ? "Yes" : "No"}</span>;
}

function BilingualCell({ enRaw, arRaw }: { enRaw: string; arRaw: string }) {
  const enClean = stripIcons(enRaw);
  const arClean = stripIcons(arRaw);
  if (!enClean && !arClean) return <span className="text-apple-tertiary">-</span>;
  const showAr = !enClean;
  const primary = enClean || arClean;
  const tooltip = [enClean, arClean].filter(Boolean).join("\n\n");
  return (
    <div className="flex items-center gap-2 max-w-[340px]">
      <div
        dir={showAr ? "rtl" : "ltr"}
        title={tooltip}
        className={`text-[13px] text-apple-text truncate flex-1 ${
          showAr ? "font-arabic text-right" : "text-left"
        }`}
      >
        {primary}
      </div>
    </div>
  );
}

function FileCell({ value }: { value: FileValue | null }) {
  if (!value || (!value.filename && !value.mediaId)) {
    return <span className="text-apple-tertiary">-</span>;
  }
  if (!value.mediaId) {
    return (
      <span
        className="text-[13px] text-apple-text truncate inline-block max-w-[220px]"
        title={value.filename}
      >
        {value.filename}
      </span>
    );
  }
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const data = await api<{ url: string }>(`/api/v1/media/${value.mediaId}/url`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      className="text-[13px] text-pair hover:underline truncate inline-block max-w-[220px] text-left"
      title={value.filename}
    >
      {value.filename || "Open file"}
    </button>
  );
}

function ShapeCell({ col, d }: { col: Column; d: Record<string, unknown> }) {
  if (col.shape === "bilingual") {
    const en = col.enKey ? String(d[col.enKey] ?? "") : "";
    const ar = col.arKey ? String(d[col.arKey] ?? "") : "";
    return <BilingualCell enRaw={en} arRaw={ar} />;
  }
  const raw = col.dataKey ? d[col.dataKey] : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return <span className="text-apple-tertiary">-</span>;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "filename" in (raw as object)) {
    return <FileCell value={parseFileValue(raw)} />;
  }
  const s = String(raw);
  switch (col.shape) {
    case "bool":
      return <BoolPill v={raw} />;
    case "date":
      return (
        <span className="text-[13px] text-apple-text tabular-nums whitespace-nowrap">
          {formatDate(s)}
        </span>
      );
    case "url": {
      const short = s
        .replace(/^https?:\/\/(www\.)?/, "")
        .split("/")
        .slice(0, 2)
        .join("/");
      return (
        <a
          href={s}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[13px] text-pair hover:underline truncate inline-block max-w-[220px]"
          title={s}
        >
          {short}
        </a>
      );
    }
    case "hours": {
      const entries = parseHoursValue(raw);
      if (entries.length === 0) return <span className="text-apple-tertiary">-</span>;
      return (
        <div
          className="text-[13px] text-apple-text whitespace-nowrap"
          title={entries.map((e) => `${e.days}: ${e.time}`).join("\n")}
        >
          {entries.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="font-medium">{entry.days}</span>
              <span className="text-apple-secondary tabular-nums">{entry.time}</span>
            </div>
          ))}
        </div>
      );
    }
    case "id":
      return (
        <span className="text-[13px] text-apple-text tabular-nums whitespace-nowrap">
          {stripIcons(s)}
        </span>
      );
    default: {
      const v = displayValue(col.dataKey!, s);
      const isAr = ARABIC_RE.test(v);
      return (
        <div
          dir={isAr ? "rtl" : "ltr"}
          title={v}
          className={`text-[13px] text-apple-text truncate max-w-[340px] ${
            isAr ? "font-arabic text-right" : "text-left"
          }`}
        >
          {v}
        </div>
      );
    }
  }
}

function EntryTable({
  entries,
  totalCount,
  loading,
  langGroups,
  onEdit,
}: {
  entries: Entry[];
  totalCount: number;
  loading: boolean;
  langGroups: LangGroup[];
  onEdit: (e: Entry) => void;
}) {
  const cols = useMemo(() => deriveColumns(entries, langGroups), [entries, langGroups]);

  if (!loading && entries.length === 0) {
    return (
      <div className="card p-10 text-center text-apple-tertiary text-[13px]">
        {totalCount === 0
          ? "No entries yet. Add one via Brain Chat."
          : "No matches for your filter."}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-apple-separator-light bg-[#FBFBFD]">
              {cols[0] && (
                <th
                  key={cols[0].key}
                  scope="col"
                  className={`px-3 py-2.5 text-[11px] uppercase tracking-[0.06em] font-medium text-apple-tertiary whitespace-nowrap ${
                    cols[0].primary ? "" : "hidden lg:table-cell"
                  } ${cols[0].shape === "bool" ? "text-center" : ""}`}
                >
                  {cols[0].label}
                </th>
              )}
              {cols.slice(1).map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`px-3 py-2.5 text-[11px] uppercase tracking-[0.06em] font-medium text-apple-tertiary whitespace-nowrap ${
                    c.primary ? "" : "hidden lg:table-cell"
                  } ${c.shape === "bool" ? "text-center" : ""}`}
                >
                  {c.label}
                </th>
              ))}
              <th
                scope="col"
                className="px-3 py-2.5 text-[11px] uppercase tracking-[0.06em] font-medium text-apple-tertiary whitespace-nowrap w-[1%] text-right"
              >
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const d = e.data as Record<string, unknown>;
              return (
                <tr
                  key={e.id}
                  onClick={() => onEdit(e)}
                  className="border-b border-apple-separator-light last:border-0 hover:bg-[#F9F9F9] cursor-pointer transition-colors"
                >
                  {cols[0] && (
                    <td
                      key={cols[0].key}
                      className={`px-3 py-3 align-middle ${cols[0].primary ? "" : "hidden lg:table-cell"} ${
                        cols[0].shape === "bool" ? "text-center" : ""
                      }`}
                    >
                      <ShapeCell col={cols[0]} d={d} />
                    </td>
                  )}
                  {cols.slice(1).map((c) => (
                    <td
                      key={c.key}
                      className={`px-3 py-3 align-middle ${c.primary ? "" : "hidden lg:table-cell"} ${
                        c.shape === "bool" ? "text-center" : ""
                      }`}
                    >
                      <ShapeCell col={c} d={d} />
                    </td>
                  ))}
                  <td className="px-3 py-3 align-middle whitespace-nowrap text-right">
                    <span className={`badge ${badgeFor(e.status)}`}>{e.status || "active"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CollapsibleTextarea({
  value,
  onChange,
  isAr,
  label,
}: {
  value: string;
  onChange: (val: string) => void;
  isAr: boolean;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const autoSize = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    node.style.height = "auto";
    node.style.height = node.scrollHeight + 2 + "px";
  }, []);
  const textareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      if (node && expanded) {
        autoSize(node);
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      }
    },
    [expanded, autoSize],
  );

  const preview = value.length > 120 ? value.slice(0, 120) + "..." : value;
  const lines = value.split("\n");
  const isCollapsible = value.length > 120 || lines.length > 3;

  if (!isCollapsible) {
    return (
      <textarea
        rows={3}
        dir={isAr ? "rtl" : "ltr"}
        className={`input-apple resize-y min-h-[72px] leading-relaxed ${isAr ? "font-arabic text-right" : "text-left"}`}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
      />
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        dir={isAr ? "rtl" : "ltr"}
        className={`input-apple text-left cursor-pointer hover:border-[#D0D0D0] group w-full ${isAr ? "font-arabic !text-right" : ""}`}
      >
        <div
          className={`text-[13px] leading-relaxed text-apple-text line-clamp-2 whitespace-pre-line ${isAr ? "text-right" : "text-left"}`}
        >
          {preview}
        </div>
        <div className="text-[11px] font-medium text-pair mt-1.5 group-hover:underline">
          Show full {label.toLowerCase()}
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <textarea
        ref={textareaRef}
        dir={isAr ? "rtl" : "ltr"}
        className={`input-apple resize-none leading-relaxed overflow-hidden ${isAr ? "font-arabic text-right" : "text-left"}`}
        value={value}
        onChange={(ev) => {
          onChange(ev.target.value);
          autoSize(ev.target);
        }}
      />
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="text-[11px] font-medium text-apple-secondary hover:text-pair transition-colors"
      >
        Collapse
      </button>
    </div>
  );
}

function CategoryCombobox({
  value,
  options,
  onChange,
  onDeleteOption,
}: {
  value: string;
  options: string[];
  onChange: (val: string) => void;
  onDeleteOption?: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [localExtra, setLocalExtra] = useState<string[]>([]);
  const [dropUp, setDropUp] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const allOptions = useMemo(() => {
    const set = new Set<string>([...options, ...localExtra]);
    if (value.trim()) set.add(value.trim());
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [options, localExtra, value]);

  const trimmed = search.trim();
  const filtered = trimmed
    ? allOptions.filter((o) => o.toLowerCase().includes(trimmed.toLowerCase()))
    : allOptions;
  const canAdd = !!trimmed && !allOptions.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  function toggleOpen() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 320 && rect.top > spaceBelow);
    }
    setOpen((v) => !v);
    if (open) setSearch("");
  }

  function commit(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!allOptions.some((o) => o.toLowerCase() === name.toLowerCase())) {
      setLocalExtra((prev) => [...prev, name]);
    }
    onChange(name);
    setOpen(false);
    setSearch("");
  }

  async function handleDelete(name: string) {
    if (!onDeleteOption) return;
    const ok = await onDeleteOption(name);
    if (!ok) return;
    setLocalExtra((prev) => prev.filter((o) => o !== name));
    if (value === name) onChange("");
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="input-apple w-full cursor-pointer text-left flex items-center justify-between gap-2"
      >
        <span className={`truncate ${value ? "text-apple-text" : "text-apple-tertiary"}`}>
          {value || "Select or add a category..."}
        </span>
        <span
          className={`shrink-0 text-apple-tertiary transition-transform ${open ? "rotate-180" : ""}`}
        >
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {open && (
        <div
          className={`absolute z-30 w-full rounded-apple border border-apple-separator-light bg-white shadow-apple-lg overflow-hidden ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div className="p-2 border-b border-apple-separator-light">
            <input
              ref={inputRef}
              type="text"
              className="input-apple !py-1.5 !text-[13px]"
              placeholder="Search or type to add..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (trimmed) commit(trimmed);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                  setSearch("");
                }
              }}
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {canAdd && (
              <button
                type="button"
                onClick={() => commit(trimmed)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-pair hover:bg-[#F5F8FF]"
              >
                <Icon name="plus" size={13} />
                <span className="truncate">Add &ldquo;{trimmed}&rdquo;</span>
              </button>
            )}
            {filtered.length === 0 && !canAdd && (
              <div className="px-3 py-4 text-center text-[12px] text-apple-tertiary">
                No categories yet. Type above to add one.
              </div>
            )}
            {filtered.map((opt) => (
              <div
                key={opt}
                role="option"
                aria-selected={opt === value}
                tabIndex={0}
                onClick={() => commit(opt)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    commit(opt);
                  }
                }}
                className={`group flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-[#F2F2F5] ${
                  opt === value ? "bg-[#F5F8FF]" : ""
                }`}
              >
                <span className="flex-1 truncate text-[13px] text-apple-text flex items-center gap-2">
                  <span className="truncate">{opt}</span>
                  {opt === value && (
                    <span className="shrink-0 text-pair">
                      <Icon name="check" size={12} />
                    </span>
                  )}
                </span>
                {onDeleteOption && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(opt);
                    }}
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-apple-tertiary opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50 transition-opacity"
                    title={`Delete "${opt}"`}
                    aria-label={`Delete category ${opt}`}
                  >
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Turn a save error into something a human can read. Server validation errors
 * arrive as a JSON-stringified Zod issue array; map each issue to its field
 * label. Anything else passes through as-is.
 */
function humanizeSaveError(err: unknown, labelFor: (k: string) => string): string {
  const raw = err instanceof Error ? err.message : "Failed to save";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map((issue) => {
          const key =
            Array.isArray(issue?.path) && issue.path.length > 0 ? String(issue.path[0]) : "";
          const label = key ? labelFor(key) : "";
          return label ? `${label}: ${issue.message}` : issue.message;
        })
        .join("; ");
    }
  } catch {
    // not JSON — fall through to raw
  }
  return raw;
}

function EditEntryModal({
  slug,
  entry,
  isNew,
  selectOptions,
  fieldDefinitions,
  categoryOptions,
  onDeleteCategory,
  onClose,
  onSaved,
  onDelete,
}: {
  slug: string;
  entry: Entry;
  isNew?: boolean;
  selectOptions?: Record<string, string[]>;
  fieldDefinitions?: FieldDef[];
  categoryOptions?: string[];
  onDeleteCategory?: (name: string) => Promise<boolean>;
  onClose: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const initialKeys = useMemo(
    () => orderKeys(Object.keys(entry.data).filter((k) => !HIDDEN_EDIT_KEYS.has(k))),
    [entry],
  );

  const requiredKeys = useMemo(() => {
    const s = new Set<string>();
    for (const f of fieldDefinitions ?? []) {
      if (!f.required) continue;
      if (f.localized) {
        s.add(`${f.key}_en`);
        s.add(`${f.key}_ar`);
      } else {
        s.add(f.key);
      }
    }
    return s;
  }, [fieldDefinitions]);

  const baseLabel = useMemo(() => {
    const map: Record<string, string> = {};
    if (fieldDefinitions) {
      for (const f of fieldDefinitions) {
        if (f.localized) {
          map[`${f.key}_en`] = `${f.label} (English)`;
          map[`${f.key}_ar`] = `${f.label} (Arabic)`;
        } else {
          map[f.key] = f.label;
        }
      }
    }
    return (k: string) => map[k] ?? humanizeKey(k);
  }, [fieldDefinitions]);

  const getLabel = useMemo(
    () => (k: string) => baseLabel(k) + (requiredKeys.has(k) ? " *" : ""),
    [baseLabel, requiredKeys],
  );
  const fieldTypeMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of fieldDefinitions ?? []) m[f.key] = f.type;
    return m;
  }, [fieldDefinitions]);
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      initialKeys.map((k) => {
        const rawVal = entry.data[k];
        if (HOURS_KEY_RE.test(k)) {
          return [k, parseHoursValue(rawVal)];
        }
        if (fieldTypeMap[k] === "file") {
          return [k, parseFileValue(rawVal)];
        }
        const raw = String(rawVal ?? "");
        if (DATE_KEY_RE.test(k) || ISO_DATE_RE.test(raw)) return [k, raw];
        return [k, stripIcons(raw)];
      }),
    ),
  );
  const [active, setActive] = useState<boolean>(
    (entry.status ?? "active").toLowerCase() !== "inactive",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.data)) {
      if (HIDDEN_EDIT_KEYS.has(k)) data[k] = v;
    }
    for (const k of initialKeys) {
      if (HOURS_KEY_RE.test(k)) {
        const entries = (draft[k] as HoursEntry[] | undefined) ?? [];
        data[k] = entries.filter((e) => e.days.trim() || e.time.trim());
        continue;
      }
      if (fieldTypeMap[k] === "file") {
        data[k] = draft[k] ?? null;
        continue;
      }
      const v = String(draft[k] ?? "");
      const fieldType = fieldTypeMap[k] ?? fieldTypeMap[k.replace(/_(en|ar)$/, "")];
      if (fieldType === "number") {
        if (v.trim() === "") continue; // omit empty optional number; server enforces required
        const n = Number(v);
        data[k] = Number.isNaN(n) ? v : n;
      } else if (DATE_KEY_RE.test(k) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        data[k] = `${v}T00:00:00.000Z`;
      } else {
        data[k] = v;
      }
    }

    // Client-side required check: fail fast with a readable message.
    const missing = [...requiredKeys].filter((k) => {
      const val = data[k];
      if (val == null) return true;
      if (typeof val === "string") return val.trim() === "";
      if (Array.isArray(val)) return val.length === 0;
      if (typeof val === "object") return !(val as FileValue).mediaId;
      return false;
    });
    if (missing.length) {
      setError(`Please fill in: ${missing.map((k) => baseLabel(k)).join(", ")}`);
      setBusy(false);
      return;
    }

    try {
      if (isNew) {
        await api(`/api/v1/entries/${slug}`, {
          method: "POST",
          body: JSON.stringify({ data }),
        });
      } else {
        await api(`/api/v1/entries/${slug}/${entry.id}`, {
          method: "PATCH",
          body: JSON.stringify({ data, changeSummary: "manual edit" }),
        });
        setEntryActive(slug, entry.id, active);
      }
      onSaved();
    } catch (err) {
      setError(humanizeSaveError(err, baseLabel));
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit entry"
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-sm p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card w-full max-w-2xl max-h-[92vh] sm:max-h-[88vh] flex flex-col animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-3.5 border-b border-apple-separator-light">
          <div className="min-w-0 flex-1 mr-3">
            <div className="text-[15px] font-semibold text-apple-text">
              {isNew ? "New entry" : "Edit entry"}
            </div>
            {!isNew && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(entry.id)}
                className="text-[10px] text-apple-tertiary mt-0.5 font-mono hover:text-apple-secondary transition-colors opacity-60 hover:opacity-100"
                title="Click to copy ID"
              >
                {entry.id.slice(0, 6)}
              </button>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost !px-2 !py-1.5 shrink-0" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!isNew && (
            <div className="flex items-center justify-between rounded-apple border border-apple-separator-light bg-[#FAFAFA] px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-apple-text">
                  {active ? "Active" : "Inactive"}
                </div>
                <div className="text-[11px] text-apple-tertiary">
                  {active ? "Visible to customers" : "Hidden from customers until reactivated"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-label={active ? "Deactivate entry" : "Activate entry"}
                onClick={() => setActive((v) => !v)}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
                  active ? "bg-pair" : "bg-[#E5E5EA]"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    active ? "translate-x-[18px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          )}
          {(() => {
            const elements: React.ReactNode[] = [];
            let i = 0;

            const isShortField = (key: string) => {
              if (key === "category") return false;
              return !!selectOptions?.[key];
            };

            const renderField = (key: string) => {
              const rawVal = draft[key] ?? "";
              if (key === "category") {
                const val = String(rawVal);
                return (
                  <div key={key}>
                    <label className="label">{getLabel(key)}</label>
                    <CategoryCombobox
                      value={val}
                      options={categoryOptions ?? []}
                      onChange={(v) => setDraft({ ...draft, [key]: v })}
                      onDeleteOption={onDeleteCategory}
                    />
                  </div>
                );
              }
              const opts = selectOptions?.[key];

              if (fieldTypeMap[key] === "file") {
                const fileVal = parseFileValue(rawVal);
                return (
                  <div key={key}>
                    <label className="label">{getLabel(key)}</label>
                    <FileFieldInput
                      value={fileVal}
                      onChange={(v) => setDraft({ ...draft, [key]: v })}
                    />
                  </div>
                );
              }

              if (HOURS_KEY_RE.test(key)) {
                const entries = (rawVal as HoursEntry[] | undefined) ?? [];
                const updateEntry = (idx: number, field: "days" | "time", value: string) => {
                  const updated = entries.map((e, i) => (i === idx ? { ...e, [field]: value } : e));
                  setDraft({ ...draft, [key]: updated });
                };
                const addEntry = () =>
                  setDraft({ ...draft, [key]: [...entries, { days: "", time: "" }] });
                const removeEntry = (idx: number) =>
                  setDraft({ ...draft, [key]: entries.filter((_, i) => i !== idx) });
                return (
                  <div key={key}>
                    <label className="label">{getLabel(key)}</label>
                    <div className="space-y-2">
                      {entries.map((entry, idx) => {
                        const dayPicks = parseDaySelection(entry.days);
                        const allDays = dayPicks.every((v) => v);
                        const shifts = parseShifts(entry.time);
                        const toggleDay = (i: number) => {
                          const next = [...dayPicks];
                          next[i] = !next[i];
                          updateEntry(idx, "days", formatDaySelection(next));
                        };
                        const toggleDaily = () => {
                          updateEntry(idx, "days", allDays ? "" : "Daily");
                        };
                        const updateShift = (shiftIdx: number, pos: 0 | 1, value: string) => {
                          const next: Array<[string, string]> = shifts.map((s, i) =>
                            i === shiftIdx
                              ? ((pos === 0 ? [value, s[1]] : [s[0], value]) as [string, string])
                              : s,
                          );
                          updateEntry(idx, "time", formatShifts(next));
                        };
                        const addShift = () => {
                          const next: Array<[string, string]> = [...shifts, ["", ""]];
                          updateEntry(idx, "time", formatShifts(next));
                        };
                        const removeShift = (shiftIdx: number) => {
                          const next = shifts.filter((_, i) => i !== shiftIdx);
                          updateEntry(idx, "time", formatShifts(next.length ? next : [["", ""]]));
                        };
                        return (
                          <div
                            key={idx}
                            className="rounded-apple border border-apple-separator-light bg-[#FAFAFA] p-2.5"
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex-1 min-w-0 space-y-2">
                                <div className="flex items-center gap-1 flex-wrap">
                                  {DAY_SHORT.map((lbl, i) => (
                                    <button
                                      key={i}
                                      type="button"
                                      onClick={() => toggleDay(i)}
                                      aria-label={DAY_LABELS[i]}
                                      aria-pressed={dayPicks[i]}
                                      className={`w-8 h-8 rounded-full text-[11px] font-medium transition-colors ${
                                        dayPicks[i]
                                          ? "bg-pair text-white"
                                          : "bg-white border border-[#E8E8E8] text-apple-secondary hover:bg-[#F2F2F5]"
                                      }`}
                                    >
                                      {lbl}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={toggleDaily}
                                    aria-pressed={allDays}
                                    className={`ml-1 px-3 h-8 rounded-full text-[11px] font-medium transition-colors ${
                                      allDays
                                        ? "bg-pair text-white"
                                        : "bg-white border border-[#E8E8E8] text-apple-secondary hover:bg-[#F2F2F5]"
                                    }`}
                                  >
                                    Daily
                                  </button>
                                </div>
                                <div className="space-y-1.5">
                                  {shifts.map(([open, close], shiftIdx) => (
                                    <div key={shiftIdx} className="flex items-center gap-1.5">
                                      <select
                                        className="input-apple flex-1 min-w-0 text-[13px] cursor-pointer !py-1.5"
                                        value={open}
                                        onChange={(ev) => updateShift(shiftIdx, 0, ev.target.value)}
                                        aria-label="Opens"
                                      >
                                        <option value="">Opens</option>
                                        {TIME_OPTIONS.map((t) => (
                                          <option key={t} value={t}>
                                            {t}
                                          </option>
                                        ))}
                                      </select>
                                      <span className="text-[11px] text-apple-tertiary shrink-0">
                                        to
                                      </span>
                                      <select
                                        className="input-apple flex-1 min-w-0 text-[13px] cursor-pointer !py-1.5"
                                        value={close}
                                        onChange={(ev) => updateShift(shiftIdx, 1, ev.target.value)}
                                        aria-label="Closes"
                                      >
                                        <option value="">Closes</option>
                                        {TIME_OPTIONS.map((t) => (
                                          <option key={t} value={t}>
                                            {t}
                                          </option>
                                        ))}
                                      </select>
                                      {shifts.length > 1 && (
                                        <button
                                          type="button"
                                          onClick={() => removeShift(shiftIdx)}
                                          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-apple-tertiary hover:text-red-500 hover:bg-red-50 transition-colors"
                                          title="Remove shift"
                                        >
                                          <svg
                                            className="w-3 h-3"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M6 18L18 6M6 6l12 12"
                                            />
                                          </svg>
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={addShift}
                                    className="text-[11px] text-apple-tertiary hover:text-pair"
                                  >
                                    + Add shift
                                  </button>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeEntry(idx)}
                                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-apple-tertiary hover:text-red-500 hover:bg-red-50 transition-colors"
                                title="Remove row"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={addEntry}
                        className="text-[12px] text-pair hover:underline"
                      >
                        + Add hours row
                      </button>
                    </div>
                  </div>
                );
              }

              const val = String(rawVal);
              const isLong = !opts && (val.length > 80 || val.includes("\n"));
              const isAr = ARABIC_RE.test(val);

              return (
                <div key={key}>
                  <label className="label">{getLabel(key)}</label>
                  {opts ? (
                    <select
                      className="input-apple cursor-pointer"
                      value={val}
                      onChange={(ev) => setDraft({ ...draft, [key]: ev.target.value })}
                    >
                      {!opts.includes(val) && <option value={val}>{val || "Select..."}</option>}
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : isLong ? (
                    <CollapsibleTextarea
                      value={val}
                      onChange={(v) => setDraft({ ...draft, [key]: v })}
                      isAr={isAr}
                      label={getLabel(key)}
                    />
                  ) : (
                    <input
                      type="text"
                      dir={isAr ? "rtl" : "ltr"}
                      className={`input-apple ${isAr ? "font-arabic text-right" : "text-left"}`}
                      value={val}
                      onChange={(ev) => setDraft({ ...draft, [key]: ev.target.value })}
                    />
                  )}
                </div>
              );
            };

            let prevFieldType: string | null = null;

            while (i < initialKeys.length) {
              const k = initialKeys[i]!;
              const v = draft[k] ?? "";
              const vStr = typeof v === "string" ? v : "";
              const isHoursField = HOURS_KEY_RE.test(k);
              const isDate = !isHoursField && (DATE_KEY_RE.test(k) || ISO_DATE_RE.test(vStr));
              const isShort = !isDate && !isHoursField && isShortField(k);
              const curFieldType = isDate ? "date" : isShort ? "short" : "long";

              if (prevFieldType && prevFieldType !== curFieldType) {
                elements.push(
                  <div key={`sep-${i}`} className="border-t border-apple-separator-light" />,
                );
              }

              if (isDate) {
                const dateGroup: string[] = [k];
                while (i + 1 < initialKeys.length) {
                  const nk = initialKeys[i + 1]!;
                  const nv = typeof draft[nk] === "string" ? (draft[nk] as string) : "";
                  if (DATE_KEY_RE.test(nk) || ISO_DATE_RE.test(nv)) {
                    dateGroup.push(nk);
                    i++;
                  } else break;
                }
                dateGroup.sort((a, b) => {
                  const rank = (key: string) => {
                    if (
                      START_KEYS.includes(key) ||
                      /(^|_)(start|starts|publish|begin|from)(_|$)/i.test(key)
                    )
                      return 0;
                    if (
                      END_KEYS.includes(key) ||
                      /(^|_)(end|ends|expires?|until|to)(_|$)/i.test(key)
                    )
                      return 2;
                    return 1;
                  };
                  return rank(a) - rank(b);
                });
                elements.push(
                  <div key={`dates-${dateGroup.join("-")}`} className="grid grid-cols-2 gap-3">
                    {dateGroup.map((dk) => {
                      const raw = String(draft[dk] ?? "");
                      const dateVal = toDateInput(raw);
                      const timeVal = toTimeInput(raw);
                      return (
                        <div key={dk}>
                          <label className="label">{getLabel(dk)}</label>
                          <DatePicker
                            value={dateVal}
                            timeValue={timeVal}
                            onChange={(v) =>
                              setDraft({ ...draft, [dk]: combineDateTime(v, timeVal) })
                            }
                            onTimeChange={(v) =>
                              setDraft({ ...draft, [dk]: combineDateTime(dateVal, v) })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>,
                );
              } else if (isShort) {
                const shortGroup: string[] = [k];
                while (i + 1 < initialKeys.length) {
                  const nk = initialKeys[i + 1]!;
                  if (isShortField(nk)) {
                    shortGroup.push(nk);
                    i++;
                  } else break;
                }
                if (shortGroup.length >= 2) {
                  for (let j = 0; j < shortGroup.length; j += 2) {
                    if (j + 1 < shortGroup.length) {
                      elements.push(
                        <div
                          key={`pair-${shortGroup[j]}-${shortGroup[j + 1]}`}
                          className="grid grid-cols-2 gap-3"
                        >
                          {renderField(shortGroup[j]!)}
                          {renderField(shortGroup[j + 1]!)}
                        </div>,
                      );
                    } else {
                      elements.push(renderField(shortGroup[j]!));
                    }
                  }
                } else {
                  elements.push(renderField(k));
                }
              } else {
                elements.push(renderField(k));
              }

              prevFieldType = curFieldType;
              i++;
            }
            return elements;
          })()}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 px-4 sm:px-5 py-3 sm:py-3.5 border-t border-apple-separator-light">
          <div className="flex items-center gap-3">
            {!isNew && (
              <button
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="btn-ghost !px-3 !py-2 !text-[13px] text-apple-red hover:!bg-red-50 hover:!text-red-700"
                disabled={busy}
                title="Delete entry"
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            )}
            {error && <div className="text-[12px] text-apple-red">{error}</div>}
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button onClick={onClose} className="btn-secondary flex-1 sm:flex-none" disabled={busy}>
              Cancel
            </button>
            <button onClick={save} className="btn-primary flex-1 sm:flex-none" disabled={busy}>
              {busy ? (
                <Icon name="refresh" size={15} className="animate-spin" />
              ) : (
                <Icon name="check" size={15} />
              )}
              {busy ? "Saving…" : isNew ? "Create entry" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SlaBadge({ hours }: { hours: number | null }) {
  if (hours == null) return null;
  const urgency = slaUrgency(hours);
  const label =
    hours < 1
      ? `SLA ${Math.round(hours * 60)} min`
      : `SLA ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  const cls = {
    urgent: "badge-red",
    high: "bg-amber-50 text-amber-700 border border-amber-200",
    normal: "badge-blue",
    low: "badge-gray",
    none: "badge-gray",
  }[urgency];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function EscalationRuleCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: Entry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const d = entry.data as Record<string, unknown>;
  const parsed = parseTrigger(String(d.trigger ?? ""));
  const channel = String(d.channel ?? "");
  const muted = !hasEscalationTarget(parsed);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
      className={`card p-4 sm:p-5 hover:shadow-apple transition-shadow cursor-pointer text-left min-w-0 overflow-hidden ${muted ? "opacity-75" : ""}`}
    >
      <header className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-apple-text line-clamp-2">
            {parsed.category || "(untitled rule)"}
          </h2>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className={`badge ${badgeFor(entry.status)}`}>{entry.status}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="btn-ghost !px-2 !py-1 !text-[12px] text-apple-red hover:!bg-red-50 hover:!text-red-700"
            aria-label="Delete rule"
            title="Delete"
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </header>

      {(parsed.keywords || parsed.escalationTarget || parsed.autoResponse) && (
        <div className="mt-3.5 grid gap-x-6 gap-y-2.5 grid-cols-1 sm:grid-cols-2">
          {parsed.keywords && (
            <div className="sm:col-span-2">
              <div className="text-[11px] uppercase tracking-[0.06em] font-medium text-apple-tertiary mb-1">
                Triggers
              </div>
              <div className="flex flex-wrap gap-1">
                {parsed.keywords
                  .split(/,\s*/)
                  .filter(Boolean)
                  .map((k) => (
                    <span
                      key={k}
                      className="px-2 py-0.5 rounded-full bg-apple-separator-light text-[11px] text-apple-secondary"
                    >
                      {k}
                    </span>
                  ))}
              </div>
            </div>
          )}
          {parsed.autoResponse && (
            <div className="sm:col-span-2">
              <div className="text-[11px] uppercase tracking-[0.06em] font-medium text-apple-tertiary mb-0.5">
                AI agent behavior
              </div>
              <div className="text-[13px] text-apple-text italic line-clamp-3 whitespace-pre-line">
                {parsed.autoResponse}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function TriggerChipInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const chips = useMemo(
    () =>
      value
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean),
    [value],
  );
  const [draft, setDraft] = useState("");

  const write = (next: string[]) => onChange(next.join(", "));
  const commit = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) {
      setDraft("");
      return;
    }
    const seen = new Set(chips.map((c) => c.toLowerCase()));
    const added: string[] = [];
    for (const p of parts) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      added.push(p);
    }
    if (added.length) write([...chips, ...added]);
    setDraft("");
  };

  return (
    <div className="input-apple flex flex-wrap gap-1.5 min-h-[38px] py-1.5">
      {chips.map((c, i) => (
        <span
          key={`${c}-${i}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-apple-separator-light text-[12px] text-apple-secondary"
        >
          {c}
          <button
            type="button"
            onClick={() => write(chips.filter((_, j) => j !== i))}
            className="text-apple-tertiary hover:text-apple-red"
            aria-label={`Remove ${c}`}
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) commit(v.slice(0, -1));
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && chips.length) {
            write(chips.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        onPaste={(e) => {
          const txt = e.clipboardData.getData("text");
          if (txt.includes(",")) {
            e.preventDefault();
            commit(txt);
          }
        }}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-[14px]"
        placeholder={chips.length ? "Add another…" : "Type a trigger and press Enter"}
      />
    </div>
  );
}

function EscalationRuleEditModal({
  slug,
  entry,
  isNew,
  channelOptions,
  onClose,
  onSaved,
  onDelete,
}: {
  slug: string;
  entry: Entry;
  isNew?: boolean;
  channelOptions: string[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState(() => {
    const d = entry.data as Record<string, unknown>;
    const initial = parseTrigger(String(d.trigger ?? ""));
    return {
      category: initial.category,
      keywords: initial.keywords,
      escalationTarget: initial.escalationTarget,
      slaHours: initial.slaHours == null ? "" : String(initial.slaHours),
      autoResponse: initial.autoResponse,
      channel: String(d.channel ?? "human_chat"),
      webhook_url: String(d.webhook_url ?? ""),
    };
  });
  const [active, setActive] = useState<boolean>(
    (entry.status ?? "active").toLowerCase() !== "inactive",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const slaNum = form.slaHours.trim() === "" ? null : Number(form.slaHours);
    const trigger = serializeTrigger({
      category: form.category,
      keywords: form.keywords,
      escalationTarget: form.escalationTarget,
      slaHours: Number.isFinite(slaNum) ? (slaNum as number) : null,
      autoResponse: form.autoResponse,
    });
    const data = {
      trigger,
      channel: form.channel,
      webhook_url: form.webhook_url,
    };
    try {
      if (isNew) {
        await api(`/api/v1/entries/${slug}`, {
          method: "POST",
          body: JSON.stringify({ data }),
        });
      } else {
        await api(`/api/v1/entries/${slug}/${entry.id}`, {
          method: "PATCH",
          body: JSON.stringify({ data, changeSummary: "manual edit" }),
        });
        setEntryActive(slug, entry.id, active);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setBusy(false);
    }
  }

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  const canSave = form.category.trim().length > 0 && !busy;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit escalation rule"
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-sm p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card w-full max-w-2xl max-h-[92vh] sm:max-h-[88vh] flex flex-col animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-3.5 border-b border-apple-separator-light">
          <div className="min-w-0 flex-1 mr-3">
            <div className="text-[15px] font-semibold text-apple-text">
              {isNew ? "New escalation rule" : "Edit escalation rule"}
            </div>
            {!isNew && entry.id && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(entry.id)}
                className="text-[10px] text-apple-tertiary mt-0.5 font-mono hover:text-apple-secondary transition-colors opacity-60 hover:opacity-100"
                title="Click to copy ID"
              >
                {entry.id.slice(0, 6)}
              </button>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost !px-2 !py-1.5 shrink-0" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!isNew && (
            <div className="flex items-center justify-between rounded-apple border border-apple-separator-light bg-[#FAFAFA] px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-apple-text">
                  {active ? "Active" : "Inactive"}
                </div>
                <div className="text-[11px] text-apple-tertiary">
                  {active
                    ? "Rule is live and will trigger escalations"
                    : "Rule is paused and will not trigger"}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-label={active ? "Deactivate rule" : "Activate rule"}
                onClick={() => setActive((v) => !v)}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
                  active ? "bg-pair" : "bg-[#E5E5EA]"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    active ? "translate-x-[18px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          )}
          <div>
            <label className="label">Category</label>
            <input
              type="text"
              className="input-apple"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
              placeholder="e.g. Complaint, Lost Child, Refund Request"
            />
          </div>
          <div>
            <label className="label">Triggers</label>
            <TriggerChipInput value={form.keywords} onChange={(v) => set("keywords", v)} />
          </div>
          <div className="text-[13px] text-apple-secondary">
            All rules escalate to <span className="font-medium text-apple-text">CS Team</span>
          </div>
          <div>
            <label className="label">AI agent behavior</label>
            <CollapsibleTextarea
              value={form.autoResponse}
              onChange={(v) => set("autoResponse", v)}
              isAr={false}
              label="auto response"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 px-4 sm:px-5 py-3 sm:py-3.5 border-t border-apple-separator-light">
          <div className="flex items-center gap-3">
            {!isNew && (
              <button
                onClick={() => {
                  onDelete();
                  onClose();
                }}
                className="btn-ghost !px-3 !py-2 !text-[13px] text-apple-red hover:!bg-red-50 hover:!text-red-700"
                disabled={busy}
                title="Delete rule"
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            )}
            {error && <div className="text-[12px] text-apple-red">{error}</div>}
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button onClick={onClose} className="btn-secondary flex-1 sm:flex-none" disabled={busy}>
              Cancel
            </button>
            <button onClick={save} className="btn-primary flex-1 sm:flex-none" disabled={!canSave}>
              {busy ? (
                <Icon name="refresh" size={15} className="animate-spin" />
              ) : (
                <Icon name="check" size={15} />
              )}
              {busy ? "Saving…" : isNew ? "Create rule" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
