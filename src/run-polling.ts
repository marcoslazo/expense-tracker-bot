import { bot, registerCommands } from "./bot.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

bot.catch((err) => {
  logger.error("Error en el loop de long polling:", err.error);
});

registerCommands(bot).catch((error) => {
  logger.error("Error registrando comandos del bot:", error);
});

bot.start({
  onStart: (botInfo) => {
    logger.info(
      `Bot conectado como @${botInfo.username} — long polling activo, ` +
        `proveedor LLM: ${config.llmProvider}, log level: ${config.logLevel}`,
    );
  },
});
