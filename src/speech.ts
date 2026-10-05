import { google } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";

function getSpeechAuthClient() {
  const credentials = JSON.parse(config.googleServiceAccountKey);
  // Speech-to-Text v1 solo soporta el scope amplio cloud-platform — a
  // diferencia de Sheets, no existe un scope específico para Speech. El
  // mínimo privilegio real se aplica del lado de IAM (rol Cloud Speech
  // Client en el service account), no acá.
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

function getSpeechClient() {
  return google.speech({ version: "v1", auth: getSpeechAuthClient() });
}

// Telegram manda las notas de voz nativamente en OGG/Opus a 48kHz — se
// transcribe tal cual, sin transcodificar.
export async function transcribeVoice(audio: Buffer): Promise<string> {
  const speech = getSpeechClient();
  const { data } = await speech.speech.recognize({
    requestBody: {
      config: {
        encoding: "OGG_OPUS",
        sampleRateHertz: 48000,
        languageCode: "es-AR",
      },
      audio: {
        content: audio.toString("base64"),
      },
    },
  });

  const transcript = (data.results ?? [])
    .map((result) => result.alternatives?.[0]?.transcript)
    .filter((text): text is string => Boolean(text))
    .join(" ");

  logger.debug(`[speech] transcribeVoice: ${data.results?.length ?? 0} resultado(s) — "${transcript}"`);
  return transcript;
}
