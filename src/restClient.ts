// ThingsBoard API client with re-authentication logic
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
      this.tokenExpiry = Date.now() + 2 * 60 * 60 * 1000 - 60000; // ~2 hours buffer
    } catch (err: any) {
      throw new Error(`Failed to authenticate with ThingsBoard: ${err.message}`);
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.login();
    }
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
        // Attempt immediate token refresh once on unauthorized
        await this.login();
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