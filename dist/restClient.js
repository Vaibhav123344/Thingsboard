"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThingsBoardClient = void 0;
// rest_client.ts
const axios_1 = __importDefault(require("axios"));
class ThingsBoardClient {
    config;
    http;
    token = null;
    refreshToken = null;
    tokenExpiry = 0;
    pendingLoginPromise = null;
    constructor(config) {
        this.config = config;
        this.http = axios_1.default.create({
            baseURL: config.baseUrl,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
    async login() {
        if (!this.config.username || !this.config.password) {
            throw new Error('Username or password credentials missing in ThingsBoard client configuration.');
        }
        try {
            const response = await axios_1.default.post(`${this.config.baseUrl}/api/auth/login`, {
                username: this.config.username,
                password: this.config.password,
            });
            this.token = response.data.token;
            this.refreshToken = response.data.refreshToken;
            this.tokenExpiry = this.parseTokenExpiry(response.data.token);
        }
        catch (err) {
            throw new Error(`Failed to authenticate with ThingsBoard: ${err.message}`);
        }
    }
    parseTokenExpiry(token) {
        try {
            const parts = token.split('.');
            if (parts.length === 3) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                if (payload.exp) {
                    // Subtract a safe 30-second window buffer
                    return payload.exp * 1000 - 30000;
                }
            }
        }
        catch {
            // Graceful fallback to static 2-hour window if parsing fails
        }
        return Date.now() + 2 * 60 * 60 * 1000 - 60000;
    }
    async ensureAuthenticated() {
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
    async request(method, url, params, data) {
        await this.ensureAuthenticated();
        try {
            const response = await this.http.request({
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
        catch (err) {
            if (err.response && err.response.status === 401) {
                // Clear expired token and execute on-the-fly re-authentication
                this.token = null;
                await this.ensureAuthenticated();
                const response = await this.http.request({
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
exports.ThingsBoardClient = ThingsBoardClient;
// // ThingsBoard API client with re-authentication logic
// import axios, { AxiosInstance, Method } from 'axios';
// export interface ThingsBoardClientConfig {
//   baseUrl: string;
//   username?: string;
//   password?: string;
//   verifySsl?: boolean;
// }
// export class ThingsBoardClient {
//   private http: AxiosInstance;
//   private token: string | null = null;
//   private refreshToken: string | null = null;
//   private tokenExpiry: number = 0;
//   constructor(private config: ThingsBoardClientConfig) {
//     this.http = axios.create({
//       baseURL: config.baseUrl,
//       headers: {
//         'Content-Type': 'application/json',
//       },
//     });
//   }
//   private async login(): Promise<void> {
//     if (!this.config.username || !this.config.password) {
//       throw new Error('Username or password credentials missing in ThingsBoard client configuration.');
//     }
//     try {
//       const response = await axios.post(`${this.config.baseUrl}/api/auth/login`, {
//         username: this.config.username,
//         password: this.config.password,
//       });
//       this.token = response.data.token;
//       this.refreshToken = response.data.refreshToken;
//       this.tokenExpiry = Date.now() + 2 * 60 * 60 * 1000 - 60000; // ~2 hours buffer
//     } catch (err: any) {
//       throw new Error(`Failed to authenticate with ThingsBoard: ${err.message}`);
//     }
//   }
//   private async ensureAuthenticated(): Promise<void> {
//     if (!this.token || Date.now() >= this.tokenExpiry) {
//       await this.login();
//     }
//   }
//   public async request<T>(
//     method: Method,
//     url: string,
//     params?: Record<string, any>,
//     data?: any
//   ): Promise<T> {
//     await this.ensureAuthenticated();
//     try {
//       const response = await this.http.request<T>({
//         method,
//         url,
//         params,
//         data,
//         headers: {
//           'X-Authorization': `Bearer ${this.token}`,
//         },
//       });
//       return response.data;
//     } catch (err: any) {
//       if (err.response && err.response.status === 401) {
//         // Attempt immediate token refresh once on unauthorized
//         await this.login();
//         const response = await this.http.request<T>({
//           method,
//           url,
//           params,
//           data,
//           headers: {
//             'X-Authorization': `Bearer ${this.token}`,
//           },
//         });
//         return response.data;
//       }
//       throw new Error(err.response?.data?.message || err.message || 'Request execution failed');
//     }
//   }
// }
