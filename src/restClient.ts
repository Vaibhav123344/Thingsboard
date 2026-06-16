// rest_client.ts
import axios, { AxiosInstance, Method } from 'axios';

export interface ThingsBoardClientConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  verifySsl?: boolean;
}

export class ThingsBoardClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number = 0;
  private pendingLoginPromise: Promise<void> | null = null;

  constructor(private config: ThingsBoardClientConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private async login(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      throw new Error('Username or password credentials missing in ThingsBoard client configuration.');
    }

    try {
      const response = await axios.post(`${this.config.baseUrl}/api/auth/login`, {
        username: this.config.username,
        password: this.config.password,
      });

      this.token = response.data.token;
      this.refreshToken = response.data.refreshToken;
      this.tokenExpiry = this.parseTokenExpiry(response.data.token);
    } catch (err: any) {
      throw new Error(`Failed to authenticate with ThingsBoard: ${err.message}`);
    }
  }

  private parseTokenExpiry(token: string): number {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp) {
          // Subtract a safe 30-second window buffer
          return payload.exp * 1000 - 30000;
        }
      }
    } catch {
      // Graceful fallback to static 2-hour window if parsing fails
    }
    return Date.now() + 2 * 60 * 60 * 1000 - 60000;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return;
    }

    if (this.pendingLoginPromise) {
      return this.pendingLoginPromise;
    }

    this.pendingLoginPromise = this.login().finally(() => {
      this.pendingLoginPromise = null;
    });

    return this.pendingLoginPromise;
  }

  public async request<T>(
    method: Method,
    url: string,
    params?: Record<string, any>,
    data?: any
  ): Promise<T> {
    await this.ensureAuthenticated();

    try {
      const response = await this.http.request<T>({
        method,
        url,
        params,
        data,
        headers: {
          'X-Authorization': `Bearer ${this.token}`,
        },
      });
      return response.data;
    } catch (err: any) {
      if (err.response && err.response.status === 401) {
        // Clear expired token and execute on-the-fly re-authentication
        this.token = null;
        await this.ensureAuthenticated();
        const response = await this.http.request<T>({
          method,
          url,
          params,
          data,
          headers: {
            'X-Authorization': `Bearer ${this.token}`,
          },
        });
        return response.data;
      }
      throw new Error(err.response?.data?.message || err.message || 'Request execution failed');
    }
  }
}