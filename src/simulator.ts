// simulator.ts
import express, { Request, Response } from 'express';
import * as mqtt from 'mqtt';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import * as dotenv from 'dotenv';
import { GeminiLiveWSBroker } from './live_agent_ws';
import { ThingsBoardClient } from './restClient';
import { ThingsBoardRESTBridge } from './bridge';

dotenv.config();

const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;
const PORT = parseInt(process.env.SIMULATOR_PORT || '9005', 10);

class StableMQTTClient {
  private client: mqtt.MqttClient | null = null;
  public connected = false;

  constructor(public deviceName: string, private token: string) {}

  public connect(): void {
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

  public publish(telemetry: Record<string, any>): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.client || !this.connected) {
        return resolve(false);
      }
      this.client.publish('v1/devices/me/telemetry', JSON.stringify(telemetry), { qos: 1 }, (err) => {
        if (err) resolve(false);
        else resolve(true);
      });
    });
  }

  public disconnect(): void {
    if (this.client) {
      this.client.end();
      this.connected = false;
    }
  }
}

const activeClients: Record<string, StableMQTTClient> = {};
const deviceIntervals: Record<string, NodeJS.Timeout> = {};
const deviceTelemetryKeys: Record<string, string[]> = {};

function generateSensorTelemetry(deviceName: string): Record<string, number> {
  const keys = deviceTelemetryKeys[deviceName] || ['temperature', 'humidity', 'pressure', 'vibration'];
  const telemetry: Record<string, number> = {};
  
  for (const key of keys) {
    if (key === 'temperature') telemetry[key] = parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2));
    else if (key === 'humidity') telemetry[key] = parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2));
    else if (key === 'pressure') telemetry[key] = parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3));
    else if (key === 'vibration') telemetry[key] = parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2));
    else {
      // For unknown keys, generate a generic random value between 0 and 100
      telemetry[key] = parseFloat((Math.random() * 100).toFixed(2));
    }
  }
  return telemetry;
}

async function autoProvisionDevices() {
  console.log('🔄 Syncing all devices from ThingsBoard for simulation...');
  const tbClient = new ThingsBoardClient({
    baseUrl: process.env.THINGSBOARD_HOST || 'http://localhost:8080',
    username: process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org',
    password: process.env.THINGSBOARD_PASSWORD || 'tenant',
    verifySsl: false,
  });

  const bridge = new ThingsBoardRESTBridge();

  try {
    // 1. Fetch all devices from tenant
    const devicesRes = await tbClient.request<any>('GET', '/api/tenant/devices', { pageSize: 100, page: 0 });
    const devices = devicesRes.data || [];

    for (const device of devices) {
      const name = device.name;
      const deviceId = device.id.id;

      try {
        // 2. Resolve credentials
        const credentials = await tbClient.request<any>('GET', `/api/device/${deviceId}/credentials`);
        const token = credentials.credentialsId;

        if (token && !activeClients[name]) {
          const client = new StableMQTTClient(name, token);
          client.connect();
          activeClients[name] = client;
          console.log(`✓ Simulation client ready for: ${name}`);
        }

        // 3. Resolve active telemetry keys for dynamic schema
        const latest = await bridge.getLatestTelemetry(name);
        const keys = Object.keys(latest);
        if (keys.length > 0) {
          deviceTelemetryKeys[name] = keys;
        } else {
          deviceTelemetryKeys[name] = ['temperature', 'humidity', 'pressure', 'vibration'];
        }
      } catch (err: any) {
        console.error(`❌ Failed to sync credentials/keys for ${name}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error(`❌ Global device sync failed:`, err.message);
  }
}

export async function startSimulatorAPI() {
  const app = express();

  // Shared bridge instance
  const bridge = new ThingsBoardRESTBridge();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else {
      res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json());

  const reportsDir = path.join(process.cwd(), 'reports');
  app.use('/reports', express.static(reportsDir));

  await autoProvisionDevices();

  // Periodic device refresh every 5 minutes
  setInterval(autoProvisionDevices, 5 * 60 * 1000);

  app.post('/simulation/start/:deviceName', (req: Request, res: Response) => {
    const { deviceName } = req.params;
    const client = activeClients[deviceName];
    if (!client) return res.status(400).json({ error: 'Device not active' });
    if (deviceIntervals[deviceName]) return res.json({ status: 'Already running' });

    deviceIntervals[deviceName] = setInterval(async () => {
      if (client.connected) {
        const payload = generateSensorTelemetry(deviceName);
        await client.publish(payload);
      }
    }, SIMULATION_INTERVAL_MS);

    res.json({ status: `Simulation started for ${deviceName}` });
  });

  app.post('/simulation/stop/:deviceName', (req: Request, res: Response) => {
    const { deviceName } = req.params;
    if (deviceIntervals[deviceName]) {
      clearInterval(deviceIntervals[deviceName]);
      delete deviceIntervals[deviceName];
      return res.json({ status: `Simulation stopped for ${deviceName}` });
    }
    res.json({ status: 'Not running' });
  });

  app.post('/simulation/start_all', (req: Request, res: Response) => {
    for (const name of Object.keys(activeClients)) {
      if (!deviceIntervals[name]) {
        deviceIntervals[name] = setInterval(async () => {
          if (activeClients[name].connected) {
            await activeClients[name].publish(generateSensorTelemetry(name));
          }
        }, SIMULATION_INTERVAL_MS);
      }
    }
    res.json({ status: 'All simulations active' });
  });

  app.post('/simulation/stop_all', (req: Request, res: Response) => {
    for (const name of Object.keys(deviceIntervals)) {
      clearInterval(deviceIntervals[name]);
      delete deviceIntervals[name];
    }
    res.json({ status: 'All simulations suspended' });
  });

  app.get('/simulation/status', (req: Request, res: Response) => {
    const status: Record<string, { running: boolean }> = {};
    for (const name of Object.keys(activeClients)) {
      status[name] = { running: !!deviceIntervals[name] };
    }
    res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
  });

  // Uses shared bridge instance instead of creating new one per request
  app.get('/simulation/devices', async (req: Request, res: Response) => {
    try {
      const devices = await bridge.listDevices();
      res.json(devices);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/simulation/telemetry/:deviceName', async (req: Request, res: Response) => {
    const { deviceName } = req.params;
    try {
      const telemetry = await bridge.getLatestTelemetry(deviceName);
      res.json(telemetry);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Active alarms endpoint for frontend polling
  app.get('/simulation/alarms', async (req: Request, res: Response) => {
    try {
      const alarms = await bridge.getActiveAlarms();
      res.json(alarms);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/simulation/forecast_what_if', async (req: Request, res: Response) => {
    try {
      const result = await bridge.forecastWhatIf(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/voice') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const broker = new GeminiLiveWSBroker(ws);
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

    // Handles BOTH binary streams (PCM chunks) and stringified JSON payloads
    ws.on('message', (message: any, isBinary: boolean) => {
      try {
        if (isBinary || Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
          const rawBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
          const base64Audio = rawBuffer.toString('base64');
          broker.handleClientMessage({
            type: 'audio_chunk',
            data: base64Audio
          });
        } else {
          const parsed = JSON.parse(message.toString());
          broker.handleClientMessage(parsed);
        }
      } catch (e: any) {
        console.warn('[WS Gateway] Bypassing malformed client packet:', e.message);
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      broker.close();
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
    console.log(`WebSocket Gateway mounted on ws://localhost:${PORT}/ws/voice`);
  });
}

// Graceful shutdown for both SIGTERM and SIGINT (Windows Ctrl+C)
function gracefulShutdown() {
  console.log('Ingestion termination caught. Unsubscribing MQTT clients...');
  for (const interval of Object.values(deviceIntervals)) {
    clearInterval(interval);
  }
  for (const client of Object.values(activeClients)) {
    client.disconnect();
  }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

if (require.main === module) {
  startSimulatorAPI();
}