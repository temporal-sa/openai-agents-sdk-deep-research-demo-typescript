import { Client, Connection } from "@temporalio/client";

import { temporalConfig } from "./config.js";

export async function createTemporalClient(): Promise<Client> {
  const config = temporalConfig();
  const connection = await Connection.connect({
    address: config.address,
    tls: config.tls,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
  return new Client({ connection, namespace: config.namespace });
}
