"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = exports.RpcService = exports.DeviceProfileService = exports.DashboardService = exports.RelationService = exports.AssetService = exports.RuleEngineService = exports.AlarmService = exports.TelemetryService = exports.DeviceService = void 0;
class DeviceService {
    client;
    constructor(client) {
        this.client = client;
    }
    async createOrUpdateDevice(device) {
        return this.client.request('POST', '/api/device', undefined, device);
    }
    async getDeviceById(deviceId) {
        return this.client.request('GET', `/api/device/${deviceId}`);
    }
    async deleteDevice(deviceId) {
        await this.client.request('DELETE', `/api/device/${deviceId}`);
    }
    async getTenantDevices(pageSize = 10, page = 0, deviceType = '') {
        const params = { pageSize, page, type: deviceType };
        return this.client.request('GET', '/api/tenant/devices', params);
    }
    async getDeviceCredentials(deviceId) {
        return this.client.request('GET', `/api/device/${deviceId}/credentials`);
    }
}
exports.DeviceService = DeviceService;
class TelemetryService {
    client;
    constructor(client) {
        this.client = client;
    }
    async saveDeviceTelemetry(deviceId, payload) {
        await this.client.request('POST', `/api/plugins/telemetry/DEVICE/${deviceId}/timeseries/ANY`, undefined, payload);
    }
    async getLatestTelemetry(deviceId, keys) {
        const params = keys ? { keys: keys.join(',') } : {};
        return this.client.request('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`, params);
    }
    async getHistoricalTelemetry(deviceId, query) {
        const params = {
            keys: query.keys,
            startTs: query.startTs,
            endTs: query.endTs,
            limit: query.limit ?? 100,
            orderBy: query.orderBy ?? 'DESC',
        };
        if (query.agg && query.agg !== 'NONE') {
            params.agg = query.agg;
            if (!query.interval) {
                throw new Error('An aggregation interval (ms) is required if utilizing aggregation filters.');
            }
            params.interval = query.interval;
        }
        return this.client.request('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`, params);
    }
    async getAttributes(deviceId, scope) {
        const scopeSegment = scope ? `/${scope}` : '';
        return this.client.request('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes${scopeSegment}`);
    }
    async saveAttributes(deviceId, scope, attributes) {
        await this.client.request('POST', `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`, undefined, attributes);
    }
    async deleteAttributes(deviceId, scope, keys) {
        await this.client.request('DELETE', `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`, { keys: keys.join(',') });
    }
}
exports.TelemetryService = TelemetryService;
class AlarmService {
    client;
    constructor(client) {
        this.client = client;
    }
    async saveAlarm(alarm) {
        return this.client.request('POST', '/api/alarm', undefined, alarm);
    }
    async getAlarmById(alarmId) {
        return this.client.request('GET', `/api/alarm/${alarmId}`);
    }
    async acknowledgeAlarm(alarmId) {
        await this.client.request('POST', `/api/alarm/${alarmId}/ack`);
    }
    async clearAlarm(alarmId) {
        await this.client.request('POST', `/api/alarm/${alarmId}/clear`);
    }
    async getTenantAlarms(pageSize = 10, page = 0, status, searchStatus, sortProperty = 'createdTime', sortOrder = 'DESC') {
        const params = { pageSize, page, sortProperty, sortOrder };
        if (status)
            params.status = status;
        if (searchStatus)
            params.searchStatus = searchStatus;
        return this.client.request('GET', '/api/alarms', params); // GET global tenant alarms
    }
    async updateAlarmDetails(alarmId, additionalDetails) {
        const existingAlarm = await this.getAlarmById(alarmId);
        const existingDetails = existingAlarm.details ?? {};
        existingAlarm.details = { ...existingDetails, ...additionalDetails };
        return this.saveAlarm(existingAlarm);
    }
}
exports.AlarmService = AlarmService;
class RuleEngineService {
    client;
    constructor(client) {
        this.client = client;
    }
    async getRootRuleChain() {
        return this.client.request('GET', '/api/ruleChain/root');
    }
    async getRuleChainById(ruleChainId) {
        return this.client.request('GET', `/api/ruleChain/${ruleChainId}`);
    }
    async saveRuleChain(ruleChain) {
        return this.client.request('POST', '/api/ruleChain', undefined, ruleChain);
    }
    async pushMessageToRuleEngine(entityType, entityId, message, queueName) {
        const queueSegment = queueName ? `/${queueName}` : '';
        const path = `/api/rule-engine/${entityType}/${entityId}${queueSegment}`;
        await this.client.request('POST', path, undefined, message);
    }
}
exports.RuleEngineService = RuleEngineService;
class AssetService {
    client;
    constructor(client) {
        this.client = client;
    }
    async createOrUpdateAsset(asset) {
        return this.client.request('POST', '/api/asset', undefined, asset);
    }
    async getAssetById(assetId) {
        return this.client.request('GET', `/api/asset/${assetId}`);
    }
    async deleteAsset(assetId) {
        await this.client.request('DELETE', `/api/asset/${assetId}`);
    }
    async getTenantAssets(pageSize = 10, page = 0, assetType = '') {
        const params = { pageSize, page, type: assetType };
        return this.client.request('GET', '/api/tenant/assets', params);
    }
}
exports.AssetService = AssetService;
class RelationService {
    client;
    constructor(client) {
        this.client = client;
    }
    async createRelation(relation) {
        await this.client.request('POST', '/api/relation', undefined, relation);
    }
    async deleteRelation(relation) {
        await this.client.request('DELETE', '/api/relation', {
            fromId: relation.from.id,
            fromType: relation.from.entityType,
            relationType: relation.type,
            toId: relation.to.id,
            toType: relation.to.entityType,
        });
    }
    async listRelationsFrom(entityId, entityType) {
        return this.client.request('GET', '/api/relations', { fromId: entityId, fromType: entityType });
    }
}
exports.RelationService = RelationService;
class DashboardService {
    client;
    constructor(client) {
        this.client = client;
    }
    async getTenantDashboards(pageSize = 10, page = 0) {
        return this.client.request('GET', '/api/tenant/dashboards', { pageSize, page });
    }
    async getDashboardById(dashboardId) {
        return this.client.request('GET', `/api/dashboard/${dashboardId}`);
    }
    async saveDashboard(dashboard) {
        return this.client.request('POST', '/api/dashboard', undefined, dashboard);
    }
    async assignDashboardToCustomer(customerId, dashboardId) {
        return this.client.request('POST', `/api/customer/${customerId}/dashboard/${dashboardId}`);
    }
}
exports.DashboardService = DashboardService;
class DeviceProfileService {
    client;
    constructor(client) {
        this.client = client;
    }
    async getDeviceProfiles(pageSize = 10, page = 0) {
        return this.client.request('GET', '/api/deviceProfiles', { pageSize, page });
    }
    async getDeviceProfileById(profileId) {
        return this.client.request('GET', `/api/deviceProfile/${profileId}`);
    }
}
exports.DeviceProfileService = DeviceProfileService;
class RpcService {
    client;
    constructor(client) {
        this.client = client;
    }
    async sendOneWayRpc(deviceId, rpcRequest) {
        await this.client.request('POST', `/api/rpc/oneway/${deviceId}`, undefined, rpcRequest);
    }
    async sendTwoWayRpc(deviceId, rpcRequest) {
        return this.client.request('POST', `/api/rpc/twoway/${deviceId}`, undefined, rpcRequest);
    }
    async listPersistentRpcs(deviceId, pageSize = 10, page = 0) {
        return this.client.request('GET', `/api/rpc/persistent/device/${deviceId}`, { pageSize, page });
    }
}
exports.RpcService = RpcService;
class AuditService {
    client;
    constructor(client) {
        this.client = client;
    }
    async getAuditLogs(pageSize = 10, page = 0) {
        return this.client.request('GET', '/api/audit/logs', { pageSize, page });
    }
}
exports.AuditService = AuditService;
// // ThingsBoard API service layers
// import { ThingsBoardClient } from './restClient';
// import {
//   Device,
//   DeviceCredentials,
//   HistoricalQuery,
//   TelemetryQueryResponse,
//   Alarm,
//   RuleChain,
//   RuleEngineMessage,
//   Asset,
//   Relation,
//   Dashboard,
//   DeviceProfile,
//   AuditLog,
// } from './types';
// export class DeviceService {
//   constructor(private client: ThingsBoardClient) {}
//   public async createOrUpdateDevice(device: Device): Promise<Device> {
//     return this.client.request<Device>('POST', '/api/device', undefined, device);
//   }
//   public async getDeviceById(deviceId: string): Promise<Device> {
//     return this.client.request<Device>('GET', `/api/device/${deviceId}`);
//   }
//   public async deleteDevice(deviceId: string): Promise<void> {
//     await this.client.request<void>('DELETE', `/api/device/${deviceId}`);
//   }
//   public async getTenantDevices(
//     pageSize = 10,
//     page = 0,
//     deviceType = ''
//   ): Promise<{ data: Device[]; [key: string]: any }> {
//     const params = { pageSize, page, type: deviceType };
//     return this.client.request('GET', '/api/tenant/devices', params);
//   }
//   public async getDeviceCredentials(deviceId: string): Promise<DeviceCredentials> {
//     return this.client.request<DeviceCredentials>('GET', `/api/device/${deviceId}/credentials`);
//   }
// }
// export class TelemetryService {
//   constructor(private client: ThingsBoardClient) {}
//   public async saveDeviceTelemetry(deviceId: string, payload: Record<string, any>): Promise<void> {
//     await this.client.request<void>(
//       'POST',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/timeseries/ANY`,
//       undefined,
//       payload
//     );
//   }
//   public async getLatestTelemetry(deviceId: string, keys?: string[]): Promise<TelemetryQueryResponse> {
//     const params = keys ? { keys: keys.join(',') } : {};
//     return this.client.request<TelemetryQueryResponse>(
//       'GET',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
//       params
//     );
//   }
//   public async getHistoricalTelemetry(
//     deviceId: string,
//     query: HistoricalQuery
//   ): Promise<TelemetryQueryResponse> {
//     const params: Record<string, any> = {
//       keys: query.keys,
//       startTs: query.startTs,
//       endTs: query.endTs,
//       limit: query.limit ?? 100,
//       orderBy: query.orderBy ?? 'DESC',
//     };
//     if (query.agg && query.agg !== 'NONE') {
//       params.agg = query.agg;
//       if (!query.interval) {
//         throw new Error('An aggregation interval (ms) is required if utilizing aggregation filters.');
//       }
//       params.interval = query.interval;
//     }
//     return this.client.request<TelemetryQueryResponse>(
//       'GET',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
//       params
//     );
//   }
//   public async getAttributes(deviceId: string, scope?: string): Promise<any[]> {
//     const scopeSegment = scope ? `/${scope}` : '';
//     return this.client.request<any[]>(
//       'GET',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes${scopeSegment}`
//     );
//   }
//   public async saveAttributes(deviceId: string, scope: string, attributes: Record<string, any>): Promise<void> {
//     await this.client.request<void>(
//       'POST',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
//       undefined,
//       attributes
//     );
//   }
//   public async deleteAttributes(deviceId: string, scope: string, keys: string[]): Promise<void> {
//     await this.client.request<void>(
//       'DELETE',
//       `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
//       { keys: keys.join(',') }
//     );
//   }
// }
// export class AlarmService {
//   constructor(private client: ThingsBoardClient) {}
//   public async saveAlarm(alarm: Alarm): Promise<Alarm> {
//     return this.client.request<Alarm>('POST', '/api/alarm', undefined, alarm);
//   }
//   public async getAlarmById(alarmId: string): Promise<Alarm> {
//     return this.client.request<Alarm>('GET', `/api/alarm/${alarmId}`);
//   }
//   public async acknowledgeAlarm(alarmId: string): Promise<void> {
//     await this.client.request<void>('POST', `/api/alarm/${alarmId}/ack`);
//   }
//   public async clearAlarm(alarmId: string): Promise<void> {
//     await this.client.request<void>('POST', `/api/alarm/${alarmId}/clear`);
//   }
//   public async updateAlarmDetails(alarmId: string, additionalDetails: Record<string, any>): Promise<Alarm> {
//     const existingAlarm = await this.getAlarmById(alarmId);
//     const existingDetails = existingAlarm.details ?? {};
//     existingAlarm.details = { ...existingDetails, ...additionalDetails };
//     return this.saveAlarm(existingAlarm);
//   }
// }
// export class RuleEngineService {
//   constructor(private client: ThingsBoardClient) {}
//   public async getRootRuleChain(): Promise<RuleChain> {
//     return this.client.request<RuleChain>('GET', '/api/ruleChain/root');
//   }
//   public async getRuleChainById(ruleChainId: string): Promise<RuleChain> {
//     return this.client.request<RuleChain>('GET', `/api/ruleChain/${ruleChainId}`);
//   }
//   public async saveRuleChain(ruleChain: RuleChain): Promise<RuleChain> {
//     return this.client.request<RuleChain>('POST', '/api/ruleChain', undefined, ruleChain);
//   }
//   public async pushMessageToRuleEngine(
//     entityType: 'DEVICE' | 'ASSET',
//     entityId: string,
//     message: RuleEngineMessage,
//     queueName?: string
//   ): Promise<void> {
//     const queueSegment = queueName ? `/${queueName}` : '';
//     const path = `/api/rule-engine/${entityType}/${entityId}${queueSegment}`;
//     await this.client.request<void>('POST', path, undefined, message);
//   }
// }
// export class AssetService {
//   constructor(private client: ThingsBoardClient) {}
//   public async createOrUpdateAsset(asset: Asset): Promise<Asset> {
//     return this.client.request<Asset>('POST', '/api/asset', undefined, asset);
//   }
//   public async getAssetById(assetId: string): Promise<Asset> {
//     return this.client.request<Asset>('GET', `/api/asset/${assetId}`);
//   }
//   public async deleteAsset(assetId: string): Promise<void> {
//     await this.client.request<void>('DELETE', `/api/asset/${assetId}`);
//   }
//   public async getTenantAssets(pageSize = 10, page = 0, assetType = ''): Promise<{ data: Asset[] }> {
//     const params = { pageSize, page, type: assetType };
//     return this.client.request('GET', '/api/tenant/assets', params);
//   }
// }
// export class RelationService {
//   constructor(private client: ThingsBoardClient) {}
//   public async createRelation(relation: Relation): Promise<void> {
//     await this.client.request<void>('POST', '/api/relation', undefined, relation);
//   }
//   public async deleteRelation(relation: Relation): Promise<void> {
//     await this.client.request<void>(
//       'DELETE',
//       '/api/relation',
//       {
//         fromId: relation.from.id,
//         fromType: relation.from.entityType,
//         relationType: relation.type,
//         toId: relation.to.id,
//         toType: relation.to.entityType,
//       }
//     );
//   }
//   public async listRelationsFrom(entityId: string, entityType: string): Promise<Relation[]> {
//     return this.client.request<Relation[]>('GET', '/api/relations', { fromId: entityId, fromType: entityType });
//   }
// }
// export class DashboardService {
//   constructor(private client: ThingsBoardClient) {}
//   public async getTenantDashboards(pageSize = 10, page = 0): Promise<{ data: Dashboard[] }> {
//     return this.client.request('GET', '/api/tenant/dashboards', { pageSize, page });
//   }
//   public async getDashboardById(dashboardId: string): Promise<Dashboard> {
//     return this.client.request<Dashboard>('GET', `/api/dashboard/${dashboardId}`);
//   }
//   public async saveDashboard(dashboard: Dashboard): Promise<Dashboard> {
//     return this.client.request<Dashboard>('POST', '/api/dashboard', undefined, dashboard);
//   }
//   public async assignDashboardToCustomer(customerId: string, dashboardId: string): Promise<Dashboard> {
//     return this.client.request<Dashboard>('POST', `/api/customer/${customerId}/dashboard/${dashboardId}`);
//   }
// }
// export class DeviceProfileService {
//   constructor(private client: ThingsBoardClient) {}
//   public async getDeviceProfiles(pageSize = 10, page = 0): Promise<{ data: DeviceProfile[] }> {
//     return this.client.request('GET', '/api/deviceProfiles', { pageSize, page });
//   }
//   public async getDeviceProfileById(profileId: string): Promise<DeviceProfile> {
//     return this.client.request<DeviceProfile>('GET', `/api/deviceProfile/${profileId}`);
//   }
// }
// export class RpcService {
//   constructor(private client: ThingsBoardClient) {}
//   public async sendOneWayRpc(deviceId: string, rpcRequest: any): Promise<void> {
//     await this.client.request<void>('POST', `/api/rpc/oneway/${deviceId}`, undefined, rpcRequest);
//   }
//   public async sendTwoWayRpc(deviceId: string, rpcRequest: any): Promise<any> {
//     return this.client.request<any>('POST', `/api/rpc/twoway/${deviceId}`, undefined, rpcRequest);
//   }
//   public async listPersistentRpcs(deviceId: string, pageSize = 10, page = 0): Promise<any> {
//     return this.client.request('GET', `/api/rpc/persistent/device/${deviceId}`, { pageSize, page });
//   }
// }
// export class AuditService {
//   constructor(private client: ThingsBoardClient) {}
//   public async getAuditLogs(pageSize = 10, page = 0): Promise<{ data: AuditLog[] }> {
//     return this.client.request('GET', '/api/audit/logs', { pageSize, page });
//   }
// }
