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
  Activity, Layers, ChevronRight, Bell, RefreshCw, Cpu
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
  
  // Real-time Dashboard variables
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [alarms, setAlarms] = useState<AlarmLog[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [predictionReport, setPredictionReport] = useState<any>(null);

  // Chat and transcription outputs
  const [userInput, setUserInput] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    { timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Industrial Copilot Zephyr initialized.' }
  ]);

  const selectedDevObj = devices.find(d => d.name === selectedDevice);
  const telemetry = selectedDevObj?.lastTelemetry || {};

  useEffect(() => {
    fetchSimulationStatus();
    fetchInitialDevices();
    const alarmInterval = setInterval(() => refreshAlarms(), 10000);
    return () => clearInterval(alarmInterval);
  }, []);

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
    // TODO: Connect this to the LiveKit data channel or a separate chat endpoint if needed.
    // For now, the primary interaction is voice.
    setUserInput('');
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
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: livekitConnected ? '#10b981' : '#ef4444', boxShadow: livekitConnected ? '0 0 8px #10b981' : 'none' }}></div>
          <span style={{ color: '#475569' }}>SYSTEM {livekitConnected ? 'READY' : 'OFFLINE'}</span>
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
    <aside style={{ width: '320px', background: '#f8fafc', borderRight: '1px solid #e2e8f0', padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Layers size={18} style={{ color: '#2563eb' }} />
          <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#475569', letterSpacing: '0.5px' }}>Factory Inventory</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }}></div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: selectedDevice === dev.name ? '#1e293b' : '#64748b' }}>{dev.name}</div>
              </div>
              <ChevronRight size={14} style={{ color: selectedDevice === dev.name ? '#2563eb' : '#94a3b8' }} />
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Bell size={18} style={{ color: '#ef4444' }} />
          <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#475569', letterSpacing: '0.5px' }}>Active Alarms</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '300px', overflowY: 'auto' }}>
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

  const renderMainContent = () => {
    const keys = Object.keys(telemetry);
    return (
      <section style={{ flex: 1, padding: '32px', display: 'flex', flexDirection: 'column', gap: '32px', overflowY: 'auto' }}>
        
        {/* Telemetry Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 800, color: '#1e293b' }}>{selectedDevice} <span style={{ color: '#2563eb', fontSize: '16px', fontWeight: 600 }}>Active Monitor</span></h2>
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
            <button onClick={() => setPredictionReport(null)} style={{ position: 'absolute', top: '24px', right: '24px', border: 'none', background: 'transparent', cursor: 'pointer', color: '#0369a1' }}>✕</button>
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
            {/* The microphone button here is decorative; actual logic is in MicController via LiveKit */}
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
  };

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
      // The toggle handler handles connecting to the room.
      // Once connected, LiveKit handles the microphone based on constraints.
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