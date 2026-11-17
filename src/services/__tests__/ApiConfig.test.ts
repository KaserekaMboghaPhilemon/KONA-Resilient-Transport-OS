import { resolveApiBaseUrl } from '../ApiConfig';

describe('resolveApiBaseUrl', () => {
  const originalKonaUrl = process.env.KONA_API_BASE_URL;
  const originalExpoUrl = process.env.EXPO_PUBLIC_KONA_API_BASE_URL;

  afterEach(() => {
    if (originalKonaUrl === undefined) {
      delete process.env.KONA_API_BASE_URL;
    } else {
      process.env.KONA_API_BASE_URL = originalKonaUrl;
    }
    if (originalExpoUrl === undefined) {
      delete process.env.EXPO_PUBLIC_KONA_API_BASE_URL;
    } else {
      process.env.EXPO_PUBLIC_KONA_API_BASE_URL = originalExpoUrl;
    }
  });

  it('prefers the server-configured API URL and removes trailing slashes', () => {
    process.env.KONA_API_BASE_URL = 'https://kona.example/api/';
    process.env.EXPO_PUBLIC_KONA_API_BASE_URL = 'https://public.example/';

    expect(resolveApiBaseUrl()).toBe('https://kona.example/api');
  });

  it('supports Expo public runtime configuration', () => {
    delete process.env.KONA_API_BASE_URL;
    process.env.EXPO_PUBLIC_KONA_API_BASE_URL = 'https://mobile.example/';

    expect(resolveApiBaseUrl()).toBe('https://mobile.example');
  });

  it('fails explicitly when no API URL is configured rather than targeting localhost', () => {
    delete process.env.KONA_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_KONA_API_BASE_URL;

    expect(() => resolveApiBaseUrl()).toThrow(/Missing API base URL/);
  });
});
