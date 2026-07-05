import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getClaude,
  extractMetrics,
  recordClaudeCall,
  type ClaudeCallMetrics,
} from "./claude-client.js";
import { MODELS } from "./models.js";
import type { FieldDefinition } from "../../shared/src/index.js";

/**
 * Parser: user utterance + session context → structured action via Anthropic tool use.
 * Never writes to DB. Returns validated tool call + metrics.
 */

export const ParsedAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CREATE"),
    module: z.string(),
    fields: z.record(z.unknown()),
  }),
  z.object({
    action: z.literal("UPDATE"),
    module: z.string(),
    match: z.object({ entry_id: z.string().optional(), name: z.string().optional() }),
    fields: z.record(z.unknown()),
  }),
  z.object({
    action: z.literal("BULK_UPDATE"),
    module: z.string(),
    where: z.record(z.unknown()),
    set: z.record(z.unknown()),
  }),
  z.object({
    action: z.literal("DELETE"),
    module: z.string(),
    match: z.object({ entry_id: z.string().optional(), name: z.string().optional() }),
  }),
  z.object({
    action: z.literal("DUPLICATE"),
    module: z.string(),
    source: z.object({ entry_id: z.string().optional(), name: z.string().optional() }),
    changes: z.record(z.unknown()),
  }),
  z.object({
    action: z.literal("QUERY"),
    module: z.string().optional(),
    query: z.string(),
  }),
  z.object({
    action: z.literal("SCHEDULE"),
    module: z.string(),
    fields: z.record(z.unknown()),
    publish_at: z.string().datetime(),
  }),
]);
export type ParsedAction = z.infer<typeof ParsedAction>;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "emit_create",
    description: "Create a new entry in a module.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["module", "fields"],
    },
  },
  {
    name: "emit_update",
    description: "Update an existing entry. Match by name or entry_id.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        match: {
          type: "object",
          properties: { entry_id: { type: "string" }, name: { type: "string" } },
        },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["module", "match", "fields"],
    },
  },
  {
    name: "emit_bulk_update",
    description: "Apply a single change to many entries that match a filter.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        where: { type: "object", additionalProperties: true },
        set: { type: "object", additionalProperties: true },
      },
      required: ["module", "where", "set"],
    },
  },
  {
    name: "emit_delete",
    description: "Delete an entry. Requires explicit user confirmation downstream.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        match: {
          type: "object",
          properties: { entry_id: { type: "string" }, name: { type: "string" } },
        },
      },
      required: ["module", "match"],
    },
  },
  {
    name: "emit_duplicate",
    description: "Clone an existing entry and apply changes.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        source: {
          type: "object",
          properties: { entry_id: { type: "string" }, name: { type: "string" } },
        },
        changes: { type: "object", additionalProperties: true },
      },
      required: ["module", "source", "changes"],
    },
  },
  {
    name: "emit_query",
    description: "Read-only question. No preview card; just a summary answer.",
    input_schema: {
      type: "object",
      properties: { module: { type: "string" }, query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "emit_schedule",
    description: "Create an entry that publishes at publish_at.",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        publish_at: { type: "string", format: "date-time" },
      },
      required: ["module", "fields", "publish_at"],
    },
  },
];

const TOOL_TO_ACTION: Record<string, ParsedAction["action"]> = {
  emit_create: "CREATE",
  emit_update: "UPDATE",
  emit_bulk_update: "BULK_UPDATE",
  emit_delete: "DELETE",
  emit_duplicate: "DUPLICATE",
  emit_query: "QUERY",
  emit_schedule: "SCHEDULE",
};

export type ParserInput = {
  utterance: string;
  tenantId: string;
  modules: Array<{ slug: string; label: string; fields: FieldDefinition[] }>;
  recentEntriesByModule: Record<string, Array<{ id: string; name: string; data: unknown }>>;
  sessionHistory: Array<{ role: "user" | "assistant"; content: string }>;
  summary?: string;
};

export type ParserResult =
  | { ok: true; action: ParsedAction; metrics: ClaudeCallMetrics }
  | { ok: false; error: string; metrics?: ClaudeCallMetrics };

export async function parseUtterance(input: ParserInput): Promise<ParserResult> {
  const client = getClaude();
  const startedAt = Date.now();

  // Cache-heavy blocks ordered static → dynamic:
  // 1) system instructions (cached)
  // 2) module schemas (cached)
  // 3) brand glossary + FK tone (cached)
  // 4) recent entries + session summary (dynamic)
  const systemBlocks = [
    {
      type: "text",
      text: "You are The Brain, PAIR AI's knowledge-base editor. Convert the user's natural-language or transcribed-voice message into exactly ONE tool call. Never guess module names: use only the provided schemas. If the user asks a question, use emit_query. For bilingual fields, fill whichever language the user gave and leave the other empty; downstream translation will handle it. Prefer the latest matching entry for context references like 'that one' or 'the last promo'.",
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `MODULES:\n${JSON.stringify(input.modules, null, 2)}`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: "BRAND GLOSSARY (EN→AR): Flare Fitness → فلير فيتنس; branch → فرع; promotion → عرض; ride → لعبة; bank card → بطاقة بنكية. TONE: warm, concise, family-friendly. Kuwait market context.",
      cache_control: { type: "ephemeral" },
    },
  ] as unknown as Anthropic.Messages.TextBlockParam[];

  const contextBlocks: Array<{ type: "text"; text: string }> = [
    {
      type: "text",
      text: `RECENT_ENTRIES_BY_MODULE:\n${JSON.stringify(input.recentEntriesByModule, null, 2)}`,
    },
  ];
  if (input.summary) {
    contextBlocks.push({ type: "text", text: `SESSION_SUMMARY: ${input.summary}` });
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    ...input.sessionHistory.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: [...contextBlocks, { type: "text", text: input.utterance }] },
  ];

  let resp: Anthropic.Message;
  try {
    resp = await client.messages.create({
      model: MODELS.parser,
      max_tokens: 1024,
      system: systemBlocks,
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages,
    });
  } catch (err) {
    recordClaudeCall(MODELS.parser, startedAt, "error");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  recordClaudeCall(MODELS.parser, startedAt, "success");

  const metrics = extractMetrics(resp, MODELS.parser, startedAt);
  const toolUse = resp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    return { ok: false, error: "No tool call emitted", metrics };
  }

  const actionName = TOOL_TO_ACTION[toolUse.name];
  if (!actionName) return { ok: false, error: `Unknown tool ${toolUse.name}`, metrics };

  const parsed = ParsedAction.safeParse({ action: actionName, ...(toolUse.input as object) });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, metrics };
  }
  return { ok: true, action: parsed.data, metrics };
}
