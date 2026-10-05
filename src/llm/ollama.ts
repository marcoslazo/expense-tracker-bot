import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ExpenseInterpreter } from "./types.js";
import { buildSystemPrompt, todayInArgentina } from "./prompt.js";

interface OllamaGenerateResponse {
  response: string;
}

// Implementación solo para desarrollo local: Ollama + Qwen/Gemma, usada
// para comparar calidad/costo contra Claude Haiku 4.5. Nunca se despliega
// en producción — requiere `ollama serve` corriendo en la máquina local.
// A diferencia de Claude, no hay garantía de schema — el JSON puede venir
// incompleto o con campos inválidos; por eso interpretExpense devuelve
// `unknown` y la validación real ocurre en `validateExpense` (bot.ts).
export class OllamaExpenseInterpreter implements ExpenseInterpreter {
  async interpretExpense(text: string, categories: string[]): Promise<unknown[]> {
    const prompt = [
      buildSystemPrompt(todayInArgentina(), categories),
      `Respondé ÚNICAMENTE con un JSON de esta forma exacta, sin texto adicional ni`,
      `explicaciones: un array con un objeto por cada gasto mencionado en el mensaje,`,
      `cada uno con la forma {"date": "YYYY-MM-DD", "description": string, "amount":`,
      `number, "category": una de [${categories.join(", ")}], "expenseType": "diario" |`,
      `"extraordinario"}. Ejemplo para un solo gasto: [{"date": "...", ...}].`,
      `Mensaje del usuario: ${text}`,
    ].join(" ");

    logger.debug(`[ollama] interpretExpense: model=${config.ollamaModel} categorías=${categories.length}`);
    const response = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt,
        format: "json",
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama respondió ${response.status}: ${await response.text()} ` +
          `(¿está corriendo "ollama serve" y descargado el modelo "${config.ollamaModel}"?)`,
      );
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    logger.debug(`[ollama] respuesta cruda: ${data.response}`);
    try {
      const parsed: unknown = JSON.parse(data.response);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      logger.warn(`[ollama] response no es JSON válido: ${data.response}`);
      return [];
    }
  }
}
