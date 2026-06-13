import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
} from '@google/genai';
import { writeFile } from 'fs';
import * as dotenv from 'dotenv';
import { ThingsBoardRESTBridge } from './bridge';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('❌ Error: GEMINI_API_KEY is missing from your .env file.');
  process.exit(1);
}

const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Zephyr';

// Initialize our unified ThingsBoard REST Bridge
const bridge = new ThingsBoardRESTBridge();

// Mapping tools directly to the operational bridge logic
const TOOL_MAP: Record<string, Function> = {
  list_devices: () => bridge.listDevices(),
  get_current_telemetry: (args: { device_name: string }) => bridge.getLatestTelemetry(args.device_name),
  get_historical_summary: (args: { device_name: string; hours?: number }) => bridge.getHistoricalStats(args.device_name, args.hours),
  get_active_alarms: () => bridge.getActiveAlarms(),
  get_device_attributes: (args: { device_name: string }) => bridge.getAttributes(args.device_name),
  get_highest_metric: (args: { metric: string }) => bridge.getHighestMetric(args.metric),
  get_metric_trend: (args: { device_name: string; metric: string }) => bridge.getMetricTrend(args.device_name, args.metric),
  perform_deep_analysis: (args: { device_name: string; start_time?: string; end_time?: string; hours?: number }) =>
    bridge.performDeepAnalysis(args.device_name, args.start_time, args.end_time, args.hours),
  create_device: (args: { device_name: string; device_type: string; label?: string }) =>
    bridge.createDevice(args.device_name, args.device_type, args.label),
  delete_device: (args: { device_name: string }) => bridge.deleteDevice(args.device_name),
  get_device_credentials: (args: { device_name: string }) => bridge.getDeviceCredentials(args.device_name),
  acknowledge_alarm: (args: { alarm_id: string }) => bridge.acknowledgeAlarm(args.alarm_id),
  clear_alarm: (args: { alarm_id: string }) => bridge.clearAlarm(args.alarm_id),
  trigger_rule_engine: (args: { device_name: string; message: any }) => bridge.triggerRuleEngine(args.device_name, args.message),
  create_alarm: (args: { device_name: string; alarm_type: string; severity: string; details?: any }) =>
    bridge.createAlarm(args.device_name, args.alarm_type, args.severity, args.details),
  create_rule_chain: (args: { name: string; nodes: any[]; connections: any[]; first_node_index?: number }) =>
    bridge.createRuleChain(args.name, args.nodes, args.connections, args.first_node_index),
};

const SYSTEM_INSTRUCTION = `
## IDENTITY & PERSONALITY
You are an intelligent, conversational, and highly attentive Industrial Voice Assistant named "Zephyr." 
You are connected directly to the ThingsBoard smart factory database and monitoring environment.
Your style is professional, concise, and efficient.

## CONVERSATIONAL FLOW PROTOCOLS
1. **Greeting & Initialization**: On startup, greet the operator warmly. Let them know you are scanning active devices, then immediately call list_devices().
2. **Familiarity**: Remember the device currently being discussed.
3. **Spoken Formatting**: Speak units aloud clearly: Degrees Celsius, Percent relative humidity, Bar, G-force.

## CAPABILITIES
- Live Monitoring & Trends
- Device Management
- Alarm Management
- Advanced Deep Audit: Perform deep compliance audits with perform_deep_analysis().

## SAFETY & ALERTS
Be highly vigilant. If a tool returns temperatures exceeding 80.0°C or vibration amplitudes exceeding 4.0 G-force, caution the operator immediately.
`;

const toolDeclarations = [
  {
    name: 'list_devices',
    description: 'Returns a list of all active industrial devices and sensors in the system.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_current_telemetry',
    description: 'Fetches the latest real-time telemetry readings for a specific device.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING', description: 'The exact name of the device' } },
      required: ['device_name'],
    },
  },
  {
    name: 'get_historical_summary',
    description: 'Provides an aggregated summary (average, min, max) of telemetry over a specific time window.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'The name of the device' },
        hours: { type: 'INTEGER', description: 'The number of past hours to analyze (default 1)' },
      },
      required: ['device_name', 'hours'],
    },
  },
  {
    name: 'get_active_alarms',
    description: 'Checks the entire system for any currently active or critical industrial alarms.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_device_attributes',
    description: 'Retrieves metadata like installation location, model number, and static configuration.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING', description: 'The name of the device' } },
      required: ['device_name'],
    },
  },
  {
    name: 'get_highest_metric',
    description: 'Compares all devices and identifies which one currently has the highest value for a specific metric.',
    parameters: {
      type: 'OBJECT',
      properties: { metric: { type: 'STRING', description: 'The metric to compare' } },
      required: ['metric'],
    },
  },
  {
    name: 'get_metric_trend',
    description: 'Analyzes if a specific metric is rising, falling, or stable compared to the last hour.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'The name of the device' },
        metric: { type: 'STRING', description: 'The metric to analyze' },
      },
      required: ['device_name', 'metric'],
    },
  },
  {
    name: 'perform_deep_analysis',
    description: 'Performs a deep compliance audit over a specific time window. Outputs interactive HTML charts.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'Exact name of the device' },
        hours: { type: 'INTEGER', description: 'Relative window in hours (default 24)' },
        start_time: { type: 'STRING', description: 'ISO-8601 start time' },
        end_time: { type: 'STRING', description: 'ISO-8601 end time' },
      },
      required: ['device_name'],
    },
  },
  {
    name: 'create_device',
    description: 'Register new sensors or edge nodes in ThingsBoard.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'Name of the new device' },
        device_type: { type: 'STRING', description: 'Type of the device' },
        label: { type: 'STRING', description: 'Optional label for the device' },
      },
      required: ['device_name', 'device_type'],
    },
  },
  {
    name: 'delete_device',
    description: 'Remove a device from the ThingsBoard database.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING', description: 'Name of the device to delete' } },
      required: ['device_name'],
    },
  },
  {
    name: 'get_device_credentials',
    description: 'Retrieve connection credentials for a device.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING', description: 'Name of the device' } },
      required: ['device_name'],
    },
  },
  {
    name: 'acknowledge_alarm',
    description: 'Acknowledge an alarm to mark it as being investigated.',
    parameters: {
      type: 'OBJECT',
      properties: { alarm_id: { type: 'STRING', description: 'Internal UUID of the alarm' } },
      required: ['alarm_id'],
    },
  },
  {
    name: 'clear_alarm',
    description: 'Resolve an alarm once the condition is fixed.',
    parameters: {
      type: 'OBJECT',
      properties: { alarm_id: { type: 'STRING', description: 'Internal UUID of the alarm' } },
      required: ['alarm_id'],
    },
  },
  {
    name: 'trigger_rule_engine',
    description: 'Push custom JSON telemetry data or commands directly into the active rule chains.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'Name of the device' },
        message: { type: 'OBJECT', description: 'JSON payload to push' },
      },
      required: ['device_name', 'message'],
    },
  },
  {
    name: 'create_alarm',
    description: 'Creates a new alarm for a device.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING', description: 'Name of the device' },
        alarm_type: { type: 'STRING', description: 'Type of the alarm' },
        text: { type: 'STRING', description: 'Alarm description or log message' },
        severity: { type: 'STRING', description: 'Severity (CRITICAL, MAJOR, MINOR, WARNING)' },
        details: { type: 'OBJECT', description: 'Optional JSON details' },
      },
      required: ['device_name', 'alarm_type', 'severity'],
    },
  },
  {
    name: 'create_rule_chain',
    description: 'Creates a new rule chain.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Name of the rule chain' },
        nodes: { type: 'ARRAY', items: { type: 'OBJECT' } },
        connections: { type: 'ARRAY', items: { type: 'OBJECT' } },
        first_node_index: { type: 'INTEGER' },
      },
      required: ['name', 'nodes', 'connections'],
    },
  },
];

const responseQueue: LiveServerMessage[] = [];
let session: Session | undefined = undefined;

async function handleTurn(): Promise<LiveServerMessage[]> {
  const turn: LiveServerMessage[] = [];
  let done = false;
  while (!done) {
    const message = await waitMessage();
    turn.push(message);
    if (message.serverContent && message.serverContent.turnComplete) {
      done = true;
    }
  }
  return turn;
}

async function waitMessage(): Promise<LiveServerMessage> {
  let done = false;
  let message: LiveServerMessage | undefined = undefined;
  while (!done) {
    message = responseQueue.shift();
    if (message) {
      await handleServerMessage(message);
      done = true;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return message!;
}

const audioParts: string[] = [];

// Dynamic transport helper to locate underlying WebSocket or send mechanism safely
function sendSessionPayload(session: any, payload: any) {
  if (typeof session.send === 'function') {
    session.send(payload);
  } else if (session.ws && typeof session.ws.send === 'function') {
    session.ws.send(JSON.stringify(payload));
  } else if (session.websocket && typeof session.websocket.send === 'function') {
    session.websocket.send(JSON.stringify(payload));
  } else if (session.socket && typeof session.socket.send === 'function') {
    session.socket.send(JSON.stringify(payload));
  } else {
    let found = false;
    for (const key of Object.keys(session)) {
      if (session[key] && typeof session[key].send === 'function') {
        session[key].send(JSON.stringify(payload));
        found = true;
        break;
      }
    }
    if (!found) {
      console.error('❌ Error: Could not find a transport or send method on the session object.');
      console.log('Available session keys:', Object.keys(session));
    }
  }
}

async function handleServerMessage(message: LiveServerMessage) {
  // 1. Text & File / Model Audio Output aggregation
  if (message.serverContent?.modelTurn?.parts) {
    for (const part of message.serverContent.modelTurn.parts) {
      if (part.fileData) {
        console.log(`File: ${part.fileData.fileUri}`);
      }

      if (part.inlineData) {
        const fileName = 'audio.wav';
        const inlineData = part.inlineData;
        audioParts.push(inlineData.data ?? '');
        const buffer = convertToWav(audioParts, inlineData.mimeType ?? '');
        saveBinaryFile(fileName, buffer);
      }

      if (part.text) {
        console.log(`🤖 Zephyr: ${part.text}`);
      }
    }
  }

  // 2. Dynamic Tool Calling Execution
  if (message.toolCall?.functionCalls) {
    const functionResponses = [];
    for (const call of message.toolCall.functionCalls) {
      if (call.name && call.name in TOOL_MAP) {
        console.log(`🛠️ Executing Tool: ${call.name}`);
        const func = TOOL_MAP[call.name];

        let result;
        try {
          result = await func(call.args);
          if (typeof result !== 'object' || result === null) {
            result = { result };
          }
        } catch (e: any) {
          result = { error: `Execution error: ${e.message}` };
        }

        functionResponses.push({
          id: call.id,
          name: call.name,
          response: result,
        });
      } else {
        console.warn(`⚠️ Warning: Tool ${call.name} is not bound on this agent.`);
        functionResponses.push({
          id: call.id,
          name: call.name || 'unknown',
          response: { error: `Function ${call.name} is not bound on this agent.` },
        });
      }
    }

    if (session) {
      sendSessionPayload(session, {
        toolResponse: {
          functionResponses,
        },
      });
    }
  }
}

function saveBinaryFile(fileName: string, content: Buffer) {
  // @ts-ignore
  writeFile(fileName, content, 'utf8', (err) => {
    if (err) {
      console.error(`Error writing file ${fileName}:`, err);
      return;
    }
  });
}

interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function convertToWav(rawData: string[], mimeType: string) {
  const options = parseMimeType(mimeType);
  const buffers = rawData.map((data) => Buffer.from(data, 'base64'));
  const dataLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
  const wavHeader = createWavHeader(dataLength, options);

  // @ts-ignore
  return Buffer.concat([wavHeader, ...buffers]);
}

function parseMimeType(mimeType: string) {
  const [fileType, ...params] = mimeType.split(';').map((s) => s.trim());
  const [, format] = fileType.split('/');

  const options: Partial<WavConversionOptions> = {
    numChannels: 1,
    bitsPerSample: 16,
  };

  if (format && format.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) {
      options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map((s) => s.trim());
    if (key === 'rate') {
      options.sampleRate = parseInt(value, 10);
    }
  }

  return options as WavConversionOptions;
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
  const { numChannels, sampleRate, bitsPerSample } = options;

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0); // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
  buffer.write('WAVE', 8); // Format
  buffer.write('fmt ', 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  buffer.write('data', 36); // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

  return buffer;
}

async function main() {
  const ai = new GoogleGenAI({
    apiKey: API_KEY,
  });

  const config = {
    responseModalities: [Modality.AUDIO],
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: VOICE_NAME,
        },
      },
    },
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    tools: [{ functionDeclarations: toolDeclarations }] as any,
    contextWindowCompression: {
      triggerTokens: '104857',
      slidingWindow: { targetTokens: '52428' },
    },
  };

  session = await ai.live.connect({
    model: MODEL_NAME,
    callbacks: {
      onopen: function () {
        console.log('✅ Connected to Gemini Live Session.');
        console.log("Welcome! Type your command below (e.g. 'Status of sensor 01', 'Any alarms?', or 'q' to quit):");
        
        // Initial handshake greeting & context resolution
        session?.sendClientContent({
          turns: [
            "Hello! Initialize connection, identify the environment, and tell me the active devices."
          ]
        });
        handleTurn().catch(console.error);
      },
      onmessage: function (message: LiveServerMessage) {
        responseQueue.push(message);
      },
      onerror: function (e: any) {
        console.error('Session Error:', e.message || e);
      },
      onclose: function (e: any) {
        console.log('Session Closed:', e.reason || 'Normal shutdown');
        process.exit(0);
      },
    },
    config,
  });

  // Interactive CLI Loop to converse continually
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (text) => {
    const inputStr = text.toString().trim();
    if (!inputStr) return;

    if (inputStr.toLowerCase() === 'q') {
      console.log('Disconnecting from agent...');
      session?.close();
      process.exit(0);
    }

    if (session) {
      session.sendClientContent({
        turns: [inputStr],
      });
      // Await processing of the response frames generated by this user prompt
      handleTurn().catch(console.error);
    }
  });
}

main().catch(console.error);





// import {
//   GoogleGenAI,
//   LiveServerMessage,
//   MediaResolution,
//   Modality,
//   Session,
// } from '@google/genai';
// import { writeFile } from 'fs';
// import * as dotenv from 'dotenv';
// import { ThingsBoardRESTBridge } from './bridge';

// dotenv.config();

// const API_KEY = process.env.GEMINI_API_KEY;
// if (!API_KEY) {
//   console.error('❌ Error: GEMINI_API_KEY is missing from your .env file.');
//   process.exit(1);
// }

// const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
// const VOICE_NAME = 'Zephyr';

// // Initialize our unified ThingsBoard REST Bridge
// const bridge = new ThingsBoardRESTBridge();

// // Mapping tools directly to the operational bridge logic
// const TOOL_MAP: Record<string, Function> = {
//   list_devices: () => bridge.listDevices(),
//   get_current_telemetry: (args: { device_name: string }) => bridge.getLatestTelemetry(args.device_name),
//   get_historical_summary: (args: { device_name: string; hours?: number }) => bridge.getHistoricalStats(args.device_name, args.hours),
//   get_active_alarms: () => bridge.getActiveAlarms(),
//   get_device_attributes: (args: { device_name: string }) => bridge.getAttributes(args.device_name),
//   get_highest_metric: (args: { metric: string }) => bridge.getHighestMetric(args.metric),
//   get_metric_trend: (args: { device_name: string; metric: string }) => bridge.getMetricTrend(args.device_name, args.metric),
//   perform_deep_analysis: (args: { device_name: string; start_time?: string; end_time?: string; hours?: number }) =>
//     bridge.performDeepAnalysis(args.device_name, args.start_time, args.end_time, args.hours),
//   create_device: (args: { device_name: string; device_type: string; label?: string }) =>
//     bridge.createDevice(args.device_name, args.device_type, args.label),
//   delete_device: (args: { device_name: string }) => bridge.deleteDevice(args.device_name),
//   get_device_credentials: (args: { device_name: string }) => bridge.getDeviceCredentials(args.device_name),
//   acknowledge_alarm: (args: { alarm_id: string }) => bridge.acknowledgeAlarm(args.alarm_id),
//   clear_alarm: (args: { alarm_id: string }) => bridge.clearAlarm(args.alarm_id),
//   trigger_rule_engine: (args: { device_name: string; message: any }) => bridge.triggerRuleEngine(args.device_name, args.message),
//   create_alarm: (args: { device_name: string; alarm_type: string; severity: string; details?: any }) =>
//     bridge.createAlarm(args.device_name, args.alarm_type, args.severity, args.details),
//   create_rule_chain: (args: { name: string; nodes: any[]; connections: any[]; first_node_index?: number }) =>
//     bridge.createRuleChain(args.name, args.nodes, args.connections, args.first_node_index),
// };

// const SYSTEM_INSTRUCTION = `
// ## IDENTITY & PERSONALITY
// You are an intelligent, conversational, and highly attentive Industrial Voice Assistant named "Zephyr." 
// You are connected directly to the ThingsBoard smart factory database and monitoring environment.
// Your style is professional, concise, and efficient.

// ## CONVERSATIONAL FLOW PROTOCOLS
// 1. **Greeting & Initialization**: On startup, greet the operator warmly. Let them know you are scanning active devices, then immediately call list_devices().
// 2. **Familiarity**: Remember the device currently being discussed.
// 3. **Spoken Formatting**: Speak units aloud clearly: Degrees Celsius, Percent relative humidity, Bar, G-force.

// ## CAPABILITIES
// - Live Monitoring & Trends
// - Device Management
// - Alarm Management
// - Advanced Deep Audit: Perform deep compliance audits with perform_deep_analysis().

// ## SAFETY & ALERTS
// Be highly vigilant. If a tool returns temperatures exceeding 80.0°C or vibration amplitudes exceeding 4.0 G-force, caution the operator immediately.
// `;

// const toolDeclarations = [
//   {
//     name: 'list_devices',
//     description: 'Returns a list of all active industrial devices and sensors in the system.',
//     parameters: { type: 'OBJECT', properties: {} },
//   },
//   {
//     name: 'get_current_telemetry',
//     description: 'Fetches the latest real-time telemetry readings for a specific device.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { device_name: { type: 'STRING', description: 'The exact name of the device' } },
//       required: ['device_name'],
//     },
//   },
//   {
//     name: 'get_historical_summary',
//     description: 'Provides an aggregated summary (average, min, max) of telemetry over a specific time window.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'The name of the device' },
//         hours: { type: 'INTEGER', description: 'The number of past hours to analyze (default 1)' },
//       },
//       required: ['device_name', 'hours'],
//     },
//   },
//   {
//     name: 'get_active_alarms',
//     description: 'Checks the entire system for any currently active or critical industrial alarms.',
//     parameters: { type: 'OBJECT', properties: {} },
//   },
//   {
//     name: 'get_device_attributes',
//     description: 'Retrieves metadata like installation location, model number, and static configuration.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { device_name: { type: 'STRING', description: 'The name of the device' } },
//       required: ['device_name'],
//     },
//   },
//   {
//     name: 'get_highest_metric',
//     description: 'Compares all devices and identifies which one currently has the highest value for a specific metric.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { metric: { type: 'STRING', description: 'The metric to compare' } },
//       required: ['metric'],
//     },
//   },
//   {
//     name: 'get_metric_trend',
//     description: 'Analyzes if a specific metric is rising, falling, or stable compared to the last hour.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'The name of the device' },
//         metric: { type: 'STRING', description: 'The metric to analyze' },
//       },
//       required: ['device_name', 'metric'],
//     },
//   },
//   {
//     name: 'perform_deep_analysis',
//     description: 'Performs a deep compliance audit over a specific time window. Outputs interactive HTML charts.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'Exact name of the device' },
//         hours: { type: 'INTEGER', description: 'Relative window in hours (default 24)' },
//         start_time: { type: 'STRING', description: 'ISO-8601 start time' },
//         end_time: { type: 'STRING', description: 'ISO-8601 end time' },
//       },
//       required: ['device_name'],
//     },
//   },
//   {
//     name: 'create_device',
//     description: 'Register new sensors or edge nodes in ThingsBoard.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'Name of the new device' },
//         device_type: { type: 'STRING', description: 'Type of the device' },
//         label: { type: 'STRING', description: 'Optional label for the device' },
//       },
//       required: ['device_name', 'device_type'],
//     },
//   },
//   {
//     name: 'delete_device',
//     description: 'Remove a device from the ThingsBoard database.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { device_name: { type: 'STRING', description: 'Name of the device to delete' } },
//       required: ['device_name'],
//     },
//   },
//   {
//     name: 'get_device_credentials',
//     description: 'Retrieve connection credentials for a device.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { device_name: { type: 'STRING', description: 'Name of the device' } },
//       required: ['device_name'],
//     },
//   },
//   {
//     name: 'acknowledge_alarm',
//     description: 'Acknowledge an alarm to mark it as being investigated.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { alarm_id: { type: 'STRING', description: 'Internal UUID of the alarm' } },
//       required: ['alarm_id'],
//     },
//   },
//   {
//     name: 'clear_alarm',
//     description: 'Resolve an alarm once the condition is fixed.',
//     parameters: {
//       type: 'OBJECT',
//       properties: { alarm_id: { type: 'STRING', description: 'Internal UUID of the alarm' } },
//       required: ['alarm_id'],
//     },
//   },
//   {
//     name: 'trigger_rule_engine',
//     description: 'Push custom JSON telemetry data or commands directly into the active rule chains.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'Name of the device' },
//         message: { type: 'OBJECT', description: 'JSON payload to push' },
//       },
//       required: ['device_name', 'message'],
//     },
//   },
//   {
//     name: 'create_alarm',
//     description: 'Creates a new alarm for a device.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         device_name: { type: 'STRING', description: 'Name of the device' },
//         alarm_type: { type: 'STRING', description: 'Type of the alarm' },
//         text: { type: 'STRING', description: 'Alarm description or log message' },
//         severity: { type: 'STRING', description: 'Severity (CRITICAL, MAJOR, MINOR, WARNING)' },
//         details: { type: 'OBJECT', description: 'Optional JSON details' },
//       },
//       required: ['device_name', 'alarm_type', 'severity'],
//     },
//   },
//   {
//     name: 'create_rule_chain',
//     description: 'Creates a new rule chain.',
//     parameters: {
//       type: 'OBJECT',
//       properties: {
//         name: { type: 'STRING', description: 'Name of the rule chain' },
//         nodes: { type: 'ARRAY', items: { type: 'OBJECT' } },
//         connections: { type: 'ARRAY', items: { type: 'OBJECT' } },
//         first_node_index: { type: 'INTEGER' },
//       },
//       required: ['name', 'nodes', 'connections'],
//     },
//   },
// ];

// const responseQueue: LiveServerMessage[] = [];
// let session: Session | undefined = undefined;

// async function handleTurn(): Promise<LiveServerMessage[]> {
//   const turn: LiveServerMessage[] = [];
//   let done = false;
//   while (!done) {
//     const message = await waitMessage();
//     turn.push(message);
//     if (message.serverContent && message.serverContent.turnComplete) {
//       done = true;
//     }
//   }
//   return turn;
// }

// async function waitMessage(): Promise<LiveServerMessage> {
//   let done = false;
//   let message: LiveServerMessage | undefined = undefined;
//   while (!done) {
//     message = responseQueue.shift();
//     if (message) {
//       await handleServerMessage(message);
//       done = true;
//     } else {
//       await new Promise((resolve) => setTimeout(resolve, 100));
//     }
//   }
//   return message!;
// }

// const audioParts: string[] = [];

// async function handleServerMessage(message: LiveServerMessage) {
//   // 1. Text & File / Model Audio Output aggregation
//   if (message.serverContent?.modelTurn?.parts) {
//     for (const part of message.serverContent.modelTurn.parts) {
//       if (part.fileData) {
//         console.log(`File: ${part.fileData.fileUri}`);
//       }

//       if (part.inlineData) {
//         const fileName = 'audio.wav';
//         const inlineData = part.inlineData;
//         audioParts.push(inlineData.data ?? '');
//         const buffer = convertToWav(audioParts, inlineData.mimeType ?? '');
//         saveBinaryFile(fileName, buffer);
//       }

//       if (part.text) {
//         console.log(`🤖 Zephyr: ${part.text}`);
//       }
//     }
//   }

//   // 2. Dynamic Tool Calling Execution
//   if (message.toolCall?.functionCalls) {
//     const functionResponses = [];
//     for (const call of message.toolCall.functionCalls) {
//       if (call.name && call.name in TOOL_MAP) {
//         console.log(`🛠️ Executing Tool: ${call.name}`);
//         const func = TOOL_MAP[call.name];

//         let result;
//         try {
//           result = await func(call.args);
//           if (typeof result !== 'object' || result === null) {
//             result = { result };
//           }
//         } catch (e: any) {
//           result = { error: `Execution error: ${e.message}` };
//         }

//         functionResponses.push({
//           id: call.id,
//           name: call.name,
//           response: result,
//         });
//       } else {
//         console.warn(`⚠️ Warning: Tool ${call.name} is not bound on this agent.`);
//         functionResponses.push({
//           id: call.id,
//           name: call.name || 'unknown',
//           response: { error: `Function ${call.name} is not bound on this agent.` },
//         });
//       }
//     }

//     if (session) {
//       (session as any).send({
//         toolResponse: {
//           functionResponses,
//         },
//       });
//     }
//   }
// }

// function saveBinaryFile(fileName: string, content: Buffer) {
//   // @ts-ignore
//   writeFile(fileName, content, 'utf8', (err) => {
//     if (err) {
//       console.error(`Error writing file ${fileName}:`, err);
//       return;
//     }
//   });
// }

// interface WavConversionOptions {
//   numChannels: number;
//   sampleRate: number;
//   bitsPerSample: number;
// }

// function convertToWav(rawData: string[], mimeType: string) {
//   const options = parseMimeType(mimeType);
//   const buffers = rawData.map((data) => Buffer.from(data, 'base64'));
//   const dataLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
//   const wavHeader = createWavHeader(dataLength, options);

//   // @ts-ignore
//   return Buffer.concat([wavHeader, ...buffers]);
// }

// function parseMimeType(mimeType: string) {
//   const [fileType, ...params] = mimeType.split(';').map((s) => s.trim());
//   const [, format] = fileType.split('/');

//   const options: Partial<WavConversionOptions> = {
//     numChannels: 1,
//     bitsPerSample: 16,
//   };

//   if (format && format.startsWith('L')) {
//     const bits = parseInt(format.slice(1), 10);
//     if (!isNaN(bits)) {
//       options.bitsPerSample = bits;
//     }
//   }

//   for (const param of params) {
//     const [key, value] = param.split('=').map((s) => s.trim());
//     if (key === 'rate') {
//       options.sampleRate = parseInt(value, 10);
//     }
//   }

//   return options as WavConversionOptions;
// }

// function createWavHeader(dataLength: number, options: WavConversionOptions) {
//   const { numChannels, sampleRate, bitsPerSample } = options;

//   const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
//   const blockAlign = (numChannels * bitsPerSample) / 8;
//   const buffer = Buffer.alloc(44);

//   buffer.write('RIFF', 0); // ChunkID
//   buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
//   buffer.write('WAVE', 8); // Format
//   buffer.write('fmt ', 12); // Subchunk1ID
//   buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
//   buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
//   buffer.writeUInt16LE(numChannels, 22); // NumChannels
//   buffer.writeUInt32LE(sampleRate, 24); // SampleRate
//   buffer.writeUInt32LE(byteRate, 28); // ByteRate
//   buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
//   buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
//   buffer.write('data', 36); // Subchunk2ID
//   buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

//   return buffer;
// }

// async function main() {
//   const ai = new GoogleGenAI({
//     apiKey: API_KEY,
//   });

//   const config = {
//     responseModalities: [Modality.AUDIO],
//     mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
//     speechConfig: {
//       voiceConfig: {
//         prebuiltVoiceConfig: {
//           voiceName: VOICE_NAME,
//         },
//       },
//     },
//     systemInstruction: {
//       parts: [{ text: SYSTEM_INSTRUCTION }],
//     },
//     tools: [{ functionDeclarations: toolDeclarations }] as any,
//     contextWindowCompression: {
//       triggerTokens: '104857',
//       slidingWindow: { targetTokens: '52428' },
//     },
//   };

//   session = await ai.live.connect({
//     model: MODEL_NAME,
//     callbacks: {
//       onopen: function () {
//         console.log('✅ Connected to Gemini Live Session.');
//         console.log("Welcome! Type your command below (e.g. 'Status of sensor 01', 'Any alarms?', or 'q' to quit):");
        
//         // Initial handshake greeting & context resolution
//         session?.sendClientContent({
//           turns: [
//             "Hello! Initialize connection, identify the environment, and tell me the active devices."
//           ]
//         });
//         handleTurn().catch(console.error);
//       },
//       onmessage: function (message: LiveServerMessage) {
//         responseQueue.push(message);
//       },
//       onerror: function (e: any) {
//         console.error('Session Error:', e.message || e);
//       },
//       onclose: function (e: any) {
//         console.log('Session Closed:', e.reason || 'Normal shutdown');
//         process.exit(0);
//       },
//     },
//     config,
//   });

//   // Interactive CLI Loop to converse continually
//   process.stdin.setEncoding('utf-8');
//   process.stdin.on('data', async (text) => {
//     const inputStr = text.toString().trim();
//     if (!inputStr) return;

//     if (inputStr.toLowerCase() === 'q') {
//       console.log('Disconnecting from agent...');
//       session?.close();
//       process.exit(0);
//     }

//     if (session) {
//       session.sendClientContent({
//         turns: [inputStr],
//       });
//       // Await processing of the response frames generated by this user prompt
//       handleTurn().catch(console.error);
//     }
//   });
// }

// main().catch(console.error);