import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

export class ThingsBoardException extends Error {
  constructor(public statusCode: number | undefined, message: string) {
    super(`ThingsBoard API Error [Status ${statusCode ?? 'Unknown'}]: ${message}`);
    this.name = 'ThingsBoardException';
  }
}

interface JwtPayload {
  exp?: number;
  [key: string]: any;
}

export class ThingsBoardClient {
  private baseUrl: string;
  private apiKey?: string;
  private username?: string;
  private password?: string;
  private timeoutMs: number;
  private retryAttempts: number;
  private retryDelayMs: number;

  private token: string | null = null;
  private refreshToken: string | null = null;
  private axiosInstance: AxiosInstance;

  constructor(config: {
    baseUrl?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    timeoutSeconds?: number;
    retryAttempts?: number;
    retryDelayMs?: number;
    verifySsl?: boolean;
  }) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:8080').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.username = config.username ?? 'tenant@thingsboard.org';
    this.password = config.password ?? 'tenant';
    this.timeoutMs = (config.timeoutSeconds ?? 10) * 1000;
    this.retryAttempts = config.retryAttempts ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;

    // Node.js TLS verification bypass if specified
    if (config.verifySsl === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
    });
  }

  private decodeJwt(token: string): JwtPayload {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return {};
      const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
      return JSON.parse(payload) as JwtPayload;
    } catch {
      return {};
    }
  }

  private isTokenExpired(): boolean {
    if (!this.token) return true;
    const decoded = this.decodeJwt(this.token);
    const expiration = decoded.exp;
    if (!expiration) return true;

    const currentTime = Math.floor(Date.now() / 1000);
    // Refresh token if it is within 5 minutes of expiring
    return expiration - currentTime < 300;
  }

  private async login(): Promise<void> {
    if (!this.username || !this.password) {
      throw new Error('Credentials are required when no API Key is specified.');
    }
    try {
      const response = await axios.post(`${this.baseUrl}/api/auth/login`, {
        username: this.username,
        password: this.password,
      }, { timeout: this.timeoutMs });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new ThingsBoardException(status, `Login execution failed: ${msg}`);
    }
  }

  private async refreshJwt(): Promise<void> {
    if (!this.refreshToken) {
      await this.login();
      return;
    }
    try {
      const response = await axios.post(`${this.baseUrl}/api/auth/token`, {
        refreshToken: this.refreshToken,
      }, { timeout: this.timeoutMs });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
    } catch {
      await this.login();
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.apiKey) return;
    if (!this.token) {
      await this.login();
      return;
    }
    if (this.isTokenExpired()) {
      await this.refreshJwt();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params?: Record<string, any>,
    data?: any,
    headers?: Record<string, string>
  ): Promise<T> {
    let attempts = 0;

    while (attempts < this.retryAttempts) {
      try {
        await this.ensureAuthenticated();

        const requestHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(headers ?? {}),
        };

        if (this.apiKey) {
          requestHeaders['X-Authorization'] = `ApiKey ${this.apiKey}`;
        } else if (this.token) {
          requestHeaders['X-Authorization'] = `Bearer ${this.token}`;
        }

        const config: InternalAxiosRequestConfig = {
          method,
          url: path,
          params,
          data,
          headers: requestHeaders as any,
        } as any;

        const response = await this.axiosInstance.request<T>(config);
        return response.data;
      } catch (error: any) {
        attempts++;
        const status = error.response?.status;
        const isClientFault = status && status >= 400 && status < 500 && status !== 401 && status !== 429;

        if (status === 401 && !this.apiKey) {
          this.token = null; // Forces re-authentication on the next loop
          continue;
        }

        if (attempts >= this.retryAttempts || isClientFault) {
          const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
          throw new ThingsBoardException(status, msg);
        }

        const delay = this.retryDelayMs * Math.pow(2, attempts - 1);
        await this.sleep(delay);
      }
    }

    throw new ThingsBoardException(undefined, 'Request failed: Retry limit reached');
  }
}