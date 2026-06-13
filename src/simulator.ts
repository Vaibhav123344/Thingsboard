import express, { Request, Response } from 'express';
import * as mqtt from 'mqtt';
import * as dotenv from 'dotenv';

dotenv.config();

const MQTT_HOST = process.env.THINGSBOARD_MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.THINGSBOARD_MQTT_PORT || '1883', 10);
const SIMULATION_INTERVAL_MS = parseInt(process.env.SIMULATION_INTERVAL_SECONDS || '15', 10) * 1000;

const DEVICES_CONFIG: Record<string, string | undefined> = {
  'Smart-Industrial-Sensor-01': process.env.SENSOR_01_TOKEN,
  'Smart-Industrial-Sensor-02': process.env.SENSOR_02_TOKEN,
};

class StableMQTTClient {
  private client: mqtt.MqttClient | null = null;
  public connected = false;

  constructor(public deviceName: string, private token: string) {}

  public connect(): void {
    const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
    this.client = mqtt.connect(brokerUrl, {
      username: this.token,
      reconnectPeriod: 5000, // Attempt reconnection every 5s
      connectTimeout: 30 * 1000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log(`Connected to ThingsBoard MQTT for ${this.deviceName}`);
    });

    this.client.on('offline', () => {
      this.connected = false;
      console.warn(`MQTT Client Offline for ${this.deviceName}. Attempting auto-reconnect...`);
    });

    this.client.on('error', (err) => {
      console.error(`MQTT Client Error on ${this.deviceName}:`, err.message);
    });
  }

  public publish(telemetry: Record<string, any>): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.client || !this.connected) {
        console.warn(`Cannot publish telemetry for ${this.deviceName}: Client offline.`);
        return resolve(false);
      }

      const payload = JSON.stringify(telemetry);
      this.client.publish('v1/devices/me/telemetry', payload, { qos: 1 }, (err) => {
        if (err) {
          console.error(`Telemetry publish failed for ${this.deviceName}:`, err.message);
          return resolve(false);
        }
        resolve(true);
      });
    });
  }

  public disconnect(): void {
    if (this.client) {
      this.client.end();
    }
  }
}

// Global state trackers
const activeClients: Record<string, StableMQTTClient> = {};
const deviceIntervals: Record<string, NodeJS.Timeout> = {};

function generateSensorTelemetry(): Record<string, number> {
  return {
    temperature: parseFloat((Math.random() * (85.0 - 20.0) + 20.0).toFixed(2)),
    humidity: parseFloat((Math.random() * (90.0 - 30.0) + 30.0).toFixed(2)),
    pressure: parseFloat((Math.random() * (1.5 - 0.9) + 0.9).toFixed(3)),
    vibration: parseFloat((Math.random() * (4.5 - 0.01) + 0.01).toFixed(2)),
  };
}

const app = express();
app.use(express.json());

// Initialize Active Clients
for (const [name, token] of Object.entries(DEVICES_CONFIG)) {
  if (token) {
    const client = new StableMQTTClient(name, token);
    client.connect();
    activeClients[name] = client;
  }
}

app.post('/simulation/start/:deviceName', (req: Request, res: Response) => {
  const { deviceName } = req.params;
  const client = activeClients[deviceName];

  if (!client) {
    return res.status(400).json({ error: 'Device connection details or token missing.' });
  }

  if (deviceIntervals[deviceName]) {
    return res.json({ status: 'Already running' });
  }

  deviceIntervals[deviceName] = setInterval(async () => {
    const payload = generateSensorTelemetry();
    await client.publish(payload);
  }, SIMULATION_INTERVAL_MS);

  console.log(`Simulation loop interval active for ${deviceName}`);
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
        const payload = generateSensorTelemetry();
        await activeClients[name].publish(payload);
      }, SIMULATION_INTERVAL_MS);
    }
  }
  res.json({ status: 'All simulations started' });
});

app.post('/simulation/stop_all', (req: Request, res: Response) => {
  for (const name of Object.keys(deviceIntervals)) {
    clearInterval(deviceIntervals[name]);
    delete deviceIntervals[name];
  }
  res.json({ status: 'All simulations stopped' });
});

app.get('/simulation/status', (req: Request, res: Response) => {
  const status: Record<string, { running: boolean }> = {};
  for (const name of Object.keys(activeClients)) {
    status[name] = { running: !!deviceIntervals[name] };
  }
  res.json({ devices: status, interval_seconds: SIMULATION_INTERVAL_MS / 1000 });
});

app.post('/simulation/publish', async (req: Request, res: Response) => {
  const { device_name, telemetry } = req.body;
  const client = activeClients[device_name];

  if (!client) {
    return res.status(400).json({ error: `Device '${device_name}' connection details missing.` });
  }

  const success = await client.publish(telemetry);
  if (success) {
    res.json({ status: 'Telemetry published', device: device_name });
  } else {
    res.status(500).json({ error: 'Failed to publish telemetry payload via MQTT.' });
  }
});

const PORT = 9001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stable Ingestion Layer Simulation listening on port ${PORT}`);
});

// Graceful termination handling
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