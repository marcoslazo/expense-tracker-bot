import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Lectura en runtime (no import de TS) porque package.json vive fuera de
// rootDir ("src") — funciona igual en dev (tsx) y en dist/ compilado, ya
// que ambos quedan a un nivel de la raíz del repo.
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };

export const appVersion = packageJson.version;
