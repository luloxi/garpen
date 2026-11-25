// Pure payment helpers (no Next.js or Cloudflare imports) so node:test can load them.

import { isDateKey } from "./recurring.ts";

export const PAYMENT_CURRENCIES = ["ARS", "USD"] as const;
export const PAYMENT_STATUSES = ["pending", "paid"] as const;
export const CONCEPT_MAX = 500;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type Payment = {
  id: string;
  contactId: string;
  contactName?: string | null;
  amountMinor: number;
  currency: PaymentCurrency;
  occurredAt: string;
  concept: string;
  status: PaymentStatus;
  createdAt: number;
  updatedAt: number;
};

export const PAYMENT_SELECT =
  "SELECT p.id, p.contact_id AS contactId, c.name AS contactName, p.amount_minor AS amountMinor, p.currency, p.occurred_at AS occurredAt, p.concept, p.status, p.created_at AS createdAt, p.updated_at AS updatedAt FROM contact_payments p JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id";

const ES: Record<string, string> = {
  "invalid amount": "Importe inválido",
  "invalid currency": "Moneda inválida",
  "invalid date": "Fecha inválida",
  "invalid concept": "Concepto inválido",
  "invalid status": "Estado inválido",
  "invalid contact": "Contacto inválido",
  "invalid payment": "Pago inválido",
};

export function paymentErrorEs(message: string): string {
  return ES[message] ?? "Datos inválidos";
}

function isCurrency(value: unknown): value is PaymentCurrency {
  return value === "ARS" || value === "USD";
}

function isStatus(value: unknown): value is PaymentStatus {
  return value === "pending" || value === "paid";
}

/** Parse a major-unit amount (1500.5 or "1.500,50" / "1500.50") into integer cents. */
export function majorToMinor(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const minor = Math.round(value * 100);
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT_MINOR) return null;
    if (Math.abs(value * 100 - minor) > 1e-6) return null;
    return minor;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s/g, "");
  if (!text || text.length > 32) return null;
  let normalized = text;
  if (text.includes(",") && text.includes(".")) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    normalized = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    const parts = text.split(",");
    normalized = parts.length === 2 && parts[1]!.length <= 2 ? text.replace(",", ".") : text.replace(/,/g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  const minor = Math.round(n * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT_MINOR) return null;
  return minor;
}

export function parseAmountMinor(input: Record<string, unknown>): { ok: true; amountMinor: number } | { ok: false; message: "invalid amount" } {
  if (Object.prototype.hasOwnProperty.call(input, "amountMinor") && input.amountMinor !== undefined && input.amountMinor !== null && input.amountMinor !== "") {
    const n = typeof input.amountMinor === "number" ? input.amountMinor : typeof input.amountMinor === "string" && input.amountMinor.trim() !== "" ? Number(input.amountMinor) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_AMOUNT_MINOR) return { ok: false, message: "invalid amount" };
    return { ok: true, amountMinor: n };
  }
  if (Object.prototype.hasOwnProperty.call(input, "amount") && input.amount !== undefined && input.amount !== null && input.amount !== "") {
    const minor = majorToMinor(input.amount);
    if (minor == null) return { ok: false, message: "invalid amount" };
    return { ok: true, amountMinor: minor };
  }
  return { ok: false, message: "invalid amount" };
}

export function parseCurrency(value: unknown): { ok: true; value: PaymentCurrency } | { ok: false; message: "invalid currency" } {
  if (!isCurrency(value)) return { ok: false, message: "invalid currency" };
  return { ok: true, value };
}

export function parseStatus(value: unknown, fallback?: PaymentStatus): { ok: true; value: PaymentStatus } | { ok: false; message: "invalid status" } {
  if (value === undefined || value === null || value === "") {
    if (fallback) return { ok: true, value: fallback };
    return { ok: false, message: "invalid status" };
  }
  if (!isStatus(value)) return { ok: false, message: "invalid status" };
  return { ok: true, value };
}

export function parsePaymentDate(value: unknown): { ok: true; value: string } | { ok: false; message: "invalid date" } {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || !isDateKey(text)) return { ok: false, message: "invalid date" };
  return { ok: true, value: text };
}

export function paymentDateOf(input: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(input, "date") && input.date !== undefined && input.date !== null && input.date !== "") return input.date;
  return input.occurredAt;
}

export function parseConcept(value: unknown): { ok: true; value: string } | { ok: false; message: "invalid concept" } {
  if (typeof value !== "string") return { ok: false, message: "invalid concept" };
  const text = value.trim();
  if (!text || text.length > CONCEPT_MAX) return { ok: false, message: "invalid concept" };
  return { ok: true, value: text };
}

export type PaymentCreate = {
  contactId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  occurredAt: string;
  concept: string;
  status: PaymentStatus;
};

export type PaymentPatch = {
  amountMinor?: number;
  currency?: PaymentCurrency;
  occurredAt?: string;
  concept?: string;
  status?: PaymentStatus;
};

export function parsePaymentCreate(input: Record<string, unknown>): { ok: true; value: PaymentCreate } | { ok: false; message: string } {
  const contactId = typeof input.contactId === "string" ? input.contactId.trim() : "";
  if (!contactId || contactId.length > 80) return { ok: false, message: "invalid contact" };
  const amount = parseAmountMinor(input);
  if (!amount.ok) return amount;
  const currency = parseCurrency(input.currency);
  if (!currency.ok) return currency;
  const occurredAt = parsePaymentDate(paymentDateOf(input));
  if (!occurredAt.ok) return occurredAt;
  const concept = parseConcept(input.concept);
  if (!concept.ok) return concept;
  const status = parseStatus(input.status, "pending");
  if (!status.ok) return status;
  return {
    ok: true,
    value: {
      contactId,
      amountMinor: amount.amountMinor,
      currency: currency.value,
      occurredAt: occurredAt.value,
      concept: concept.value,
      status: status.value,
    },
  };
}

export function parsePaymentPatch(input: Record<string, unknown>): { ok: true; value: PaymentPatch } | { ok: false; message: string } {
  const patch: PaymentPatch = {};
  const hasAmount = (Object.prototype.hasOwnProperty.call(input, "amountMinor") && input.amountMinor !== undefined && input.amountMinor !== null && input.amountMinor !== "")
    || (Object.prototype.hasOwnProperty.call(input, "amount") && input.amount !== undefined && input.amount !== null && input.amount !== "");
  if (hasAmount) {
    const amount = parseAmountMinor(input);
    if (!amount.ok) return amount;
    patch.amountMinor = amount.amountMinor;
  }
  if (Object.prototype.hasOwnProperty.call(input, "currency") && input.currency !== undefined && input.currency !== null && input.currency !== "") {
    const currency = parseCurrency(input.currency);
    if (!currency.ok) return currency;
    patch.currency = currency.value;
  }
  const dateValue = paymentDateOf(input);
  if (dateValue !== undefined && dateValue !== null && dateValue !== "") {
    const occurredAt = parsePaymentDate(dateValue);
    if (!occurredAt.ok) return occurredAt;
    patch.occurredAt = occurredAt.value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "concept") && input.concept !== undefined) {
    const concept = parseConcept(input.concept);
    if (!concept.ok) return concept;
    patch.concept = concept.value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "status") && input.status !== undefined && input.status !== null && input.status !== "") {
    const status = parseStatus(input.status);
    if (!status.ok) return status;
    patch.status = status.value;
  }
  if (patch.amountMinor === undefined && patch.currency === undefined && patch.occurredAt === undefined && patch.concept === undefined && patch.status === undefined) {
    return { ok: false, message: "invalid payment" };
  }
  return { ok: true, value: patch };
}

export function mapPayment(row: {
  id: string;
  contactId: string;
  contactName?: string | null;
  amountMinor: unknown;
  currency: string;
  occurredAt: string;
  concept: string;
  status: string;
  createdAt: unknown;
  updatedAt: unknown;
}): Payment {
  const amount = typeof row.amountMinor === "bigint" ? Number(row.amountMinor) : Number(row.amountMinor);
  const createdAt = typeof row.createdAt === "bigint" ? Number(row.createdAt) : Number(row.createdAt);
  const updatedAt = typeof row.updatedAt === "bigint" ? Number(row.updatedAt) : Number(row.updatedAt);
  return {
    id: String(row.id),
    contactId: String(row.contactId),
    contactName: row.contactName == null ? null : String(row.contactName),
    amountMinor: Number.isFinite(amount) ? amount : 0,
    currency: isCurrency(row.currency) ? row.currency : "ARS",
    occurredAt: String(row.occurredAt),
    concept: String(row.concept),
    status: isStatus(row.status) ? row.status : "pending",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}
