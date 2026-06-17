// bridge.ts
import { promises as fs } from 'fs';
import * as path from 'path';
import axios from 'axios';
import { ThingsBoardClient } from './restClient';
import {
  DeviceService,
  TelemetryService,
  AlarmService,
  RuleEngineService,
  AssetService,
  RelationService,
  DashboardService,
  DeviceProfileService,
  RpcService,
  AuditService,
} from './services';
import { FallbackThresholds, MetricLimits, Alarm, RuleChain, Relation } from './types';

// Cache entry with TTL support for negative lookups
interface CacheEntry {
  value: string | null;
  expiresAt: number; // epoch ms — only used for null entries
}

const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

export class ThingsBoardRESTBridge {
  private client: ThingsBoardClient;
  private deviceSrv: DeviceService;
  private telemetrySrv: TelemetryService;
  private alarmSrv: AlarmService;
  private ruleSrv: RuleEngineService;
  private assetSrv: AssetService;
  private relationSrv: RelationService;
  private dashboardSrv: DashboardService;
  private profileSrv: DeviceProfileService;
  private rpcSrv: RpcService;
  private auditSrv: AuditService;

  // Supports caching with TTL for negative lookups
  private deviceCache: Record<string, CacheEntry> = {};
  private assetCache: Record<string, CacheEntry> = {};

  private fallbackThresholds: FallbackThresholds = {
    temperature: { min: 20.0, max: 75.0 },
    humidity: { min: 20.0, max: 85.0 },
    pressure: { min: 0.8, max: 1.4 },
    vibration: { min: 0.0, max: 4.0 },
  };

  constructor() {
    this.client = new ThingsBoardClient({
      baseUrl: process.env.THINGSBOARD_HOST || 'http://localhost:8080',
      username: process.env.THINGSBOARD_USERNAME || 'tenant@thingsboard.org',
      password: process.env.THINGSBOARD_PASSWORD || 'tenant',
      verifySsl: false,
    });

    this.deviceSrv = new DeviceService(this.client);
    this.telemetrySrv = new TelemetryService(this.client);
    this.alarmSrv = new AlarmService(this.client);
    this.ruleSrv = new RuleEngineService(this.client);
    this.assetSrv = new AssetService(this.client);
    this.relationSrv = new RelationService(this.client);
    this.dashboardSrv = new DashboardService(this.client);
    this.profileSrv = new DeviceProfileService(this.client);
    this.rpcSrv = new RpcService(this.client);
    this.auditSrv = new AuditService(this.client);
  }

  private isoToEpochMs(isoStr: string): number {
    try {
      return new Date(isoStr).getTime();
    } catch {
      return Date.now();
    }
  }

  private async getDeviceId(deviceName: string): Promise<string | null> {
    const cached = this.deviceCache[deviceName];
    if (cached !== undefined) {
      // If positive cache, return immediately
      if (cached.value !== null) return cached.value;
      // If negative cache, check TTL
      if (Date.now() < cached.expiresAt) return null;
      // TTL expired, re-query
      delete this.deviceCache[deviceName];
    }
    try {
      const res = await this.client.request<any>('GET', '/api/tenant/device', { deviceName });
      if (res && res.id) {
        const devId = res.id.id;
        this.deviceCache[deviceName] = { value: devId, expiresAt: 0 };
        return devId;
      }
    } catch (err: any) {
      console.warn(`[Bridge Cache] Resolve device failed for '${deviceName}': ${err.message}`);
    }
    // Negative cache with TTL
    this.deviceCache[deviceName] = { value: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS };
    return null;
  }

  private async getAssetId(assetName: string): Promise<string | null> {
    const cached = this.assetCache[assetName];
    if (cached !== undefined) {
      if (cached.value !== null) return cached.value;
      if (Date.now() < cached.expiresAt) return null;
      delete this.assetCache[assetName];
    }
    try {
      const res = await this.client.request<any>('GET', '/api/tenant/asset', { assetName });
      if (res && res.id) {
        const assetId = res.id.id;
        this.assetCache[assetName] = { value: assetId, expiresAt: 0 };
        return assetId;
      }
    } catch (err: any) {
      console.warn(`[Bridge Cache] Resolve asset failed for '${assetName}': ${err.message}`);
    }
    this.assetCache[assetName] = { value: null, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS };
    return null;
  }

  private async resolveEntityIdAndType(name: string): Promise<{ id: string; type: 'DEVICE' | 'ASSET' } | null> {
    const devId = await this.getDeviceId(name);
    if (devId) return { id: devId, type: 'DEVICE' };
    const assetId = await this.getAssetId(name);
    if (assetId) return { id: assetId, type: 'ASSET' };
    return null;
  }

  // Safe min/max that won't blow the call stack on large arrays
  private safeMin(arr: number[]): number {
    let min = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
    }
    return min;
  }

  private safeMax(arr: number[]): number {
    let max = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > max) max = arr[i];
    }
    return max;
  }

  // Tool 1: list_devices
  public async listDevices(): Promise<string[]> {
    try {
      const res = await this.deviceSrv.getTenantDevices(100);
      return (res.data || []).map((d) => d.name);
    } catch (err: any) {
      console.error('[Tool listDevices] Failed:', err.message);
      return [];
    }
  }

  // Tool 2: get_current_telemetry
  public async getLatestTelemetry(deviceName: string): Promise<Record<string, any>> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return {};

    try {
      const rawData = await this.telemetrySrv.getLatestTelemetry(devId);
      const data: Record<string, any> = {};
      for (const [key, valueArray] of Object.entries(rawData)) {
        if (valueArray && valueArray.length > 0) {
          const rawVal = valueArray[0].value;
          const num = parseFloat(rawVal);
          data[key] = isNaN(num) ? rawVal : parseFloat(num.toFixed(2));
        }
      }
      return data;
    } catch (err: any) {
      console.error(`[Tool getLatestTelemetry] Error for '${deviceName}':`, err.message);
      return {};
    }
  }

  // Tool 3: get_historical_summary
  public async getHistoricalStats(deviceName: string, hours = 1): Promise<Record<string, any>> {
    const endTs = Date.now();
    const startTs = endTs - hours * 3600 * 1000;

    const devId = await this.getDeviceId(deviceName);
    if (!devId) return {};

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

      const statsMap: Record<string, number[]> = {};
      for (const [key, list] of Object.entries(telemetry)) {
        statsMap[key] = list.map((pt) => parseFloat(pt.value)).filter((v) => !isNaN(v));
      }

      const result: Record<string, any> = {};
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
    } catch (err: any) {
      console.error(`[Tool getHistoricalStats] Error for '${deviceName}':`, err.message);
      return {};
    }
  }

  // Tool 4: get_active_alarms (O(1) Global Query)
  public async getActiveAlarms(): Promise<any[]> {
    try {
      const result = await this.alarmSrv.getTenantAlarms(50, 0, undefined, 'ACTIVE');
      const alarms = (result.data || []).map((alarm: any) => ({
        id: alarm.id?.id,
        originatorName: alarm.originatorName || alarm.originator?.entityType,
        type: alarm.type,
        severity: alarm.severity,
        status: alarm.status,
        timestamp: alarm.createdTime,
        details: alarm.details || {}
      }));

      const severityPriority: Record<string, number> = {
        CRITICAL: 4,
        MAJOR: 3,
        MINOR: 2,
        WARNING: 1,
        INDETERMINATE: 0,
      };

      alarms.sort((a, b) => {
        const sevDiff = (severityPriority[b.severity] ?? 0) - (severityPriority[a.severity] ?? 0);
        if (sevDiff !== 0) return sevDiff;
        return (b.timestamp ?? 0) - (a.timestamp ?? 0);
      });

      return alarms.slice(0, 10);
    } catch (err: any) {
      console.error('[Tool getActiveAlarms] Global fetch failed:', err.message);
      return [];
    }
  }

  // Tool 5: get_device_attributes
  public async getAttributes(deviceName: string): Promise<Record<string, string>> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return {};
    try {
      const res = await this.telemetrySrv.getAttributes(devId);
      const attrs: Record<string, string> = {};
      for (const scopeData of res) {
        if (Array.isArray(scopeData)) {
          for (const item of scopeData) {
            attrs[item.key] = item.value !== undefined ? String(item.value) : 'N/A';
          }
        }
      }
      return attrs;
    } catch (err: any) {
      console.error(`[Tool getAttributes] Error for '${deviceName}':`, err.message);
      return {};
    }
  }

  // Tool 6: get_highest_metric — parallelized with Promise.allSettled
  public async getHighestMetric(metric: string): Promise<any> {
    try {
      const devices = await this.listDevices();
      
      const results = await Promise.allSettled(
        devices.map(async (dev) => {
          const latest = await this.getLatestTelemetry(dev);
          return { dev, val: latest[metric] };
        })
      );

      let highestVal = -Infinity;
      let highestDev: string | null = null;

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
    } catch (err: any) {
      console.error(`[Tool getHighestMetric] Error comparing '${metric}':`, err.message);
    }
    return {};
  }

  // Tool 7: get_metric_trend
  public async getMetricTrend(deviceName: string, metric: string): Promise<any> {
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
    } catch (err: any) {
      console.error(`[Tool getMetricTrend] Failed for '${deviceName}':`, err.message);
    }
    return {};
  }

  // Helper Threshold extraction
  public async getDeviceThresholds(deviceName: string): Promise<FallbackThresholds> {
    const thresholds: FallbackThresholds = JSON.parse(JSON.stringify(this.fallbackThresholds));
    try {
      const attrs = await this.getAttributes(deviceName);

      for (const [key, value] of Object.entries(attrs)) {
        if (key.includes('_limit_max')) {
          const metric = key.replace('_limit_max', '');
          if (thresholds[metric]) thresholds[metric].max = parseFloat(value);
        } else if (key.includes('_limit_min')) {
          const metric = key.replace('_limit_min', '');
          if (thresholds[metric]) thresholds[metric].min = parseFloat(value);
        }
      }
    } catch (err: any) {
      console.warn(`[Bridge Thresholds] Excursion parsing error:`, err.message);
    }
    return thresholds;
  }

  // Tool 8: perform_deep_analysis — now processes ALL dynamic telemetry keys
  public async performDeepAnalysis(
    deviceName: string,
    startTime?: string,
    endTime?: string,
    hours = 24
  ): Promise<any> {
    let startTs: number;
    let endTs: number;

    if (startTime && endTime) {
      startTs = this.isoToEpochMs(startTime);
      endTs = this.isoToEpochMs(endTime);
    } else {
      endTs = Date.now();
      startTs = endTs - hours * 3600 * 1000;
    }

    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { error: 'Device not found' };

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
    const telemetryStreams: Record<string, { timestamps: number[]; values: number[] }> = {};
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
    const statsSummary: Record<string, any> = {};
    const breachesSummary: Record<string, { count: number; points: { ts: number; val: number }[] }> = {};

    for (const key of Object.keys(telemetryStreams)) {
      const data = telemetryStreams[key];
      const limits = thresholds[key] || { min: -Infinity, max: Infinity };
      statsSummary[key] = this.calculateAdvancedStats(data.values, limits);

      breachesSummary[key] = { count: 0, points: [] };
      for (let i = 0; i < data.values.length; i++) {
        const ts = data.timestamps[i];
        const val = data.values[i];
        let breached = false;

        if (limits.max !== undefined && limits.max !== Infinity && val > limits.max) breached = true;
        if (limits.min !== undefined && limits.min !== -Infinity && val < limits.min) breached = true;

        if (breached) {
          breachesSummary[key].count++;
          breachesSummary[key].points.push({ ts, val });
        }
      }
    }

    // Fetch historical alarms
    let alarms: any[] = [];
    try {
      const res = await this.client.request<any>('GET', `/api/alarm/DEVICE/${devId}`, {
        pageSize: 50,
        page: 0,
        startTime: startTs,
        endTime: endTs,
        sortProperty: 'createdTime',
        sortOrder: 'DESC',
      });
      alarms = (res.data || []).map((a: any) => ({
        type: a.type,
        severity: a.severity,
        status: a.status,
        timestamp: a.createdTime,
      }));
    } catch (err: any) {
      console.warn(`[Deep Audit] Alarm logs fetch bypassed: ${err.message}`);
    }

    // Deduplicate alarms
    const seenAlarms = new Set<string>();
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
      htmlReportPath = await this.generateHtmlReportFileAsync(
        deviceName,
        startTs,
        endTs,
        telemetryStreams,
        thresholds,
        breachesSummary,
        mergedAlarms
      );
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
  public async createDevice(
    deviceName: string, 
    deviceType: string, 
    label = '', 
    attributes?: Record<string, any>,
    profileName?: string
  ): Promise<any> {
    try {
      const payload: any = { name: deviceName, type: deviceType, label };

      if (profileName) {
        const profileList = await this.profileSrv.getDeviceProfiles(100);
        const match = (profileList.data || []).find((p: any) => p.name.toLowerCase() === profileName.toLowerCase());
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
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 10: delete_device
  public async deleteDevice(deviceName: string): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      await this.deviceSrv.deleteDevice(devId);
      delete this.deviceCache[deviceName];
      return { status: 'success', message: `Device ${deviceName} deleted successfully.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 11: get_device_credentials
  public async getDeviceCredentials(deviceName: string): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      const res = await this.deviceSrv.getDeviceCredentials(devId);
      return { status: 'success', credentials: res };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 12: acknowledge_alarm
  public async acknowledgeAlarm(alarmId: string): Promise<any> {
    try {
      await this.alarmSrv.acknowledgeAlarm(alarmId);
      return { status: 'success', message: `Alarm ${alarmId} acknowledged.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 13: clear_alarm
  public async clearAlarm(alarmId: string): Promise<any> {
    try {
      await this.alarmSrv.clearAlarm(alarmId);
      return { status: 'success', message: `Alarm ${alarmId} cleared.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 14: trigger_rule_engine
  public async triggerRuleEngine(deviceName: string, message: any): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      const ruleMsg = {
        msgType: 'POST_TELEMETRY_REQUEST',
        msg: message,
        metadata: { source: 'Gemini Voice Integration Agent' },
      };
      await this.ruleSrv.pushMessageToRuleEngine('DEVICE', devId, ruleMsg);
      return { status: 'success', message: 'Message successfully pushed to the rule engine.' };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 15: create_alarm
  public async createAlarm(
    deviceName: string, 
    alarmType: string, 
    severity: string, 
    details: any = null,
    metricParam?: string,
    operatorCondition?: string,
    comparisonValue?: number
  ): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    
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
        name: alarmType,
        type: alarmType,
        originator: {
          entityType: 'DEVICE' as const,
          id: devId,
        },
        severity: severity.toUpperCase() as any,
        status: 'ACTIVE_UNACK',
        propagate: true,
        details: ruleDetails,
      };
      const res = await this.alarmSrv.saveAlarm(alarmDef);
      return { 
        status: 'success', 
        alarmId: res.id?.id, 
        type: alarmType,
        condition: ruleDetails.condition || 'Manual trigger details'
      };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 16: create_rule_chain
  public async createRuleChain(name: string, nodes: any[], connections: any[], firstNodeIndex = 0): Promise<any> {
    try {
      const ruleChainDef: RuleChain = {
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
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 17: list_assets
  public async listAssets(): Promise<string[]> {
    try {
      const res = await this.assetSrv.getTenantAssets(100);
      return (res.data || []).map((a) => a.name);
    } catch {
      return [];
    }
  }

  // Tool 18: get_asset_by_name
  public async getAssetByName(assetName: string): Promise<any> {
    const assetId = await this.getAssetId(assetName);
    if (!assetId) return { error: 'Asset not found' };
    try {
      const res = await this.assetSrv.getAssetById(assetId);
      return { status: 'success', asset: res };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 19: create_asset
  public async createAsset(assetName: string, assetType: string, label = ''): Promise<any> {
    try {
      const res = await this.assetSrv.createOrUpdateAsset({ name: assetName, type: assetType, label });
      const assetId = res.id?.id;
      if (assetId) {
        // Invalidate any stale negative cache entry
        this.assetCache[assetName] = { value: assetId, expiresAt: 0 };
      }
      return { status: 'success', assetId, name: assetName };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 20: delete_asset
  public async deleteAsset(assetName: string): Promise<any> {
    const assetId = await this.getAssetId(assetName);
    if (!assetId) return { status: 'error', message: 'Asset not found' };
    try {
      await this.assetSrv.deleteAsset(assetId);
      delete this.assetCache[assetName];
      return { status: 'success', message: `Asset ${assetName} deleted successfully.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 21: create_relation
  public async createRelation(fromName: string, toName: string, relationType: string): Promise<any> {
    try {
      const fromObj = await this.resolveEntityIdAndType(fromName);
      const toObj = await this.resolveEntityIdAndType(toName);

      if (!fromObj || !toObj) {
        return { status: 'error', message: 'Failed to resolve source or destination entity name.' };
      }

      const relation: Relation = {
        from: { id: fromObj.id, entityType: fromObj.type },
        to: { id: toObj.id, entityType: toObj.type },
        type: relationType,
      };
      await this.relationSrv.createRelation(relation);
      return { status: 'success', message: `Relation '${relationType}' between ${fromName} and ${toName} established.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 22: delete_relation
  public async deleteRelation(fromName: string, toName: string, relationType: string): Promise<any> {
    try {
      const fromObj = await this.resolveEntityIdAndType(fromName);
      const toObj = await this.resolveEntityIdAndType(toName);

      if (!fromObj || !toObj) {
        return { status: 'error', message: 'Failed to resolve source or destination entity.' };
      }

      const relation: Relation = {
        from: { id: fromObj.id, entityType: fromObj.type },
        to: { id: toObj.id, entityType: toObj.type },
        type: relationType,
      };
      await this.relationSrv.deleteRelation(relation);
      return { status: 'success', message: `Relation '${relationType}' between ${fromName} and ${toName} removed.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 23: list_relations
  public async listRelations(entityName: string): Promise<any> {
    try {
      const obj = await this.resolveEntityIdAndType(entityName);
      if (!obj) return { status: 'error', message: `Entity '${entityName}' not found.` };

      const relations = await this.relationSrv.listRelationsFrom(obj.id, obj.type);
      return { status: 'success', relations };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 24: save_device_attributes
  public async saveDeviceAttributes(deviceName: string, scope: string, attributes: any): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      await this.telemetrySrv.saveAttributes(devId, scope, attributes);
      return { status: 'success', message: 'Attributes saved successfully.' };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 25: delete_device_attributes
  public async deleteDeviceAttributes(deviceName: string, scope: string, keys: string[]): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      await this.telemetrySrv.deleteAttributes(devId, scope, keys);
      return { status: 'success', message: 'Attributes deleted successfully.' };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 26: list_dashboards
  public async listDashboards(): Promise<any> {
    try {
      const dashboards = await this.dashboardSrv.getTenantDashboards();
      return { status: 'success', dashboards: dashboards.data };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 36: create_device_dashboard
  public async createDeviceDashboard(
    deviceName: string, 
    monitoredKeys: string[] = ['temperature', 'humidity', 'pressure', 'vibration'],
    dashboardTitle?: string,
    backgroundColor = '#ffffff'
  ): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };

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

      const res = await this.dashboardSrv.saveDashboard(dashboardConfig as any);
      return {
        status: 'success',
        dashboardId: res.id?.id,
        title: res.title,
        monitored_parameters: monitoredKeys,
        message: `Dashboard created successfully. You can view it in ThingsBoard UI for device ${deviceName}.`,
      };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 27: get_dashboard_by_id
  public async getDashboardById(dashboardId: string): Promise<any> {
    try {
      const dashboard = await this.dashboardSrv.getDashboardById(dashboardId);
      return { status: 'success', dashboard };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 28: assign_dashboard_to_customer
  public async assignDashboardToCustomer(customerId: string, dashboardId: string): Promise<any> {
    try {
      const res = await this.dashboardSrv.assignDashboardToCustomer(customerId, dashboardId);
      return { status: 'success', dashboard: res };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 29: list_device_profiles
  public async listDeviceProfiles(): Promise<any> {
    try {
      const profiles = await this.profileSrv.getDeviceProfiles();
      return { status: 'success', profiles: profiles.data };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 30: get_device_profile_by_id
  public async getDeviceProfileById(profileId: string): Promise<any> {
    try {
      const profile = await this.profileSrv.getDeviceProfileById(profileId);
      return { status: 'success', profile };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 31: send_one_way_rpc
  public async sendOneWayRpc(deviceName: string, method: string, params: any): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      await this.rpcSrv.sendOneWayRpc(devId, { method, params });
      return { status: 'success', message: 'One-way RPC request transmitted.' };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 32: send_two_way_rpc
  public async sendTwoWayRpc(deviceName: string, method: string, params: any): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      const response = await this.rpcSrv.sendTwoWayRpc(devId, { method, params });
      return { status: 'success', response };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 33: list_persistent_rpcs
  public async listPersistentRpcs(deviceName: string): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      const rpcs = await this.rpcSrv.listPersistentRpcs(devId);
      return { status: 'success', rpcs };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 34: inject_rule_engine_queue
  public async injectRuleEngineQueue(deviceName: string, messagePayload: any, queueName: string): Promise<any> {
    const devId = await this.getDeviceId(deviceName);
    if (!devId) return { status: 'error', message: 'Device not found' };
    try {
      const message: any = {
        msgType: 'POST_TELEMETRY_REQUEST',
        msg: messagePayload,
        metadata: { source: 'Gemini Voice Integration Pipeline' },
      };
      await this.ruleSrv.pushMessageToRuleEngine('DEVICE', devId, message, queueName);
      return { status: 'success', message: `Injected into ${queueName} queue successfully.` };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  // Tool 35: get_audit_logs
  public async getAuditLogs(): Promise<any> {
    try {
      const logs = await this.auditSrv.getAuditLogs();
      return { status: 'success', logs: logs.data };
    } catch (e: any) {
      return { status: 'error', message: e.message };
    }
  }

  private calculateAdvancedStats(values: number[], limits: MetricLimits): any {
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
      } else if (limits.min !== undefined && val < limits.min) {
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
  private async generateHtmlReportFileAsync(
    deviceName: string,
    startTs: number,
    endTs: number,
    streams: Record<string, { timestamps: number[]; values: number[] }>,
    thresholds: FallbackThresholds,
    breaches: Record<string, { count: number }>,
    alarms: any[]
  ): Promise<string> {
    const reportDir = path.join(process.cwd(), 'reports');
    
    await fs.mkdir(reportDir, { recursive: true });

    const filename = `industrial_audit_${deviceName}_${Math.floor(Date.now() / 1000)}.html`;
    const filepath = path.join(reportDir, filename);

    const clientTraceData: any[] = [];
    const colors: Record<string, string> = {
      temperature: '#ef4444',
      humidity: '#3b82f6',
      pressure: '#10b981',
      vibration: '#f59e0b',
    };

    for (const [metric, data] of Object.entries(streams)) {
      if (data.values.length === 0) continue;
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
                  ${
                    alarms.length === 0
                      ? '<tr><td colspan="3" style="text-align:center; color:#94a3b8;">No recent alarms</td></tr>'
                      : alarms
                          .slice(0, 10)
                          .map(
                            (a) => `
                    <tr>
                      <td><strong>${a.type}</strong></td>
                      <td><span class="badge badge-${a.severity.toLowerCase() === 'critical' ? 'critical' : 'warning'}">${a.severity}</span></td>
                      <td><span style="font-size: 12px; color: #475569;">${a.status}</span></td>
                    </tr>`
                          )
                          .join('')
                  }
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

    await fs.writeFile(filepath, htmlContent, 'utf-8');
    return filepath;
  }

  public formatMarkdownReport(data: any): string {
    const lines = [
      `# Industrial Health Audit: ${data.device}`,
      `**Interval:** ${data.window.start} to ${data.window.end}`,
      `**Total Data Points Scanned:** ${data.total_points}`,
      `\n## Threshold Analysis:`,
    ];

    const breachEntries = Object.entries(data.breaches);
    if (breachEntries.length === 0) {
      lines.push('  *No threshold breaches logged. All systems are reporting normally.*');
    } else {
      for (const [metric, b] of breachEntries as any[]) {
        const st = data.stats[metric];
        lines.push(`### ${metric.toUpperCase()}:`);
        lines.push(`  - **Breaches Count:** ${b.count} out-of-bounds occurrences (${st.breach_percent}% breach duration).`);
        lines.push(`  - **Deviation Spreads:** Avg ${st.avg} | Max ${st.max} | Min ${st.min} (SD: ±${st.std_dev})`);
        if (b.points && b.points.length > 0) {
          const worst = b.points.reduce((maxPt: any, pt: any) => (pt.val > maxPt.val ? pt : maxPt), b.points[0]);
          const timeStr = new Date(worst.ts).toTimeString().substring(0, 8);
          lines.push(`  - **Highest Breach Point:** ${worst.val} reached at ${timeStr}`);
        }
      }
    }

    lines.push(`\n## Alarms Logged (${data.alarms.length}):`);
    if (data.alarms.length === 0) {
      lines.push('  *No system alarms triggered.*');
    } else {
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
  public async forecastWhatIf(args: {
    device_name: string;
    target_metric: string;
    prediction_horizon_steps?: number;
    interventions?: Array<{ metric: string; action: string; value: number }>;
    question_type?: string;
    crossing_threshold?: number;
  }): Promise<any> {
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
          if (pt.ts < minTs) minTs = pt.ts;
          if (pt.ts > maxTs) maxTs = pt.ts;
        }
      }

      if (minTs === Infinity || maxTs === -Infinity || maxTs - minTs < gridIntervalMs) {
        minTs = startTs;
        maxTs = endTs;
      }

      const startGrid = Math.floor(minTs / gridIntervalMs) * gridIntervalMs;
      const endGrid = Math.floor(maxTs / gridIntervalMs) * gridIntervalMs;

      const timestampsGrid: number[] = [];
      for (let t = startGrid; t <= endGrid; t += gridIntervalMs) {
        timestampsGrid.push(t);
      }

      if (timestampsGrid.length < 2) {
        return { error: "Insufficient historical telemetry data to align grid." };
      }

      // Pre-process raw key streams into sorted { ts, value } maps
      const streams: Record<string, Array<{ ts: number; val: number }>> = {};
      for (const key of keys) {
        const pts = rawTelemetry[key] || [];
        streams[key] = pts
          .map((pt) => ({ ts: pt.ts, val: parseFloat(pt.value) }))
          .filter((pt) => !isNaN(pt.val))
          .sort((a, b) => a.ts - b.ts);
      }

      // Resample function using forward-fill (nearest historical point)
      const resampleSeries = (pts: Array<{ ts: number; val: number }>, grid: number[]): number[] => {
        const resampled: number[] = [];
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
      const alignedCovariates: Record<string, number[]> = {};
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

      const response = await axios.post('http://localhost:8000/forecast_what_if', payload, {
        timeout: 120000, // 120 second timeout for model inference
      });
      return response.data;
    } catch (err: any) {
      console.error(`[forecastWhatIf] Failed:`, err.message);
      return { error: `Failed to execute forecast what-if: ${err.message}` };
    }
  }
}