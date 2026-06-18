// frontend/src/App.tsx
import { useState, useEffect, useCallback } from 'react';
import { 
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
} from '@livekit/components-react';
import { 
  Mic, MicOff, Send, AlertTriangle, 
  Terminal, Radio, Play, Square,
  Activity, Layers, ChevronRight, Bell, RefreshCw, Cpu,
  Search, Check, Database, Settings, Key
} from 'lucide-react';
import { DeviceInfo, AlarmLog, TerminalLog } from './types';

// Physical constants for UI safety flagging
const TEMP_THRESHOLD = 80.0;
const VIB_THRESHOLD = 4.0;

const LIVEKIT_SERVER = 'ws://localhost:7880';
const TOKEN_ENDPOINT = 'http://localhost:9005/api/livekit/token';

async function fetchRoomToken(room: string): Promise<string> {
  const identity = `operator-${Date.now()}`;
  const url = `${TOKEN_ENDPOINT}?room=${encodeURIComponent(room)}&identity=${identity}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.statusText}`);
  const data = await res.json();
  return data.token;
}

export default function App() {
  const [roomToken, setRoomToken] = useState<string | null>(null);
  const [livekitConnected, setLivekitConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  
  // Real-time Dashboard variables
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [alarms, setAlarms] = useState<AlarmLog[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [predictionReport, setPredictionReport] = useState<any>(null);

  // Tabs navigation
  const [activeTab, setActiveTab] = useState<'telemetry' | 'alarms' | 'diagnostics' | 'entities'>('telemetry');

  // Alarm Counts state
  const [criticalCount, setCriticalCount] = useState<number>(0);
  const [majorCount, setMajorCount] = useState<number>(0);

  // Alarms Explorer State
  const [fetchedAlarms, setFetchedAlarms] = useState<any[]>([]);
  const [alarmSeverityFilter, setAlarmSeverityFilter] = useState<string>('');
  const [alarmStatusFilter, setAlarmStatusFilter] = useState<string>('');
  const [alarmTextSearch, setAlarmTextSearch] = useState<string>('');
  const [alarmPage, setAlarmPage] = useState<number>(0);
  const [isAlarmsLoading, setIsAlarmsLoading] = useState<boolean>(false);

  // Rule Node Diagnostics State
  const [diagnosticRuleNodeId, setDiagnosticRuleNodeId] = useState<string>('');
  const [ruleNodeLogs, setRuleNodeLogs] = useState<any[]>([]);
  const [isLoadingRuleLogs, setIsLoadingRuleLogs] = useState<boolean>(false);

  // Entity Hub State
  const [entityQueryFilter, setEntityQueryFilter] = useState<string>(
    JSON.stringify({ type: 'entityType', entityType: 'DEVICE' }, null, 2)
  );
  const [entityCountResult, setEntityCountResult] = useState<number | null>(null);
  const [availableKeysResult, setAvailableKeysResult] = useState<{
    CLIENT_ATTRIBUTE?: string[];
    SHARED_ATTRIBUTE?: string[];
    SERVER_ATTRIBUTE?: string[];
    TIME_SERIES?: string[];
  } | null>(null);
  const [provisionCustomerId, setProvisionCustomerId] = useState<string>('');
  const [provisionDashboardId, setProvisionDashboardId] = useState<string>('');
  const [provisionStatusMsg, setProvisionStatusMsg] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [isProvisioning, setIsProvisioning] = useState<boolean>(false);

  // Chat and transcription outputs
  const [userInput, setUserInput] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    { timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Industrial Copilot Zephyr initialized.' }
  ]);

  const selectedDevObj = devices.find(d => d.name === selectedDevice);
  const telemetry = selectedDevObj?.lastTelemetry || {};

  // Tool execution client helper
  const executeTool = async (name: string, args: any = {}) => {
    try {
      const res = await fetch('http://localhost:9005/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      const data = await res.json();
      if (data.success) {
        return data.result;
      } else {
        throw new Error(data.error || 'Execution failed');
      }
    } catch (err: any) {
      console.error(`[Tool Client SDK] Execution failed for ${name}:`, err);
      throw err;
    }
  };

  // Fetch counts
  const refreshAlarmCounts = useCallback(async () => {
    try {
      const critRes = await executeTool('count_alarms', {
        severityList: ['CRITICAL'],
        statusList: ['ACTIVE_UNACK', 'ACTIVE_ACK']
      });
      if (critRes && typeof critRes.count === 'number') {
        setCriticalCount(critRes.count);
      }

      const majRes = await executeTool('count_alarms', {
        severityList: ['MAJOR'],
        statusList: ['ACTIVE_UNACK', 'ACTIVE_ACK']
      });
      if (majRes && typeof majRes.count === 'number') {
        setMajorCount(majRes.count);
      }
    } catch (err) {
      console.warn('Failed to fetch alarm counts:', err);
    }
  }, []);

  useEffect(() => {
    fetchSimulationStatus();
    fetchInitialDevices();
    refreshAlarmCounts();
    const alarmInterval = setInterval(() => {
      refreshAlarms();
      refreshAlarmCounts();
    }, 10000);
    return () => clearInterval(alarmInterval);
  }, [refreshAlarmCounts]);

  useEffect(() => {
    if (!selectedDevice) return;
    refreshTelemetry();
    const telemetryInterval = setInterval(() => refreshTelemetry(), 5000);
    return () => clearInterval(telemetryInterval);
  }, [selectedDevice]);

  const fetchInitialDevices = async () => {
    try {
      const res = await fetch('http://localhost:9005/simulation/devices');
      if (!res.ok) return;
      const deviceNames: string[] = await res.json();
      if (deviceNames.length > 0) {
        setDevices(deviceNames.map(name => ({ name, status: 'ONLINE' })));
        if (!selectedDevice) setSelectedDevice(deviceNames[0]);
      }
    } catch (e) {
      addLog('error', 'Critical: Could not reach backend device discovery API.');
    }
  };

  const refreshTelemetry = async () => {
    try {
      const res = await fetch(`http://localhost:9005/simulation/telemetry/${selectedDevice}`);
      if (!res.ok) return;
      const telemetryData = await res.json();
      setDevices(prev => prev.map(dev => dev.name === selectedDevice ? { ...dev, lastTelemetry: telemetryData } : dev));
    } catch {}
  };

  const refreshAlarms = async () => {
    try {
      const res = await fetch('http://localhost:9005/simulation/alarms');
      if (!res.ok) return;
      const activeAlarms: any[] = await res.json();
      setAlarms(activeAlarms.map(a => ({
        id: a.id,
        device: a.originatorName || 'Unknown',
        type: a.type,
        severity: a.severity,
        status: a.status,
        timestamp: a.timestamp,
        details: a.details
      })));
    } catch {}
  };

  const toggleSimulation = async () => {
    try {
      const endpoint = simulationRunning ? 'stop_all' : 'start_all';
      await fetch(`http://localhost:9005/simulation/${endpoint}`, { method: 'POST' });
      setSimulationRunning(!simulationRunning);
      addLog('status', `Telemetry Simulation ${!simulationRunning ? 'ACTIVE' : 'HALTED'}`);
    } catch {
      addLog('error', 'Simulation relay unreachable.');
    }
  };

  const fetchSimulationStatus = async () => {
    try {
      const res = await fetch('http://localhost:9005/simulation/status');
      const data = await res.json();
      setSimulationRunning(Object.values(data.devices).some((d: any) => d.running));
    } catch {}
  };

  const addLog = (type: TerminalLog['type'], message: string) => {
    setTerminalLogs(prev => [
      { timestamp: new Date().toLocaleTimeString(), type, message },
      ...prev.slice(0, 50)
    ]);
  };

  const handleToggleLiveMode = useCallback(async (activate: boolean) => {
    if (activate) {
      setIsConnecting(true);
      try {
        const token = await fetchRoomToken('zephyr-operational-room');
        setRoomToken(token);
        setLivekitConnected(true);
        addLog('status', 'Neural link established with Zephyr Gateway via LiveKit.');
      } catch (err) {
        console.error('Could not obtain LiveKit token:', err);
        addLog('error', 'Failed to connect to LiveKit Gateway.');
      } finally {
        setIsConnecting(false);
      }
    } else {
      setRoomToken(null);
      setLivekitConnected(false);
      addLog('status', 'LiveKit Gateway disconnected.');
    }
  }, []);

  const handleSendPrompt = () => {
    if (!userInput.trim()) return;
    addLog('user', userInput);
    setUserInput('');
  };

  // Alarms Explorer filters/search
  const fetchFilteredAlarms = useCallback(async () => {
    setIsAlarmsLoading(true);
    try {
      const sevs = alarmSeverityFilter ? [alarmSeverityFilter] : undefined;
      const stats = alarmStatusFilter ? [alarmStatusFilter] : undefined;
      
      const res = await executeTool('find_alarms', {
        entityType: 'DEVICE',
        pageSize: 15,
        page: alarmPage,
        textSearch: alarmTextSearch || undefined,
        severityList: sevs,
        statusList: stats
      });
      setFetchedAlarms(res || []);
    } catch (err: any) {
      addLog('error', `Alarms search failed: ${err.message}`);
    } finally {
      setIsAlarmsLoading(false);
    }
  }, [alarmSeverityFilter, alarmStatusFilter, alarmTextSearch, alarmPage]);

  useEffect(() => {
    if (activeTab === 'alarms') {
      fetchFilteredAlarms();
    }
  }, [activeTab, fetchFilteredAlarms]);

  const handleAcknowledgeAlarm = async (alarmId: string) => {
    try {
      addLog('info', `Acknowledging alarm: ${alarmId}`);
      await executeTool('acknowledge_alarm', { alarm_id: alarmId });
      addLog('status', `Alarm ${alarmId} acknowledged.`);
      fetchFilteredAlarms();
      refreshAlarms();
      refreshAlarmCounts();
    } catch (err: any) {
      addLog('error', `Acknowledge failed: ${err.message}`);
    }
  };

  const handleClearAlarm = async (alarmId: string) => {
    try {
      addLog('info', `Clearing alarm: ${alarmId}`);
      await executeTool('clear_alarm', { alarm_id: alarmId });
      addLog('status', `Alarm ${alarmId} cleared.`);
      fetchFilteredAlarms();
      refreshAlarms();
      refreshAlarmCounts();
    } catch (err: any) {
      addLog('error', `Clear failed: ${err.message}`);
    }
  };

  // Diagnostics Rule Node
  const fetchRuleNodeLogs = async () => {
    if (!diagnosticRuleNodeId.trim()) {
      addLog('error', 'Please specify a Rule Node UUID.');
      return;
    }
    setIsLoadingRuleLogs(true);
    try {
      addLog('info', `Fetching rule node events for: ${diagnosticRuleNodeId}`);
      const res = await executeTool('get_rule_node_events', {
        ruleNodeId: diagnosticRuleNodeId.trim(),
        limit: 15
      });
      if (res && res.error) {
        throw new Error(res.error);
      }
      setRuleNodeLogs(Array.isArray(res) ? res : (res?.data || []));
      addLog('status', `Rule node diagnostics updated.`);
    } catch (err: any) {
      addLog('error', `Diagnostics fetch failed: ${err.message}`);
      setRuleNodeLogs([]);
    } finally {
      setIsLoadingRuleLogs(false);
    }
  };

  // Entity Hub
  const handleCountEntities = async () => {
    try {
      let filterObj;
      try {
        filterObj = JSON.parse(entityQueryFilter);
      } catch {
        addLog('error', 'Entity count query contains invalid JSON syntax.');
        return;
      }
      addLog('info', 'Submitting entity count query...');
      const res = await executeTool('count_entities', {
        entityFilter: filterObj.entityFilter || filterObj,
        keyFilters: filterObj.keyFilters || []
      });
      if (res && typeof res.count === 'number') {
        setEntityCountResult(res.count);
        addLog('status', `Queried entity count: ${res.count}`);
      }
    } catch (err: any) {
      addLog('error', `Entity count failed: ${err.message}`);
    }
  };

  const handleFindAvailableKeys = async () => {
    try {
      let filterObj;
      try {
        filterObj = JSON.parse(entityQueryFilter);
      } catch {
        addLog('error', 'Entity key discovery contains invalid JSON syntax.');
        return;
      }
      addLog('info', 'Searching for available telemetry & attributes...');
      const res = await executeTool('find_available_keys', {
        entityFilter: filterObj.entityFilter || filterObj,
        includeTimeseries: true,
        includeAttributes: true
      });
      setAvailableKeysResult(res || null);
      addLog('status', 'Entity keys schema fetched.');
    } catch (err: any) {
      addLog('error', `Key discovery failed: ${err.message}`);
    }
  };

  const handleProvisionDashboard = async () => {
    if (!provisionCustomerId.trim() || !provisionDashboardId.trim()) {
      setProvisionStatusMsg({ type: 'error', text: 'Both Customer ID and Dashboard ID are required.' });
      return;
    }
    setProvisionStatusMsg(null);
    setIsProvisioning(true);
    try {
      addLog('info', `Provisioning dashboard ${provisionDashboardId} to customer ${provisionCustomerId}...`);
      const res = await executeTool('provision_customer_dashboard', {
        customerId: provisionCustomerId.trim(),
        dashboardId: provisionDashboardId.trim()
      });
      if (res && res.status === 'success') {
        setProvisionStatusMsg({ type: 'success', text: 'Dashboard assigned to customer tenant successfully!' });
        addLog('status', 'Dashboard provisioned successfully.');
      } else {
        throw new Error(res?.message || 'Provisioning failed');
      }
    } catch (err: any) {
      setProvisionStatusMsg({ type: 'error', text: `Provisioning failed: ${err.message}` });
      addLog('error', `Dashboard provisioning failed: ${err.message}`);
    } finally {
      setIsProvisioning(false);
    }
  };

  const renderNavbar = () => (
    <header style={{ 
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
      padding: '16px 32px', borderBottom: '1px solid #e2e8f0',
      background: '#fff', zIndex: 100,
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ padding: '8px', background: '#2563eb', borderRadius: '10px' }}>
          <Cpu size={24} style={{ color: '#fff' }} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: '#1e293b' }}>
            Industrial <span style={{ color: '#2563eb' }}>AI Observer</span>
          </h1>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>PREDICTIVE OPERATIONS GATEWAY</div>
        </div>
      </div>
      
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700 }}>
          <div style={{ 
            width: '8px', height: '8px', borderRadius: '50%', 
            background: livekitConnected ? '#10b981' : isConnecting ? '#fbbf24' : '#ef4444', 
            boxShadow: livekitConnected ? '0 0 8px #10b981' : isConnecting ? '0 0 8px #fbbf24' : 'none' 
          }}></div>
          <span style={{ color: '#475569' }}>
            SYSTEM {livekitConnected ? 'READY' : isConnecting ? 'CONNECTING' : 'OFFLINE'}
          </span>
        </div>
        
        <button 
          onClick={toggleSimulation}
          style={{
            background: simulationRunning ? '#fee2e2' : '#dbeafe',
            color: simulationRunning ? '#dc2626' : '#2563eb',
            border: 'none',
            borderRadius: '8px', padding: '10px 24px', fontSize: '12px', fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.2s',
          }}
        >
          {simulationRunning ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          {simulationRunning ? 'STOP SIMULATION' : 'START SIMULATION'}
        </button>
      </div>
    </header>
  );

  const renderSidebar = () => (
    <aside style={{ width: '320px', background: '#f8fafc', borderRight: '1px solid #e2e8f0', padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px', overflowY: 'auto' }}>
      
      {/* Premium Alarm Dashboard Counter Widget */}
      <div 
        className="glass-card" 
        style={{ 
          padding: '16px', 
          background: 'linear-gradient(135deg, rgba(254, 242, 242, 0.9) 0%, rgba(254, 226, 226, 0.9) 100%)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          boxShadow: '0 4px 12px rgba(239, 68, 68, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          borderRadius: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={18} style={{ color: '#dc2626' }} className="blink" />
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#991b1b', letterSpacing: '0.5px', textTransform: 'uppercase' }}>System Threat Level</span>
        </div>
        <div style={{ display: 'flex', gap: '16px' }}>
          <div style={{ flex: 1, background: '#fff', padding: '10px', borderRadius: '8px', border: '1px solid #fee2e2', textAlign: 'center' }}>
            <div style={{ fontSize: '10px', color: '#dc2626', fontWeight: 700 }}>CRITICAL</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#dc2626', marginTop: '2px' }}>{criticalCount}</div>
          </div>
          <div style={{ flex: 1, background: '#fff', padding: '10px', borderRadius: '8px', border: '1px solid #ffedd5', textAlign: 'center' }}>
            <div style={{ fontSize: '10px', color: '#ea580c', fontWeight: 700 }}>MAJOR</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#ea580c', marginTop: '2px' }}>{majorCount}</div>
          </div>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Layers size={18} style={{ color: '#2563eb' }} />
          <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#475569', letterSpacing: '0.5px' }}>Factory Inventory</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
          {devices.map((dev, i) => (
            <div 
              key={i} 
              onClick={() => {
                setSelectedDevice(dev.name);
                setPredictionReport(null);
              }}
              style={{ 
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderRadius: '10px', cursor: 'pointer',
                background: selectedDevice === dev.name ? '#fff' : 'transparent',
                border: `1px solid ${selectedDevice === dev.name ? '#2563eb' : 'transparent'}`,
                boxShadow: selectedDevice === dev.name ? '0 4px 6px -1px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.2s'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }}></div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: selectedDevice === dev.name ? '#1e293b' : '#64748b' }}>{dev.name}</div>
                </div>
                <ChevronRight size={14} style={{ color: selectedDevice === dev.name ? '#2563eb' : '#94a3b8' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Bell size={18} style={{ color: '#ef4444' }} />
          <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#475569', letterSpacing: '0.5px' }}>Active Alarms</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '250px', overflowY: 'auto' }}>
          {alarms.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#94a3b8', fontStyle: 'italic' }}>No active alarms.</div>
          ) : (
            alarms.map((alarm, i) => (
              <div key={i} style={{ padding: '12px', borderRadius: '10px', background: '#fff', border: '1px solid #fee2e2' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#dc2626' }}>{alarm.type}</span>
                  <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: '#fee2e2', color: '#dc2626', fontWeight: 800 }}>{alarm.severity}</span>
                </div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>{alarm.device}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );

  const renderTabContent = () => {
    if (activeTab === 'telemetry') {
      const keys = Object.keys(telemetry);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Telemetry Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#1e293b' }}>
                {selectedDevice} <span style={{ color: '#2563eb', fontSize: '16px', fontWeight: 600 }}>Active Monitor</span>
              </h2>
              <div style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>Real-time telemetry stream and predictive analytics.</div>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', background: '#dcfce7', color: '#15803d', borderRadius: '8px', fontSize: '12px', fontWeight: 700 }}>
                <Radio size={14} className="glow-active" /> LIVE DATA
              </div>
            </div>
          </div>

          {/* Telemetry Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '24px' }}>
            {keys.map((key, i) => {
              const val = telemetry[key];
              const isDangerous = (key === 'temperature' && val > TEMP_THRESHOLD) || (key === 'vibration' && val > VIB_THRESHOLD);
              return (
                <div key={i} style={{ 
                  padding: '24px', borderRadius: '16px', background: '#fff', border: `1px solid ${isDangerous ? '#fecaca' : '#e2e8f0'}`,
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', position: 'relative', overflow: 'hidden'
                }}>
                  {isDangerous && <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', background: '#ef4444' }}></div>}
                  <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>{key}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                    <div style={{ fontSize: '32px', fontWeight: 800, color: isDangerous ? '#ef4444' : '#1e293b' }}>{val}</div>
                    <div style={{ fontSize: '14px', color: '#94a3b8', fontWeight: 600 }}>{key === 'temperature' ? '°C' : key === 'vibration' ? 'Gs' : ''}</div>
                  </div>
                  {isDangerous && <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '8px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}><AlertTriangle size={12} /> CRITICAL LIMIT</div>}
                </div>
              );
            })}
          </div>

          {/* Prediction Report */}
          {predictionReport && (
            <div style={{ padding: '32px', background: '#f0f9ff', borderRadius: '24px', border: '2px solid #bae6fd', position: 'relative' }}>
              <button onClick={() => setPredictionReport(null)} style={{ position: 'absolute', top: '24px', right: '24px', border: 'none', background: 'transparent', cursor: 'pointer', color: '#0369a1', fontSize: '18px' }}>✕</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                <RefreshCw size={24} style={{ color: '#0284c7' }} />
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#0c4a6e' }}>What-If Scenario Result: {predictionReport.target_metric.toUpperCase()}</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' }}>
                <div style={{ padding: '20px', background: '#fff', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <div style={{ fontSize: '11px', color: '#0369a1', fontWeight: 800, textTransform: 'uppercase' }}>Projected Peak</div>
                  <div style={{ fontSize: '32px', fontWeight: 800, color: '#0c4a6e', marginTop: '4px' }}>{predictionReport.metrics_summary.peak_value}</div>
                  <div style={{ fontSize: '12px', color: '#0284c7', marginTop: '4px' }}>Confidence: {predictionReport.metrics_summary.confidence_p90_at_peak} (p90)</div>
                </div>
                <div style={{ padding: '20px', background: '#fff', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <div style={{ fontSize: '11px', color: '#0369a1', fontWeight: 800, textTransform: 'uppercase' }}>Occurrence Time</div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#0c4a6e', marginTop: '12px' }}>{new Date(predictionReport.metrics_summary.peak_time).toLocaleTimeString()}</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{new Date(predictionReport.metrics_summary.peak_time).toLocaleDateString()}</div>
                </div>
                <div style={{ padding: '20px', background: '#fff', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                  <div style={{ fontSize: '11px', color: '#0369a1', fontWeight: 800, textTransform: 'uppercase' }}>Next Cycle</div>
                  <div style={{ fontSize: '32px', fontWeight: 800, color: '#0c4a6e', marginTop: '4px' }}>{predictionReport.metrics_summary.recurrence_period_hours} <span style={{ fontSize: '16px' }}>HRS</span></div>
                  <div style={{ fontSize: '12px', color: '#0284c7', marginTop: '4px' }}>{predictionReport.metrics_summary.peak_detected ? 'Harmonic Recurrence' : 'Single Event'}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeTab === 'alarms') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#1e293b' }}>Alarms Explorer</h2>
            <div style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>Query, acknowledge, and resolve active system alarms dynamically.</div>
          </div>

          {/* Search / Filter Bar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', background: '#f8fafc', padding: '16px', borderRadius: '12px', border: '1px solid #e2e8f0', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Severity</label>
              <select 
                value={alarmSeverityFilter} 
                onChange={(e) => setAlarmSeverityFilter(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', background: '#fff', outline: 'none' }}
              >
                <option value="">All Severities</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="MAJOR">MAJOR</option>
                <option value="MINOR">MINOR</option>
                <option value="WARNING">WARNING</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Status</label>
              <select 
                value={alarmStatusFilter} 
                onChange={(e) => setAlarmStatusFilter(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', background: '#fff', outline: 'none' }}
              >
                <option value="">All Statuses</option>
                <option value="ACTIVE_UNACK">Active Unacknowledged</option>
                <option value="ACTIVE_ACK">Active Acknowledged</option>
                <option value="CLEARED_UNACK">Cleared Unacknowledged</option>
                <option value="CLEARED_ACK">Cleared Acknowledged</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '200px' }}>
              <label style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Text Search</label>
              <div style={{ position: 'relative' }}>
                <input 
                  type="text" 
                  placeholder="Search alarm type or message..." 
                  value={alarmTextSearch}
                  onChange={(e) => setAlarmTextSearch(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px 8px 36px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', boxSizing: 'border-box', outline: 'none' }}
                />
                <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
              </div>
            </div>

            <button 
              onClick={() => {
                setAlarmPage(0);
                fetchFilteredAlarms();
              }}
              style={{
                alignSelf: 'flex-end', background: '#2563eb', color: '#fff', border: 'none',
                borderRadius: '8px', padding: '10px 20px', fontSize: '13px', fontWeight: 700,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px'
              }}
            >
              <RefreshCw size={14} /> FILTER
            </button>
          </div>

          {/* Alarms Table */}
          <div style={{ background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
            {isAlarmsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '40px', gap: '12px', color: '#64748b' }}>
                <RefreshCw size={20} className="glow-active" /> Searching ThingsBoard alarm registry...
              </div>
            ) : fetchedAlarms.length === 0 ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8', fontStyle: 'italic' }}>
                No alarms matching current filter criteria.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700 }}>CREATED TIME</th>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700 }}>ORIGINATOR</th>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700 }}>ALARM TYPE</th>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700 }}>SEVERITY</th>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700 }}>STATUS</th>
                    <th style={{ padding: '16px', color: '#64748b', fontWeight: 700, textAlign: 'right' }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {fetchedAlarms.map((alarm, idx) => {
                    const isCritical = alarm.severity === 'CRITICAL';
                    const isMajor = alarm.severity === 'MAJOR';
                    const isUnack = alarm.status.includes('UNACK');
                    const isCleared = alarm.status.includes('CLEARED');

                    return (
                      <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9', transition: 'background 0.2s' }} className="table-row-hover">
                        <td style={{ padding: '16px', color: '#475569', fontWeight: 500 }}>
                          {new Date(alarm.createdTime).toLocaleString()}
                        </td>
                        <td style={{ padding: '16px', color: '#1e293b', fontWeight: 700 }}>
                          {alarm.entityName || 'Unknown Device'}
                        </td>
                        <td style={{ padding: '16px', color: '#475569', fontWeight: 600 }}>
                          {alarm.type}
                        </td>
                        <td style={{ padding: '16px' }}>
                          <span style={{ 
                            fontSize: '10px', fontWeight: 800, padding: '4px 8px', borderRadius: '6px',
                            background: isCritical ? '#fee2e2' : isMajor ? '#ffedd5' : '#f1f5f9',
                            color: isCritical ? '#dc2626' : isMajor ? '#ea580c' : '#475569'
                          }}>
                            {alarm.severity}
                          </span>
                        </td>
                        <td style={{ padding: '16px' }}>
                          <span style={{ 
                            fontSize: '11px', fontWeight: 600,
                            color: isCleared ? '#10b981' : '#dc2626'
                          }}>
                            {alarm.status}
                          </span>
                        </td>
                        <td style={{ padding: '16px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                            {isUnack && (
                              <button 
                                onClick={() => handleAcknowledgeAlarm(alarm.id.id)}
                                style={{
                                  background: '#dbeafe', color: '#2563eb', border: 'none',
                                  padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                  cursor: 'pointer', transition: 'background 0.2s'
                                }}
                              >
                                ACK
                              </button>
                            )}
                            {!isCleared && (
                              <button 
                                onClick={() => handleClearAlarm(alarm.id.id)}
                                style={{
                                  background: '#fee2e2', color: '#dc2626', border: 'none',
                                  padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                  cursor: 'pointer', transition: 'background 0.2s'
                                }}
                              >
                                CLEAR
                              </button>
                            )}
                            {!isUnack && isCleared && (
                              <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
                                <Check size={14} /> RESOLVED
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {/* Pagination Controls */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center' }}>
            <button
              disabled={alarmPage === 0}
              onClick={() => {
                setAlarmPage(prev => Math.max(0, prev - 1));
                fetchFilteredAlarms();
              }}
              style={{
                padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1',
                background: alarmPage === 0 ? '#f1f5f9' : '#fff',
                color: alarmPage === 0 ? '#94a3b8' : '#475569',
                cursor: alarmPage === 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px', fontWeight: 600
              }}
            >
              PREV
            </button>
            <span style={{ fontSize: '13px', color: '#475569', fontWeight: 600 }}>Page {alarmPage + 1}</span>
            <button
              disabled={fetchedAlarms.length < 15}
              onClick={() => {
                setAlarmPage(prev => prev + 1);
                fetchFilteredAlarms();
              }}
              style={{
                padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1',
                background: fetchedAlarms.length < 15 ? '#f1f5f9' : '#fff',
                color: fetchedAlarms.length < 15 ? '#94a3b8' : '#475569',
                cursor: fetchedAlarms.length < 15 ? 'not-allowed' : 'pointer',
                fontSize: '12px', fontWeight: 600
              }}
            >
              NEXT
            </button>
          </div>
        </div>
      );
    }

    if (activeTab === 'diagnostics') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#1e293b' }}>Rule Engine Diagnostics</h2>
            <div style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>Debug rule chain message processing by reading telemetry event logs from custom Rule Nodes.</div>
          </div>

          {/* Node Specifier Box */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '16px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Rule Node ID (UUID)</label>
              <div style={{ display: 'flex', gap: '12px' }}>
                <input 
                  type="text" 
                  placeholder="e.g. 5d57b2ac-5f0f-488f-9e6e-bc3d81b4dc80" 
                  value={diagnosticRuleNodeId}
                  onChange={(e) => setDiagnosticRuleNodeId(e.target.value)}
                  style={{ flex: 1, padding: '12px 16px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none' }}
                />
                <button
                  onClick={fetchRuleNodeLogs}
                  disabled={isLoadingRuleLogs}
                  style={{
                    background: '#0f172a', color: '#f8fafc', border: 'none', borderRadius: '10px',
                    padding: '12px 24px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '8px', transition: 'background 0.2s'
                  }}
                >
                  {isLoadingRuleLogs ? <RefreshCw size={14} className="glow-active" /> : <Settings size={14} />} 
                  FETCH LOGS
                </button>
              </div>
            </div>
          </div>

          {/* Event Stream Terminal Output */}
          <div 
            className="terminal-box" 
            style={{ 
              height: '400px', display: 'flex', flexDirection: 'column', overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid #1e293b', background: '#1e293b' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#38bdf8', fontWeight: 800 }}>
                <Terminal size={14} /> LIVE NODE EVENT STREAM (LIMIT 15)
              </div>
              <div style={{ fontSize: '10px', color: '#64748b' }}>
                {ruleNodeLogs.length} LOGS RETRIEVED
              </div>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px', fontSize: '12px', fontFamily: '"JetBrains Mono", monospace', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {isLoadingRuleLogs ? (
                <div style={{ color: '#64748b', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <RefreshCw size={14} className="glow-active" /> Querying ThingsBoard Event log DB...
                </div>
              ) : ruleNodeLogs.length === 0 ? (
                <div style={{ color: '#475569', fontStyle: 'italic' }}>
                  No Rule Node events recorded. Enter a valid Rule Node UUID and click Fetch.
                </div>
              ) : (
                ruleNodeLogs.map((log, index) => {
                  const isSuccess = log.entityId ? true : false;
                  const type = log.type || 'UNKNOWN_EVENT';
                  const timestampStr = new Date(log.createdTime).toLocaleString();

                  return (
                    <div key={index} style={{ borderBottom: '1px solid #1e293b', paddingBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ color: '#10b981', fontWeight: 800 }}>[{timestampStr}]</span>
                        <span style={{ 
                          fontSize: '10px', padding: '2px 6px', borderRadius: '4px', fontWeight: 800,
                          background: isSuccess ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          color: isSuccess ? '#10b981' : '#ef4444'
                        }}>
                          {isSuccess ? 'SUCCESS' : 'FAILURE'}
                        </span>
                      </div>
                      <div style={{ color: '#fbbf24', fontWeight: 600, fontSize: '11px', marginBottom: '4px' }}>
                        EVENT TYPE: {type}
                      </div>
                      <div style={{ padding: '8px', background: '#090d16', borderRadius: '6px', color: '#94a3b8', wordBreak: 'break-all', fontSize: '11px' }}>
                        {JSON.stringify(log.body || log, null, 2)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      );
    }

    if (activeTab === 'entities') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#1e293b' }}>Entity Hub</h2>
            <div style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>Discover telemetry schemas, perform custom entity counts, and provision dashboards.</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            
            {/* Column 1: Schema & Counts */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Database size={18} style={{ color: '#2563eb' }} />
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: '#1e293b' }}>Entity Discovery Query</h3>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Filter Configuration (JSON)</label>
                  <textarea
                    rows={4}
                    value={entityQueryFilter}
                    onChange={(e) => setEntityQueryFilter(e.target.value)}
                    style={{ padding: '12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '12px', fontFamily: 'monospace', resize: 'vertical', outline: 'none' }}
                  />
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    onClick={handleCountEntities}
                    style={{
                      flex: 1, background: '#f1f5f9', color: '#1e293b', border: '1px solid #cbd5e1',
                      borderRadius: '8px', padding: '10px', fontSize: '12px', fontWeight: 700,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                    }}
                  >
                    <Activity size={14} /> COUNT ENTITIES
                  </button>
                  <button
                    onClick={handleFindAvailableKeys}
                    style={{
                      flex: 1, background: '#2563eb', color: '#fff', border: 'none',
                      borderRadius: '8px', padding: '10px', fontSize: '12px', fontWeight: 700,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                    }}
                  >
                    <Key size={14} /> DISCOVER KEYS
                  </button>
                </div>

                {entityCountResult !== null && (
                  <div style={{ padding: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#475569' }}>Total Matching Entities:</span>
                    <span style={{ fontSize: '18px', fontWeight: 800, color: '#2563eb' }}>{entityCountResult}</span>
                  </div>
                )}
              </div>

              {availableKeysResult && (
                <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '300px', overflowY: 'auto' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Key size={18} style={{ color: '#10b981' }} />
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: '#1e293b' }}>Telemetry & Attributes Schema</h3>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {availableKeysResult.TIME_SERIES && availableKeysResult.TIME_SERIES.length > 0 && (
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', marginBottom: '6px', textTransform: 'uppercase' }}>Timeseries Keys</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {availableKeysResult.TIME_SERIES.map((k, i) => (
                            <span key={i} style={{ fontSize: '11px', background: '#dbeafe', color: '#2563eb', padding: '4px 8px', borderRadius: '6px', fontWeight: 600 }}>{k}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {['SHARED_ATTRIBUTE', 'SERVER_ATTRIBUTE', 'CLIENT_ATTRIBUTE'].map((scope) => {
                      const keys = (availableKeysResult as any)[scope];
                      if (!keys || keys.length === 0) return null;
                      return (
                        <div key={scope}>
                          <div style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', marginBottom: '6px', textTransform: 'uppercase' }}>{scope.replace('_', ' ')}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {keys.map((k: string, i: number) => (
                              <span key={i} style={{ fontSize: '11px', background: '#f1f5f9', color: '#475569', padding: '4px 8px', borderRadius: '6px', fontWeight: 600 }}>{k}</span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Column 2: Dashboard Provisioner */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: 'fit-content' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Settings size={18} style={{ color: '#ea580c' }} />
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: '#1e293b' }}>Provision Customer Dashboard</h3>
              </div>
              <div style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.4' }}>
                Assign visibility and administration rights for an existing ThingsBoard dashboard to a designated customer ID.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Customer ID (UUID)</label>
                  <input
                    type="text"
                    placeholder="e.g. a78f9211-1311-45fe-823d-1a89c891efab"
                    value={provisionCustomerId}
                    onChange={(e) => setProvisionCustomerId(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase' }}>Dashboard ID (UUID)</label>
                  <input
                    type="text"
                    placeholder="e.g. b219c118-2e0e-43a0-8911-3abcdc829ee1"
                    value={provisionDashboardId}
                    onChange={(e) => setProvisionDashboardId(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <button
                  onClick={handleProvisionDashboard}
                  disabled={isProvisioning}
                  style={{
                    background: '#ea580c', color: '#fff', border: 'none', borderRadius: '8px',
                    padding: '12px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                  }}
                >
                  {isProvisioning ? <RefreshCw size={14} className="glow-active" /> : <Settings size={14} />} 
                  PROVISION ACCESS RIGHTS
                </button>

                {provisionStatusMsg && (
                  <div style={{ 
                    padding: '12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                    background: provisionStatusMsg.type === 'success' ? '#dcfce7' : '#fee2e2',
                    color: provisionStatusMsg.type === 'success' ? '#15803d' : '#dc2626',
                    border: `1px solid ${provisionStatusMsg.type === 'success' ? '#bbf7d0' : '#fecaca'}`
                  }}>
                    {provisionStatusMsg.text}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  const renderMainContent = () => (
    <section style={{ flex: 1, padding: '32px', display: 'flex', flexDirection: 'column', gap: '32px', overflowY: 'auto' }}>
      
      {/* Workspace Tab Navigation */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', gap: '8px', paddingBottom: '2px' }}>
        {(['telemetry', 'alarms', 'diagnostics', 'entities'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              background: activeTab === tab ? '#2563eb' : 'transparent',
              color: activeTab === tab ? '#fff' : '#64748b',
              border: 'none',
              borderRadius: '8px 8px 0 0',
              padding: '10px 20px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.2s',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {tab === 'telemetry' ? 'Telemetry Stream' :
             tab === 'alarms' ? 'Alarms Explorer' :
             tab === 'diagnostics' ? 'Rule Node Debug' :
             'Entity Hub'}
          </button>
        ))}
      </div>

      {/* Dynamic Tab Body */}
      <div style={{ flex: 1 }}>
        {renderTabContent()}
      </div>

      {/* AI Interface */}
      <div style={{ marginTop: 'auto', background: '#0f172a', borderRadius: '24px', padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Activity size={20} style={{ color: '#38bdf8' }} />
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#f8fafc', letterSpacing: '0.5px' }}>ZEPHYR NEURAL LINK</h3>
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 700 }}>AI STATUS: <span style={{ color: '#38bdf8' }}>{livekitConnected ? 'ONLINE' : 'STANDBY'}</span></div>
        </div>

        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <div 
            style={{
              width: '72px', height: '72px', borderRadius: '50%', border: 'none',
              background: livekitConnected ? '#ef4444' : '#38bdf8',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: livekitConnected ? '0 0 20px rgba(239, 68, 68, 0.4)' : '0 0 20px rgba(56, 189, 248, 0.4)',
              transition: 'all 0.3s'
            }}
          >
            {livekitConnected ? <Mic size={32} /> : <MicOff size={32} />}
          </div>

          <div style={{ flex: 1, position: 'relative' }}>
            <input 
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
              placeholder="Type a manual command..."
              style={{
                width: '100%', padding: '16px 56px 16px 24px', borderRadius: '16px',
                background: 'rgba(30, 41, 59, 0.5)', border: '1px solid #334155',
                color: '#fff', fontSize: '15px', outline: 'none'
              }}
            />
            <button 
              onClick={handleSendPrompt}
              style={{ position: 'absolute', right: '16px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: '#38bdf8' }}
            >
              <Send size={20} />
            </button>
          </div>
        </div>
        
        <div style={{ textAlign: 'center' }}>
          {livekitConnected ? (
            <div style={{ fontSize: '11px', color: '#ef4444', fontWeight: 800, letterSpacing: '2px' }} className="blink">● LIVE RECORDING ACTIVE</div>
          ) : (
            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>USE THE FLOATING MICROPHONE BUTTON TO CONNECT</div>
          )}
        </div>
      </div>
    </section>
  );

  const renderTerminal = () => (
    <section style={{ width: '400px', background: '#0f172a', borderLeft: '1px solid #1e293b', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '24px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Terminal size={18} style={{ color: '#10b981' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#f8fafc', textTransform: 'uppercase' }}>System Logs</h2>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px', fontSize: '12px', fontFamily: '"Fira Code", monospace' }}>
        {terminalLogs.map((log, i) => (
          <div key={i} style={{ marginBottom: '8px', lineHeight: '1.4' }}>
            <span style={{ color: '#475569' }}>[{log.timestamp}]</span>{' '}
            <span style={{ 
              color: log.type === 'tool_start' ? '#fbbf24' : 
                     log.type === 'tool_complete' ? '#10b981' : 
                     log.type === 'error' ? '#ef4444' : '#94a3b8' 
            }}>{log.message}</span>
          </div>
        ))}
      </div>
    </section>
  );

  const commonLayout = (
    <>
      {renderSidebar()}
      {renderMainContent()}
      {renderTerminal()}
    </>
  );

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#1e293b', overflow: 'hidden' }}>
      {renderNavbar()}

      {livekitConnected && roomToken ? (
        <LiveKitRoom
          video={false}
          audio={true}
          token={roomToken}
          serverUrl={LIVEKIT_SERVER}
          onConnected={() => addLog('status', '[LiveKit] Joined operational room')}
          onDisconnected={() => {
            addLog('status', '[LiveKit] Disconnected');
            setLivekitConnected(false);
            setRoomToken(null);
          }}
          onError={(err) => addLog('error', `[LiveKit] Error: ${err.message}`)}
          options={{
            audioCaptureDefaults: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          }}
        >
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {commonLayout}
          </div>

          {/* Core components for S2S architecture */}
          <RoomAudioRenderer />
          <MicController onToggle={handleToggleLiveMode} isActive={livekitConnected} />
        </LiveKitRoom>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {commonLayout}
          <MicController onToggle={handleToggleLiveMode} isActive={false} />
        </div>
      )}

      <style>{`
        .glow-active { animation: glow 2s infinite ease-in-out; }
        @keyframes glow {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.2); }
        }
        .blink { animation: blinker 1.5s linear infinite; }
        @keyframes blinker {
          50% { opacity: 0; }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        .table-row-hover:hover {
          background: #f8fafc !important;
        }
      `}</style>
    </div>
  );
}

function MicController({
  onToggle,
  isActive,
}: {
  onToggle: (active: boolean) => void;
  isActive: boolean;
}) {
  const { localParticipant } = useLocalParticipant();

  const handleClick = async () => {
    if (isActive) {
      await localParticipant?.setMicrophoneEnabled(false);
      onToggle(false);
    } else {
      onToggle(true);
    }
  };

  return (
    <button
      onClick={handleClick}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 64,
        height: 64,
        borderRadius: '50%',
        background: isActive ? '#ef4444' : '#38bdf8',
        border: 'none',
        cursor: 'pointer',
        fontSize: 24,
        boxShadow: isActive ? '0 0 16px rgba(239,68,68,0.6)' : '0 4px 12px rgba(0,0,0,0.3)',
        transition: 'all 0.2s ease',
        zIndex: 1000
      }}
      title={isActive ? 'Stop Live Mode' : 'Start Live Mode'}
    >
      {isActive ? '🔴' : '🎙️'}
    </button>
  );
}