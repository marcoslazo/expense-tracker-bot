const NON_RETRYABLE_STATUSES = new Set([400, 401, 403]);

// 400/401/403 (bad request / auth) van a fallar exactamente igual en el
// segundo intento — no vale la pena gastar el retry ni el backoff en eso.
// Todo lo demás (429, 5xx, errores de red, JSON inválido del LLM sin
// status) sigue reintentándose como antes.
function isNonRetryableStatus(error: unknown): boolean {
  const status = (error as { status?: unknown; response?: { status?: unknown } })?.status ??
    (error as { response?: { status?: unknown } })?.response?.status;
  return typeof status === "number" && NON_RETRYABLE_STATUSES.has(status);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 2, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isNonRetryableStatus(error)) {
        throw error;
      }
      if (attempt < attempts - 1) {
        const delayMs = baseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
