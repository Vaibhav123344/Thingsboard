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
