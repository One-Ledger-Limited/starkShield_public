import axios, { AxiosError, AxiosInstance } from 'axios';

export interface ApiClientError {
  code: string;
  message: string;
  status?: number;
  correlationId?: string;
}

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeError(error: AxiosError): ApiClientError {
  const payload = error.response?.data as
    | {
        error?: string;
        code?: string;
        correlation_id?: string;
      }
    | undefined;

  return {
    code: payload?.code ?? 'UNKNOWN_ERROR',
    message: payload?.error ?? error.message ?? 'Request failed',
    status: error.response?.status,
    correlationId: payload?.correlation_id,
  };
}

function resolveBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_SOLVER_API_URL as string | undefined;
  if (typeof window !== 'undefined') {
    if (window.location.protocol === 'https:' && configuredBaseUrl?.startsWith('http://')) {
      // Browsers will block mixed-content requests from HTTPS -> HTTP.
      // In production, the expected setup is a same-origin reverse proxy at `/api`
      // that forwards to the solver service.
      return '/api';
    }
  }
  return configuredBaseUrl ?? '';
}

const baseURL = resolveBaseUrl();

export const apiClient: AxiosInstance = axios.create({
  baseURL,
  timeout: 15000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  if (!config.headers['x-correlation-id']) {
    config.headers['x-correlation-id'] = generateCorrelationId();
  }

  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const normalized = normalizeError(error);

    // If the backend rejects a request due to auth, clear the stale token so the UI
    // can prompt the user to login again (e.g., after a redeploy that rotates JWT_SECRET).
    if (typeof window !== 'undefined' && (normalized.status === 401 || normalized.code === 'UNAUTHORIZED')) {
      try {
        localStorage.removeItem('token');
        window.dispatchEvent(new Event('starkshield:auth:invalid'));
      } catch {
        // Ignore storage/event failures; the original error will still be surfaced.
      }
    }

    return Promise.reject(normalized);
  }
);
