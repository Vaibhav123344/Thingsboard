import { startSimulatorAPI } from './simulator';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('🚀 Starting Industrial AI Observer supervisor bootstrapper...');

  // Boot the Unified API, MQTT Ingestion & WebSocket Relay on Port 9001
  try {
    startSimulatorAPI();
    console.log('🤖 Unified Server (Express, MQTT Simulator & Gemini WS Gateway) is online on Port 9001.');
  } catch (err: any) {
    console.error('❌ Error initializing Unified Server:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);

