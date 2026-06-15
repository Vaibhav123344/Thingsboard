// index.ts
import { startSimulatorAPI } from './simulator';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('🚀 Starting Industrial AI Observer supervisor bootstrapper...');

  const PORT = process.env.PORT || '9005';

  try {
    // Starts the unified Express server, MQTT simulator, and WebSocket relay
    await startSimulatorAPI();
    console.log(`🤖 Unified Server (Express, MQTT Simulator & Gemini WS Gateway) is online on Port ${PORT}.`);
  } catch (err: any) {
    console.error('❌ Error initializing Unified Server:', err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal initialization failure:', err);
});




// import { startSimulatorAPI } from './simulator';
// import * as dotenv from 'dotenv';

// dotenv.config();

// async function main() {
//   console.log('🚀 Starting Industrial AI Observer supervisor bootstrapper...');

//   // Boot the Unified API, MQTT Ingestion & WebSocket Relay on Port 9001
//   try {
//     startSimulatorAPI();
//     console.log('🤖 Unified Server (Express, MQTT Simulator & Gemini WS Gateway) is online on Port 9001.');
//   } catch (err: any) {
//     console.error('❌ Error initializing Unified Server:', err.message);
//     process.exit(1);
//   }
// }

// main().catch(console.error);

