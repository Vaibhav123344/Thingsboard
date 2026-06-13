import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
} from '@google/genai';
import { WebSocket } from 'ws';
import * as dotenv from 'dotenv';
import { ThingsBoardRESTBridge } from './bridge';

dotenv.config();

const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Zephyr';

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
You are equipped with 36 tools covering:
- Live Monitoring & Trends
- Device and Asset Management
- Alarm Management
- Relationship Configurations
- Dashboards and Profiles
- RPC Commands
- Advanced Deep Audit: Perform deep compliance audits with perform_deep_analysis().
- **Direct Dashboard Creation**: You have direct access to \`create_device_dashboard(device_name)\`. When an operator asks to create, set up, or build a dashboard for a device, use this tool immediately.

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
  {
    name: 'list_assets',
    description: 'Returns a list of all active asset structures registered in the tenant environment.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_asset_by_name',
    description: 'Fetches complete metadata configuration metrics for a named asset.',
    parameters: {
      type: 'OBJECT',
      properties: { asset_name: { type: 'STRING', description: 'Exact asset name' } },
      required: ['asset_name'],
    },
  },
  {
    name: 'create_asset',
    description: 'Creates a new asset structure node inside the factory schema map.',
    parameters: {
      type: 'OBJECT',
      properties: {
        asset_name: { type: 'STRING', description: 'Name of the asset' },
        asset_type: { type: 'STRING', description: 'Physical or logical type' },
        label: { type: 'STRING', description: 'Optional descriptive label' },
      },
      required: ['asset_name', 'asset_type'],
    },
  },
  {
    name: 'delete_asset',
    description: 'Deletes an asset structure from the ThingsBoard environment.',
    parameters: {
      type: 'OBJECT',
      properties: { asset_name: { type: 'STRING', description: 'Name of the asset' } },
      required: ['asset_name'],
    },
  },
  {
    name: 'create_relation',
    description: 'Constructs an explicit relationship link between two distinct entities.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_id: { type: 'STRING' },
        from_type: { type: 'STRING' },
        to_id: { type: 'STRING' },
        to_type: { type: 'STRING' },
        relation_type: { type: 'STRING' },
      },
      required: ['from_id', 'from_type', 'to_id', 'to_type', 'relation_type'],
    },
  },
  {
    name: 'delete_relation',
    description: 'Deletes a relationship link mapping connection between entities.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_id: { type: 'STRING' },
        from_type: { type: 'STRING' },
        to_id: { type: 'STRING' },
        to_type: { type: 'STRING' },
        relation_type: { type: 'STRING' },
      },
      required: ['from_id', 'from_type', 'to_id', 'to_type', 'relation_type'],
    },
  },
  {
    name: 'list_relations',
    description: 'List relationship mappings associated from the entity scope.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_id: { type: 'STRING' },
        entity_type: { type: 'STRING' },
      },
      required: ['entity_id', 'entity_type'],
    },
  },
  {
    name: 'save_device_attributes',
    description: 'Writes system attributes within selected scoping metrics (SERVER_SCOPE, SHARED_SCOPE).',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING' },
        scope: { type: 'STRING', description: 'Scoping metric (e.g. SERVER_SCOPE)' },
        attributes: { type: 'OBJECT', description: 'Metadata configurations payload' },
      },
      required: ['device_name', 'scope', 'attributes'],
    },
  },
  {
    name: 'delete_device_attributes',
    description: 'Deletes specific attribute parameters mapped to a target device.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING' },
        scope: { type: 'STRING' },
        keys: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['device_name', 'scope', 'keys'],
    },
  },
  {
    name: 'list_dashboards',
    description: 'List configuration profiles of active monitoring dashboards.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_dashboard_by_id',
    description: 'Fetches the structured config profile for a dashboard.',
    parameters: {
      type: 'OBJECT',
      properties: { dashboard_id: { type: 'STRING' } },
      required: ['dashboard_id'],
    },
  },
  {
    name: 'assign_dashboard_to_customer',
    description: 'Assigns access controls for a dashboard to a specified customer user group.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customer_id: { type: 'STRING' },
        dashboard_id: { type: 'STRING' },
      },
      required: ['customer_id', 'dashboard_id'],
    },
  },
  {
    name: 'list_device_profiles',
    description: 'Lists all device profiles established in the database context.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_device_profile_by_id',
    description: 'Fetches configuration parameters associated with a specific device profile.',
    parameters: {
      type: 'OBJECT',
      properties: { profile_id: { type: 'STRING' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'send_one_way_rpc',
    description: 'Issues a fire-and-forget remote action parameter directly down to the physical node.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING' },
        method: { type: 'STRING' },
        params: { type: 'OBJECT' },
      },
      required: ['device_name', 'method', 'params'],
    },
  },
  {
    name: 'send_two_way_rpc',
    description: 'Issues a command and halts processes to confirm physical loop status responses.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING' },
        method: { type: 'STRING' },
        params: { type: 'OBJECT' },
      },
      required: ['device_name', 'method', 'params'],
    },
  },
  {
    name: 'list_persistent_rpcs',
    description: 'Lists queued device remote controller command records.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING' } },
      required: ['device_name'],
    },
  },
  {
    name: 'inject_rule_engine_queue',
    description: 'Pushes JSON payloads straight into custom Rule Engine queues.',
    parameters: {
      type: 'OBJECT',
      properties: {
        device_name: { type: 'STRING' },
        message_payload: { type: 'OBJECT' },
        queue_name: { type: 'STRING' },
      },
      required: ['device_name', 'message_payload', 'queue_name'],
    },
  },
  {
    name: 'get_audit_logs',
    description: 'Fetches structured log files mapping changes and interactions with system configurations.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_device_dashboard',
    description: 'Automatically constructs and saves a functional monitoring dashboard for a specific device with telemetry charts.',
    parameters: {
      type: 'OBJECT',
      properties: { device_name: { type: 'STRING', description: 'Exact name of the device' } },
      required: ['device_name'],
    },
  },
];

export class GeminiLiveWSBroker {
  private ws: WebSocket;
  private geminiSession: Session | null = null;
  private audioParts: string[] = [];
  private shouldClearAudioOnNextPacket = false;
  private responseQueue: LiveServerMessage[] = [];
  private bridge: ThingsBoardRESTBridge;
  private isProcessing = false;

  private TOOL_MAP: Record<string, Function>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.bridge = new ThingsBoardRESTBridge();

    // Map tools to bridge instances
    this.TOOL_MAP = {
      list_devices: () => this.bridge.listDevices(),
      get_current_telemetry: (args: { device_name: string }) => this.bridge.getLatestTelemetry(args.device_name),
      get_historical_summary: (args: { device_name: string; hours?: number }) => this.bridge.getHistoricalStats(args.device_name, args.hours),
      get_active_alarms: () => this.bridge.getActiveAlarms(),
      get_device_attributes: (args: { device_name: string }) => this.bridge.getAttributes(args.device_name),
      get_highest_metric: (args: { metric: string }) => this.bridge.getHighestMetric(args.metric),
      get_metric_trend: (args: { device_name: string; metric: string }) => this.bridge.getMetricTrend(args.device_name, args.metric),
      perform_deep_analysis: (args: { device_name: string; start_time?: string; end_time?: string; hours?: number }) =>
        this.bridge.performDeepAnalysis(args.device_name, args.start_time, args.end_time, args.hours),
      create_device: (args: { device_name: string; device_type: string; label?: string }) =>
        this.bridge.createDevice(args.device_name, args.device_type, args.label),
      delete_device: (args: { device_name: string }) => this.bridge.deleteDevice(args.device_name),
      get_device_credentials: (args: { device_name: string }) => this.bridge.getDeviceCredentials(args.device_name),
      acknowledge_alarm: (args: { alarm_id: string }) => this.bridge.acknowledgeAlarm(args.alarm_id),
      clear_alarm: (args: { alarm_id: string }) => this.bridge.clearAlarm(args.alarm_id),
      trigger_rule_engine: (args: { device_name: string; message: any }) => this.bridge.triggerRuleEngine(args.device_name, args.message),
      create_alarm: (args: { device_name: string; alarm_type: string; severity: string; details?: any }) =>
        this.bridge.createAlarm(args.device_name, args.alarm_type, args.severity, args.details),
      create_rule_chain: (args: { name: string; nodes: any[]; connections: any[]; first_node_index?: number }) =>
        this.bridge.createRuleChain(args.name, args.nodes, args.connections, args.first_node_index),
      list_assets: () => this.bridge.listAssets(),
      get_asset_by_name: (args: { asset_name: string }) => this.bridge.getAssetByName(args.asset_name),
      create_asset: (args: { asset_name: string; asset_type: string; label?: string }) =>
        this.bridge.createAsset(args.asset_name, args.asset_type, args.label),
      delete_asset: (args: { asset_name: string }) => this.bridge.deleteAsset(args.asset_name),
      create_relation: (args: { from_id: string; from_type: string; to_id: string; to_type: string; relation_type: string }) =>
        this.bridge.createRelation(args.from_id, args.from_type, args.to_id, args.to_type, args.relation_type),
      delete_relation: (args: { from_id: string; from_type: string; to_id: string; to_type: string; relation_type: string }) =>
        this.bridge.deleteRelation(args.from_id, args.from_type, args.to_id, args.to_type, args.relation_type),
      list_relations: (args: { entity_id: string; entity_type: string }) => this.bridge.listRelations(args.entity_id, args.entity_type),
      save_device_attributes: (args: { device_name: string; scope: string; attributes: any }) =>
        this.bridge.saveDeviceAttributes(args.device_name, args.scope, args.attributes),
      delete_device_attributes: (args: { device_name: string; scope: string; keys: string[] }) =>
        this.bridge.deleteDeviceAttributes(args.device_name, args.scope, args.keys),
      list_dashboards: () => this.bridge.listDashboards(),
      get_dashboard_by_id: (args: { dashboard_id: string }) => this.bridge.getDashboardById(args.dashboard_id),
      assign_dashboard_to_customer: (args: { customer_id: string; dashboard_id: string }) =>
        this.bridge.assignDashboardToCustomer(args.customer_id, args.dashboard_id),
      list_device_profiles: () => this.bridge.listDeviceProfiles(),
      get_device_profile_by_id: (args: { profile_id: string }) => this.bridge.getDeviceProfileById(args.profile_id),
      send_one_way_rpc: (args: { device_name: string; method: string; params: any }) =>
        this.bridge.sendOneWayRpc(args.device_name, args.method, args.params),
      send_two_way_rpc: (args: { device_name: string; method: string; params: any }) =>
        this.bridge.sendTwoWayRpc(args.device_name, args.method, args.params),
      list_persistent_rpcs: (args: { device_name: string }) => this.bridge.listPersistentRpcs(args.device_name),
      inject_rule_engine_queue: (args: { device_name: string; message_payload: any; queue_name: string }) =>
        this.bridge.injectRuleEngineQueue(args.device_name, args.message_payload, args.queue_name),
      get_audit_logs: () => this.bridge.getAuditLogs(),
      create_device_dashboard: (args: { device_name: string }) => this.bridge.createDeviceDashboard(args.device_name),
    };
  }

  public async start() {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      this.sendClientStatus('Error: GEMINI_API_KEY is missing from environment config.');
      return;
    }

    const ai = new GoogleGenAI({ apiKey: API_KEY });

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
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    try {
      this.geminiSession = await ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            this.sendClientStatus('Connected to Gemini Live Studio Session.');
            // Send initial operational trigger
            this.geminiSession?.sendRealtimeInput({
              text: "Hello! Copilot initialized. Run scan to discover active devices."
            });
            this.isProcessing = true;
            this.responseLoop();
          },
          onmessage: (message: LiveServerMessage) => {
            this.responseQueue.push(message);
          },
          onerror: (e: any) => {
            console.error('Gemini WS Broker Error:', e.message || e);
            this.sendClientStatus(`Gemini session error: ${e.message || 'unknown'}`);
          },
          onclose: (e: any) => {
            console.log('Gemini WS Broker Session closed:', e.reason || 'normal');
            this.sendClientStatus('Gemini session closed.');
            this.isProcessing = false;
          },
        },
        config,
      });
    } catch (err: any) {
      console.error('Fatal Gemini Live launch error:', err);
      this.sendClientStatus(`Fatal launch error: ${err.message}`);
    }
  }

  public handleClientMessage(payload: any) {
    if (!this.geminiSession) return;

    try {
      if (payload.type === 'text') {
        this.geminiSession.sendRealtimeInput({
          text: payload.text,
        });
      } else if (payload.type === 'audio_chunk') {
        this.geminiSession.sendRealtimeInput({
          audio: {
            data: payload.data, // base64 string
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      }
    } catch (err: any) {
      console.error('Failed to send payload to Gemini Live Session:', err.message);
    }
  }

  public close() {
    this.isProcessing = false;
    this.geminiSession?.close();
  }

  private async responseLoop() {
    while (this.isProcessing && this.ws.readyState === WebSocket.OPEN) {
      const message = this.responseQueue.shift();
      if (message) {
        await this.processMessage(message);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async processMessage(message: LiveServerMessage) {
    if (this.shouldClearAudioOnNextPacket) {
      this.audioParts.length = 0;
      this.shouldClearAudioOnNextPacket = false;
    }

    // 1. Send live transcription back to frontend
    if (message.serverContent?.outputTranscription?.text) {
      this.sendToClient({
        type: 'transcription',
        text: message.serverContent.outputTranscription.text,
      });
    }

    // 2. Collect and stream binary voice payloads immediately
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) {
          // Stream the raw base64 PCM chunk directly to the frontend
          this.sendToClient({
            type: 'audio_chunk',
            data: part.inlineData.data,
          });
        }
      }
    }

    // 3. Signal turn completion (optional, for UI status)
    if (message.serverContent?.turnComplete) {
      this.sendToClient({ type: 'turn_complete' });
    }

    // 4. Handle incoming operational tool execution requests on the bridge
    if (message.toolCall?.functionCalls) {
      const functionResponses = [];
      for (const call of message.toolCall.functionCalls) {
        if (call.name && call.name in this.TOOL_MAP) {
          
          // Dispatch status log indicating tool process initiation
          this.sendToClient({ type: 'tool_start', name: call.name });

          const func = this.TOOL_MAP[call.name];
          let result;
          try {
            result = await func(call.args);
          } catch (e: any) {
            result = { error: `Execution error: ${e.message}` };
          }

          // Format response Struct parameters compatibility
          let wrappedResponse: Record<string, any>;
          if (result === null || result === undefined) {
            wrappedResponse = { result: null };
          } else if (Array.isArray(result)) {
            wrappedResponse = { result };
          } else if (typeof result !== 'object') {
            wrappedResponse = { result };
          } else {
            wrappedResponse = result;
          }

          // Send logs indicating tool run completion
          this.sendToClient({
            type: 'tool_complete',
            name: call.name,
            result: wrappedResponse,
          });

          functionResponses.push({
            id: call.id,
            name: call.name,
            response: wrappedResponse,
          });
        } else {
          functionResponses.push({
            id: call.id,
            name: call.name || 'unknown',
            response: { error: `Function ${call.name} is not bound on this agent.` },
          });
        }
      }

      if (this.geminiSession) {
        try {
          await this.geminiSession.sendToolResponse({ functionResponses });
        } catch (err: any) {
          console.error('❌ Error sending tool response back to Gemini:', err.message);
        }
      }
    }
  }

  private convertToWav(rawData: string[], mimeType: string): Buffer {
    const options = this.parseMimeType(mimeType);
    const dataLength = rawData.reduce((a, b) => a + b.length, 0);
    const wavHeader = this.createWavHeader(dataLength, options);
    const buffer = Buffer.concat(rawData.map((data) => Buffer.from(data, 'base64')));
    return Buffer.concat([wavHeader, buffer]);
  }

  private parseMimeType(mimeType: string) {
    const [fileType, ...params] = mimeType.split(';').map((s) => s.trim());
    const [, format] = fileType.split('/');

    const options = {
      numChannels: 1,
      bitsPerSample: 16,
      sampleRate: 24000,
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

    return options;
  }

  private createWavHeader(dataLength: number, options: { numChannels: number, sampleRate: number, bitsPerSample: number }): Buffer {
    const { numChannels, sampleRate, bitsPerSample } = options;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const buffer = Buffer.alloc(44);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
  }

  private sendClientStatus(message: string) {
    this.sendToClient({ type: 'status', message });
  }

  private sendToClient(data: any) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
