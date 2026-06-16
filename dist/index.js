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
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts
const simulator_1 = require("./simulator");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
async function main() {
    console.log('🚀 Starting Industrial AI Observer supervisor bootstrapper...');
    const PORT = process.env.PORT || '9005';
    try {
        // Starts the unified Express server, MQTT simulator, and WebSocket relay
        await (0, simulator_1.startSimulatorAPI)();
        console.log(`🤖 Unified Server (Express, MQTT Simulator & Gemini WS Gateway) is online on Port ${PORT}.`);
    }
    catch (err) {
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
