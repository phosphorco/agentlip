/**
 * Bootstrap runtime configuration from hub
 */

export interface BootstrapConfig {
  baseUrl: string;
  wsUrl: string;
  authToken: string;
  buildVersion: string;
}

let cachedConfig: BootstrapConfig | null = null;

export async function getBootstrap(): Promise<BootstrapConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const res = await fetch("/ui/bootstrap");

  if (!res.ok) {
    throw new Error(`Bootstrap failed: ${res.status}`);
  }

  cachedConfig = await res.json();
  return cachedConfig!;
}
