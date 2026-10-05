import type { ExpenseData } from "./llm/types.js";
import { logger } from "./logger.js";

const PENDING_TTL_MS = 15 * 60 * 1000;

export interface PendingExpense {
  expenses: ExpenseData[];
  updatedAt: number;
  // "processing" evita que un doble tap de "Confirmar" (o un callback_query
  // reenviado por Telegram) duplique el gasto mientras el primer intento de
  // appendExpense todavía está en vuelo.
  status: "pending" | "processing";
}

// Estado en memoria, un solo proceso — suficiente para un bot de un único
// usuario y bajo volumen. Si Cloud Run llegara a escalar a más de una
// instancia o reciclar el proceso a mitad de una conversación, el
// pendiente se pierde; riesgo aceptado para este volumen de uso.
const pendingExpenses = new Map<number, PendingExpense>();

export function getPending(chatId: number): PendingExpense | undefined {
  const pending = pendingExpenses.get(chatId);
  if (!pending) {
    logger.debug(`[conversation-state] getPending(${chatId}): sin pendiente`);
    return undefined;
  }

  if (Date.now() - pending.updatedAt > PENDING_TTL_MS) {
    logger.debug(`[conversation-state] getPending(${chatId}): pendiente vencido (TTL), descartado`);
    pendingExpenses.delete(chatId);
    return undefined;
  }

  logger.debug(`[conversation-state] getPending(${chatId}): hit`);
  return pending;
}

export function setPending(chatId: number, expenses: ExpenseData[]): void {
  logger.debug(`[conversation-state] setPending(${chatId})`);
  pendingExpenses.set(chatId, { expenses, updatedAt: Date.now(), status: "pending" });
}

export function markProcessing(chatId: number): void {
  const pending = pendingExpenses.get(chatId);
  if (!pending) {
    return;
  }
  logger.debug(`[conversation-state] markProcessing(${chatId})`);
  pending.status = "processing";
}

export function markPending(chatId: number): void {
  const pending = pendingExpenses.get(chatId);
  if (!pending) {
    return;
  }
  logger.debug(`[conversation-state] markPending(${chatId})`);
  pending.status = "pending";
}

export function clearPending(chatId: number): void {
  logger.debug(`[conversation-state] clearPending(${chatId})`);
  pendingExpenses.delete(chatId);
}

const AWAITING_GASTOS_RANGE_TTL_MS = 5 * 60 * 1000;

export interface AwaitingGastosRange {
  category?: string;
  updatedAt: number;
}

// Mismo patrón/Map en memoria que pendingExpenses, TTL más corto: es solo la
// espera del texto de rango tras tocar "Personalizado" en /gastos, no hace
// falta que sobreviva tanto como la confirmación de un gasto.
const awaitingGastosRange = new Map<number, AwaitingGastosRange>();

export function getAwaitingGastosRange(chatId: number): AwaitingGastosRange | undefined {
  const awaiting = awaitingGastosRange.get(chatId);
  if (!awaiting) {
    logger.debug(`[conversation-state] getAwaitingGastosRange(${chatId}): sin pendiente`);
    return undefined;
  }

  if (Date.now() - awaiting.updatedAt > AWAITING_GASTOS_RANGE_TTL_MS) {
    logger.debug(`[conversation-state] getAwaitingGastosRange(${chatId}): vencido (TTL), descartado`);
    awaitingGastosRange.delete(chatId);
    return undefined;
  }

  logger.debug(`[conversation-state] getAwaitingGastosRange(${chatId}): hit`);
  return awaiting;
}

export function setAwaitingGastosRange(chatId: number, category?: string): void {
  logger.debug(`[conversation-state] setAwaitingGastosRange(${chatId})`);
  awaitingGastosRange.set(chatId, { category, updatedAt: Date.now() });
}

export function clearAwaitingGastosRange(chatId: number): void {
  logger.debug(`[conversation-state] clearAwaitingGastosRange(${chatId})`);
  awaitingGastosRange.delete(chatId);
}
