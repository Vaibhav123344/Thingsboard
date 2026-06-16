"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSimulatorAPI = startSimulatorAPI;
// simulator.ts
const express_1 = __importDefault(require("express"));
const mqtt = __importStar(require("mqtt"));
const http = __importStar(require("http"));
const path = __importStar(require("path"));
const ws_1 = require("ws");
const dotenv = __importStar(require("dotenv"));
const live_agent_ws_1 = require("./live_agent_ws");
const restClient_1 = require("./restClient");
const bridge_1 = require("./bridge");
dotenv.config();
const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;
const DEVICES_CONFIG = {
    'Smart-Industrial-Sensor-01': undefined,
    'Smart-Industrial-Sensor-02': undefined,
};
class StableMQTTClient {
    deviceName;
    token;
    client = null;
    connected = false;
    constructor(deviceName, token) {
        this.deviceName = deviceName;
        this.token = token;
    }
    connect() {
        const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
        this.client = mqtt.connect(brokerUrl, {
            username: this.token,
            reconnectPeriod: 5000,
            connectTimeout: 30 * 1000,
        });
        this.client.on('connect', () => {
            this.connected = true;
            console.log(`✓ Connected to ThingsBoard MQTT for ${this.deviceName}`);
        });
        this.client.on('offline', () => {
            this.connected = false;
            console.warn(`⚠️ MQTT Client Offline for ${this.deviceName}. Pause publishing.`);
        });
        this.client.on('error', (err) => {
            console.error(`MQTT Client Error on ${this.deviceName}:`, err.message);
        });
    }
    publish(telemetry) {
        return new Promise((resolve) => {
            // Guards against publishing telemetry when connection drops [2.3.1]
            if (!this.client || !this.connected) {
                return resolve(false);
            }
            this.client.publish('v1/devices/me/telemetry', JSON.stringify(telemetry), { qos: 1 }, (err) => {
                if (err)
                    resolve(false);
                else
                    resolve(true);
            });
        });
    }
    disconnect() {
        if (this.client) {
            this.client.end();
            this.connected = false;
        }
    }
}
const activeClients = {};
const deviceIntervals = {};
function generateSensorTelemetry() {
    return {
        temperature: parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2)),
        humidity: parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2)),
        pressure: parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3)),
        vibration: parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2)),
    };
}
async function autoProvisionDevices() {
    console.log('🔄 Checking and auto-provisioning devices in ThingsBoard...');
    const tbClient = new restClient_1.ThingsBoardClient({
        baseUrl: process.env.THINGSBOARD_HOST || 'http://localhost:8080',
        username: process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org',
        password: process.env.THINGSBOARD_PASSWORD || 'tenant',
        verifySsl: false,
    });
    const deviceNames = Object.keys(DEVICES_CONFIG);
    for (const name of deviceNames) {
        try {
            let deviceId = null;
            try {
                const response = await tbClient.request('GET', '/api/tenant/device', { deviceName: name });
                if (response && response.id) {
                    deviceId = response.id.id;
                    console.log(`✓ Device found: ${name} (${deviceId})`);
                }
            }
            catch {
                // Handled silently
            }
            if (!deviceId) {
                console.log(`+ Creating device: ${name}...`);
                const createResponse = await tbClient.request('POST', '/api/device', undefined, {
                    name,
                    type: 'sensor',
                });
                deviceId = createResponse.id.id;
                console.log(`✓ Device created: ${name} (${deviceId})`);
            }
            const credentials = await tbClient.request('GET', `/api/device/${deviceId}/credentials`);
            const token = credentials.credentialsId;
            if (token) {
                DEVICES_CONFIG[name] = token;
                console.log(`✓ Access Token resolved programmatically for ${name}`);
            }
        }
        catch (err) {
            console.error(`❌ Failed to auto-provision credentials for ${name}:`, err.message || err);
        }
    }
}
async function startSimulatorAPI() {
    const app = (0, express_1.default)();
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Access-Control-Allow-Credentials', 'true');
        }
        else {
            res.header('Access-Control-Allow-Origin', '*');
        }
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });
    app.use(express_1.default.json());
    const reportsDir = path.join(process.cwd(), 'reports');
    app.use('/reports', express_1.default.static(reportsDir));
    await autoProvisionDevices();
    for (const [name, token] of Object.entries(DEVICES_CONFIG)) {
        if (token) {
            const client = new StableMQTTClient(name, token);
            client.connect();
            activeClients[name] = client;
        }
    }
    app.post('/simulation/start/:deviceName', (req, res) => {
        const { deviceName } = req.params;
        const client = activeClients[deviceName];
        if (!client)
            return res.status(400).json({ error: 'Device not active' });
        if (deviceIntervals[deviceName])
            return res.json({ status: 'Already running' });
        deviceIntervals[deviceName] = setInterval(async () => {
            // Check client connection state before executing network tasks [2.3.1]
            if (client.connected) {
                const payload = generateSensorTelemetry();
                await client.publish(payload);
            }
        }, SIMULATION_INTERVAL_MS);
        res.json({ status: `Simulation started for ${deviceName}` });
    });
    app.post('/simulation/stop/:deviceName', (req, res) => {
        const { deviceName } = req.params;
        if (deviceIntervals[deviceName]) {
            clearInterval(deviceIntervals[deviceName]);
            delete deviceIntervals[deviceName];
            return res.json({ status: `Simulation stopped for ${deviceName}` });
        }
        res.json({ status: 'Not running' });
    });
    app.post('/simulation/start_all', (req, res) => {
        for (const name of Object.keys(activeClients)) {
            if (!deviceIntervals[name]) {
                deviceIntervals[name] = setInterval(async () => {
                    if (activeClients[name].connected) {
                        await activeClients[name].publish(generateSensorTelemetry());
                    }
                }, SIMULATION_INTERVAL_MS);
            }
        }
        res.json({ status: 'All simulations active' });
    });
    app.post('/simulation/stop_all', (req, res) => {
        for (const name of Object.keys(deviceIntervals)) {
            clearInterval(deviceIntervals[name]);
            delete deviceIntervals[name];
        }
        res.json({ status: 'All simulations suspended' });
    });
    app.get('/simulation/status', (req, res) => {
        const status = {};
        for (const name of Object.keys(activeClients)) {
            status[name] = { running: !!deviceIntervals[name] };
        }
        res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
    });
    app.get('/simulation/devices', async (req, res) => {
        const bridge = new bridge_1.ThingsBoardRESTBridge();
        try {
            const devices = await bridge.listDevices();
            res.json(devices);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.get('/simulation/telemetry/:deviceName', async (req, res) => {
        const { deviceName } = req.params;
        const bridge = new bridge_1.ThingsBoardRESTBridge();
        try {
            const telemetry = await bridge.getLatestTelemetry(deviceName);
            res.json(telemetry);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.post('/simulation/forecast_what_if', async (req, res) => {
        const bridge = new bridge_1.ThingsBoardRESTBridge();
        try {
            const result = await bridge.forecastWhatIf(req.body);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    const server = http.createServer(app);
    const wss = new ws_1.WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
        if (pathname === '/ws/voice') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        }
        else {
            socket.destroy();
        }
    });
    // Updated WebSocket block in simulator.ts
    wss.on('connection', (ws) => {
        const broker = new live_agent_ws_1.GeminiLiveWSBroker(ws);
        broker.start();
        let isAlive = true;
        ws.on('pong', () => { isAlive = true; });
        const pingInterval = setInterval(() => {
            if (!isAlive) {
                clearInterval(pingInterval);
                return ws.terminate();
            }
            isAlive = false;
            ws.ping();
        }, 30000);
        // Seamlessly handles BOTH binary streams (PCM chunks) and stringified JSON payloads
        ws.on('message', (message, isBinary) => {
            try {
                if (isBinary || Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
                    const rawBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
                    const base64Audio = rawBuffer.toString('base64');
                    broker.handleClientMessage({
                        type: 'audio_chunk',
                        data: base64Audio
                    });
                }
                else {
                    const parsed = JSON.parse(message.toString());
                    broker.handleClientMessage(parsed);
                }
            }
            catch (e) {
                console.warn('[WS Gateway] Bypassing malformed client packet:', e.message);
            }
        });
        ws.on('close', () => {
            clearInterval(pingInterval);
            broker.close();
        });
    });
    const PORT = 9005;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
        console.log(`WebSocket Gateway mounted on ws://localhost:${PORT}/ws/voice`);
    });
}
process.on('SIGTERM', () => {
    console.log('Ingestion termination caught. Unsubscribing MQTT clients...');
    for (const interval of Object.values(deviceIntervals)) {
        clearInterval(interval);
    }
    for (const client of Object.values(activeClients)) {
        client.disconnect();
    }
    process.exit(0);
});
if (require.main === module) {
    startSimulatorAPI();
}
// import express, { Request, Response } from 'express';
// import * as mqtt from 'mqtt';
// import * as http from 'http';
// import * as path from 'path';
// import { WebSocketServer, WebSocket } from 'ws';
// import * as dotenv from 'dotenv';
// import { GeminiLiveWSBroker } from './live_agent_ws';
// import { ThingsBoardClient } from './restClient';
// import { ThingsBoardRESTBridge } from './bridge';
// dotenv.config();
// const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
// const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
// const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;
// // Dynamic configuration holding resolved tokens
// const DEVICES_CONFIG: Record<string, string | undefined> = {
//   'Smart-Industrial-Sensor-01': undefined,
//   'Smart-Industrial-Sensor-02': undefined,
// };
// class StableMQTTClient {
//   private client: mqtt.MqttClient | null = null;
//   public connected = false;
//   constructor(public deviceName: string, private token: string) {}
//   public connect(): void {
//     const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
//     this.client = mqtt.connect(brokerUrl, {
//       username: this.token,
//       reconnectPeriod: 5000,
//       connectTimeout: 30 * 1000,
//     });
//     this.client.on('connect', () => {
//       this.connected = true;
//       console.log(`✓ Connected to ThingsBoard MQTT for ${this.deviceName}`);
//     });
//     this.client.on('offline', () => {
//       this.connected = false;
//     });
//     this.client.on('error', (err) => {
//       console.error(`MQTT Client Error on ${this.deviceName}:`, err.message);
//     });
//   }
//   public publish(telemetry: Record<string, any>): Promise<boolean> {
//     return new Promise((resolve) => {
//       if (!this.client || !this.connected) {
//         return resolve(false);
//       }
//       this.client.publish('v1/devices/me/telemetry', JSON.stringify(telemetry), { qos: 1 }, (err) => {
//         if (err) resolve(false);
//         else resolve(true);
//       });
//     });
//   }
//   public disconnect(): void {
//     if (this.client) this.client.end();
//   }
// }
// const activeClients: Record<string, StableMQTTClient> = {};
// const deviceIntervals: Record<string, NodeJS.Timeout> = {};
// function generateSensorTelemetry(): Record<string, number> {
//   return {
//     temperature: parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2)),
//     humidity: parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2)),
//     pressure: parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3)),
//     vibration: parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2)),
//   };
// }
// /**
//  * Automatically queries ThingsBoard, provisions missing devices, and
//  * extracts their valid active MQTT Access Tokens.
//  */
// async function autoProvisionDevices() {
//   console.log('🔄 Checking and auto-provisioning devices in ThingsBoard...');
//   const tbClient = new ThingsBoardClient({
//     baseUrl: process.env.THINGSBOARD_HOST || 'http://localhost:8080',
//     username: process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org',
//     password: process.env.THINGSBOARD_PASSWORD || 'tenant',
//     verifySsl: false,
//   });
//   const deviceNames = Object.keys(DEVICES_CONFIG);
//   for (const name of deviceNames) {
//     try {
//       let deviceId: string | null = null;
//       // 1. Check if the device exists using the singular route
//       try {
//         const response = await tbClient.request<any>('GET', '/api/tenant/device', { deviceName: name });
//         if (response && response.id) {
//           deviceId = response.id.id;
//           console.log(`✓ Device found: ${name} (${deviceId})`);
//         }
//       } catch {
//         // Singular endpoint throws an error (404) if not found, proceeding to step 2
//       }
//       // 2. If missing, create the device
//       if (!deviceId) {
//         console.log(`+ Creating device: ${name}...`);
//         const createResponse = await tbClient.request<any>('POST', '/api/device', undefined, {
//           name,
//           type: 'sensor',
//         });
//         deviceId = createResponse.id.id;
//         console.log(`✓ Device created: ${name} (${deviceId})`);
//       }
//       // 3. Query the device credentials to extract the active token
//       const credentials = await tbClient.request<any>('GET', `/api/device/${deviceId}/credentials`);
//       const token = credentials.credentialsId;
//       if (token) {
//         DEVICES_CONFIG[name] = token;
//         console.log(`✓ Access Token resolved programmatically for ${name}`);
//       }
//     } catch (err: any) {
//       console.error(`❌ Failed to auto-provision credentials for ${name}:`, err.message || err);
//     }
//   }
// }
// export async function startSimulatorAPI() {
//   const app = express();
//   // Intercept and resolve CORS and Preflight OPTIONS requests
//   app.use((req, res, next) => {
//     const origin = req.headers.origin;
//     if (origin) {
//       res.header('Access-Control-Allow-Origin', origin);
//       res.header('Access-Control-Allow-Credentials', 'true');
//     } else {
//       res.header('Access-Control-Allow-Origin', '*');
//     }
//     res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
//     res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//     // Immediately terminate preflight requests with 204 No Content
//     if (req.method === 'OPTIONS') {
//       return res.sendStatus(204);
//     }
//     next();
//   });
//   app.use(express.json());
//   // Serve static generated HTML audit reports
//   const reportsDir = path.join(process.cwd(), 'reports');
//   app.use('/reports', express.static(reportsDir));
//   // Run the programmatic dynamic token resolver before starting clients
//   await autoProvisionDevices();
//   // Initialize Active Clients with verified tokens
//   for (const [name, token] of Object.entries(DEVICES_CONFIG)) {
//     if (token) {
//       const client = new StableMQTTClient(name, token);
//       client.connect();
//       activeClients[name] = client;
//     }
//   }
//   app.post('/simulation/start/:deviceName', (req: Request, res: Response) => {
//     const { deviceName } = req.params;
//     const client = activeClients[deviceName];
//     if (!client) return res.status(400).json({ error: 'Device not active' });
//     if (deviceIntervals[deviceName]) return res.json({ status: 'Already running' });
//     deviceIntervals[deviceName] = setInterval(async () => {
//       const payload = generateSensorTelemetry();
//       await client.publish(payload);
//     }, SIMULATION_INTERVAL_MS);
//     res.json({ status: `Simulation started for ${deviceName}` });
//   });
//   app.post('/simulation/stop/:deviceName', (req: Request, res: Response) => {
//     const { deviceName } = req.params;
//     if (deviceIntervals[deviceName]) {
//       clearInterval(deviceIntervals[deviceName]);
//       delete deviceIntervals[deviceName];
//       return res.json({ status: `Simulation stopped for ${deviceName}` });
//     }
//     res.json({ status: 'Not running' });
//   });
//   app.post('/simulation/start_all', (req: Request, res: Response) => {
//     for (const name of Object.keys(activeClients)) {
//       if (!deviceIntervals[name]) {
//         deviceIntervals[name] = setInterval(async () => {
//           await activeClients[name].publish(generateSensorTelemetry());
//         }, SIMULATION_INTERVAL_MS);
//       }
//     }
//     res.json({ status: 'All simulations active' });
//   });
//   app.post('/simulation/stop_all', (req: Request, res: Response) => {
//     for (const name of Object.keys(deviceIntervals)) {
//       clearInterval(deviceIntervals[name]);
//       delete deviceIntervals[name];
//     }
//     res.json({ status: 'All simulations suspended' });
//   });
//   app.get('/simulation/status', (req: Request, res: Response) => {
//     const status: Record<string, { running: boolean }> = {};
//     for (const name of Object.keys(activeClients)) {
//       status[name] = { running: !!deviceIntervals[name] };
//     }
//     res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
//   });
//   app.get('/simulation/devices', async (req: Request, res: Response) => {
//     const bridge = new ThingsBoardRESTBridge();
//     try {
//       const devices = await bridge.listDevices();
//       res.json(devices);
//     } catch (err: any) {
//       res.status(500).json({ error: err.message });
//     }
//   });
//   app.get('/simulation/telemetry/:deviceName', async (req: Request, res: Response) => {
//     const { deviceName } = req.params;
//     const bridge = new ThingsBoardRESTBridge();
//     try {
//       const telemetry = await bridge.getLatestTelemetry(deviceName);
//       res.json(telemetry);
//     } catch (err: any) {
//       res.status(500).json({ error: err.message });
//     }
//   });
//   // Serve static production build files if deployed
//   const feBuildPath = path.join(process.cwd(), 'frontend', 'dist');
//   app.use(express.static(feBuildPath));
//   app.get('*', (req, res, next) => {
//     if (req.path.startsWith('/simulation') || req.path.startsWith('/reports') || req.path.startsWith('/ws')) {
//       return next();
//     }
//     res.sendFile(path.join(feBuildPath, 'index.html'), (err) => {
//       if (err) res.status(404).send('Dashboard production assets not built yet. Run local development server.');
//     });
//   });
//   // Initialize unified HTTP server to support WebSockets multiplexing
//   const server = http.createServer(app);
//   const wss = new WebSocketServer({ noServer: true });
//   server.on('upgrade', (request, socket, head) => {
//     const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
//     if (pathname === '/ws/voice') {
//       wss.handleUpgrade(request, socket, head, (ws) => {
//         wss.emit('connection', ws, request);
//       });
//     } else {
//       socket.destroy();
//     }
//   });
//   wss.on('connection', (ws: WebSocket) => {
//     const broker = new GeminiLiveWSBroker(ws);
//     broker.start();
//     ws.on('message', (message: string) => {
//       try {
//         const parsed = JSON.parse(message);
//         broker.handleClientMessage(parsed);
//       } catch (e) {
//         // Skip unparseable buffers
//       }
//     });
//     ws.on('close', () => {
//       broker.close();
//     });
//   });
//   const PORT = 9005;
//   server.listen(PORT, '0.0.0.0', () => {
//     console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
//     console.log(`WebSocket Gateway mounted on ws://localhost:${PORT}/ws/voice`);
//   });
// }
// if (require.main === module) {
//   startSimulatorAPI();
// }
// // import express, { Request, Response } from 'express';
// // import * as mqtt from 'mqtt';
// // import * as dotenv from 'dotenv';
// // import { ThingsBoardClient } from './restClient';
// // import { DeviceService } from './services';
// // dotenv.config();
// // const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
// // const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
// // const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;
// // class StableMQTTClient {
// //   private client: mqtt.MqttClient | null = null;
// //   public connected = false;
// //   constructor(public deviceName: string, private token: string) {}
// //   public connect(): void {
// //     const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
// //     this.client = mqtt.connect(brokerUrl, {
// //       username: this.token,
// //       reconnectPeriod: 5000,
// //       connectTimeout: 30 * 1000,
// //     });
// //     this.client.on('connect', () => {
// //       this.connected = true;
// //       console.log(`✓ Connected to ThingsBoard MQTT for ${this.deviceName}`);
// //     });
// //     this.client.on('offline', () => {
// //       this.connected = false;
// //       console.warn(`⚠️ MQTT Client Offline for ${this.deviceName}. Attempting auto-reconnect...`);
// //     });
// //     this.client.on('error', (err) => {
// //       console.error(`❌ MQTT Client Error on ${this.deviceName}:`, err.message);
// //     });
// //   }
// //   public publish(telemetry: Record<string, any>): Promise<boolean> {
// //     return new Promise((resolve) => {
// //       if (!this.client || !this.connected) {
// //         console.warn(`⚠️ Cannot publish telemetry for ${this.deviceName}: Client offline.`);
// //         return resolve(false);
// //       }
// //       const payload = JSON.stringify(telemetry);
// //       this.client.publish('v1/devices/me/telemetry', payload, { qos: 1 }, (err) => {
// //         if (err) {
// //           console.error(`❌ Telemetry publish failed for ${this.deviceName}:`, err.message);
// //           return resolve(false);
// //         }
// //         resolve(true);
// //       });
// //     });
// //   }
// //   public disconnect(): void {
// //     if (this.client) {
// //       this.client.end();
// //     }
// //   }
// // }
// // const activeClients: Record<string, StableMQTTClient> = {};
// // const deviceIntervals: Record<string, NodeJS.Timeout> = {};
// // function generateSensorTelemetry(): Record<string, number> {
// //   return {
// //     temperature: parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2)),
// //     humidity: parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2)),
// //     pressure: parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3)),
// //     vibration: parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2)),
// //   };
// // }
// // /**
// //  * Automates logging into ThingsBoard, locating or creating our simulated sensors,
// //  * and programmatically retrieving their valid Access Tokens.
// //  */
// // async function autoProvisionDevices(): Promise<Record<string, string>> {
// //   console.log('🔄 Checking and auto-provisioning devices in ThingsBoard...');
// //   const host = process.env.THINGSBOARD_HOST || 'http://localhost:8080';
// //   const username = process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org';
// //   const password = process.env.THINGSBOARD_PASSWORD || 'tenant';
// //   const client = new ThingsBoardClient({
// //     baseUrl: host,
// //     username,
// //     password,
// //     verifySsl: false,
// //   });
// //   const deviceSrv = new DeviceService(client);
// //   const resolvedTokens: Record<string, string> = {};
// //   const targetDevices = ['Smart-Industrial-Sensor-01', 'Smart-Industrial-Sensor-02'];
// //   for (const name of targetDevices) {
// //     try {
// //       let deviceId: string | null = null;
// //       // 1. Check if device exists in ThingsBoard
// //       try {
// //         const searchRes = await client.request<any>('GET', '/api/tenant/devices', { deviceName: name });
// //         if (searchRes && searchRes.id) {
// //           deviceId = searchRes.id.id;
// //           console.log(`✓ Device found: ${name} (${deviceId})`);
// //         }
// //       } catch {
// //         // Device not found, continue to creation step
// //       }
// //       // 2. Create device if it does not exist
// //       if (!deviceId) {
// //         console.log(`+ Creating device: ${name}...`);
// //         const created = await deviceSrv.createOrUpdateDevice({
// //           name,
// //           type: 'default',
// //           label: `${name} Simulated Node`,
// //         });
// //         deviceId = created.id?.id || null;
// //         if (!deviceId) throw new Error(`Could not read ID of newly created device ${name}`);
// //         console.log(`✓ Device created: ${name} (${deviceId})`);
// //       }
// //       // 3. Programmatically extract the credentials (Access Token)
// //       const credentials = await deviceSrv.getDeviceCredentials(deviceId);
// //       resolvedTokens[name] = credentials.credentialsId;
// //       console.log(`✓ Access Token resolved programmatically for ${name}`);
// //     } catch (err: any) {
// //       console.error(`❌ Auto-provisioning failed for ${name}:`, err.message);
// //     }
// //   }
// //   return resolvedTokens;
// // }
// // export async function startSimulatorAPI() {
// //   const app = express();
// //   app.use(express.json());
// //   let resolvedTokens: Record<string, string> = {};
// //   try {
// //     resolvedTokens = await autoProvisionDevices();
// //   } catch (err: any) {
// //     console.warn('⚠️ Programmatic provisioning failed. Falling back to .env values.', err.message);
// //     resolvedTokens = {
// //       'Smart-Industrial-Sensor-01': process.env.SENSOR_01_TOKEN || '',
// //       'Smart-Industrial-Sensor-02': process.env.SENSOR_02_TOKEN || '',
// //     };
// //   }
// //   // Initialize clients with programmatically validated tokens
// //   for (const [name, token] of Object.entries(resolvedTokens)) {
// //     if (token) {
// //       const client = new StableMQTTClient(name, token);
// //       client.connect();
// //       activeClients[name] = client;
// //     } else {
// //       console.warn(`⚠️ No token found for device ${name}. Skipping simulation launch.`);
// //     }
// //   }
// //   app.post('/simulation/start/:deviceName', (req: Request, res: Response) => {
// //     const { deviceName } = req.params;
// //     const client = activeClients[deviceName];
// //     if (!client) {
// //       return res.status(400).json({ error: 'Device connection details or token missing.' });
// //     }
// //     if (deviceIntervals[deviceName]) {
// //       return res.json({ status: 'Already running' });
// //     }
// //     deviceIntervals[deviceName] = setInterval(async () => {
// //       const payload = generateSensorTelemetry();
// //       await client.publish(payload);
// //     }, SIMULATION_INTERVAL_MS);
// //     console.log(`Simulation loop interval active for ${deviceName}`);
// //     res.json({ status: `Simulation started for ${deviceName}` });
// //   });
// //   app.post('/simulation/stop/:deviceName', (req: Request, res: Response) => {
// //     const { deviceName } = req.params;
// //     if (deviceIntervals[deviceName]) {
// //       clearInterval(deviceIntervals[deviceName]);
// //       delete deviceIntervals[deviceName];
// //       return res.json({ status: `Simulation stopped for ${deviceName}` });
// //     }
// //     res.json({ status: 'Not running' });
// //   });
// //   app.post('/simulation/start_all', (req: Request, res: Response) => {
// //     for (const name of Object.keys(activeClients)) {
// //       if (!deviceIntervals[name]) {
// //         deviceIntervals[name] = setInterval(async () => {
// //           const payload = generateSensorTelemetry();
// //           await activeClients[name].publish(payload);
// //         }, SIMULATION_INTERVAL_MS);
// //       }
// //     }
// //     res.json({ status: 'All simulations started' });
// //   });
// //   app.post('/simulation/stop_all', (req: Request, res: Response) => {
// //     for (const name of Object.keys(deviceIntervals)) {
// //       clearInterval(deviceIntervals[name]);
// //       delete deviceIntervals[name];
// //     }
// //     res.json({ status: 'All simulations stopped' });
// //   });
// //   app.get('/simulation/status', (req: Request, res: Response) => {
// //     const status: Record<string, { running: boolean }> = {};
// //     for (const name of Object.keys(activeClients)) {
// //       status[name] = { running: !!deviceIntervals[name] };
// //     }
// //     res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
// //   });
// //   app.post('/simulation/publish', async (req: Request, res: Response) => {
// //     const { device_name, telemetry } = req.body;
// //     const client = activeClients[device_name];
// //     if (!client) {
// //       return res.status(400).json({ error: `Device '${device_name}' connection details missing.` });
// //     }
// //     const success = await client.publish(telemetry);
// //     if (success) {
// //       res.json({ status: 'Telemetry published', device: device_name });
// //     } else {
// //       res.status(500).json({ error: 'Failed to publish telemetry payload via MQTT.' });
// //     }
// //   });
// //   const PORT = 9001;
// //   app.listen(PORT, '0.0.0.0', () => {
// //     console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
// //   });
// // }
// // process.on('SIGTERM', () => {
// //   console.log('Ingestion termination caught. Unsubscribing MQTT clients...');
// //   for (const interval of Object.values(deviceIntervals)) {
// //     clearInterval(interval);
// //   }
// //   for (const client of Object.values(activeClients)) {
// //     client.disconnect();
// //   }
// //   process.exit(0);
// // });
// // if (require.main === module) {
// //   startSimulatorAPI();
// // }
// // // // MQTT mock simulator and control API server
// // // import express, { Request, Response } from 'express';
// // // import * as mqtt from 'mqtt';
// // // import * as dotenv from 'dotenv';
// // // dotenv.config();
// // // const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
// // // const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
// // // const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;
// // // const DEVICES_CONFIG: Record<string, string | undefined> = {
// // //   'Smart-Industrial-Sensor-01': process.env.SENSOR_01_TOKEN,
// // //   'Smart-Industrial-Sensor-02': process.env.SENSOR_02_TOKEN,
// // // };
// // // class StableMQTTClient {
// // //   private client: mqtt.MqttClient | null = null;
// // //   public connected = false;
// // //   constructor(public deviceName: string, private token: string) {}
// // //   public connect(): void {
// // //     const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
// // //     this.client = mqtt.connect(brokerUrl, {
// // //       username: this.token,
// // //       reconnectPeriod: 5000,
// // //       connectTimeout: 30 * 1000,
// // //     });
// // //     this.client.on('connect', () => {
// // //       this.connected = true;
// // //       console.log(`Connected to ThingsBoard MQTT for ${this.deviceName}`);
// // //     });
// // //     this.client.on('offline', () => {
// // //       this.connected = false;
// // //       console.warn(`MQTT Client Offline for ${this.deviceName}. Attempting auto-reconnect...`);
// // //     });
// // //     this.client.on('error', (err) => {
// // //       console.error(`MQTT Client Error on ${this.deviceName}:`, err.message);
// // //     });
// // //   }
// // //   public publish(telemetry: Record<string, any>): Promise<boolean> {
// // //     return new Promise((resolve) => {
// // //       if (!this.client || !this.connected) {
// // //         console.warn(`Cannot publish telemetry for ${this.deviceName}: Client offline.`);
// // //         return resolve(false);
// // //       }
// // //       const payload = JSON.stringify(telemetry);
// // //       this.client.publish('v1/devices/me/telemetry', payload, { qos: 1 }, (err) => {
// // //         if (err) {
// // //           console.error(`Telemetry publish failed for ${this.deviceName}:`, err.message);
// // //           return resolve(false);
// // //         }
// // //         resolve(true);
// // //       });
// // //     });
// // //   }
// // //   public disconnect(): void {
// // //     if (this.client) {
// // //       this.client.end();
// // //     }
// // //   }
// // // }
// // // // Global state trackers
// // // const activeClients: Record<string, StableMQTTClient> = {};
// // // const deviceIntervals: Record<string, NodeJS.Timeout> = {};
// // // function generateSensorTelemetry(): Record<string, number> {
// // //   return {
// // //     temperature: parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2)),
// // //     humidity: parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2)),
// // //     pressure: parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3)),
// // //     vibration: parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2)),
// // //   };
// // // }
// // // export function startSimulatorAPI() {
// // //   const app = express();
// // //   app.use(express.json());
// // //   // Initialize Active Clients
// // //   for (const [name, token] of Object.entries(DEVICES_CONFIG)) {
// // //     if (token) {
// // //       const client = new StableMQTTClient(name, token);
// // //       client.connect();
// // //       activeClients[name] = client;
// // //     }
// // //   }
// // //   app.post('/simulation/start/:deviceName', (req: Request, res: Response) => {
// // //     const { deviceName } = req.params;
// // //     const client = activeClients[deviceName];
// // //     if (!client) {
// // //       return res.status(400).json({ error: 'Device connection details or token missing.' });
// // //     }
// // //     if (deviceIntervals[deviceName]) {
// // //       return res.json({ status: 'Already running' });
// // //     }
// // //     deviceIntervals[deviceName] = setInterval(async () => {
// // //       const payload = generateSensorTelemetry();
// // //       await client.publish(payload);
// // //     }, SIMULATION_INTERVAL_MS);
// // //     console.log(`Simulation loop interval active for ${deviceName}`);
// // //     res.json({ status: `Simulation started for ${deviceName}` });
// // //   });
// // //   app.post('/simulation/stop/:deviceName', (req: Request, res: Response) => {
// // //     const { deviceName } = req.params;
// // //     if (deviceIntervals[deviceName]) {
// // //       clearInterval(deviceIntervals[deviceName]);
// // //       delete deviceIntervals[deviceName];
// // //       return res.json({ status: `Simulation stopped for ${deviceName}` });
// // //     }
// // //     res.json({ status: 'Not running' });
// // //   });
// // //   app.post('/simulation/start_all', (req: Request, res: Response) => {
// // //     for (const name of Object.keys(activeClients)) {
// // //       if (!deviceIntervals[name]) {
// // //         deviceIntervals[name] = setInterval(async () => {
// // //           const payload = generateSensorTelemetry();
// // //           await activeClients[name].publish(payload);
// // //         }, SIMULATION_INTERVAL_MS);
// // //       }
// // //     }
// // //     res.json({ status: 'All simulations started' });
// // //   });
// // //   app.post('/simulation/stop_all', (req: Request, res: Response) => {
// // //     for (const name of Object.keys(deviceIntervals)) {
// // //       clearInterval(deviceIntervals[name]);
// // //       delete deviceIntervals[name];
// // //     }
// // //     res.json({ status: 'All simulations stopped' });
// // //   });
// // //   app.get('/simulation/status', (req: Request, res: Response) => {
// // //     const status: Record<string, { running: boolean }> = {};
// // //     for (const name of Object.keys(activeClients)) {
// // //       status[name] = { running: !!deviceIntervals[name] };
// // //     }
// // //     res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
// // //   });
// // //   app.post('/simulation/publish', async (req: Request, res: Response) => {
// // //     const { device_name, telemetry } = req.body;
// // //     const client = activeClients[device_name];
// // //     if (!client) {
// // //       return res.status(400).json({ error: `Device '${device_name}' connection details missing.` });
// // //     }
// // //     const success = await client.publish(telemetry);
// // //     if (success) {
// // //       res.json({ status: 'Telemetry published', device: device_name });
// // //     } else {
// // //       res.status(500).json({ error: 'Failed to publish telemetry payload via MQTT.' });
// // //     }
// // //   });
// // //   const PORT = 9001;
// // //   app.listen(PORT, '0.0.0.0', () => {
// // //     console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
// // //   });
// // // }
// // // // Graceful termination handling
// // // process.on('SIGTERM', () => {
// // //   console.log('Ingestion termination caught. Unsubscribing MQTT clients...');
// // //   for (const interval of Object.values(deviceIntervals)) {
// // //     clearInterval(interval);
// // //   }
// // //   for (const client of Object.values(activeClients)) {
// // //     client.disconnect();
// // //   }
// // //   process.exit(0);
// // // });
// // // // Run directly if called as main process
// // // if (require.main === module) {
// // //   startSimulatorAPI();
// // // }
