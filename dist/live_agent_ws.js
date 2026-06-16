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
exports.GeminiLiveWSBroker = void 0;
// live_agent_ws.ts
const genai_1 = require("@google/genai");
const ws_1 = require("ws");
const dotenv = __importStar(require("dotenv"));
const bridge_1 = require("./bridge");
dotenv.config();
const MODEL_NAME = 'models/gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Zephyr';
const SYSTEM_INSTRUCTION = `
## IDENTITY & PERSONALITY
You are Zephyr, an elite Industrial Operations Copilot. You don't just report data; you provide proactive, predictive insights to ensure factory uptime and safety.
You speak with technical authority, precision, and efficiency. You are the digital supervisor of this smart factory.

## PROACTIVE ANALYSIS & ALERTS
1. **Critical Monitoring**: If any telemetry tool returns temperature > 80.0°C or vibration > 4.0 G-force, immediately alert the operator with a high-severity warning.
2. **Trend Awareness**: When asked for a status update, automatically check trends. If a metric is rising quickly towards a limit, warn before it hits the threshold.
3. **Deep Audits**: When performing a deep analysis, verbally summarize the key "health indicators" (avg/max/min) and highlight any "breach periods" where the system was at risk.

## PREDICTIVE WHAT-IF HYPOTHESIS TESTING
You have access to a powerful Chronos-2 multivariate forecasting engine. 
**Usage Scenarios**: 
- If the operator asks about future risks (e.g., "What happens if...").
- If a scenario involves changing covariates (e.g., "If I increase speed to 1500 RPM...").
- If the operator needs to know *when* something will happen (e.g., "When will vibration peak next week?").

**Execution Guidelines**:
- **Tool**: Always use \`forecast_what_if\`.
- **Parsing**: Accurately parse the "target_metric" (the one we want to predict) and "interventions" (the changes being made to other metrics like pressure, speed, etc.).
- **Synthesis**: When the tool returns results, do not just read the numbers. Explain the physical impact:
  - "My predictive analysis indicates that under those conditions, vibration will reach a critical peak of 4.2 G-force at approximately 6:30 PM today."
  - "The model detects a recurring peak cycle every 12.5 hours, suggesting a potential resonance issue at that speed."
  - "Safety Warning: The projected temperature will cross your 80-degree threshold in exactly 4 hours."

## OPERATIONAL ETIQUETTE
- Be concise. Industrial operators value time.
- Always use physical units: Degrees Celsius, Percent Humidity, Bar, G-force.
- If a tool call fails, suggest a troubleshooting step or ask for clarification on the parameters.
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
        description: 'Registers a new industrial device. Supports profile name linking and initial configuration server-scope attributes.',
        parameters: {
            type: 'OBJECT',
            properties: {
                device_name: { type: 'STRING', description: 'Unique descriptive name' },
                device_type: { type: 'STRING', description: 'The category or model of device' },
                label: { type: 'STRING', description: 'Descriptive physical label' },
                profile_name: { type: 'STRING', description: 'The device profile name to bind with' },
                attributes: { type: 'OBJECT', description: 'Initial parameters mapping' }
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
        description: 'Creates a structured alarm. Accepts comparison thresholds to replicate UI validation rules.',
        parameters: {
            type: 'OBJECT',
            properties: {
                device_name: { type: 'STRING', description: 'Name of the originator device' },
                alarm_type: { type: 'STRING', description: 'Categorized type, e.g. HighTemperature' },
                severity: { type: 'STRING', description: 'CRITICAL, MAJOR, MINOR, WARNING' },
                metric_param: { type: 'STRING', description: 'The telemetry parameter to trigger upon, e.g. temperature' },
                operator_condition: { type: 'STRING', description: 'Comparison operator: GREATER, LESS, EQUALS' },
                comparison_value: { type: 'NUMBER', description: 'Threshold benchmark value' },
                details: { type: 'OBJECT', description: 'Optional metadata log payload' }
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
        description: 'Establishes a semantic relationship. Automatically resolves entity names to UUIDs.',
        parameters: {
            type: 'OBJECT',
            properties: {
                from_name: { type: 'STRING', description: 'The device or asset name originating the relationship' },
                to_name: { type: 'STRING', description: 'The device or asset name target of the relationship' },
                relation_type: { type: 'STRING', description: 'Relation descriptor, e.g. Contains, ManagedBy' }
            },
            required: ['from_name', 'to_name', 'relation_type'],
        },
    },
    {
        name: 'delete_relation',
        description: 'Removes a mapped relationship between two named entities.',
        parameters: {
            type: 'OBJECT',
            properties: {
                from_name: { type: 'STRING', description: 'The source entity name' },
                to_name: { type: 'STRING', description: 'The target entity name' },
                relation_type: { type: 'STRING', description: 'Relationship identifier' }
            },
            required: ['from_name', 'to_name', 'relation_type'],
        },
    },
    {
        name: 'list_relations',
        description: 'Lists all outgoing relationship mappings mapped from a named entity.',
        parameters: {
            type: 'OBJECT',
            properties: {
                entity_name: { type: 'STRING', description: 'The named device or asset to scan' }
            },
            required: ['entity_name'],
        },
    },
    {
        name: 'save_device_attributes',
        description: 'Writes attributes within selected scoping metrics (SERVER_SCOPE, SHARED_SCOPE).',
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
        description: 'Builds a structured real-time line chart monitoring dashboard. Accepts custom parameter keys and layouts.',
        parameters: {
            type: 'OBJECT',
            properties: {
                device_name: { type: 'STRING', description: 'Exact name of the device' },
                monitored_keys: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Specific telemetry fields to plot' },
                dashboard_title: { type: 'STRING', description: 'Optional operational title mapping' },
                background_color: { type: 'STRING', description: 'Visual style Hex code' }
            },
            required: ['device_name'],
        },
    },
    {
        name: 'forecast_what_if',
        description: "Performs a 'What-if' predictive analysis using multivariate forecasting. Simulates interventions on covariates (e.g., set to a value, or scale by a multiplier) over a prediction horizon, and projects the target metric. Answers recurrence, peak, or crossing time questions.",
        parameters: {
            type: 'OBJECT',
            properties: {
                device_name: { type: 'STRING', description: 'The exact name of the device' },
                target_metric: { type: 'STRING', description: 'The target telemetry parameter/metric to forecast (e.g. vibration, temperature)' },
                prediction_horizon_steps: { type: 'INTEGER', description: 'The number of time steps (15-min intervals) to forecast into the future (default 96 steps, i.e., 24 hours)' },
                interventions: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            metric: { type: 'STRING', description: 'The covariate parameter to modify (e.g., pressure, speed, temperature)' },
                            action: { type: 'STRING', description: 'The intervention action: scale (multiply values by factor) or set (set to constant value)' },
                            value: { type: 'NUMBER', description: 'The multiplier factor or constant target value for the intervention' }
                        },
                        required: ['metric', 'action', 'value']
                    },
                    description: 'List of simulated changes to the covariates over the prediction horizon'
                },
                question_type: { type: 'STRING', description: "The analytical question type: peak (when/what value of peak), crossing (when it crosses threshold), or recurrence (time to next peak recurrence)" },
                crossing_threshold: { type: 'NUMBER', description: 'The threshold value to check for crossing if question_type is crossing' }
            },
            required: ['device_name', 'target_metric']
        }
    }
];
class GeminiLiveWSBroker {
    ws;
    geminiSession = null;
    responseQueue = [];
    bridge;
    isProcessing = false;
    queueResolver = null;
    TOOL_MAP;
    constructor(ws) {
        this.ws = ws;
        this.bridge = new bridge_1.ThingsBoardRESTBridge();
        this.TOOL_MAP = {
            list_devices: () => this.bridge.listDevices(),
            get_current_telemetry: (args) => this.bridge.getLatestTelemetry(args.device_name),
            get_historical_summary: (args) => this.bridge.getHistoricalStats(args.device_name, args.hours),
            get_active_alarms: () => this.bridge.getActiveAlarms(),
            get_device_attributes: (args) => this.bridge.getAttributes(args.device_name),
            get_highest_metric: (args) => this.bridge.getHighestMetric(args.metric),
            get_metric_trend: (args) => this.bridge.getMetricTrend(args.device_name, args.metric),
            perform_deep_analysis: (args) => this.bridge.performDeepAnalysis(args.device_name, args.start_time, args.end_time, args.hours),
            create_device: (args) => this.bridge.createDevice(args.device_name, args.device_type, args.label, args.attributes, args.profile_name),
            delete_device: (args) => this.bridge.deleteDevice(args.device_name),
            get_device_credentials: (args) => this.bridge.getDeviceCredentials(args.device_name),
            acknowledge_alarm: (args) => this.bridge.acknowledgeAlarm(args.alarm_id),
            clear_alarm: (args) => this.bridge.clearAlarm(args.alarm_id),
            trigger_rule_engine: (args) => this.bridge.triggerRuleEngine(args.device_name, args.message),
            create_alarm: (args) => this.bridge.createAlarm(args.device_name, args.alarm_type, args.severity, args.details, args.metric_param, args.operator_condition, args.comparison_value),
            create_rule_chain: (args) => this.bridge.createRuleChain(args.name, args.nodes, args.connections, args.first_node_index),
            list_assets: () => this.bridge.listAssets(),
            get_asset_by_name: (args) => this.bridge.getAssetByName(args.asset_name),
            create_asset: (args) => this.bridge.createAsset(args.asset_name, args.asset_type, args.label),
            delete_asset: (args) => this.bridge.deleteAsset(args.asset_name),
            create_relation: (args) => this.bridge.createRelation(args.from_name, args.to_name, args.relation_type),
            delete_relation: (args) => this.bridge.deleteRelation(args.from_name, args.to_name, args.relation_type),
            list_relations: (args) => this.bridge.listRelations(args.entity_name),
            save_device_attributes: (args) => this.bridge.saveDeviceAttributes(args.device_name, args.scope, args.attributes),
            delete_device_attributes: (args) => this.bridge.deleteDeviceAttributes(args.device_name, args.scope, args.keys),
            list_dashboards: () => this.bridge.listDashboards(),
            get_dashboard_by_id: (args) => this.bridge.getDashboardById(args.dashboard_id),
            assign_dashboard_to_customer: (args) => this.bridge.assignDashboardToCustomer(args.customer_id, args.dashboard_id),
            list_device_profiles: () => this.bridge.listDeviceProfiles(),
            get_device_profile_by_id: (args) => this.bridge.getDeviceProfileById(args.profile_id),
            send_one_way_rpc: (args) => this.bridge.sendOneWayRpc(args.device_name, args.method, args.params),
            send_two_way_rpc: (args) => this.bridge.sendTwoWayRpc(args.device_name, args.method, args.params),
            list_persistent_rpcs: (args) => this.bridge.listPersistentRpcs(args.device_name),
            inject_rule_engine_queue: (args) => this.bridge.injectRuleEngineQueue(args.device_name, args.message_payload, args.queue_name),
            get_audit_logs: () => this.bridge.getAuditLogs(),
            create_device_dashboard: (args) => this.bridge.createDeviceDashboard(args.device_name, args.monitored_keys, args.dashboard_title, args.background_color),
            forecast_what_if: (args) => this.bridge.forecastWhatIf(args),
        };
    }
    async start() {
        const API_KEY = process.env.GEMINI_API_KEY;
        if (!API_KEY) {
            this.sendClientStatus('Error: GEMINI_API_KEY is missing from environment config.');
            return;
        }
        const ai = new genai_1.GoogleGenAI({ apiKey: API_KEY });
        const config = {
            responseModalities: [genai_1.Modality.AUDIO],
            mediaResolution: genai_1.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
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
            tools: [{ functionDeclarations: toolDeclarations }],
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
                        this.geminiSession?.sendRealtimeInput({
                            text: "Hello! Copilot initialized. Run scan to discover active devices."
                        });
                        this.isProcessing = true;
                        this.responseLoop();
                    },
                    onmessage: (message) => {
                        this.responseQueue.push(message);
                        if (this.queueResolver) {
                            this.queueResolver();
                            this.queueResolver = null;
                        }
                    },
                    onerror: (e) => {
                        console.error('Gemini WS Broker Error:', e.message || e);
                        this.sendClientStatus(`Gemini session error: ${e.message || 'unknown'}`);
                    },
                    onclose: (e) => {
                        console.log('Gemini WS Broker Session closed:', e.reason || 'normal');
                        this.sendClientStatus('Gemini session closed.');
                        this.isProcessing = false;
                        if (this.queueResolver) {
                            this.queueResolver();
                        }
                    },
                },
                config,
            });
        }
        catch (err) {
            console.error('Fatal Gemini Live launch error:', err);
            this.sendClientStatus(`Fatal launch error: ${err.message}`);
        }
    }
    handleClientMessage(payload) {
        if (!this.geminiSession)
            return;
        try {
            if (payload.type === 'text') {
                this.geminiSession.sendRealtimeInput({
                    text: payload.text,
                });
            }
            else if (payload.type === 'audio_chunk') {
                this.geminiSession.sendRealtimeInput({
                    audio: {
                        data: payload.data,
                        mimeType: 'audio/pcm;rate=16000',
                    },
                });
            }
        }
        catch (err) {
            console.error('Failed to send payload to Gemini Live Session:', err.message);
        }
    }
    close() {
        this.isProcessing = false;
        this.geminiSession?.close();
        if (this.queueResolver) {
            this.queueResolver();
        }
    }
    // Event-driven response loop (zero lag, no setInterval blockages)
    async responseLoop() {
        while (this.isProcessing && this.ws.readyState === ws_1.WebSocket.OPEN) {
            const message = this.responseQueue.shift();
            if (message) {
                await this.processMessage(message);
            }
            else {
                // Wait asynchronously until a new message is pushed, freeing Node's thread
                await new Promise((resolve) => {
                    this.queueResolver = resolve;
                });
            }
        }
    }
    async processMessage(message) {
        if (message.serverContent?.outputTranscription?.text) {
            this.sendToClient({
                type: 'transcription',
                text: message.serverContent.outputTranscription.text,
            });
        }
        if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData && part.inlineData.data) {
                    this.sendToClient({
                        type: 'audio_chunk',
                        data: part.inlineData.data,
                    });
                }
            }
        }
        if (message.serverContent?.turnComplete) {
            this.sendToClient({ type: 'turn_complete' });
        }
        if (message.toolCall?.functionCalls) {
            const functionResponses = [];
            for (const call of message.toolCall.functionCalls) {
                if (call.name && call.name in this.TOOL_MAP) {
                    this.sendToClient({ type: 'tool_start', name: call.name });
                    const func = this.TOOL_MAP[call.name];
                    let result;
                    try {
                        result = await func(call.args);
                    }
                    catch (e) {
                        result = { error: `Execution error: ${e.message}` };
                    }
                    let wrappedResponse;
                    if (result === null || result === undefined) {
                        wrappedResponse = { result: null };
                    }
                    else if (Array.isArray(result)) {
                        wrappedResponse = { result };
                    }
                    else if (typeof result !== 'object') {
                        wrappedResponse = { result };
                    }
                    else {
                        wrappedResponse = result;
                    }
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
                }
                else {
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
                }
                catch (err) {
                    console.error('Error sending tool response to Gemini:', err.message);
                }
            }
        }
    }
    sendClientStatus(message) {
        this.sendToClient({ type: 'status', message });
    }
    sendToClient(data) {
        if (this.ws.readyState === ws_1.WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}
exports.GeminiLiveWSBroker = GeminiLiveWSBroker;
