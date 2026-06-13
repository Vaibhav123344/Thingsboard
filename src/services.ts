import { ThingsBoardClient } from './restClient';
import {
  Device,
  DeviceCredentials,
  HistoricalQuery,
  TelemetryQueryResponse,
  Alarm,
  RuleChain,
  RuleEngineMessage,
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

  public async updateAlarmDetails(alarmId: string, additionalDetails: Record<string, any>): Promise<Alarm> {
    const existingAlarm = await this.getAlarmById(alarmId);
    const existingDetails = existingAlarm.details ?? {};
    existingAlarm.details = { ...existingDetails, ...additionalDetails };
    return this.saveAlarm(existingAlarm);
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
}