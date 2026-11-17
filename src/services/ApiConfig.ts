const API_BASE_URL_ENV_KEYS = [
  'KONA_API_BASE_URL',
  'EXPO_PUBLIC_KONA_API_BASE_URL',
] as const;

export function resolveApiBaseUrl(): string {
  for (const key of API_BASE_URL_ENV_KEYS) {
    const value =
      typeof process !== 'undefined' && typeof process.env[key] === 'string'
        ? process.env[key].trim()
        : '';
    if (value) {
      return value.replace(/\/+$/, '');
    }
  }

  throw new Error(
    '[ApiConfig] Missing API base URL. Configure KONA_API_BASE_URL or EXPO_PUBLIC_KONA_API_BASE_URL.',
  );
}
