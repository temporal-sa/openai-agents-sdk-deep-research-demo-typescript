import "dotenv/config";

export interface TemporalConfig {
  address: string;
  namespace: string;
  apiKey?: string;
  tls: boolean;
  taskQueue: string;
}

export function temporalConfig(): TemporalConfig {
  const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;
  const address = process.env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || "default";

  return {
    address,
    namespace,
    ...(apiKey ? { apiKey } : {}),
    tls: Boolean(apiKey) || process.env.TEMPORAL_TLS === "true",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE?.trim() || "research-queue",
  };
}

export function temporalUiBaseUrl(config = temporalConfig()): string {
  if (
    config.address.includes("localhost") ||
    config.address.includes("127.0.0.1")
  ) {
    return `http://localhost:8233/namespaces/${encodeURIComponent(config.namespace)}/workflows`;
  }
  return `https://cloud.temporal.io/namespaces/${encodeURIComponent(config.namespace)}/workflows`;
}
