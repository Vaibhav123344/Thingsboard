// service.ts
import { ThingsBoardClient } from './restClient';
import {
  Device,
  DeviceCredentials,
  HistoricalQuery,
  TelemetryQueryResponse,
  Alarm,
  RuleChain,
  RuleEngineMessage,
  Asset,
  Relation,
  Dashboard,
  DeviceProfile,
  AuditLog,
} from './types';

export class DeviceService {
  constructor(private client: ThingsBoardClient) {}

  public async createOrUpdateDevice(device: Device): Promise<Device> {
    return this.client.request<Device>('POST', '/api/device', undefined, device);
  }

  public async getDeviceById(deviceId: string): Promise<Device> {
    return this.client.request<Device>('GET', `/api/device/${deviceId}`);
  }

  public async deleteDevice(deviceId: string): Promise<void> {
    await this.client.request<void>('DELETE', `/api/device/${deviceId}`);
  }

  public async getTenantDevices(
    pageSize = 10,
    page = 0,
    deviceType = ''
  ): Promise<{ data: Device[]; [key: string]: any }> {
    const params = { pageSize, page, type: deviceType };
    return this.client.request('GET', '/api/tenant/devices', params);
  }

  public async getDeviceCredentials(deviceId: string): Promise<DeviceCredentials> {
    return this.client.request<DeviceCredentials>('GET', `/api/device/${deviceId}/credentials`);
  }
}

export class TelemetryService {
  constructor(private client: ThingsBoardClient) {}

  public async saveDeviceTelemetry(deviceId: string, payload: Record<string, any>): Promise<void> {
    await this.client.request<void>(
      'POST',
      `/api/plugins/telemetry/DEVICE/${deviceId}/timeseries/ANY`,
      undefined,
      payload
    );
  }

  public async getLatestTelemetry(deviceId: string, keys?: string[]): Promise<TelemetryQueryResponse> {
    const params = keys ? { keys: keys.join(',') } : {};
    return this.client.request<TelemetryQueryResponse>(
      'GET',
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
      params
    );
  }

  public async getHistoricalTelemetry(
    deviceId: string,
    query: HistoricalQuery
  ): Promise<TelemetryQueryResponse> {
    const params: Record<string, any> = {
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

    return this.client.request<TelemetryQueryResponse>(
      'GET',
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
      params
    );
  }

  public async getAttributes(deviceId: string, scope?: string): Promise<any[]> {
    const scopeSegment = scope ? `/${scope}` : '';
    return this.client.request<any[]>(
      'GET',
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes${scopeSegment}`
    );
  }

  public async saveAttributes(deviceId: string, scope: string, attributes: Record<string, any>): Promise<void> {
    await this.client.request<void>(
      'POST',
      `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
      undefined,
      attributes
    );
  }

  public async deleteAttributes(deviceId: string, scope: string, keys: string[]): Promise<void> {
    await this.client.request<void>(
      'DELETE',
      `/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
      { keys: keys.join(',') }
    );
  }
}

export class AlarmService {
  constructor(private client: ThingsBoardClient) {}

  public async saveAlarm(alarm: Alarm): Promise<Alarm> {
    return this.client.request<Alarm>('POST', '/api/alarm', undefined, alarm);
  }

  public async getAlarmById(alarmId: string): Promise<Alarm> {
    return this.client.request<Alarm>('GET', `/api/alarm/${alarmId}`);
  }

  public async acknowledgeAlarm(alarmId: string): Promise<void> {
    await this.client.request<void>('POST', `/api/alarm/${alarmId}/ack`);
  }

  public async clearAlarm(alarmId: string): Promise<void> {
    await this.client.request<void>('POST', `/api/alarm/${alarmId}/clear`);
  }

  public async getTenantAlarms(
    pageSize = 10,
    page = 0,
    status?: string,
    searchStatus?: string,
    sortProperty = 'createdTime',
    sortOrder = 'DESC'
  ): Promise<{ data: Alarm[] }> {
    const params: Record<string, any> = { pageSize, page, sortProperty, sortOrder };
    if (status) params.status = status;
    if (searchStatus) params.searchStatus = searchStatus;
    return this.client.request('GET', '/api/alarms', params); // GET global tenant alarms
  }

  public async updateAlarmDetails(alarmId: string, additionalDetails: Record<string, any>): Promise<Alarm> {
    const existingAlarm = await this.getAlarmById(alarmId);
    const existingDetails = existingAlarm.details ?? {};
    existingAlarm.details = { ...existingDetails, ...additionalDetails };
    return this.saveAlarm(existingAlarm);
  }

  public async findAlarms(query: any): Promise<{ data: Alarm[]; [key: string]: any }> {
    return this.client.request('POST', '/api/alarmsQuery/find', undefined, query);
  }

  public async countAlarms(query: any): Promise<number> {
    return this.client.request('POST', '/api/alarmsQuery/count', undefined, query);
  }
}

export class RuleEngineService {
  constructor(private client: ThingsBoardClient) {}

  public async getRootRuleChain(): Promise<RuleChain> {
    return this.client.request<RuleChain>('GET', '/api/ruleChain/root');
  }

  public async getRuleChainById(ruleChainId: string): Promise<RuleChain> {
    return this.client.request<RuleChain>('GET', `/api/ruleChain/${ruleChainId}`);
  }

  public async saveRuleChain(ruleChain: RuleChain): Promise<RuleChain> {
    return this.client.request<RuleChain>('POST', '/api/ruleChain', undefined, ruleChain);
  }

  public async pushMessageToRuleEngine(
    entityType: 'DEVICE' | 'ASSET',
    entityId: string,
    message: RuleEngineMessage,
    queueName?: string
  ): Promise<void> {
    const queueSegment = queueName ? `/${queueName}` : '';
    const path = `/api/rule-engine/${entityType}/${entityId}${queueSegment}`;
    await this.client.request<void>('POST', path, undefined, message);
  }

  public async getRuleNodeEvents(ruleNodeId: string, limit = 10): Promise<any> {
    return this.client.request('GET', `/api/events/RULE_NODE/${ruleNodeId}`, { limit });
  }
}

export class AssetService {
  constructor(private client: ThingsBoardClient) {}

  public async createOrUpdateAsset(asset: Asset): Promise<Asset> {
    return this.client.request<Asset>('POST', '/api/asset', undefined, asset);
  }

  public async getAssetById(assetId: string): Promise<Asset> {
    return this.client.request<Asset>('GET', `/api/asset/${assetId}`);
  }

  public async deleteAsset(assetId: string): Promise<void> {
    await this.client.request<void>('DELETE', `/api/asset/${assetId}`);
  }

  public async getTenantAssets(pageSize = 10, page = 0, assetType = ''): Promise<{ data: Asset[] }> {
    const params = { pageSize, page, type: assetType };
    return this.client.request('GET', '/api/tenant/assets', params);
  }
}

export class RelationService {
  constructor(private client: ThingsBoardClient) {}

  public async createRelation(relation: Relation): Promise<void> {
    await this.client.request<void>('POST', '/api/relation', undefined, relation);
  }

  public async deleteRelation(relation: Relation): Promise<void> {
    await this.client.request<void>(
      'DELETE',
      '/api/relation',
      {
        fromId: relation.from.id,
        fromType: relation.from.entityType,
        relationType: relation.type,
        toId: relation.to.id,
        toType: relation.to.entityType,
      }
    );
  }

  public async listRelationsFrom(entityId: string, entityType: string): Promise<Relation[]> {
    return this.client.request<Relation[]>('GET', '/api/relations', { fromId: entityId, fromType: entityType });
  }
}

export class DashboardService {
  constructor(private client: ThingsBoardClient) {}

  public async getTenantDashboards(pageSize = 10, page = 0): Promise<{ data: Dashboard[] }> {
    return this.client.request('GET', '/api/tenant/dashboards', { pageSize, page });
  }

  public async getDashboardById(dashboardId: string): Promise<Dashboard> {
    return this.client.request<Dashboard>('GET', `/api/dashboard/${dashboardId}`);
  }

  public async saveDashboard(dashboard: Dashboard): Promise<Dashboard> {
    return this.client.request<Dashboard>('POST', '/api/dashboard', undefined, dashboard);
  }

  public async assignDashboardToCustomer(customerId: string, dashboardId: string): Promise<Dashboard> {
    return this.client.request<Dashboard>('POST', `/api/customer/${customerId}/dashboard/${dashboardId}`);
  }
}

export class DeviceProfileService {
  constructor(private client: ThingsBoardClient) {}

  public async getDeviceProfiles(pageSize = 10, page = 0): Promise<{ data: DeviceProfile[] }> {
    return this.client.request('GET', '/api/deviceProfiles', { pageSize, page });
  }

  public async getDeviceProfileById(profileId: string): Promise<DeviceProfile> {
    return this.client.request<DeviceProfile>('GET', `/api/deviceProfile/${profileId}`);
  }
}

export class RpcService {
  constructor(private client: ThingsBoardClient) {}

  public async sendOneWayRpc(deviceId: string, rpcRequest: any): Promise<void> {
    await this.client.request<void>('POST', `/api/rpc/oneway/${deviceId}`, undefined, rpcRequest);
  }

  public async sendTwoWayRpc(deviceId: string, rpcRequest: any): Promise<any> {
    return this.client.request<any>('POST', `/api/rpc/twoway/${deviceId}`, undefined, rpcRequest);
  }

  public async listPersistentRpcs(deviceId: string, pageSize = 10, page = 0): Promise<any> {
    return this.client.request('GET', `/api/rpc/persistent/device/${deviceId}`, { pageSize, page });
  }
}

export class AuditService {
  constructor(private client: ThingsBoardClient) {}

  public async getAuditLogs(pageSize = 10, page = 0): Promise<{ data: AuditLog[] }> {
    return this.client.request('GET', '/api/audit/logs', { pageSize, page });
  }
}

export class EntityQueryService {
  constructor(private client: ThingsBoardClient) {}

  public async findEntityData(query: any): Promise<any> {
    return this.client.request('POST', '/api/entitiesQuery/find', undefined, query);
  }

  public async countEntities(query: any): Promise<any> {
    return this.client.request('POST', '/api/entitiesQuery/count', undefined, query);
  }

  public async findEntityKeys(query: any, includeTimeseries = true, includeAttributes = true): Promise<any> {
    const params = { includeTimeseries, includeAttributes };
    return this.client.request('POST', '/api/v2/entitiesQuery/find/keys', params, query);
  }
}