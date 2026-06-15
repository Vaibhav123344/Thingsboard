// frontend/src/types.ts

export interface DeviceInfo {
  name: string;
  status: 'ONLINE' | 'OFFLINE' | 'MAINTENANCE';
  profileName?: string;
  type?: string;
  lastTelemetry?: Record<string, any>;
  attributes?: Record<string, any>;
}

export interface AlarmLog {
  id?: string;
  device: string;
  type: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
  status: string;
  timestamp: number;
  details?: any;
}

export interface TerminalLog {
  timestamp: string;
  type: 'info' | 'user' | 'tool_start' | 'tool_complete' | 'status' | 'error';
  message: string;
}
