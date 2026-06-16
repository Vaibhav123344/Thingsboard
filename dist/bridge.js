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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThingsBoardRESTBridge = void 0;
// bridge.ts
const fs_1 = require("fs");
const path = __importStar(require("path"));
const axios_1 = __importDefault(require("axios"));
const restClient_1 = require("./restClient");
const services_1 = require("./services");
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60 seconds
class ThingsBoardRESTBridge {
    client;
    deviceSrv;
    telemetrySrv;
    alarmSrv;
    ruleSrv;
    assetSrv;
    relationSrv;
    dashboardSrv;
    profileSrv;
    rpcSrv;
    auditSrv;
    // Supports caching with TTL for negative lookups
    deviceCache = {};
    assetCache = {};
    fallbackThresholds = {
        temperature: { min: 20.0, max: 75.0 },
        humidity: { min: 20.0, max: 85.0 },
        pressure: { min: 0.8, max: 1.4 },
        vibration: { min: 0.0, max: 4.0 },
    };
    constructor() {
        this.client = new restClient_1.ThingsBoardClient({
            baseUrl: process.env.THINGSBOARD_HOST || 'http://localhost:8080',
            username: process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org',
            password: process.env.THINGSBOARD_PASSWORD || 'tenant',
            verifySsl: false,
        });
        this.deviceSrv = new services_1.DeviceService(this.client);
        this.telemetrySrv = new services_1.TelemetryService(this.client);
        this.alarmSrv = new services_1.AlarmService(this.client);
        this.ruleSrv = new services_1.RuleEngineService(this.client);
        this.assetSrv = new services_1.AssetService(this.client);
        this.relationSrv = new services_1.RelationService(this.client);
        this.dashboardSrv = new services_1.DashboardService(this.client);
        this.profileSrv = new services_1.DeviceProfileService(this.client);
        this.rpcSrv = new services_1.RpcService(this.client);
        this.auditSrv = new services_1.AuditService(this.client);
    }
    isoToEpochMs(isoStr) {
        try {
            return new Date(isoStr).getTime();
        }
        catch {
            return Date.now();
        }
    }
    async getDeviceId(deviceName) {
        const cached = this.deviceCache[deviceName];
        if (cached !== undefined) {
            // If positive cache, return immediately
            if (cached.value !== null)
                return cached.value;
            // If negative cache, check TTL
            if (Date.now() < cached.expiresAt)
                return null;
            // TTL expired, re-query
            delete this.deviceCache[deviceName];
        }
        try {
            const res = await this.client.request('GET', '/api/tenant/device', { deviceName });
            if (res && res.id) {
                const devId = res.id.id;
                this.deviceCache[deviceName] = { value: devId, expiresAt: 0 };
                return devId;
            }
        }
        catch (err) {
            console.warn(`[Bridge Cache] Resolve device failed for '${deviceName}': ${err.message}`);
        }
        // Negative cache with TTL
        this.deviceCache[deviceName] = { value: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS };
        return null;
    }
    async getAssetId(assetName) {
        const cached = this.assetCache[assetName];
        if (cached !== undefined) {
            if (cached.value !== null)
                return cached.value;
            if (Date.now() < cached.expiresAt)
                return null;
            delete this.assetCache[assetName];
        }
        try {
            const res = await this.client.request('GET', '/api/tenant/asset', { assetName });
            if (res && res.id) {
                const assetId = res.id.id;
                this.assetCache[assetName] = { value: assetId, expiresAt: 0 };
                return assetId;
            }
        }
        catch (err) {
            console.warn(`[Bridge Cache] Resolve asset failed for '${assetName}': ${err.message}`);
        }
        this.assetCache[assetName] = { value: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS };
        return null;
    }
    async resolveEntityIdAndType(name) {
        const devId = await this.getDeviceId(name);
        if (devId)
            return { id: devId, type: 'DEVICE' };
        const assetId = await this.getAssetId(name);
        if (assetId)
            return { id: assetId, type: 'ASSET' };
        return null;
    }
    // Safe min/max that won't blow the call stack on large arrays
    safeMin(arr) {
        let min = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] < min)
                min = arr[i];
        }
        return min;
    }
    safeMax(arr) {
        let max = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] > max)
                max = arr[i];
        }
        return max;
    }
    // Tool 1: list_devices
    async listDevices() {
        try {
            const res = await this.deviceSrv.getTenantDevices(100);
            return (res.data || []).map((d) => d.name);
        }
        catch (err) {
            console.error('[Tool listDevices] Failed:', err.message);
            return [];
        }
    }
    // Tool 2: get_current_telemetry
    async getLatestTelemetry(deviceName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return {};
        try {
            const rawData = await this.telemetrySrv.getLatestTelemetry(devId);
            const data = {};
            for (const [key, valueArray] of Object.entries(rawData)) {
                if (valueArray && valueArray.length > 0) {
                    const rawVal = valueArray[0].value;
                    const num = parseFloat(rawVal);
                    data[key] = isNaN(num) ? rawVal : parseFloat(num.toFixed(2));
                }
            }
            return data;
        }
        catch (err) {
            console.error(`[Tool getLatestTelemetry] Error for '${deviceName}':`, err.message);
            return {};
        }
    }
    // Tool 3: get_historical_summary
    async getHistoricalStats(deviceName, hours = 1) {
        const endTs = Date.now();
        const startTs = endTs - hours * 3600 * 1000;
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return {};
        const latest = await this.getLatestTelemetry(deviceName);
        const keys = Object.keys(latest).join(',');
        try {
            const telemetry = await this.telemetrySrv.getHistoricalTelemetry(devId, {
                keys,
                startTs,
                endTs,
                limit: 5000,
                orderBy: 'ASC',
            });
            const statsMap = {};
            for (const [key, list] of Object.entries(telemetry)) {
                statsMap[key] = list.map((pt) => parseFloat(pt.value)).filter((v) => !isNaN(v));
            }
            const result = {};
            for (const [key, vals] of Object.entries(statsMap)) {
                if (vals.length > 0) {
                    const sum = vals.reduce((a, b) => a + b, 0);
                    result[key] = {
                        avg: parseFloat((sum / vals.length).toFixed(2)),
                        min: parseFloat(this.safeMin(vals).toFixed(2)),
                        max: parseFloat(this.safeMax(vals).toFixed(2)),
                    };
                }
            }
            return result;
        }
        catch (err) {
            console.error(`[Tool getHistoricalStats] Error for '${deviceName}':`, err.message);
            return {};
        }
    }
    // Tool 4: get_active_alarms (O(1) Global Query)
    async getActiveAlarms() {
        try {
            const result = await this.alarmSrv.getTenantAlarms(50, 0, undefined, 'ACTIVE');
            const alarms = (result.data || []).map((alarm) => ({
                id: alarm.id?.id,
                originatorName: alarm.originatorName || alarm.originator?.entityType,
                type: alarm.type,
                severity: alarm.severity,
                status: alarm.status,
                timestamp: alarm.createdTime,
                details: alarm.details || {}
            }));
            const severityPriority = {
                CRITICAL: 4,
                MAJOR: 3,
                MINOR: 2,
                WARNING: 1,
                INDETERMINATE: 0,
            };
            alarms.sort((a, b) => {
                const sevDiff = (severityPriority[b.severity] ?? 0) - (severityPriority[a.severity] ?? 0);
                if (sevDiff !== 0)
                    return sevDiff;
                return (b.timestamp ?? 0) - (a.timestamp ?? 0);
            });
            return alarms.slice(0, 10);
        }
        catch (err) {
            console.error('[Tool getActiveAlarms] Global fetch failed:', err.message);
            return [];
        }
    }
    // Tool 5: get_device_attributes
    async getAttributes(deviceName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return {};
        try {
            const res = await this.telemetrySrv.getAttributes(devId);
            const attrs = {};
            for (const scopeData of res) {
                if (Array.isArray(scopeData)) {
                    for (const item of scopeData) {
                        attrs[item.key] = item.value !== undefined ? String(item.value) : 'N/A';
                    }
                }
            }
            return attrs;
        }
        catch (err) {
            console.error(`[Tool getAttributes] Error for '${deviceName}':`, err.message);
            return {};
        }
    }
    // Tool 6: get_highest_metric — parallelized with Promise.allSettled
    async getHighestMetric(metric) {
        try {
            const devices = await this.listDevices();
            const results = await Promise.allSettled(devices.map(async (dev) => {
                const latest = await this.getLatestTelemetry(dev);
                return { dev, val: latest[metric] };
            }));
            let highestVal = -Infinity;
            let highestDev = null;
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const { dev, val } = result.value;
                    if (typeof val === 'number' && val > highestVal) {
                        highestVal = val;
                        highestDev = dev;
                    }
                }
            }
            if (highestDev) {
                return { device: highestDev, value: highestVal, metric };
            }
        }
        catch (err) {
            console.error(`[Tool getHighestMetric] Error comparing '${metric}':`, err.message);
        }
        return {};
    }
    // Tool 7: get_metric_trend
    async getMetricTrend(deviceName, metric) {
        try {
            const latest = await this.getLatestTelemetry(deviceName);
            const currentVal = latest[metric];
            const stats = await this.getHistoricalStats(deviceName, 1);
            const histAvg = stats[metric]?.avg;
            if (currentVal !== undefined && histAvg !== undefined && histAvg !== 0) {
                const diff = currentVal - histAvg;
                const percentage = (diff / histAvg) * 100;
                return {
                    metric,
                    current: parseFloat(currentVal.toFixed(2)),
                    historical_avg: parseFloat(histAvg.toFixed(2)),
                    percent_change: parseFloat(percentage.toFixed(1)),
                    trend: percentage > 0.5 ? 'up' : percentage < -0.5 ? 'down' : 'stable',
                };
            }
        }
        catch (err) {
            console.error(`[Tool getMetricTrend] Failed for '${deviceName}':`, err.message);
        }
        return {};
    }
    // Helper Threshold extraction
    async getDeviceThresholds(deviceName) {
        const thresholds = JSON.parse(JSON.stringify(this.fallbackThresholds));
        try {
            const attrs = await this.getAttributes(deviceName);
            for (const [key, value] of Object.entries(attrs)) {
                if (key.includes('_limit_max')) {
                    const metric = key.replace('_limit_max', '');
                    if (thresholds[metric])
                        thresholds[metric].max = parseFloat(value);
                }
                else if (key.includes('_limit_min')) {
                    const metric = key.replace('_limit_min', '');
                    if (thresholds[metric])
                        thresholds[metric].min = parseFloat(value);
                }
            }
        }
        catch (err) {
            console.warn(`[Bridge Thresholds] Excursion parsing error:`, err.message);
        }
        return thresholds;
    }
    // Tool 8: perform_deep_analysis — now processes ALL dynamic telemetry keys
    async performDeepAnalysis(deviceName, startTime, endTime, hours = 24) {
        let startTs;
        let endTs;
        if (startTime && endTime) {
            startTs = this.isoToEpochMs(startTime);
            endTs = this.isoToEpochMs(endTime);
        }
        else {
            endTs = Date.now();
            startTs = endTs - hours * 3600 * 1000;
        }
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { error: 'Device not found' };
        const thresholds = await this.getDeviceThresholds(deviceName);
        // Fetch dynamic telemetry keys
        const latest = await this.getLatestTelemetry(deviceName);
        const dynamicKeys = Object.keys(latest);
        const keysStr = dynamicKeys.length > 0 ? dynamicKeys.join(',') : Object.keys(this.fallbackThresholds).join(',');
        const allKeys = dynamicKeys.length > 0 ? dynamicKeys : Object.keys(this.fallbackThresholds);
        const rawTelemetry = await this.telemetrySrv.getHistoricalTelemetry(devId, {
            keys: keysStr,
            startTs,
            endTs,
            limit: 5000,
            orderBy: 'ASC',
        });
        // Structure raw metrics — process ALL keys, not just fallback thresholds
        const telemetryStreams = {};
        for (const key of allKeys) {
            telemetryStreams[key] = { timestamps: [], values: [] };
        }
        let totalPoints = 0;
        for (const [key, points] of Object.entries(rawTelemetry)) {
            if (!telemetryStreams[key]) {
                telemetryStreams[key] = { timestamps: [], values: [] };
            }
            for (const pt of points) {
                const val = parseFloat(pt.value);
                if (!isNaN(val)) {
                    telemetryStreams[key].timestamps.push(pt.ts);
                    telemetryStreams[key].values.push(val);
                    totalPoints++;
                }
            }
        }
        // Process Statistics — use thresholds if available, else skip breach analysis
        const statsSummary = {};
        const breachesSummary = {};
        for (const key of Object.keys(telemetryStreams)) {
            const data = telemetryStreams[key];
            const limits = thresholds[key] || { min: -Infinity, max: Infinity };
            statsSummary[key] = this.calculateAdvancedStats(data.values, limits);
            breachesSummary[key] = { count: 0, points: [] };
            for (let i = 0; i < data.values.length; i++) {
                const ts = data.timestamps[i];
                const val = data.values[i];
                let breached = false;
                if (limits.max !== undefined && limits.max !== Infinity && val > limits.max)
                    breached = true;
                if (limits.min !== undefined && limits.min !== -Infinity && val < limits.min)
                    breached = true;
                if (breached) {
                    breachesSummary[key].count++;
                    breachesSummary[key].points.push({ ts, val });
                }
            }
        }
        // Fetch historical alarms
        let alarms = [];
        try {
            const res = await this.client.request('GET', `/api/alarm/DEVICE/${devId}`, {
                pageSize: 50,
                page: 0,
                startTime: startTs,
                endTime: endTs,
                sortProperty: 'createdTime',
                sortOrder: 'DESC',
            });
            alarms = (res.data || []).map((a) => ({
                type: a.type,
                severity: a.severity,
                status: a.status,
                timestamp: a.createdTime,
            }));
        }
        catch (err) {
            console.warn(`[Deep Audit] Alarm logs fetch bypassed: ${err.message}`);
        }
        // Deduplicate alarms
        const seenAlarms = new Set();
        const mergedAlarms = [];
        for (const alarm of alarms) {
            const key = `${alarm.type}_${alarm.timestamp}`;
            if (!seenAlarms.has(key)) {
                mergedAlarms.push(alarm);
                seenAlarms.add(key);
            }
        }
        // Non-blocking report export
        let htmlReportPath = 'N/A';
        if (totalPoints > 0) {
            htmlReportPath = await this.generateHtmlReportFileAsync(deviceName, startTs, endTs, telemetryStreams, thresholds, breachesSummary, mergedAlarms);
        }
        const reportData = {
            device: deviceName,
            window: {
                start: new Date(startTs).toISOString().replace('T', ' ').substring(0, 19),
                end: new Date(endTs).toISOString().replace('T', ' ').substring(0, 19),
            },
            total_points: totalPoints,
            stats: statsSummary,
            breaches: Object.fromEntries(Object.entries(breachesSummary).filter(([_, b]) => b.count > 0)),
            alarms: mergedAlarms,
            html_report: htmlReportPath,
        };
        return {
            report: this.formatMarkdownReport(reportData),
            raw_data: reportData,
        };
    }
    // Tool 9: create_device
    async createDevice(deviceName, deviceType, label = '', attributes, profileName) {
        try {
            const payload = { name: deviceName, type: deviceType, label };
            if (profileName) {
                const profileList = await this.profileSrv.getDeviceProfiles(100);
                const match = (profileList.data || []).find((p) => p.name.toLowerCase() === profileName.toLowerCase());
                if (match) {
                    payload.deviceProfileId = match.id;
                }
            }
            const res = await this.deviceSrv.createOrUpdateDevice(payload);
            const devId = res.id?.id;
            if (devId) {
                // Invalidate any stale negative cache entry
                this.deviceCache[deviceName] = { value: devId, expiresAt: 0 };
                if (attributes && Object.keys(attributes).length > 0) {
                    await this.telemetrySrv.saveAttributes(devId, 'SERVER_SCOPE', attributes);
                }
            }
            return { status: 'success', deviceId: devId, name: deviceName, profile: profileName || 'default' };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 10: delete_device
    async deleteDevice(deviceName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            await this.deviceSrv.deleteDevice(devId);
            delete this.deviceCache[deviceName];
            return { status: 'success', message: `Device ${deviceName} deleted successfully.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 11: get_device_credentials
    async getDeviceCredentials(deviceName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const res = await this.deviceSrv.getDeviceCredentials(devId);
            return { status: 'success', credentials: res };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 12: acknowledge_alarm
    async acknowledgeAlarm(alarmId) {
        try {
            await this.alarmSrv.acknowledgeAlarm(alarmId);
            return { status: 'success', message: `Alarm ${alarmId} acknowledged.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 13: clear_alarm
    async clearAlarm(alarmId) {
        try {
            await this.alarmSrv.clearAlarm(alarmId);
            return { status: 'success', message: `Alarm ${alarmId} cleared.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 14: trigger_rule_engine
    async triggerRuleEngine(deviceName, message) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const ruleMsg = {
                msgType: 'POST_TELEMETRY_REQUEST',
                msg: message,
                metadata: { source: 'Gemini Voice Integration Agent' },
            };
            await this.ruleSrv.pushMessageToRuleEngine('DEVICE', devId, ruleMsg);
            return { status: 'success', message: 'Message successfully pushed to the rule engine.' };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 15: create_alarm
    async createAlarm(deviceName, alarmType, severity, details = null, metricParam, operatorCondition, comparisonValue) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const ruleDetails = details || {};
            if (metricParam && operatorCondition && comparisonValue !== undefined) {
                ruleDetails.condition = {
                    parameter: metricParam,
                    operator: operatorCondition,
                    threshold: comparisonValue,
                    triggered_value: comparisonValue
                };
            }
            const alarmDef = {
                type: alarmType,
                originator: {
                    entityType: 'DEVICE',
                    id: devId,
                },
                severity: severity.toUpperCase(),
                details: ruleDetails,
            };
            const res = await this.alarmSrv.saveAlarm(alarmDef);
            return {
                status: 'success',
                alarmId: res.id?.id,
                type: alarmType,
                condition: ruleDetails.condition || 'Manual trigger details'
            };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 16: create_rule_chain
    async createRuleChain(name, nodes, connections, firstNodeIndex = 0) {
        try {
            const ruleChainDef = {
                name,
                type: 'CORE',
                debugMode: true,
                configuration: {},
            };
            const res = await this.ruleSrv.saveRuleChain(ruleChainDef);
            const rcId = res.id?.id;
            const metadata = {
                ruleChainId: { entityType: 'RULE_CHAIN', id: rcId },
                nodes,
                connections,
                firstNodeIndex,
            };
            await this.client.request('POST', '/api/ruleChain/metadata', undefined, metadata);
            return { status: 'success', ruleChainId: rcId, name };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 17: list_assets
    async listAssets() {
        try {
            const res = await this.assetSrv.getTenantAssets(100);
            return (res.data || []).map((a) => a.name);
        }
        catch {
            return [];
        }
    }
    // Tool 18: get_asset_by_name
    async getAssetByName(assetName) {
        const assetId = await this.getAssetId(assetName);
        if (!assetId)
            return { error: 'Asset not found' };
        try {
            const res = await this.assetSrv.getAssetById(assetId);
            return { status: 'success', asset: res };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 19: create_asset
    async createAsset(assetName, assetType, label = '') {
        try {
            const res = await this.assetSrv.createOrUpdateAsset({ name: assetName, type: assetType, label });
            const assetId = res.id?.id;
            if (assetId) {
                // Invalidate any stale negative cache entry
                this.assetCache[assetName] = { value: assetId, expiresAt: 0 };
            }
            return { status: 'success', assetId, name: assetName };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 20: delete_asset
    async deleteAsset(assetName) {
        const assetId = await this.getAssetId(assetName);
        if (!assetId)
            return { status: 'error', message: 'Asset not found' };
        try {
            await this.assetSrv.deleteAsset(assetId);
            delete this.assetCache[assetName];
            return { status: 'success', message: `Asset ${assetName} deleted successfully.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 21: create_relation
    async createRelation(fromName, toName, relationType) {
        try {
            const fromObj = await this.resolveEntityIdAndType(fromName);
            const toObj = await this.resolveEntityIdAndType(toName);
            if (!fromObj || !toObj) {
                return { status: 'error', message: 'Failed to resolve source or destination entity name.' };
            }
            const relation = {
                from: { id: fromObj.id, entityType: fromObj.type },
                to: { id: toObj.id, entityType: toObj.type },
                type: relationType,
            };
            await this.relationSrv.createRelation(relation);
            return { status: 'success', message: `Relation '${relationType}' between ${fromName} and ${toName} established.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 22: delete_relation
    async deleteRelation(fromName, toName, relationType) {
        try {
            const fromObj = await this.resolveEntityIdAndType(fromName);
            const toObj = await this.resolveEntityIdAndType(toName);
            if (!fromObj || !toObj) {
                return { status: 'error', message: 'Failed to resolve source or destination entity.' };
            }
            const relation = {
                from: { id: fromObj.id, entityType: fromObj.type },
                to: { id: toObj.id, entityType: toObj.type },
                type: relationType,
            };
            await this.relationSrv.deleteRelation(relation);
            return { status: 'success', message: `Relation '${relationType}' between ${fromName} and ${toName} removed.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 23: list_relations
    async listRelations(entityName) {
        try {
            const obj = await this.resolveEntityIdAndType(entityName);
            if (!obj)
                return { status: 'error', message: `Entity '${entityName}' not found.` };
            const relations = await this.relationSrv.listRelationsFrom(obj.id, obj.type);
            return { status: 'success', relations };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 24: save_device_attributes
    async saveDeviceAttributes(deviceName, scope, attributes) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            await this.telemetrySrv.saveAttributes(devId, scope, attributes);
            return { status: 'success', message: 'Attributes saved successfully.' };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 25: delete_device_attributes
    async deleteDeviceAttributes(deviceName, scope, keys) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            await this.telemetrySrv.deleteAttributes(devId, scope, keys);
            return { status: 'success', message: 'Attributes deleted successfully.' };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 26: list_dashboards
    async listDashboards() {
        try {
            const dashboards = await this.dashboardSrv.getTenantDashboards();
            return { status: 'success', dashboards: dashboards.data };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 36: create_device_dashboard
    async createDeviceDashboard(deviceName, monitoredKeys = ['temperature', 'humidity', 'pressure', 'vibration'], dashboardTitle, backgroundColor = '#ffffff') {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const title = dashboardTitle || `${deviceName} Operations Center`;
            const widgetId = `widget_telemetry_${Date.now()}`;
            const aliasId = `alias_${deviceName.replace(/\s+/g, '_')}`;
            const configuredDataKeys = monitoredKeys.map((key, i) => {
                const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
                return {
                    name: key,
                    type: 'timeseries',
                    label: key.toUpperCase(),
                    color: colors[i % colors.length],
                    settings: {
                        showLines: true,
                        fillLines: true
                    },
                    useUnitFromMetadata: true
                };
            });
            const dashboardConfig = {
                title,
                configuration: {
                    widgets: {
                        [widgetId]: {
                            typeFullFqn: "system.charts.timeseries_line_chart",
                            title: `${deviceName} Real-time Telemetry`,
                            sizeX: 16,
                            sizeY: 10,
                            config: {
                                datasources: [
                                    {
                                        type: 'entity',
                                        entityAliasId: aliasId,
                                        dataKeys: configuredDataKeys,
                                    },
                                ],
                                timewindow: {
                                    realtime: { timewindowMs: 3600000 }, // Last 1 hour
                                },
                                showTitle: true,
                                backgroundColor: backgroundColor,
                                color: 'rgba(0, 0, 0, 0.87)',
                                padding: '12px',
                                settings: {
                                    stack: false,
                                    smoothLines: true,
                                    showLegend: true,
                                    shadow: true,
                                },
                            },
                        },
                    },
                    states: {
                        default: {
                            name: title,
                            root: true,
                            layouts: {
                                main: {
                                    widgets: {
                                        [widgetId]: { sizeX: 16, sizeY: 10, row: 0, col: 0 },
                                    },
                                },
                            },
                        },
                    },
                    entityAliases: {
                        [aliasId]: {
                            id: aliasId,
                            alias: deviceName,
                            filter: {
                                type: 'singleEntity',
                                singleEntity: { entityType: 'DEVICE', id: devId },
                            },
                        },
                    },
                },
            };
            const res = await this.dashboardSrv.saveDashboard(dashboardConfig);
            return {
                status: 'success',
                dashboardId: res.id?.id,
                title: res.title,
                monitored_parameters: monitoredKeys,
                message: `Dashboard created successfully. You can view it in ThingsBoard UI for device ${deviceName}.`,
            };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 27: get_dashboard_by_id
    async getDashboardById(dashboardId) {
        try {
            const dashboard = await this.dashboardSrv.getDashboardById(dashboardId);
            return { status: 'success', dashboard };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 28: assign_dashboard_to_customer
    async assignDashboardToCustomer(customerId, dashboardId) {
        try {
            const res = await this.dashboardSrv.assignDashboardToCustomer(customerId, dashboardId);
            return { status: 'success', dashboard: res };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 29: list_device_profiles
    async listDeviceProfiles() {
        try {
            const profiles = await this.profileSrv.getDeviceProfiles();
            return { status: 'success', profiles: profiles.data };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 30: get_device_profile_by_id
    async getDeviceProfileById(profileId) {
        try {
            const profile = await this.profileSrv.getDeviceProfileById(profileId);
            return { status: 'success', profile };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 31: send_one_way_rpc
    async sendOneWayRpc(deviceName, method, params) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            await this.rpcSrv.sendOneWayRpc(devId, { method, params });
            return { status: 'success', message: 'One-way RPC request transmitted.' };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 32: send_two_way_rpc
    async sendTwoWayRpc(deviceName, method, params) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const response = await this.rpcSrv.sendTwoWayRpc(devId, { method, params });
            return { status: 'success', response };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 33: list_persistent_rpcs
    async listPersistentRpcs(deviceName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const rpcs = await this.rpcSrv.listPersistentRpcs(devId);
            return { status: 'success', rpcs };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 34: inject_rule_engine_queue
    async injectRuleEngineQueue(deviceName, messagePayload, queueName) {
        const devId = await this.getDeviceId(deviceName);
        if (!devId)
            return { status: 'error', message: 'Device not found' };
        try {
            const message = {
                msgType: 'POST_TELEMETRY_REQUEST',
                msg: messagePayload,
                metadata: { source: 'Gemini Voice Integration Pipeline' },
            };
            await this.ruleSrv.pushMessageToRuleEngine('DEVICE', devId, message, queueName);
            return { status: 'success', message: `Injected into ${queueName} queue successfully.` };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    // Tool 35: get_audit_logs
    async getAuditLogs() {
        try {
            const logs = await this.auditSrv.getAuditLogs();
            return { status: 'success', logs: logs.data };
        }
        catch (e) {
            return { status: 'error', message: e.message };
        }
    }
    calculateAdvancedStats(values, limits) {
        if (!values || values.length === 0) {
            return { count: 0, avg: 0.0, std_dev: 0.0, min: 0.0, max: 0.0, breach_percent: 0.0 };
        }
        const n = values.length;
        const avgVal = values.reduce((a, b) => a + b, 0) / n;
        const variance = n > 1 ? values.reduce((sum, val) => sum + Math.pow(val - avgVal, 2), 0) / n : 0.0;
        const stdDev = Math.sqrt(variance);
        let breachPoints = 0;
        for (const val of values) {
            if (limits.max !== undefined && val > limits.max) {
                breachPoints++;
            }
            else if (limits.min !== undefined && val < limits.min) {
                breachPoints++;
            }
        }
        const breachPercent = (breachPoints / n) * 100;
        return {
            count: n,
            avg: parseFloat(avgVal.toFixed(2)),
            std_dev: parseFloat(stdDev.toFixed(2)),
            min: parseFloat(this.safeMin(values).toFixed(3)),
            max: parseFloat(this.safeMax(values).toFixed(3)),
            breach_percent: parseFloat(breachPercent.toFixed(1)),
        };
    }
    // Asynchronous and non-blocking filesystem operational loop
    async generateHtmlReportFileAsync(deviceName, startTs, endTs, streams, thresholds, breaches, alarms) {
        const reportDir = path.join(process.cwd(), 'reports');
        await fs_1.promises.mkdir(reportDir, { recursive: true });
        const filename = `industrial_audit_${deviceName}_${Math.floor(Date.now() / 1000)}.html`;
        const filepath = path.join(reportDir, filename);
        const clientTraceData = [];
        const colors = {
            temperature: '#ef4444',
            humidity: '#3b82f6',
            pressure: '#10b981',
            vibration: '#f59e0b',
        };
        for (const [metric, data] of Object.entries(streams)) {
            if (data.values.length === 0)
                continue;
            const xTimes = data.timestamps.map((t) => new Date(t).toISOString());
            clientTraceData.push({
                x: xTimes,
                y: data.values,
                name: metric.toUpperCase(),
                type: 'scatter',
                mode: 'lines',
                line: { color: colors[metric] || '#64748b', width: 2 },
            });
            const lim = thresholds[metric];
            if (lim && lim.max !== undefined) {
                clientTraceData.push({
                    x: [xTimes[0], xTimes[xTimes.length - 1]],
                    y: [lim.max, lim.max],
                    name: `${metric.toUpperCase()} Limit Max`,
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: colors[metric] || '#64748b', width: 1, dash: 'dash' },
                    hoverinfo: 'skip',
                });
            }
            if (lim && lim.min !== undefined) {
                clientTraceData.push({
                    x: [xTimes[0], xTimes[xTimes.length - 1]],
                    y: [lim.min, lim.min],
                    name: `${metric.toUpperCase()} Limit Min`,
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: colors[metric] || '#64748b', width: 1, dash: 'dot' },
                    hoverinfo: 'skip',
                });
            }
        }
        const metricsList = Object.keys(streams).filter((m) => streams[m].values.length > 0);
        const barTrace = {
            x: metricsList.map((m) => m.toUpperCase()),
            y: metricsList.map((m) => breaches[m]?.count || 0),
            type: 'bar',
            marker: { color: metricsList.map((m) => colors[m] || '#64748b') },
            name: 'Violations Count',
        };
        const rawTracesJson = JSON.stringify(clientTraceData);
        const rawBarTraceJson = JSON.stringify([barTrace]);
        const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Industrial Audit: ${deviceName}</title>
      <script src="https://cdn.plot.ly/plotly-2.24.1.min.js"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
        .header { border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0 0 10px 0; color: #1e293b; font-size: 24px; }
        .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
        .chart-box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
        .table-box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
        th { background: #f8fafc; color: #64748b; font-weight: 600; }
        .badge { display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 9999px; text-transform: uppercase; }
        .badge-critical { background: #fee2e2; color: #991b1b; }
        .badge-warning { background: #fef3c7; color: #92400e; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Industrial Health Audit: ${deviceName}</h1>
          <p style="color: #64748b; margin: 0;">Time Period: ${new Date(startTs).toLocaleString()} to ${new Date(endTs).toLocaleString()}</p>
        </div>
        <div class="grid">
          <div>
            <div class="chart-box">
              <h3 style="margin-top: 0;">Historical Metrics Trendlines</h3>
              <div id="trendChart"></div>
            </div>
            <div class="chart-box">
              <h3 style="margin-top: 0;">Threshold Excursion Counts</h3>
              <div id="barChart"></div>
            </div>
          </div>
          <div>
            <div class="table-box">
              <h3 style="margin-top: 0;">Logged System Alarms (${alarms.length})</h3>
              <table>
                <thead>
                  <tr>
                    <th>Alarm</th>
                    <th>Severity</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${alarms.length === 0
            ? '<tr><td colspan="3" style="text-align:center; color:#94a3b8;">No recent alarms</td></tr>'
            : alarms
                .slice(0, 10)
                .map((a) => `
                    <tr>
                      <td><strong>${a.type}</strong></td>
                      <td><span class="badge badge-${a.severity.toLowerCase() === 'critical' ? 'critical' : 'warning'}">${a.severity}</span></td>
                      <td><span style="font-size: 12px; color: #475569;">${a.status}</span></td>
                    </tr>`)
                .join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      <script>
        const trendData = ${rawTracesJson};
        const barData = ${rawBarTraceJson};

        Plotly.newPlot('trendChart', trendData, {
          height: 380,
          margin: { l: 40, r: 20, t: 10, b: 40 },
          template: 'plotly_white',
          showlegend: true,
          legend: { orientation: 'h', y: 1.1 }
        });

        Plotly.newPlot('barChart', barData, {
          height: 220,
          margin: { l: 40, r: 20, t: 10, b: 30 },
          template: 'plotly_white',
          showlegend: false
        });
      </script>
    </body>
    </html>`;
        await fs_1.promises.writeFile(filepath, htmlContent, 'utf-8');
        return filepath;
    }
    formatMarkdownReport(data) {
        const lines = [
            `# Industrial Health Audit: ${data.device}`,
            `**Interval:** ${data.window.start} to ${data.window.end}`,
            `**Total Data Points Scanned:** ${data.total_points}`,
            `\n## Threshold Analysis:`,
        ];
        const breachEntries = Object.entries(data.breaches);
        if (breachEntries.length === 0) {
            lines.push('  *No threshold breaches logged. All systems are reporting normally.*');
        }
        else {
            for (const [metric, b] of breachEntries) {
                const st = data.stats[metric];
                lines.push(`### ${metric.toUpperCase()}:`);
                lines.push(`  - **Breaches Count:** ${b.count} out-of-bounds occurrences (${st.breach_percent}% breach duration).`);
                lines.push(`  - **Deviation Spreads:** Avg ${st.avg} | Max ${st.max} | Min ${st.min} (SD: ±${st.std_dev})`);
                if (b.points && b.points.length > 0) {
                    const worst = b.points.reduce((maxPt, pt) => (pt.val > maxPt.val ? pt : maxPt), b.points[0]);
                    const timeStr = new Date(worst.ts).toTimeString().substring(0, 8);
                    lines.push(`  - **Highest Breach Point:** ${worst.val} reached at ${timeStr}`);
                }
            }
        }
        lines.push(`\n## Alarms Logged (${data.alarms.length}):`);
        if (data.alarms.length === 0) {
            lines.push('  *No system alarms triggered.*');
        }
        else {
            for (const alarm of data.alarms.slice(0, 5)) {
                const timeStr = new Date(alarm.timestamp).toTimeString().substring(0, 8);
                lines.push(`  - **[${timeStr}] ${alarm.type}** (${alarm.severity}): ${alarm.status}`);
            }
        }
        if (data.html_report !== 'N/A') {
            lines.push(`\n## Artifact Output:`);
            lines.push(`  - **HTML Visual Report Saved:** \`${data.html_report}\``);
        }
        return lines.join('\n');
    }
    // Tool 37: forecast_what_if — with timeout and top-level axios import
    async forecastWhatIf(args) {
        const deviceName = args.device_name;
        const targetMetric = args.target_metric;
        const steps = args.prediction_horizon_steps || 96;
        const interventions = args.interventions || [];
        const questionType = args.question_type || "peak";
        const crossingThreshold = args.crossing_threshold;
        const devId = await this.getDeviceId(deviceName);
        if (!devId) {
            return { error: `Device '${deviceName}' not found in tenant workspace.` };
        }
        try {
            // 1. Discover all active telemetry keys dynamically
            const latestTelemetry = await this.getLatestTelemetry(deviceName);
            const keys = Object.keys(latestTelemetry);
            if (keys.length === 0) {
                return { error: `No active telemetry parameters found for device '${deviceName}'.` };
            }
            if (!keys.includes(targetMetric)) {
                return { error: `Target metric '${targetMetric}' is not an active telemetry parameter for device '${deviceName}'. Available parameters: ${keys.join(', ')}` };
            }
            // 2. Fetch last 48 hours of historical telemetry for all keys
            const endTs = Date.now();
            const startTs = endTs - 48 * 3600 * 1000;
            const keysStr = keys.join(',');
            const rawTelemetry = await this.telemetrySrv.getHistoricalTelemetry(devId, {
                keys: keysStr,
                startTs,
                endTs,
                limit: 5000,
                orderBy: 'ASC',
            });
            // 3. Resample and Align Timestamps to a fixed 15-minute grid
            const gridIntervalMs = 15 * 60 * 1000;
            let minTs = Infinity;
            let maxTs = -Infinity;
            for (const points of Object.values(rawTelemetry)) {
                for (const pt of points) {
                    if (pt.ts < minTs)
                        minTs = pt.ts;
                    if (pt.ts > maxTs)
                        maxTs = pt.ts;
                }
            }
            if (minTs === Infinity || maxTs === -Infinity || maxTs - minTs < gridIntervalMs) {
                minTs = startTs;
                maxTs = endTs;
            }
            const startGrid = Math.floor(minTs / gridIntervalMs) * gridIntervalMs;
            const endGrid = Math.floor(maxTs / gridIntervalMs) * gridIntervalMs;
            const timestampsGrid = [];
            for (let t = startGrid; t <= endGrid; t += gridIntervalMs) {
                timestampsGrid.push(t);
            }
            if (timestampsGrid.length < 2) {
                return { error: "Insufficient historical telemetry data to align grid." };
            }
            // Pre-process raw key streams into sorted { ts, value } maps
            const streams = {};
            for (const key of keys) {
                const pts = rawTelemetry[key] || [];
                streams[key] = pts
                    .map((pt) => ({ ts: pt.ts, val: parseFloat(pt.value) }))
                    .filter((pt) => !isNaN(pt.val))
                    .sort((a, b) => a.ts - b.ts);
            }
            // Resample function using forward-fill (nearest historical point)
            const resampleSeries = (pts, grid) => {
                const resampled = [];
                let dataIdx = 0;
                let lastVal = pts[0]?.val ?? 0.0;
                for (const targetTs of grid) {
                    while (dataIdx < pts.length && pts[dataIdx].ts <= targetTs) {
                        lastVal = pts[dataIdx].val;
                        dataIdx++;
                    }
                    resampled.push(lastVal);
                }
                return resampled;
            };
            // Resample target and covariates
            const alignedTargetValues = resampleSeries(streams[targetMetric] || [], timestampsGrid);
            const alignedCovariates = {};
            for (const key of keys) {
                if (key !== targetMetric) {
                    alignedCovariates[key] = resampleSeries(streams[key] || [], timestampsGrid);
                }
            }
            // 4. Construct payload for python FastAPI predictive sidecar
            const payload = {
                target_name: targetMetric,
                frequency_minutes: 15,
                history: {
                    timestamps: timestampsGrid,
                    target_values: alignedTargetValues,
                    covariates: alignedCovariates
                },
                simulation_horizon: steps,
                interventions: interventions,
                question_type: questionType,
                crossing_threshold: crossingThreshold
            };
            const response = await axios_1.default.post('http://localhost:8000/forecast_what_if', payload, {
                timeout: 120000, // 120 second timeout for model inference
            });
            return response.data;
        }
        catch (err) {
            console.error(`[forecastWhatIf] Failed:`, err.message);
            return { error: `Failed to execute forecast what-if: ${err.message}` };
        }
    }
}
exports.ThingsBoardRESTBridge = ThingsBoardRESTBridge;
