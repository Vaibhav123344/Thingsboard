"use strict";
/**
 * livekitRoutes.ts
 * ─ GET  /api/livekit/token       → generates LiveKit JWT for browser or agent
 * ─ POST /api/tools/execute       → 37-tool REST gateway forwarding to bridge.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolsRouter = exports.livekitRouter = void 0;
const express_1 = require("express");
const livekit_server_sdk_1 = require("livekit-server-sdk");
const bridge_1 = require("./bridge");
// ── Shared bridge instance ──────────────────────────────────────────────────
const bridge = new bridge_1.ThingsBoardRESTBridge();
// ── Env config ──────────────────────────────────────────────────────────────
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secretkeydefaultvalue987654321012';
// ── Token Router ────────────────────────────────────────────────────────────
exports.livekitRouter = (0, express_1.Router)();
exports.livekitRouter.get('/token', (req, res) => {
    const room = req.query.room || 'zephyr-operational-room';
    const identity = req.query.identity || `operator-${Date.now()}`;
    const at = new livekit_server_sdk_1.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity,
        ttl: '2h',
    });
    at.addGrant({
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
    res.json({ token: at.toJwt(), room, identity });
});
// ── Tool Gateway Router ─────────────────────────────────────────────────────
exports.toolsRouter = (0, express_1.Router)();
const toolMap = {
    // ── Device telemetry & monitoring ──────────────────────────────────────────
    list_devices: () => bridge.listDevices(),
    get_current_telemetry: (a) => bridge.getLatestTelemetry(a.device_name),
    get_historical_summary: (a) => bridge.getHistoricalStats(a.device_name, a.hours),
    get_active_alarms: () => bridge.getActiveAlarms(),
    get_device_attributes: (a) => bridge.getAttributes(a.device_name),
    get_highest_metric: (a) => bridge.getHighestMetric(a.metric),
    get_metric_trend: (a) => bridge.getMetricTrend(a.device_name, a.metric),
    perform_deep_analysis: (a) => bridge.performDeepAnalysis(a.device_name, a.start_time, a.end_time, a.hours),
    // ── Device lifecycle ───────────────────────────────────────────────────────
    create_device: (a) => bridge.createDevice(a.device_name, a.device_type, a.label, a.attributes, a.profile_name),
    delete_device: (a) => bridge.deleteDevice(a.device_name),
    get_device_credentials: (a) => bridge.getDeviceCredentials(a.device_name),
    // ── Alarms ─────────────────────────────────────────────────────────────────
    acknowledge_alarm: (a) => bridge.acknowledgeAlarm(a.alarm_id),
    clear_alarm: (a) => bridge.clearAlarm(a.alarm_id),
    trigger_rule_engine: (a) => bridge.triggerRuleEngine(a.device_name, a.message),
    create_alarm: (a) => bridge.createAlarm(a.device_name, a.alarm_type, a.severity, a.details, a.metric_param, a.operator_condition, a.comparison_value),
    // ── Rule engine ────────────────────────────────────────────────────────────
    create_rule_chain: (a) => bridge.createRuleChain(a.name, a.nodes, a.connections, a.first_node_index),
    inject_rule_engine_queue: (a) => bridge.injectRuleEngineQueue(a.device_name, a.message_payload, a.queue_name),
    // ── Assets ─────────────────────────────────────────────────────────────────
    list_assets: () => bridge.listAssets(),
    get_asset_by_name: (a) => bridge.getAssetByName(a.asset_name),
    create_asset: (a) => bridge.createAsset(a.asset_name, a.asset_type, a.label),
    delete_asset: (a) => bridge.deleteAsset(a.asset_name),
    // ── Relations ──────────────────────────────────────────────────────────────
    create_relation: (a) => bridge.createRelation(a.from_name, a.to_name, a.relation_type),
    delete_relation: (a) => bridge.deleteRelation(a.from_name, a.to_name, a.relation_type),
    list_relations: (a) => bridge.listRelations(a.entity_name),
    // ── Device attributes ──────────────────────────────────────────────────────
    save_device_attributes: (a) => bridge.saveDeviceAttributes(a.device_name, a.scope, a.attributes),
    delete_device_attributes: (a) => bridge.deleteDeviceAttributes(a.device_name, a.scope, a.keys),
    // ── Dashboards ─────────────────────────────────────────────────────────────
    list_dashboards: () => bridge.listDashboards(),
    get_dashboard_by_id: (a) => bridge.getDashboardById(a.dashboard_id),
    assign_dashboard_to_customer: (a) => bridge.assignDashboardToCustomer(a.customer_id, a.dashboard_id),
    create_device_dashboard: (a) => bridge.createDeviceDashboard(a.device_name, a.monitored_keys, a.dashboard_title, a.background_color),
    // ── Device profiles ────────────────────────────────────────────────────────
    list_device_profiles: () => bridge.listDeviceProfiles(),
    get_device_profile_by_id: (a) => bridge.getDeviceProfileById(a.profile_id),
    // ── RPC ────────────────────────────────────────────────────────────────────
    send_one_way_rpc: (a) => bridge.sendOneWayRpc(a.device_name, a.method, a.params),
    send_two_way_rpc: (a) => bridge.sendTwoWayRpc(a.device_name, a.method, a.params),
    list_persistent_rpcs: (a) => bridge.listPersistentRpcs(a.device_name),
    // ── Audit & analytics ──────────────────────────────────────────────────────
    get_audit_logs: () => bridge.getAuditLogs(),
    forecast_what_if: (a) => bridge.forecastWhatIf(a),
};
exports.toolsRouter.post('/execute', async (req, res) => {
    const { name, args } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, error: 'Tool name is required' });
    }
    const handler = toolMap[name];
    if (!handler) {
        return res.status(404).json({ success: false, error: `Tool '${name}' not found` });
    }
    try {
        const result = await handler(args ?? {});
        res.json({ success: true, result });
    }
    catch (err) {
        console.error(`[Tool Error] ${name}:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
