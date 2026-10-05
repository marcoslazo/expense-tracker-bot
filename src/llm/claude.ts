import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ExpenseInterpreter } from "./types.js";
import { buildSystemPrompt, todayInArgentina } from "./prompt.js";

// Las categorías se leen en runtime desde la planilla, así que el schema no
// puede ser una constante de módulo — se arma por request.
function buildExpenseSchema(categories: string[]) {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        date: { type: "string", format: "date" },
        description: { type: "string" },
        amount: { type: "number" },
        category: { type: "string", enum: categories },
        expenseType: { type: "string", enum: ["diario", "extraordinario"] },
      },
      required: ["date", "description", "amount", "category", "expenseType"],
      additionalProperties: false,
    },
  } as const;
}

// Implementación de producción: Anthropic API (claude-haiku-4-5) con
// output_config.format (JSON Schema) para extracción estructurada.
export class ClaudeExpenseInterpreter implements ExpenseInterpreter {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async interpretExpense(text: string, categories: string[]): Promise<unknown[]> {
    logger.debug(`[claude] interpretExpense: model=claude-haiku-4-5 categorías=${categories.length}`);
    const response = await this.client.messages.create({
      model: "claude-haiku-4-5",
      // 1024 alcanzaba para un solo gasto; con el schema como array, un
      // mensaje con varios ítems puede truncar el JSON a mitad de camino.
      max_tokens: 2048,
      system: buildSystemPrompt(todayInArgentina(), categories),
      messages: [{ role: "user", content: text }],
      output_config: {
        format: {
          type: "json_schema",
          schema: buildExpenseSchema(categories),
        },
      },
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude no devolvió el JSON esperado");
    }

    logger.debug(`[claude] respuesta cruda: ${textBlock.text}`);
    return JSON.parse(textBlock.text) as unknown[];
  }
}
