// Compartido entre las tres implementaciones de ExpenseInterpreter — el
// texto de instrucción debe ser el mismo sin importar el proveedor. Las
// categorías se pasan como parámetro porque se leen en runtime desde la
// planilla (ver sheets.ts), no son un enum fijo en el código.
export function buildSystemPrompt(today: string, categories: string[]): string {
  return [
    `Sos un asistente que extrae datos estructurados de gastos personales a partir de`,
    `mensajes en español rioplatense. La fecha de hoy es ${today} (zona horaria`,
    `Argentina). Resolvé referencias relativas como "hoy", "ayer" o días de la semana a`,
    `fechas absolutas en formato YYYY-MM-DD. Clasificá el gasto en una de estas`,
    `categorías: ${categories.join(", ")}. Un gasto es "diario" si es una compra`,
    `habitual o rutinaria (almacén, transporte, servicios) y "extraordinario" si es`,
    `algo puntual o fuera de lo rutinario (salidas, compras de ropa, entretenimiento).`,
    `Si el mensaje no da suficiente info para decidir la categoría o el tipo con`,
    `certeza, elegí la opción más probable en vez de dejarla ambigua — no hace`,
    `falta preguntar, el usuario va a poder corregir después. El mensaje puede`,
    `describir varios gastos distintos, cada uno con su propio monto explícito —`,
    `en ese caso, devolvé un ítem por cada monto, cada uno clasificado de forma`,
    `independiente (su propia categoría y su propio tipo). Separalos solo cuando`,
    `haya más de un monto mencionado en el mensaje: la palabra "y" o una coma`,
    `dentro de la descripción de un mismo monto (ej. "5000 en pan y leche") NO`,
    `es una separación entre gastos, es parte de un único concepto — no lo`,
    `partas en varios ítems inventando cómo dividir ese monto. Nunca sumes`,
    `montos ni agrupes conceptos vos mismo: eso lo hace el código después, tu`,
    `trabajo es solo separar y clasificar.`,
  ].join(" ");
}

export function todayInArgentina(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
}
