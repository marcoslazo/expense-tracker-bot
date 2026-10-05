import { todayInArgentina } from "./llm/prompt.js";

export interface DateRange {
  from: Date;
  to: Date;
}

export interface PeriodPreset {
  key: string;
  label: string;
  range(today: Date): DateRange;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Mismo ancla de "hoy" que ya usa la interpretación de gastos (zona horaria
// Argentina, ver todayInArgentina() en llm/prompt.ts), convertida a
// UTC-medianoche — mismo formato que produce sheetsSerialToDate en
// sheets.ts, así los rangos calculados acá comparan directo contra esas
// fechas sin conversión adicional.
export function todayUtcMidnight(): Date {
  const [year, month, day] = todayInArgentina().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

// Lunes de la semana que contiene `date` (semana lunes-domingo, no
// domingo-sábado). getUTCDay() da 0 para domingo, por eso el caso especial.
function startOfWeek(date: Date): Date {
  const dayOfWeek = date.getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDays(date, -diffToMonday);
}

function endOfWeek(date: Date): Date {
  return addDays(startOfWeek(date), 6);
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date): Date {
  // Día 0 del mes siguiente = último día del mes actual.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

// Rodante: mismo día N meses atrás. Date.UTC normaliza desbordes de mes (ej.
// "31 de..." en un mes con menos días) corriendo al mes siguiente — aceptado
// para estos presets, no hace falta un manejo especial.
function monthsAgo(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, date.getUTCDate()));
}

function startOfYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

export const CUSTOM_PERIOD_KEY = "custom";

export const PERIOD_PRESETS: PeriodPreset[] = [
  { key: "today", label: "Hoy", range: (today) => ({ from: today, to: today }) },
  { key: "week", label: "Esta semana", range: (today) => ({ from: startOfWeek(today), to: endOfWeek(today) }) },
  { key: "month", label: "Este mes", range: (today) => ({ from: startOfMonth(today), to: endOfMonth(today) }) },
  { key: "3m", label: "Últimos 3 meses", range: (today) => ({ from: monthsAgo(today, 3), to: today }) },
  { key: "6m", label: "Últimos 6 meses", range: (today) => ({ from: monthsAgo(today, 6), to: today }) },
  { key: "12m", label: "Último año", range: (today) => ({ from: monthsAgo(today, 12), to: today }) },
  { key: "ytd", label: "Este año", range: (today) => ({ from: startOfYear(today), to: today }) },
];

const CUSTOM_RANGE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function parseDdMmYyyy(token: string): Date | null {
  const match = CUSTOM_RANGE_PATTERN.exec(token);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC normaliza fechas inválidas (ej. 31/02) en vez de rechazarlas —
  // hay que confirmar que lo que volvió coincide con lo que se pidió.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export function parseCustomRange(text: string): DateRange | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) {
    return null;
  }

  const from = parseDdMmYyyy(parts[0]);
  const to = parseDdMmYyyy(parts[1]);
  if (!from || !to || from.getTime() > to.getTime()) {
    return null;
  }

  return { from, to };
}

function formatDdMmYyyy(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

export function formatRangeLabel(from: Date, to: Date): string {
  return `${formatDdMmYyyy(from)} al ${formatDdMmYyyy(to)}`;
}
