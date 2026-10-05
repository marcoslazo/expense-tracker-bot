import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { appendExpense, fetchCategories, fetchExpensesInRange, SHEET_NAMES } from "./sheets.js";
import type { ExpenseRow } from "./sheets.js";
import { transcribeVoice } from "./speech.js";
import { ClaudeExpenseInterpreter } from "./llm/claude.js";
import { OllamaExpenseInterpreter } from "./llm/ollama.js";
import { GeminiExpenseInterpreter } from "./llm/gemini.js";
import type { ExpenseData, ExpenseInterpreter } from "./llm/types.js";
import { MAX_REASONABLE_AMOUNT, mergeByCategory, validateExpense } from "./llm/validate.js";
import type { CriticalField } from "./llm/validate.js";
import {
  clearAwaitingGastosRange,
  clearPending,
  getAwaitingGastosRange,
  getPending,
  markPending,
  markProcessing,
  setAwaitingGastosRange,
  setPending,
} from "./conversation-state.js";
import { CUSTOM_PERIOD_KEY, PERIOD_PRESETS, formatRangeLabel, parseCustomRange, todayUtcMidnight } from "./date-ranges.js";
import { logger } from "./logger.js";
import { appVersion } from "./version.js";
import { withRetry } from "./retry.js";

function createInterpreter(): ExpenseInterpreter {
  switch (config.llmProvider) {
    case "ollama":
      return new OllamaExpenseInterpreter();
    case "gemini":
      return new GeminiExpenseInterpreter();
    case "claude":
      return new ClaudeExpenseInterpreter();
  }
}

const interpreter: ExpenseInterpreter = createInterpreter();

export const bot = new Bot(config.telegramBotToken);

// Timestamp de carga del módulo, no del primer mensaje procesado — sirve
// para que /version diga hace cuánto vive el proceso actual (útil para
// notar un cold start de Cloud Run) sin agregar un health check real
// contra Sheets/LLM, que sumaría latencia y costo a cada ping de Cloud Run.
const startedAt = Date.now();

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// En modo webhook, si la latencia de un update (fetchCategories + LLM, cada
// uno con hasta 2 intentos) supera el timeout de reintento de Telegram,
// Telegram reenvía el mismo update — sin este chequeo se procesaría el
// mismo mensaje dos veces. Inofensivo en long polling: grammY ya deduplica
// por offset ahí, así que un update_id nunca llega dos veces a este
// middleware en ese modo.
const SEEN_UPDATE_TTL_MS = 5 * 60 * 1000;
const MAX_SEEN_UPDATES = 200;
const seenUpdateIds = new Map<number, number>();

function pruneSeenUpdateIds(): void {
  const cutoff = Date.now() - SEEN_UPDATE_TTL_MS;
  for (const [updateId, seenAt] of seenUpdateIds) {
    if (seenAt < cutoff) {
      seenUpdateIds.delete(updateId);
    }
  }
  while (seenUpdateIds.size > MAX_SEEN_UPDATES) {
    const oldestId = seenUpdateIds.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    seenUpdateIds.delete(oldestId);
  }
}

bot.use(async (ctx, next) => {
  const updateId = ctx.update.update_id;
  if (seenUpdateIds.has(updateId)) {
    logger.debug(`Update duplicado ignorado: update_id=${updateId}`);
    return;
  }
  seenUpdateIds.set(updateId, Date.now());
  pruneSeenUpdateIds();
  await next();
});

function isOwner(from: { id: number } | undefined): boolean {
  return from?.id.toString() === config.ownerTelegramId;
}

function isOwnerOrWarn(from: { id: number } | undefined, label: string): boolean {
  if (isOwner(from)) {
    return true;
  }
  logger.warn(`${label} ignorado — chat.id=${from?.id} no coincide con OWNER_TELEGRAM_ID`);
  return false;
}

const CRITICAL_FIELD_LABEL: Record<CriticalField, string> = {
  description: "qué compraste",
  amount: "el monto",
};

function missingFieldsMessage(fields: CriticalField[]): string {
  const labels = fields.map((field) => CRITICAL_FIELD_LABEL[field]);
  return `Me falta saber ${labels.join(" y ")}. Mandame el mensaje de nuevo con eso incluido.`;
}

// Con 1 solo ítem en el mensaje, mismo texto que antes de soportar varios
// gastos (regresión sin cambios visuales). Con 2+, se lista cada ítem
// problemático por posición en un solo mensaje (todo-o-nada, ver
// validateExpense).
function missingItemsMessage(
  missingItems: { index: number; missingFields: CriticalField[] }[],
  totalItems: number,
): string {
  if (totalItems === 1) {
    return missingFieldsMessage(missingItems[0].missingFields);
  }

  const lines = missingItems.map(({ index, missingFields }) => {
    const labels = missingFields.map((field) => CRITICAL_FIELD_LABEL[field]);
    return `Ítem ${index + 1}: me falta ${labels.join(" y ")}.`;
  });
  return `${lines.join("\n")}\nMandame el mensaje de nuevo con eso incluido.`;
}

function confirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Confirmar ✅", "confirm").text("Corregir ✏️", "correct");
}

const GASTOS_CATEGORY_PREFIX = "gastos:cat:";
const GASTOS_PERIOD_PREFIX = "gastos:period:";
const CUSTOM_PERIOD_LABEL = "📅 Personalizado";

// 2 categorías por fila para que el teclado no quede desmesuradamente alto
// con listas largas. includeAll antepone un botón "Todas" en su propia
// fila — solo lo usa el paso 1 de /gastos; su callback es GASTOS_CATEGORY_PREFIX
// con sufijo vacío (ver parseo en el handler de callback_query:data).
function categoryKeyboard(categories: string[], includeAll = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (includeAll) {
    keyboard.text("Todas", GASTOS_CATEGORY_PREFIX).row();
  }
  categories.forEach((category, i) => {
    keyboard.text(category, `${GASTOS_CATEGORY_PREFIX}${category}`);
    if (i % 2 === 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

// PERIOD_PRESETS tiene 7 elementos (impar): el forEach deja el último
// ("Este año") solo en su fila, y agregar "Personalizado" a continuación lo
// empareja ahí — 2 por fila en las primeras 3 filas, el último par queda
// Este año + Personalizado, sin necesidad de un row() extra.
function periodKeyboard(category: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  PERIOD_PRESETS.forEach((preset, i) => {
    keyboard.text(preset.label, `${GASTOS_PERIOD_PREFIX}${preset.key}:${category}`);
    if (i % 2 === 1) {
      keyboard.row();
    }
  });
  keyboard.text(CUSTOM_PERIOD_LABEL, `${GASTOS_PERIOD_PREFIX}${CUSTOM_PERIOD_KEY}:${category}`);
  return keyboard;
}

// Separa por el *primer* ":" después del prefijo (no por todos) para que un
// nombre de categoría con ":" no rompa el parseo — misma robustez que ya
// tenía GASTOS_CATEGORY_PREFIX al no necesitar separador.
function parsePeriodCallbackData(data: string): { key: string; category: string } {
  const rest = data.slice(GASTOS_PERIOD_PREFIX.length);
  const separatorIndex = rest.indexOf(":");
  return separatorIndex === -1
    ? { key: rest, category: "" }
    : { key: rest.slice(0, separatorIndex), category: rest.slice(separatorIndex + 1) };
}

async function fetchExpenses(from: Date, to: Date, category?: string): Promise<ExpenseRow[]> {
  const rowsBySheet = await Promise.all(
    Object.values(SHEET_NAMES).map((sheetName) => fetchExpensesInRange(sheetName, from, to, category)),
  );
  return rowsBySheet.flat();
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("es-AR").format(amount);
}

function sumByCategory(rows: ExpenseRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.category, (totals.get(row.category) ?? 0) + row.amount);
  }
  return totals;
}

// rangeLabel viene tal cual del botón tocado ("Hoy", "Esta semana", ...) o
// del rango personalizado formateado — se muestra entre paréntesis en vez
// de encajarlo en una oración (ej. "Gastos de Esta semana:") para no
// depender de que cada label calce en género/número con la preposición.
function gastosSummaryText(rangeLabel: string, rows: ExpenseRow[], categoryFilter?: string): string {
  if (rows.length === 0) {
    return categoryFilter
      ? `No hay gastos en "${categoryFilter}" en el período seleccionado (${rangeLabel}).`
      : `No hay gastos registrados en el período seleccionado (${rangeLabel}).`;
  }

  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  if (categoryFilter) {
    return `📊 ${categoryFilter} (${rangeLabel}):\n💰 $${formatAmount(total)}`;
  }

  const lines = [
    `📊 Gastos (${rangeLabel}):`,
    ...[...sumByCategory(rows).entries()].map(([category, amount]) => `🏷️ ${category}: $${formatAmount(amount)}`),
    `💰 Total: $${formatAmount(total)}`,
  ];
  return lines.join("\n");
}

function expenseSummaryLine(expense: ExpenseData): string {
  const warning = expense.amount > MAX_REASONABLE_AMOUNT ? " ⚠️" : "";
  return `📝 ${expense.description} — 💰 $${formatAmount(expense.amount)} — 🏷️ ${expense.category} (${expense.expenseType})${warning}`;
}

// Con 1 solo gasto agrupado, mismo formato que antes de soportar varios
// (regresión sin cambios visuales). Con 2+, una línea por gasto agrupado
// más el total; el aviso de monto alto se evalúa por línea, no sobre el
// total.
function summaryText(expenses: ExpenseData[]): string {
  if (expenses.length === 1) {
    const expense = expenses[0];
    const lines = [
      "Entendí esto:",
      `📝 ${expense.description}`,
      `💰 $${formatAmount(expense.amount)}`,
      `📅 ${expense.date}`,
      `🏷️ ${expense.category} (${expense.expenseType})`,
    ];

    if (expense.amount > MAX_REASONABLE_AMOUNT) {
      lines.push("⚠️ Monto inusualmente alto, revisá antes de confirmar.");
    }

    return lines.join("\n");
  }

  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const lines = ["Entendí estos gastos:", ...expenses.map(expenseSummaryLine), `💰 Total: $${formatAmount(total)}`];
  return lines.join("\n");
}

function confirmedText(expenses: ExpenseData[]): string {
  if (expenses.length === 1) {
    const expense = expenses[0];
    return (
      `Registrado: ${expense.description} — $${formatAmount(expense.amount)} ` +
      `(${expense.category}, ${expense.expenseType}) el ${expense.date}`
    );
  }

  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  return `Se registraron ${expenses.length} gastos por $${formatAmount(total)}`;
}

const HELP_TEXT = [
  'Mandame un mensaje de texto o de voz describiendo un gasto (ej: "gasté 5000',
  'en el super") y lo interpreto, categorizo y te pido confirmación antes de',
  "guardarlo.",
  "",
  'Decime "diario" o "extraordinario" en el mensaje si querés forzar el tipo —',
  "si no, lo infiero solo.",
  "",
  "Comandos:",
  "/help — este mensaje",
  "/cancel — cancela el gasto pendiente de confirmación",
  "/gastos — consultá tus gastos: elegí categoría y período con botones",
  "/version — versión y config actual del bot",
].join("\n");

const MAX_MESSAGE_LENGTH = 500;
// Protege el free tier de Cloud Speech-to-Text (60 min/mes) de una nota
// larga — se chequea contra la duración que Telegram ya reporta, antes de
// descargar/transcribir nada.
const MAX_VOICE_DURATION_SECONDS = 60;

// /start no está en este menú a propósito: Telegram lo dispara solo al
// tocar "Iniciar" en un chat nuevo, esté o no en setMyCommands (ver el
// handler bot.command("start", ...) más abajo, que sigue registrado).
export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "version", description: "Versión, estado y configuración del bot" },
    { command: "help", description: "Cómo usar el bot" },
    { command: "cancel", description: "Cancelar el gasto pendiente de confirmación" },
    { command: "gastos", description: "Consultar gastos por categoría y período" },
  ]);
}

// Comandos registrados antes de message:text: grammY encadena los handlers
// en orden de registro y ninguno de estos llama next(), así que un mensaje
// "/comando" nunca llega al handler general — no pasa por el LLM.
bot.command("version", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "/version")) {
    return;
  }

  await ctx.reply(
    [
      `📦 v${appVersion}`,
      `🤖 LLM: ${config.llmProvider}`,
      `📋 Log level: ${config.logLevel}`,
      `⏱️ Activo hace: ${formatUptime(Date.now() - startedAt)}`,
    ].join("\n"),
  );
});

bot.command("start", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "/start")) {
    return;
  }

  await ctx.reply(`¡Hola! Soy tu bot de gastos personales.\n\n${HELP_TEXT}`);
});

bot.command("help", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "/help")) {
    return;
  }

  await ctx.reply(HELP_TEXT);
});

bot.command("cancel", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "/cancel")) {
    return;
  }

  const chatId = ctx.chat.id;
  const pending = getPending(chatId);
  const awaitingRange = getAwaitingGastosRange(chatId);

  if (!pending && !awaitingRange) {
    await ctx.reply("No hay ningún gasto pendiente de confirmación.");
    return;
  }

  if (pending) {
    clearPending(chatId);
    logger.info(`Gasto pendiente cancelado vía /cancel para chat.id=${chatId}`);
  }
  if (awaitingRange) {
    clearAwaitingGastosRange(chatId);
    logger.info(`Espera de rango personalizado de /gastos cancelada vía /cancel para chat.id=${chatId}`);
  }

  // Sin gasto pendiente, "mandame el gasto de nuevo" no aplica — el usuario
  // solo estaba a mitad del flujo de /gastos, no de una confirmación.
  await ctx.reply(
    pending ? "Cancelado. Mandame el gasto de nuevo si querés reintentarlo." : "Cancelado. Usá /gastos si querés consultar de nuevo.",
  );
});

bot.command("gastos", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "/gastos")) {
    return;
  }

  try {
    const categories = await withRetry(() => fetchCategories());
    await ctx.reply("¿Qué categoría querés consultar?", { reply_markup: categoryKeyboard(categories, true) });
  } catch (error) {
    logger.error("Error obteniendo categorías para /gastos:", error);
    await ctx.reply("No pude leer las categorías, probá de nuevo.");
  }
});

// Compartido entre message:text y message:voice (una vez transcripta):
// misma interpretación/validación/confirmación para ambos orígenes de
// texto. No atrapa errores — cada handler los atrapa con su propio mensaje
// según de dónde vino el texto.
async function processExpenseText(ctx: Context, chatId: number, text: string): Promise<void> {
  const categories = await withRetry(() => fetchCategories());
  logger.debug(`Categorías disponibles (${categories.length}): ${categories.join(", ")}`);

  const raw = await withRetry(() => interpreter.interpretExpense(text, categories));
  logger.debug(`Respuesta cruda del LLM (${config.llmProvider}):`, raw);

  const { expenses, missingItems } = validateExpense(raw, categories, text);
  logger.debug("Expenses validados:", expenses, "missingItems:", missingItems);

  if (missingItems.length > 0) {
    const itemLabels = missingItems.map((item) => item.index + 1).join(", ");
    logger.info(`Faltan campos críticos para chat.id=${chatId}: ítem(s) ${itemLabels}`);
    // raw.length es 0 cuando el LLM no devolvió nada interpretable
    // (sentinel de fallo de parseo en validateExpense) — tratarlo como 1
    // ítem para que se use el mensaje simple en vez del formato "Ítem N".
    await ctx.reply(missingItemsMessage(missingItems, raw.length || 1));
    return;
  }

  const merged = mergeByCategory(expenses);
  setPending(chatId, merged);
  logger.info(`Gasto(s) interpretado(s) (${merged.length}), esperando confirmación de chat.id=${chatId}`);
  await ctx.reply(summaryText(merged), { reply_markup: confirmationKeyboard() });
}

// También escucha edited_message:text — si el usuario corrige un mensaje con
// el botón "editar" de Telegram en vez de mandar uno nuevo, eso llega como un
// update edited_message, no message; sin este segundo filtro grammY nunca
// dispara nada y la corrección se pierde en silencio. ctx.msg
// resuelve a message o editedMessage según cuál haya disparado el handler.
bot.on(["message:text", "edited_message:text"], async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "Mensaje")) {
    return;
  }

  const chatId = ctx.chat.id;
  const text = ctx.msg.text;
  logger.debug(`Mensaje recibido de chat.id=${chatId}: "${text}"`);

  // Chequeado antes que clearPending/la interpretación de gasto: si el bot
  // está esperando el rango personalizado de /gastos, este mensaje es ese
  // rango, no un gasto nuevo.
  const awaitingRange = getAwaitingGastosRange(chatId);
  if (awaitingRange) {
    const range = parseCustomRange(text);
    if (!range) {
      await ctx.reply("No entendí ese rango. Mandalo como dd/mm/aaaa dd/mm/aaaa (ej: 01/07/2026 31/07/2026).");
      return;
    }

    clearAwaitingGastosRange(chatId);
    try {
      const rows = await withRetry(() => fetchExpenses(range.from, range.to, awaitingRange.category));
      await ctx.reply(gastosSummaryText(formatRangeLabel(range.from, range.to), rows, awaitingRange.category));
    } catch (error) {
      logger.error("Error consultando gastos por rango personalizado:", error);
      await ctx.reply("No pude leer los gastos, probá de nuevo.");
    }
    return;
  }

  // Un mensaje de texto nuevo siempre arranca un gasto desde cero — si
  // había uno esperando confirmación, queda descartado.
  clearPending(chatId);

  if (text.length > MAX_MESSAGE_LENGTH) {
    await ctx.reply(`Ese mensaje es muy largo (máx. ${MAX_MESSAGE_LENGTH} caracteres) — resumilo en menos texto.`);
    return;
  }

  try {
    await processExpenseText(ctx, chatId, text);
  } catch (error) {
    logger.error("Error procesando el mensaje:", error);
    await ctx.reply("No pude procesar ese gasto. Probá de nuevo con otra frase.");
  }
});

bot.on("message:voice", async (ctx) => {
  if (!isOwnerOrWarn(ctx.from, "Nota de voz")) {
    return;
  }

  const chatId = ctx.chat.id;
  const { duration } = ctx.message.voice;
  logger.debug(`Nota de voz recibida de chat.id=${chatId}: duration=${duration}s`);

  // Misma regla que message:text: un mensaje nuevo descarta cualquier
  // gasto pendiente de confirmación.
  clearPending(chatId);

  if (duration > MAX_VOICE_DURATION_SECONDS) {
    await ctx.reply(`Esa nota de voz es muy larga (máx. ${MAX_VOICE_DURATION_SECONDS}s) — resumila en menos tiempo.`);
    return;
  }

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const audio = Buffer.from(await response.arrayBuffer());

    const transcript = await withRetry(() => transcribeVoice(audio));
    logger.debug(`Transcripción de chat.id=${chatId}: "${transcript}"`);

    if (!transcript.trim()) {
      await ctx.reply("No pude entender el audio. Probá de nuevo o mandalo por texto.");
      return;
    }

    await processExpenseText(ctx, chatId, transcript);
  } catch (error) {
    logger.error("Error procesando la nota de voz:", error);
    await ctx.reply("No pude procesar esa nota de voz. Probá de nuevo o mandalo por texto.");
  }
});

bot.on("callback_query:data", async (ctx) => {
  if (!isOwner(ctx.from)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  const data = ctx.callbackQuery.data;

  // Atendido antes que la lógica de pending: no tiene nada que ver con el
  // flujo de confirmación de un gasto, es el paso 1 (categoría) de /gastos.
  // Solo cambia de teclado (categoría → período), todavía no hace fetch.
  if (data.startsWith(GASTOS_CATEGORY_PREFIX)) {
    const category = data.slice(GASTOS_CATEGORY_PREFIX.length);
    logger.debug(`Callback /gastos categoría de chat.id=${chatId}: categoria="${category || "(todas)"}"`);

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await ctx.reply("¿Qué período querés consultar?", { reply_markup: periodKeyboard(category) });
    return;
  }

  // Paso 2 (período) de /gastos: "custom" pide el rango como texto libre y
  // recuerda la categoría ya elegida en awaitingGastosRange; cualquier otro
  // preset calcula el rango y hace el fetch de una.
  if (data.startsWith(GASTOS_PERIOD_PREFIX)) {
    const { key, category } = parsePeriodCallbackData(data);
    logger.debug(`Callback /gastos período de chat.id=${chatId}: key="${key}" categoria="${category || "(todas)"}"`);

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();

    if (key === CUSTOM_PERIOD_KEY) {
      setAwaitingGastosRange(chatId, category || undefined);
      await ctx.reply("Mandame el rango como texto: dd/mm/aaaa dd/mm/aaaa (ej: 01/07/2026 31/07/2026).");
      return;
    }

    const preset = PERIOD_PRESETS.find((p) => p.key === key);
    if (!preset) {
      logger.warn(`Callback /gastos período con key desconocida: "${key}"`);
      await ctx.reply("No reconocí ese período, probá de nuevo con /gastos.");
      return;
    }

    const { from, to } = preset.range(todayUtcMidnight());
    try {
      const rows = await withRetry(() => fetchExpenses(from, to, category || undefined));
      await ctx.reply(gastosSummaryText(preset.label, rows, category || undefined));
    } catch (error) {
      logger.error("Error consultando gastos por período:", error);
      await ctx.reply("No pude leer los gastos, probá de nuevo.");
    }
    return;
  }

  const pending = getPending(chatId);
  logger.debug(`Callback recibido de chat.id=${chatId}: data="${data}" pending=${Boolean(pending)}`);

  try {
    if (data === "confirm") {
      if (!pending) {
        logger.warn(`Confirmación sin pendiente para chat.id=${chatId} (¿venció el TTL?)`);
        await ctx.answerCallbackQuery({ text: "Ya no hay nada pendiente para confirmar." });
        return;
      }

      if (pending.status === "processing") {
        logger.debug(`Confirmación duplicada ignorada para chat.id=${chatId} (ya se está guardando)`);
        await ctx.answerCallbackQuery({ text: "Ya se está guardando, esperá un toque." });
        return;
      }

      markProcessing(chatId);

      try {
        await withRetry(() => appendExpense(pending.expenses));
      } catch (error) {
        logger.error("Error guardando en la planilla:", error);
        markPending(chatId);
        await ctx.answerCallbackQuery({ text: "No pude guardarlo, probá de nuevo." });
        return;
      }

      clearPending(chatId);
      logger.info(`Gasto(s) registrado(s) en Sheets para chat.id=${chatId} (${pending.expenses.length})`);
      await ctx.answerCallbackQuery({ text: "Registrado ✅" });
      await ctx.editMessageReplyMarkup();
      await ctx.reply(confirmedText(pending.expenses));
      return;
    }

    if (data === "correct") {
      clearPending(chatId);
      logger.info(`Usuario pidió corregir el gasto pendiente de chat.id=${chatId}`);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup();
      await ctx.reply("Dale, mandame el gasto de nuevo con el dato corregido.");
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error procesando el botón:", error);
  }
});
