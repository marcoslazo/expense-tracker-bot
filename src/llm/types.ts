export const EXPENSE_TYPES = ["diario", "extraordinario"] as const;

export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export interface ExpenseData {
  date: string;
  description: string;
  amount: number;
  // Ya no es un enum fijo en compilación: la lista real vive en la tab
  // "Settings" de la planilla y se lee en runtime (ver sheets.ts).
  category: string;
  expenseType: ExpenseType;
}

export interface ExpenseInterpreter {
  interpretExpense(text: string, categories: string[]): Promise<unknown[]>;
}
