import { google, sheets_v4 } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { ExpenseData, ExpenseType } from "./llm/types.js";

export const SHEET_NAMES: Record<ExpenseType, string> = {
  diario: "Daily Expenses",
  extraordinario: "Extra Expenses",
};

// Las tablas de gastos siempre insertan la fila nueva en esta posición fija
// (fila 4), empujando el resto hacia abajo — mismo comportamiento que el
// botón/script manual que ya usaba el usuario antes del bot.
const TARGET_ROW = 4;
// Misma fórmula del template original (columna E), ahora parametrizada por
// fila: cada fila insertada (4, 5, ..., 3+N) necesita su propia fórmula
// apuntando a su propia celda C, no la hereda sola del insert. El separador
// de argumentos depende del locale de la planilla, no es fijo por la API —
// esta planilla está en locale Argentina, que usa ";" (no ",").
function dateTextFormula(row: number): string {
  return `=IF(ISBLANK(C${row});"";TEXT(C${row};"mmm-yy"))`;
}

const SETTINGS_SHEET = "Settings";
const CATEGORIES_RANGE = `${SETTINGS_SHEET}!A2:A`;
const CATEGORIES_TTL_MS = 10 * 60 * 1000;

// Epoch de fecha serial de Sheets (no es Unix): día 0 = 1899-12-30. Convertir
// acá en vez de dejar que la API lo infiera evita depender de un segundo tipo
// de escritura (values.update) que no puede ir en el mismo batchUpdate que
// insertDimension — ver comentario en appendExpense.
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateStringToSheetsSerial(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - SHEETS_EPOCH_UTC_MS) / MS_PER_DAY);
}

function sheetsSerialToDate(serial: number): Date {
  return new Date(SHEETS_EPOCH_UTC_MS + serial * MS_PER_DAY);
}

function getAuthClient() {
  const credentials = JSON.parse(config.googleServiceAccountKey);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuthClient() });
}

type SheetsClient = ReturnType<typeof getSheetsClient>;

// Los nombres de tab no cambian sin tocar código, así que el sheetId
// numérico (necesario para insertDimension) se resuelve una sola vez por
// proceso en vez de refetchear cada llamada.
const sheetIdCache = new Map<string, number>();

async function resolveSheetId(sheets: SheetsClient, sheetName: string): Promise<number> {
  const cached = sheetIdCache.get(sheetName);
  if (cached !== undefined) {
    return cached;
  }

  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });

  for (const sheet of data.sheets ?? []) {
    const { sheetId, title } = sheet.properties ?? {};
    if (title != null && sheetId != null) {
      sheetIdCache.set(title, sheetId);
    }
  }

  const sheetId = sheetIdCache.get(sheetName);
  if (sheetId === undefined) {
    throw new Error(`No encontré la hoja "${sheetName}" en la planilla`);
  }
  return sheetId;
}

// Inserta los gastos en la fila fija de la tabla correspondiente (Daily
// Expenses / Extra Expenses), empujando el resto hacia abajo — igual
// que el botón manual que ya usaba el usuario. La columna E recalcula la
// fecha en formato texto con la fórmula del template, reescrita en cada
// insert porque la fila nueva no la hereda sola. La columna F (comentarios)
// no se toca — el usuario la completa a mano en casos puntuales.
//
// Los expenses de entrada se agrupan por sheetId (vía SHEET_NAMES +
// resolveSheetId), preservando el orden dentro de cada grupo. Por cada
// grupo con N filas van 2 requests: 1 insertDimension que abre las N filas
// de una vez y 1 updateCells que las escribe todas en la misma request — no
// una request por fila. Si el mensaje mezcla diario + extraordinario, son 2
// sheets → 4 requests, pero TODAS van en el MISMO batchUpdate (nunca dos
// llamadas HTTP separadas): la API aplica todas las requests de un
// batchUpdate de forma atómica — si una falla, ninguna se aplica. Antes eran
// insertDimension (batchUpdate) + un values.update aparte; si el primero
// pegaba y el segundo fallaba por un corte de red, un reintento volvía a
// insertar una fila. Por eso la escritura de valores usa updateCells en vez
// de values.update — es lo único que entra en el mismo array de requests
// que insertDimension. updateCells no auto-detecta tipos como USER_ENTERED:
// cada celda necesita su ExtendedValue explícito, y la fecha en particular
// hay que mandarla como serial de Sheets (dateStringToSheetsSerial) en vez
// de string, para que la fórmula de columna E (TEXT sobre una fecha real)
// siga funcionando.
export async function appendExpense(expenses: ExpenseData[]): Promise<void> {
  const sheets = getSheetsClient();

  const groups = new Map<number, ExpenseData[]>();
  for (const expense of expenses) {
    const sheetName = SHEET_NAMES[expense.expenseType];
    const sheetId = await resolveSheetId(sheets, sheetName);
    const group = groups.get(sheetId);
    if (group) {
      group.push(expense);
    } else {
      groups.set(sheetId, [expense]);
    }
  }

  const requests: sheets_v4.Schema$Request[] = [];
  for (const [sheetId, group] of groups) {
    const rowCount = group.length;
    const endRowIndex = TARGET_ROW - 1 + rowCount;

    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: TARGET_ROW - 1,
          endIndex: endRowIndex,
        },
        // false = hereda formato de la fila de abajo (la fila de datos que
        // se corre para abajo), no de lo que esté arriba de la tabla —
        // incluye el formato de fecha/moneda ya aplicado en esa fila, que
        // no volvemos a fijar acá (solo seteamos userEnteredValue).
        inheritFromBefore: false,
      },
    });

    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: TARGET_ROW - 1,
          endRowIndex,
          startColumnIndex: 0,
          endColumnIndex: 5,
        },
        fields: "userEnteredValue",
        rows: group.map((expense, i) => ({
          values: [
            { userEnteredValue: { stringValue: expense.description } },
            { userEnteredValue: { stringValue: expense.category } },
            { userEnteredValue: { numberValue: dateStringToSheetsSerial(expense.date) } },
            { userEnteredValue: { numberValue: expense.amount } },
            { userEnteredValue: { formulaValue: dateTextFormula(TARGET_ROW + i) } },
          ],
        })),
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests },
  });

  for (const [sheetId, group] of groups) {
    logger.debug(
      `[sheets] appendExpense OK: sheetId=${sheetId} filas=${group.length} desde row=${TARGET_ROW} ` +
        group.map((expense) => `["${expense.description}" ${expense.category} ${expense.date} $${expense.amount}]`).join(" "),
    );
  }
}

export interface ExpenseRow {
  category: string;
  amount: number;
}

// Lee los gastos de una hoja (Daily Expenses/Extra Expenses) dentro de un
// rango de fechas arbitrario (ambos límites UTC-medianoche, inclusive),
// opcionalmente filtrados por categoría. Rango de lectura abierto (A4:D, sin
// límite de fila) — no hace falta saber cuántas filas tiene la tabla.
// valueRenderOption=UNFORMATTED_VALUE es necesario: por default la API
// devuelve valores formateados (fecha como texto según el formato de la
// celda, monto con separadores/moneda) en vez de los números crudos que
// escribe appendExpense.
export async function fetchExpensesInRange(
  sheetName: string,
  from: Date,
  to: Date,
  category?: string,
): Promise<ExpenseRow[]> {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${sheetName}!A4:D`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const result: ExpenseRow[] = [];
  for (const row of data.values ?? []) {
    const [, rowCategory, serial, amount] = row as [unknown, string?, number?, number?];
    if (serial === undefined || amount === undefined) {
      continue;
    }

    const date = sheetsSerialToDate(serial);
    if (date.getTime() < from.getTime() || date.getTime() > to.getTime()) {
      continue;
    }

    if (category && rowCategory !== category) {
      continue;
    }

    result.push({ category: rowCategory ?? "", amount });
  }

  logger.debug(
    `[sheets] fetchExpensesInRange: sheet="${sheetName}" ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}` +
      `${category ? ` categoria="${category}"` : ""} → ${result.length} fila(s)`,
  );
  return result;
}

let categoriesCache: { values: string[]; fetchedAt: number } | undefined;

// Lee las categorías desde la tab "Settings" (columna A, a partir de la fila
// 2). Cacheadas en memoria por CATEGORIES_TTL_MS: el volumen de mensajes es
// bajo y esporádico, no hace falta pegarle a Sheets en cada uno. Una
// categoría nueva tarda como máximo ese TTL en verse reflejada, sin
// necesidad de redeploy.
export async function fetchCategories(): Promise<string[]> {
  if (categoriesCache && Date.now() - categoriesCache.fetchedAt < CATEGORIES_TTL_MS) {
    logger.debug(`[sheets] fetchCategories: cache hit (${categoriesCache.values.length} categorías)`);
    return categoriesCache.values;
  }

  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: CATEGORIES_RANGE,
  });

  const values = (data.values ?? [])
    .map((row) => row[0])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  logger.debug(`[sheets] fetchCategories: cache miss, leídas ${values.length} de "${CATEGORIES_RANGE}": ${values.join(", ")}`);
  // No cachear un resultado vacío: podría ser un blip transitorio de la API,
  // y cachearlo tira todo a la categoría default por CATEGORIES_TTL_MS enteros.
  if (values.length > 0) {
    categoriesCache = { values, fetchedAt: Date.now() };
  }
  return values;
}
