import { config } from '../../config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface AuthHandlers {
  getAccessToken: () => string | null;
  refresh: () => Promise<boolean>;
  onAuthLost: () => void;
}

let handlers: AuthHandlers = {
  getAccessToken: () => null,
  refresh: async () => false,
  onAuthLost: () => undefined,
};

/** Wired once by the auth store at startup. */
export function configureApi(next: AuthHandlers): void {
  handlers = next;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  body?: unknown;
  /** Default true. Set false for register/login. */
  auth?: boolean;
  /** Extra query params. */
  query?: Record<string, string | number | boolean | undefined>;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const withAuth = options.auth ?? true;
  const url = config.apiBaseUrl + path + toQuery(options.query);

  const send = (token: string | null): Promise<Response> =>
    fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let response = await send(withAuth ? handlers.getAccessToken() : null);

  if (response.status === 401 && withAuth) {
    const refreshed = await handlers.refresh();
    if (refreshed) {
      response = await send(handlers.getAccessToken());
    } else {
      handlers.onAuthLost();
    }
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      error?: string;
    };
    throw new ApiError(
      response.status,
      payload.code ?? payload.error ?? 'REQUEST_FAILED',
      payload.message ?? payload.error ?? response.statusText,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function toQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.set(key, String(value));
  return `?${params.toString()}`;
}
