// live_agent_ws.ts
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
      properties: {
        device_name: { type: 'STRING', description: 'The exact name of the device' },
        keys: { type: 'STRING', description: 'Optional comma-separated metric keys list, e.g. "temperature,vibration"' }
      },
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
        keys: { type: 'STRING', description: 'Optional comma-separated metric keys list' },
        start_ts: { type: 'INTEGER', description: 'Optional absolute start Epoch milliseconds timestamp' },
        end_ts: { type: 'INTEGER', description: 'Optional absolute end Epoch milliseconds timestamp' },
        agg: { type: 'STRING', description: 'Optional aggregation function: NONE, AVG, MIN, MAX, SUM, COUNT' },
        interval: { type: 'INTEGER', description: 'Optional aggregation interval in milliseconds' }
      },
      required: ['device_name'],
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
  },
  {
    name: 'find_alarms',
    description: 'Search and filter active or cleared alarms dynamically by entity, severity, status, or text search.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_type: { type: 'STRING', description: 'Optional filter by entity type: DEVICE, ASSET (default: DEVICE)' },
        entity_name: { type: 'STRING', description: 'Optional filter by specific entity name' },
        page_size: { type: 'INTEGER', description: 'Number of alarms to fetch (default: 10)' },
        page: { type: 'INTEGER', description: 'Page number (default: 0)' },
        text_search: { type: 'STRING', description: 'Optional text filter' },
        severity_list: { type: 'STRING', description: 'Optional comma-separated severities, e.g. "CRITICAL,MAJOR"' },
        status_list: { type: 'STRING', description: 'Optional comma-separated statuses, e.g. "ACTIVE_UNACK,ACTIVE_ACK"' }
      }
    }
  },
  {
    name: 'count_alarms',
    description: 'Count active alarms on devices or assets matching severity and status filters.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_type: { type: 'STRING', description: 'Optional filter by entity type: DEVICE, ASSET (default: DEVICE)' },
        entity_name: { type: 'STRING', description: 'Optional filter by specific entity name' },
        severity_list: { type: 'STRING', description: 'Optional comma-separated severities, e.g. "CRITICAL,MAJOR" (default: "CRITICAL")' },
        status_list: { type: 'STRING', description: 'Optional comma-separated statuses, e.g. "ACTIVE_UNACK,ACTIVE_ACK" (default: "ACTIVE_UNACK,ACTIVE_ACK")' }
      }
    }
  },
  {
    name: 'find_highest_entity_metric',
    description: 'Find which device or asset currently has the highest value for a specific metric key.',
    parameters: {
      type: 'OBJECT',
      properties: {
        metric: { type: 'STRING', description: 'Metric key name to compare (e.g. "temperature", "vibration")' },
        device_type: { type: 'STRING', description: 'Optional device type filter, e.g. "industrial_sensor"' }
      },
      required: ['metric']
    }
  },
  {
    name: 'query_entity_data',
    description: 'Bulk fetch telemetry and attribute data using filter rules, page constraints, and predicates. Expects a JSON query string.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query_json: { type: 'STRING', description: 'Full JSON query structure including entityFilter, latestValues, pageLink, keyFilters' }
      },
      required: ['query_json']
    }
  },
  {
    name: 'count_entities',
    description: 'Count devices or assets matching attribute or telemetry filters. Expects JSON filter strings.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_filter_json: { type: 'STRING', description: 'JSON structure of entityFilter' },
        key_filters_json: { type: 'STRING', description: 'JSON array string of keyFilters (optional)' }
      },
      required: ['entity_filter_json']
    }
  },
  {
    name: 'find_available_keys',
    description: 'Retrieve all telemetry and attribute keys currently saved on entities matching a filter. Expects a JSON filter string.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_filter_json: { type: 'STRING', description: 'JSON structure of entityFilter' },
        include_timeseries: { type: 'BOOLEAN', description: 'Include timeseries keys (default: true)' },
        include_attributes: { type: 'BOOLEAN', description: 'Include attribute keys (default: true)' }
      },
      required: ['entity_filter_json']
    }
  },
  {
    name: 'get_rule_node_events',
    description: 'Retrieve real-time event logs and diagnostics from a custom rule node to debug rule chains.',
    parameters: {
      type: 'OBJECT',
      properties: {
        rule_node_id: { type: 'STRING', description: 'UUID of the rule node' },
        limit: { type: 'INTEGER', description: 'Max event logs to fetch (default: 10)' }
      },
      required: ['rule_node_id']
    }
  },
  {
    name: 'provision_customer_dashboard',
    description: 'Assign access and visibility rights for a dashboard to a designated customer tenant.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customer_id: { type: 'STRING', description: 'UUID of the customer' },
        dashboard_id: { type: 'STRING', description: 'UUID of the dashboard' }
      },
      required: ['customer_id', 'dashboard_id']
    }
  }
];

export class GeminiLiveWSBroker {
  private ws: WebSocket;
  private geminiSession: Session | null = null;
  private responseQueue: LiveServerMessage[] = [];
  private bridge: ThingsBoardRESTBridge;
  private isProcessing = false;
  private queueResolver: (() => void) | null = null;

  private TOOL_MAP: Record<string, Function>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.bridge = new ThingsBoardRESTBridge();

    this.TOOL_MAP = {
      list_devices: () => this.bridge.listDevices(),
      get_current_telemetry: (args: { device_name: string; keys?: string }) => this.bridge.getLatestTelemetry(args.device_name, args.keys),
      get_historical_summary: (args: {
        device_name: string;
        hours?: number;
        keys?: string;
        start_ts?: number;
        end_ts?: number;
        agg?: string;
        interval?: number;
      }) => this.bridge.getHistoricalStats(
        args.device_name,
        args.hours,
        args.keys,
        args.start_ts,
        args.end_ts,
        args.agg,
        args.interval
      ),
      get_active_alarms: () => this.bridge.getActiveAlarms(),
      get_device_attributes: (args: { device_name: string }) => this.bridge.getAttributes(args.device_name),
      get_highest_metric: (args: { metric: string }) => this.bridge.getHighestMetric(args.metric),
      get_metric_trend: (args: { device_name: string; metric: string }) => this.bridge.getMetricTrend(args.device_name, args.metric),
      perform_deep_analysis: (args: { device_name: string; start_time?: string; end_time?: string; hours?: number }) =>
        this.bridge.performDeepAnalysis(args.device_name, args.start_time, args.end_time, args.hours),
      create_device: (args: { device_name: string; device_type: string; label?: string; attributes?: any; profile_name?: string }) =>
        this.bridge.createDevice(args.device_name, args.device_type, args.label, args.attributes, args.profile_name),
      delete_device: (args: { device_name: string }) => this.bridge.deleteDevice(args.device_name),
      get_device_credentials: (args: { device_name: string }) => this.bridge.getDeviceCredentials(args.device_name),
      acknowledge_alarm: (args: { alarm_id: string }) => this.bridge.acknowledgeAlarm(args.alarm_id),
      clear_alarm: (args: { alarm_id: string }) => this.bridge.clearAlarm(args.alarm_id),
      trigger_rule_engine: (args: { device_name: string; message: any }) => this.bridge.triggerRuleEngine(args.device_name, args.message),
      create_alarm: (args: { device_name: string; alarm_type: string; severity: string; details?: any; metric_param?: string; operator_condition?: string; comparison_value?: number }) =>
        this.bridge.createAlarm(args.device_name, args.alarm_type, args.severity, args.details, args.metric_param, args.operator_condition, args.comparison_value),
      create_rule_chain: (args: { name: string; nodes: any[]; connections: any[]; first_node_index?: number }) =>
        this.bridge.createRuleChain(args.name, args.nodes, args.connections, args.first_node_index),
      list_assets: () => this.bridge.listAssets(),
      get_asset_by_name: (args: { asset_name: string }) => this.bridge.getAssetByName(args.asset_name),
      create_asset: (args: { asset_name: string; asset_type: string; label?: string }) =>
        this.bridge.createAsset(args.asset_name, args.asset_type, args.label),
      delete_asset: (args: { asset_name: string }) => this.bridge.deleteAsset(args.asset_name),
      create_relation: (args: { from_name: string; to_name: string; relation_type: string }) =>
        this.bridge.createRelation(args.from_name, args.to_name, args.relation_type),
      delete_relation: (args: { from_name: string; to_name: string; relation_type: string }) =>
        this.bridge.deleteRelation(args.from_name, args.to_name, args.relation_type),
      list_relations: (args: { entity_name: string }) => this.bridge.listRelations(args.entity_name),
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
      create_device_dashboard: (args: { device_name: string; monitored_keys?: string[]; dashboard_title?: string; background_color?: string }) => 
        this.bridge.createDeviceDashboard(args.device_name, args.monitored_keys, args.dashboard_title, args.background_color),
      forecast_what_if: (args: { device_name: string; target_metric: string; prediction_horizon_steps?: number; interventions?: any[]; question_type?: string; crossing_threshold?: number }) =>
        this.bridge.forecastWhatIf(args),
      
      // ── New & Refactored Tools ─────────────────────────────────────────────
      find_alarms: (args: any) => {
        const sevs = args.severity_list ? args.severity_list.split(',').map((s: string) => s.trim().toUpperCase()) : undefined;
        const stats = args.status_list ? args.status_list.split(',').map((s: string) => s.trim().toUpperCase()) : undefined;
        return this.bridge.findAlarms({
          entityType: args.entity_type || 'DEVICE',
          entityName: args.entity_name || undefined,
          pageSize: args.page_size || 10,
          page: args.page || 0,
          textSearch: args.text_search || undefined,
          severityList: sevs,
          statusList: stats
        });
      },
      count_alarms: (args: any) => {
        const sevs = args.severity_list ? args.severity_list.split(',').map((s: string) => s.trim().toUpperCase()) : ['CRITICAL'];
        const stats = args.status_list ? args.status_list.split(',').map((s: string) => s.trim().toUpperCase()) : ['ACTIVE_UNACK', 'ACTIVE_ACK'];
        return this.bridge.countAlarms({
          entityType: args.entity_type || 'DEVICE',
          entityName: args.entity_name || undefined,
          severityList: sevs,
          statusList: stats
        });
      },
      find_highest_entity_metric: (args: { metric: string; device_type?: string }) =>
        this.bridge.findHighestEntityMetric(args.metric, args.device_type),
      query_entity_data: (args: { query_json: string }) => {
        const payload = JSON.parse(args.query_json);
        return this.bridge.queryEntityData(payload);
      },
      count_entities: (args: { entity_filter_json: string; key_filters_json?: string }) => {
        const ef = JSON.parse(args.entity_filter_json);
        const kf = args.key_filters_json ? JSON.parse(args.key_filters_json) : [];
        return this.bridge.countEntities({
          entityFilter: ef,
          keyFilters: kf
        });
      },
      find_available_keys: (args: { entity_filter_json: string; include_timeseries?: boolean; include_attributes?: boolean }) => {
        const ef = JSON.parse(args.entity_filter_json);
        return this.bridge.findAvailableKeys({
          entityFilter: ef,
          includeTimeseries: args.include_timeseries !== false,
          includeAttributes: args.include_attributes !== false
        });
      },
      get_rule_node_events: (args: { rule_node_id: string; limit?: number }) =>
        this.bridge.getRuleNodeEvents(args.rule_node_id, args.limit || 10),
      provision_customer_dashboard: (args: { customer_id: string; dashboard_id: string }) =>
        this.bridge.provisionCustomerDashboard(args.customer_id, args.dashboard_id),
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
            this.geminiSession?.sendRealtimeInput({
              text: "Hello! Copilot initialized. Run scan to discover active devices."
            });
            this.isProcessing = true;
            this.responseLoop();
          },
          onmessage: (message: LiveServerMessage) => {
            this.responseQueue.push(message);
            if (this.queueResolver) {
              this.queueResolver();
              this.queueResolver = null;
            }
          },
          onerror: (e: any) => {
            console.error('Gemini WS Broker Error:', e.message || e);
            this.sendClientStatus(`Gemini session error: ${e.message || 'unknown'}`);
          },
          onclose: (e: any) => {
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
            data: payload.data,
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
    if (this.queueResolver) {
      this.queueResolver();
    }
  }

  // Event-driven response loop (zero lag, no setInterval blockages)
  private async responseLoop() {
    while (this.isProcessing && this.ws.readyState === WebSocket.OPEN) {
      const message = this.responseQueue.shift();
      if (message) {
        await this.processMessage(message);
      } else {
        // Wait asynchronously until a new message is pushed, freeing Node's thread
        await new Promise<void>((resolve) => {
          this.queueResolver = resolve;
        });
      }
    }
  }

  private async processMessage(message: LiveServerMessage) {
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
          } catch (e: any) {
            result = { error: `Execution error: ${e.message}` };
          }

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
          console.error('Error sending tool response to Gemini:', err.message);
        }
      }
    }
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
