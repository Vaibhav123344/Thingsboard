// Shared TypeScript interfaces
export type EntityType = 'DEVICE' | 'ASSET' | 'TENANT' | 'CUSTOMER' | 'ALARM' | 'RULE_CHAIN' | 'DASHBOARD' | 'DEVICE_PROFILE';
export type CredentialsType = 'ACCESS_TOKEN' | 'X509_CERTIFICATE' | 'MQTT_BASIC';
export type AggregationType = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM' | 'COUNT';
export type AlarmSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
export type AlarmStatus = 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'CLEARED_ACK';

export interface EntityId {
  entityType: EntityType;
  id: string;
}

export interface Device {
  id?: EntityId;
  name: string;
  type: string;
  label?: string;
  deviceProfileId?: EntityId;
  customerId?: EntityId;
  additionalInfo?: Record<string, any>;
}

export interface DeviceProfile {
  id?: EntityId;
  name: string;
  type: string;
  transportType?: string;
  provisionType?: string;
  description?: string;
}

export interface Asset {
  id?: EntityId;
  name: string;
  type: string;
  label?: string;
  customerId?: EntityId;
  additionalInfo?: Record<string, any>;
}

export interface Relation {
  from: EntityId;
  to: EntityId;
  type: string;
  typeGroup?: string;
  additionalInfo?: Record<string, any>;
}

export interface Dashboard {
  id?: EntityId;
  title: string;
  configuration?: Record<string, any>;
}

export interface AuditLog {
  id: EntityId;
  entityId: EntityId;
  entityName: string;
  userName: string;
  actionType: string;
  actionStatus: string;
  actionFailureDetails?: string;
  createdTime: number;
}

export interface DeviceCredentials {
  id?: string;
  deviceId?: string;
  credentialsType: CredentialsType;
  credentialsId: string;
  credentialsValue?: string | null;
}

export interface HistoricalQuery {
  keys: string;
  startTs: number;
  endTs: number;
  limit?: number;
  agg?: AggregationType;
  interval?: number;
  orderBy?: 'ASC' | 'DESC';
}

export interface TelemetryResponsePoint {
  ts: number;
  value: string;
}

export type TelemetryQueryResponse = Record<string, TelemetryResponsePoint[]>;

export interface Alarm {
  id?: EntityId;
  type: string;
  originator: EntityId;
  severity: AlarmSeverity;
  status?: AlarmStatus;
  startTs?: number;
  endTs?: number;
  ackTs?: number;
  clearTs?: number;
  details?: Record<string, any>;
  propagate?: boolean;
}

export interface RuleChain {
  id?: EntityId;
  name: string;
  type: 'CORE' | 'EDGE';
  firstRuleNodeId?: EntityId;
  root?: boolean;
  debugMode?: boolean;
  configuration?: Record<string, any>;
  additionalInfo?: Record<string, any>;
}

export interface RuleEngineMessage {
  msgType: string;
  msg: Record<string, any>;
  metadata: Record<string, string>;
}

export interface MetricLimits {
  min?: number;
  max?: number;
}

export type FallbackThresholds = Record<string, Required<MetricLimits>>;