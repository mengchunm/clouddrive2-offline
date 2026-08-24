export type AppConfig = {
  grpcBaseUrl: string;
  apiToken: string;
  offlineDestPath: string;
};

export const DEFAULT_APP_CONFIG: Readonly<AppConfig> = Object.freeze({
  grpcBaseUrl: "http://localhost:19798",
  apiToken: "",
  offlineDestPath: "/",
});

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Normalize old, partial or corrupted stored settings without throwing. */
export function normalizeAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_APP_CONFIG };
  const stored = value as Record<string, unknown>;
  return {
    grpcBaseUrl: readNonEmptyString(stored.grpcBaseUrl, DEFAULT_APP_CONFIG.grpcBaseUrl),
    apiToken: typeof stored.apiToken === "string" ? stored.apiToken.trim() : DEFAULT_APP_CONFIG.apiToken,
    offlineDestPath: readNonEmptyString(stored.offlineDestPath, DEFAULT_APP_CONFIG.offlineDestPath),
  };
}
