import type { FieldDefinition } from "../../../../packages/shared/src/index.js";

export type MarketplaceModule = {
  slug: string;
  label: string;
  icon: string;
  description: string;
  fields: FieldDefinition[];
};

export const MARKETPLACE: MarketplaceModule[] = [
  {
    slug: "branches",
    label: "Branches",
    icon: "map-pin",
    description: "Physical store locations with hours, governorate, status.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, localized: true },
      {
        key: "governorate",
        label: "Governorate",
        type: "select",
        required: true,
        localized: false,
        options: ["Hawalli", "Jahra", "Ahmadi", "Farwaniya", "Al-Asimah"],
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        required: true,
        localized: false,
        options: ["Active", "CLOSED", "Temp Closed"],
      },
      { key: "google_maps_url", label: "Maps", type: "url", required: false, localized: false },
      { key: "hours_regular", label: "Hours", type: "textarea", required: true, localized: false },
      {
        key: "hours_ramadan",
        label: "Ramadan hours",
        type: "textarea",
        required: false,
        localized: false,
      },
    ],
  },
  {
    slug: "promotions",
    label: "Promotions",
    icon: "tag",
    description: "Time-bound offers, bank partnerships, seasonal campaigns.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, localized: false },
      {
        key: "type",
        label: "Type",
        type: "select",
        required: true,
        localized: false,
        options: ["Promo", "Seasonal", "Bank"],
      },
      { key: "message", label: "Offer content", type: "textarea", required: true, localized: true },
      { key: "start_date", label: "Start", type: "date", required: false, localized: false },
      { key: "end_date", label: "End", type: "date", required: false, localized: false },
    ],
  },
  {
    slug: "faqs",
    label: "FAQs",
    icon: "help-circle",
    description: "Customer questions and bot-ready answers.",
    fields: [
      { key: "question", label: "Question", type: "text", required: true, localized: true },
      { key: "answer", label: "Answer", type: "textarea", required: true, localized: true },
      { key: "category", label: "Category", type: "text", required: false, localized: false },
    ],
  },
  {
    slug: "escalation_rules",
    label: "Escalation Rules",
    icon: "alert-triangle",
    description: "When to hand off to a human and where.",
    fields: [
      { key: "trigger", label: "Trigger", type: "textarea", required: true, localized: false },
      {
        key: "channel",
        label: "Channel",
        type: "select",
        required: true,
        localized: false,
        options: ["human_chat", "phone", "email", "whatsapp"],
      },
      { key: "webhook_url", label: "Webhook", type: "url", required: false, localized: false },
    ],
  },
  {
    slug: "response_templates",
    label: "Response Templates",
    icon: "file-text",
    description: "Canonical bot replies for common intents.",
    fields: [
      { key: "intent", label: "Intent", type: "text", required: true, localized: false },
      { key: "message", label: "Message", type: "textarea", required: true, localized: true },
    ],
  },
  {
    slug: "product_catalog",
    label: "Product Catalog",
    icon: "box",
    description: "SKUs, prices, availability.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, localized: true },
      { key: "price", label: "Price", type: "number", required: true, localized: false },
      { key: "available", label: "Available", type: "boolean", required: true, localized: false },
      { key: "image", label: "Image", type: "media", required: false, localized: false },
    ],
  },
  {
    slug: "pricing",
    label: "Pricing",
    icon: "dollar-sign",
    description: "Service tiers and pricing structure.",
    fields: [
      { key: "tier", label: "Tier", type: "text", required: true, localized: true },
      { key: "price_kwd", label: "Price (KWD)", type: "number", required: true, localized: false },
      { key: "includes", label: "Includes", type: "textarea", required: true, localized: true },
    ],
  },
  {
    slug: "partners",
    label: "Partner Directory",
    icon: "handshake",
    description: "Bank partners and external programs.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, localized: false },
      {
        key: "type",
        label: "Type",
        type: "select",
        required: true,
        localized: false,
        options: ["Bank", "Loyalty", "Corporate", "Other"],
      },
      { key: "notes", label: "Notes", type: "textarea", required: false, localized: true },
    ],
  },
  {
    slug: "policy_matrix",
    label: "Policy Matrix",
    icon: "shield",
    description: "Policies by scenario and role.",
    fields: [
      { key: "scenario", label: "Scenario", type: "text", required: true, localized: true },
      { key: "policy", label: "Policy", type: "textarea", required: true, localized: true },
      { key: "exception", label: "Exception", type: "textarea", required: false, localized: true },
    ],
  },
];
