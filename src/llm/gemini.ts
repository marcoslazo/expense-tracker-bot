import { config } from "../config.js";
import { logger } from "../logger.js";
import { EXPENSE_TYPES } from "./types.js";
import type { ExpenseInterpreter } from "./types.js";
import { buildSystemPrompt, todayInArgentina } from "./prompt.js";

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// El schema de Gemini es un subset de OpenAPI 3.0 (no JSON Schema
// completo): no soporta "additionalProperties", a diferencia del schema
// que usa claude.ts. Las categorías se leen en runtime desde la planilla,
// así que el schema no puede ser una constante de módulo — se arma por
// request.
function buildGeminiSchema(categories: string[]) {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        date: { type: "string", format: "date" },
        description: { type: "string" },
        amount: { type: "number" },
        category: { type: "string", enum: categories },
        expenseType: { type: "string", enum: EXPENSE_TYPES },
      },
      required: ["date", "description", "amount", "category", "expenseType"],
    },
  } as const;
}

interface GeminiContentBlock {
  type: string;
  text?: string;
}

interface GeminiStep {
  type: string;
  content?: GeminiContentBlock[];
}

interface GeminiInteractionResponse {
  // Documentado como campo de conveniencia, pero en la práctica no siempre
  // viene — hay que estar preparados para sacar el texto de `steps` igual.
  output_text?: string;
  steps?: GeminiStep[];
}

// El texto generado vive en el step de tipo "model_output" (puede haber
// steps previos de tipo "thought" que no traen el JSON final).
function extractOutputText(data: GeminiInteractionResponse): string | undefined {
  if (data.output_text) {
    return data.output_text;
  }

  const modelOutputStep = data.steps?.find((step) => step.type === "model_output");
  const text = modelOutputStep?.content
    ?.filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("");

  return text || undefined;
}

// Implementación para probar el bot en un entorno real sin costo, usando
// el free tier de la API de Gemini. Decisión informada del usuario: en el
// tier gratuito Google puede usar los mensajes (con revisión humana) para
// mejorar sus productos — por eso queda separada de `claude.ts`, reservado
// para cuando la privacidad de los datos importe más que el costo $0.
// Igual que Ollama, no hay garantía real de schema — devuelve `unknown`.
export class GeminiExpenseInterpreter implements ExpenseInterpreter {
  async interpretExpense(text: string, categories: string[]): Promise<unknown[]> {
    logger.debug(`[gemini] interpretExpense: model=${config.geminiModel} categorías=${categories.length}`);
    const response = await fetch(INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        model: config.geminiModel,
        system_instruction: buildSystemPrompt(todayInArgentina(), categories),
        input: text,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: buildGeminiSchema(categories),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini respondió ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as GeminiInteractionResponse;
    const outputText = extractOutputText(data);
    if (!outputText) {
      logger.warn("[gemini] la respuesta no trajo output_text ni steps con texto usable");
      return [];
    }

    logger.debug(`[gemini] respuesta cruda: ${outputText}`);
    try {
      const parsed: unknown = JSON.parse(outputText);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      logger.warn(`[gemini] output_text no es JSON válido: ${outputText}`);
      return [];
    }
  }
}
