import http from "node:http";
import { webhookCallback } from "grammy";
import { bot, registerCommands } from "./bot.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

bot.catch((err) => {
  logger.error("Error procesando webhook:", err.error);
});

if (config.llmProvider === "ollama") {
  throw new Error(
    "LLM_PROVIDER=ollama no puede correr en el build desplegado — Cloud Run " +
      "no tiene un proceso persistente para alojar un modelo local.",
  );
}

if (!config.webhookSecretToken) {
  throw new Error(
    "Missing WEBHOOK_SECRET_TOKEN — it is required to run in webhook mode.",
  );
}

registerCommands(bot).catch((error) => {
  logger.error("Error registrando comandos del bot:", error);
});

const handleUpdate = webhookCallback(bot, "http", { secretToken: config.webhookSecretToken });

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url === "/webhook" && req.method === "POST") {
    // grammY corta la espera a los 10s por default (onTimeout: "throw") y esa
    // promesa rechazada, sin catch, tumbaba el proceso entero cuando el LLM
    // tardaba más (unhandled rejection) — Cloud Run reiniciaba la instancia,
    // Telegram reintentaba el mismo update, y el reintento caía en una
    // instancia nueva sin memoria de seenUpdateIds, duplicando la respuesta.
    // El timeout no cancela el procesamiento real: sigue en
    // curso y termina mandando su propia respuesta por Bot API vía
    // ctx.reply — acá solo evitamos el crash y le devolvemos 200 a Telegram
    // para que no reintente.
    handleUpdate(req, res).catch((error) => {
      logger.error("Timeout esperando la respuesta del webhook (el update sigue procesándose en segundo plano):", error);
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(config.port, () => {
  logger.info(
    `Servidor webhook escuchando en el puerto ${config.port} — ` +
      `proveedor LLM: ${config.llmProvider}, log level: ${config.logLevel}`,
  );
});
