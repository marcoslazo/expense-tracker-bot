import { EXPENSE_TYPES } from "./types.js";
import type { ExpenseData } from "./types.js";
import { todayInArgentina } from "./prompt.js";
import { logger } from "../logger.js";

// Solo estos dos no se pueden inventar — todo lo demás se infiere/completa
// con un default en vez de preguntar.
export type CriticalField = "description" | "amount";

const DEFAULT_CATEGORY = "otros";
const DEFAULT_EXPENSE_TYPE: ExpenseData["expenseType"] = "diario";

// No bloquea nada — es solo un umbral para mostrarle al usuario un aviso
// visual antes de confirmar (ver summaryText en bot.ts). Ajustar si en uso
// real resulta muy bajo/alto para los montos habituales.
export const MAX_REASONABLE_AMOUNT = 1_000_000;

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidDescription(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Solo la primera letra — nunca fuerza el resto a minúscula, para no
// arruinar marcas/siglas con mayúsculas internas (iPhone, YPF, PS5). El LLM
// no es consistente con el case de lo que devuelve.
function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// appendExpense escribe a Sheets con USER_ENTERED: un string que arranca
// con =, +, - o @ se interpreta como fórmula en vez de texto literal. La
// comilla simple es la forma estándar en la que Sheets fuerza texto.
const SHEETS_FORMULA_PREFIX = /^[=+\-@]/;

function sanitizeForSheets(value: string): string {
  return SHEETS_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

function isValidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidCategory(value: unknown, categories: string[]): value is string {
  return typeof value === "string" && categories.includes(value);
}

function isValidExpenseType(value: unknown): value is ExpenseData["expenseType"] {
  return typeof value === "string" && (EXPENSE_TYPES as readonly string[]).includes(value);
}

// Si el usuario menciona el tipo explícitamente en el mensaje, eso pisa lo
// que haya inferido el LLM — más confiable que la clasificación automática
// cuando el dato está ahí. Si no lo menciona, se sigue infiriendo como
// siempre (nunca se le pregunta: mismo criterio que el resto de los campos
// no críticos).
const EXTRAORDINARIO_KEYWORD = /\bextraordinari[oa]s?\b|\bextras?\b/i;
const DIARIO_KEYWORD = /\bdiari[oa]s?\b/i;

function detectExpenseTypeKeyword(text: string): ExpenseData["expenseType"] | undefined {
  if (EXTRAORDINARIO_KEYWORD.test(text)) {
    logger.debug('[validate] expenseType detectado por palabra clave: "extraordinario"');
    return "extraordinario";
  }
  if (DIARIO_KEYWORD.test(text)) {
    logger.debug('[validate] expenseType detectado por palabra clave: "diario"');
    return "diario";
  }
  return undefined;
}

export interface ItemValidationResult {
  expense: Partial<ExpenseData>;
  missingFields: CriticalField[]; // vacío = este ítem está completo
}

export interface ValidationResult {
  // Todo-o-nada: si algún ítem tiene missingFields, expenses queda vacío y
  // ningún ítem pasa a pending (ver missingItems).
  expenses: ExpenseData[];
  // Un elemento por ítem del array crudo, en el mismo orden, únicamente
  // cuando hay al menos uno con campos faltantes — usado para armar el
  // mensaje "ítem N: falta X" sin volver a validar.
  missingItems: { index: number; missingFields: CriticalField[] }[];
}

function validateItem(data: unknown, categories: string[], expenseType: ExpenseData["expenseType"]): ItemValidationResult {
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};

  const expense: Partial<ExpenseData> = {
    date: isValidDate(record.date) ? record.date : todayInArgentina(),
    category: isValidCategory(record.category, categories) ? record.category : DEFAULT_CATEGORY,
    expenseType,
  };

  const missingFields: CriticalField[] = [];

  if (isValidDescription(record.description)) {
    expense.description = capitalizeFirst(record.description.trim());
  } else {
    missingFields.push("description");
  }

  if (isValidAmount(record.amount)) {
    expense.amount = record.amount;
  } else {
    missingFields.push("amount");
  }

  return { expense, missingFields };
}

// Único punto de confianza: acá se decide si lo que devolvió el LLM (Claude,
// Gemini u Ollama) alcanza para registrar el/los gasto(s). `date`, `category`
// y `expenseType` nunca bloquean — se autocompletan con un default sensato
// si faltan o son inválidos. Solo `description` y `amount` son datos que
// realmente no se pueden inventar; si falta alguno en CUALQUIER ítem, se
// rechaza el mensaje completo (todo-o-nada, sin estado pendiente parcial) y
// se listan todos los ítems problemáticos por posición en un solo mensaje.
export function validateExpense(data: unknown[], categories: string[], text: string): ValidationResult {
  // Array vacío = el LLM no devolvió nada interpretable (falla de parseo en
  // gemini.ts/ollama.ts). Sin esto, data.map()/filter() de abajo dan ambos
  // vacíos y el mensaje se trataría como "0 gastos válidos" en vez de
  // rechazarse — mismo comportamiento que antes tenía un objeto sin
  // description/amount.
  if (data.length === 0) {
    return { expenses: [], missingItems: [{ index: 0, missingFields: ["description", "amount"] }] };
  }

  // La heurística de palabra clave es global sobre todo el mensaje: con 2+
  // ítems no hay forma de saber a cuál se refiere, así que se descarta y se
  // confía en la clasificación por ítem que ya hace el LLM.
  const keywordExpenseType = data.length === 1 ? detectExpenseTypeKeyword(text) : undefined;

  const results = data.map((item) => {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const expenseType = keywordExpenseType ?? (isValidExpenseType(record.expenseType) ? record.expenseType : DEFAULT_EXPENSE_TYPE);
    return validateItem(item, categories, expenseType);
  });

  const missingItems = results
    .map((result, index) => ({ index, missingFields: result.missingFields }))
    .filter((entry) => entry.missingFields.length > 0);

  if (missingItems.length > 0) {
    return { expenses: [], missingItems };
  }

  return { expenses: results.map((result) => result.expense as ExpenseData), missingItems: [] };
}

function joinSpanishList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

// Agrupa por (category, expenseType) — no solo category, para no mezclar
// filas que van a hojas distintas si alguna vez una categoría aparece en
// ambos tipos. Suma amount, concatena description con join en español, toma
// date del primer ítem del grupo (fechas distintas en el mismo mensaje es un
// caso borde aceptado, no se resuelve). Se llama después de que todos los
// ítems pasaron la validación individual — nunca sobre ítems inválidos.
// sanitizeForSheets se aplica acá, sobre el string ya unido, y no por ítem
// en validateItem: si escapara cada descripción individualmente antes del
// join, la comilla de escape de un ítem no inicial quedaría incrustada en
// medio del texto final en vez de solo al principio de la celda.
export function mergeByCategory(expenses: ExpenseData[]): ExpenseData[] {
  const groups = new Map<string, ExpenseData[]>();

  for (const expense of expenses) {
    const key = `${expense.category}||${expense.expenseType}`;
    const group = groups.get(key);
    if (group) {
      group.push(expense);
    } else {
      groups.set(key, [expense]);
    }
  }

  return Array.from(groups.values()).map((group) => ({
    date: group[0].date,
    description: sanitizeForSheets(joinSpanishList(group.map((expense) => expense.description))),
    amount: group.reduce((sum, expense) => sum + expense.amount, 0),
    category: group[0].category,
    expenseType: group[0].expenseType,
  }));
}
