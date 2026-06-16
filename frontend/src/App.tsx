// frontend/src/App.tsx
import { useState, useEffect, useRef } from 'react';
import { 
  Mic, MicOff, Send, AlertTriangle, 
  Terminal, ShieldCheck, Radio, Play, Square,
  Activity, Layers, Settings, ChevronRight, Bell, Plus, Trash2, RefreshCw
} from 'lucide-react';
import { DeviceInfo, AlarmLog, TerminalLog } from './types';

// Physical constants for UI safety flagging
const TEMP_THRESHOLD = 80.0;
const VIB_THRESHOLD = 4.0;

export default function App() {
  // Connection states
  const [wsConnected, setWsConnected] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState('Standby');
  
  // Real-time Dashboard variables
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [alarms, setAlarms] = useState<AlarmLog[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [predictionReport, setPredictionReport] = useState<any>(null);

  // What-If Simulation panel state
  const [targetMetric, setTargetMetric] = useState<string>('vibration');
  const [horizonSteps, setHorizonSteps] = useState<number>(96);
  const [interventions, setInterventions] = useState<Array<{ metric: string; action: 'scale' | 'set'; value: number }>>([]);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);

  // Chat and transcription outputs
  const [userInput, setUserInput] = useState('');
  const [transcription, setTranscription] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    { timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Industrial Copilot Zephyr initialized.' }
  ]);

  // High-performance Audio State
  const [isRecording, setIsRecording] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  // Speaker state
  const speakerContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);

  // Retrieve current active keys for the selected device
  const selectedDevObj = devices.find(d => d.name === selectedDevice);
  const telemetry = selectedDevObj?.lastTelemetry || {};
  const telemetryKeys = Object.keys(telemetry).length > 0 ? Object.keys(telemetry) : ['temperature', 'humidity', 'pressure', 'vibration'];

  // WebSocket + initial load — mount only (no dependency on selectedDevice)
  useEffect(() => {
    connectWS();
    fetchSimulationStatus();
    fetchInitialDevices();

    const alarmInterval = setInterval(() => {
      refreshAlarms();
    }, 10000);

    return () => {
      wsRef.current?.close();
      clearInterval(alarmInterval);
      stopVoiceInput();
    };
  }, []);

  // Telemetry polling — depends on selectedDevice
  useEffect(() => {
    if (!selectedDevice) return;
    refreshTelemetry();

    const telemetryInterval = setInterval(() => {
      refreshTelemetry();
    }, 5000);

    return () => {
      clearInterval(telemetryInterval);
    };
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
      
      setDevices(prev => prev.map(dev => {
        if (dev.name === selectedDevice) {
          return { ...dev, lastTelemetry: telemetryData };
        }
        return dev;
      }));
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

  // WebSocket handler [16kHz Binary Streaming]
  const connectWS = () => {
    const ws = new WebSocket('ws://localhost:9005/ws/voice');
    ws.binaryType = 'arraybuffer'; // Crucial for receiving/sending raw PCM
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      addLog('status', 'Neural link established with Zephyr Gateway.');
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const payload = JSON.parse(event.data);
        switch (payload.type) {
          case 'status':
            setGeminiStatus(payload.message);
            break;
          case 'transcription':
            setTranscription(prev => prev + payload.text);
            break;
          case 'audio_chunk':
            playAudioChunk(payload.data);
            break;
          case 'tool_start':
            addLog('tool_start', `Tool sequence: ${payload.name}()`);
            break;
          case 'tool_complete':
            addLog('tool_complete', `Response received: ${payload.name}`);
            processToolImpact(payload.name, payload.result);
            break;
          case 'turn_complete':
            setTranscription(''); // Clear for next turn
            break;
        }
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      setGeminiStatus('Reconnecting...');
      setTimeout(connectWS, 3000);
    };
  };

  // --- Voice Input Engine (16kHz Mono Int16 PCM) ---
  const startVoiceInput = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

      const source = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
      scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      scriptProcessorRef.current.onaudioprocess = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const float32Samples = event.inputBuffer.getChannelData(0);
        const int16Samples = new Int16Array(float32Samples.length);

        for (let i = 0; i < float32Samples.length; i++) {
          const s = Math.max(-1, Math.min(1, float32Samples[i]));
          int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        wsRef.current.send(int16Samples.buffer);
      };

      source.connect(scriptProcessorRef.current);
      scriptProcessorRef.current.connect(audioContextRef.current.destination);
      
      setIsRecording(true);
      addLog('info', 'Voice capture active. Streaming 16kHz PCM.');
    } catch (err: any) {
      addLog('error', `Mic failed: ${err.message}`);
    }
  };

  const stopVoiceInput = () => {
    scriptProcessorRef.current?.disconnect();
    audioContextRef.current?.close();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    setIsRecording(false);
    scriptProcessorRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;
  };

  // --- Audio Output Engine (Streaming Player) ---
  const playAudioChunk = async (base64Data: string) => {
    try {
      if (!speakerContextRef.current) {
        speakerContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const ctx = speakerContextRef.current;
      
      const binaryStr = window.atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Int16Array(len / 2);
      const view = new DataView(new Uint8Array(len).map((_, i) => binaryStr.charCodeAt(i)).buffer);
      
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = view.getInt16(i * 2, true);
      }

      const audioBuffer = ctx.createBuffer(1, bytes.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) {
        channelData[i] = bytes[i] / 32768.0;
      }

      audioQueueRef.current.push(audioBuffer);
      if (!isPlayingRef.current) {
        playNextInQueue();
      }
    } catch (e) {
      console.error('Playback error:', e);
    }
  };

  const playNextInQueue = () => {
    if (audioQueueRef.current.length === 0 || !speakerContextRef.current) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const ctx = speakerContextRef.current;
    const buffer = audioQueueRef.current.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;
    
    source.onended = () => {
      playNextInQueue();
    };
  };

  // --- What-If Predictor Client Submission ---
  const handleRunSimulation = async () => {
    if (!selectedDevice) return;
    setIsSimulating(true);
    addLog('info', `Deploying manual scenario prediction. Target: ${targetMetric}. Horizon: ${horizonSteps} steps...`);

    try {
      const payload = {
        device_name: selectedDevice,
        target_metric: targetMetric,
        prediction_horizon_steps: horizonSteps,
        interventions: interventions,
        question_type: 'peak'
      };

      const res = await fetch('http://localhost:9005/simulation/forecast_what_if', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Simulation endpoint failed.');

      const result = await res.json();
      if (result.status === 'success') {
        setPredictionReport(result);
        addLog('info', `What-If Analysis: Chronos-2 simulation complete. Value peak at ${result.metrics_summary.peak_value}`);
      } else {
        addLog('error', `What-If Analysis failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      addLog('error', `Failed to run what-if simulation: ${err.message}`);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleAddIntervention = () => {
    const availableKeys = telemetryKeys.filter(k => k !== targetMetric && !interventions.some(i => i.metric === k));
    const defaultKey = availableKeys[0] || telemetryKeys[0];
    if (!defaultKey) return;
    setInterventions(prev => [...prev, { metric: defaultKey, action: 'scale', value: 1.0 }]);
  };

  const handleRemoveIntervention = (index: number) => {
    setInterventions(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpdateIntervention = (index: number, field: string, value: any) => {
    setInterventions(prev => prev.map((item, i) => {
      if (i === index) {
        return { ...item, [field]: value };
      }
      return item;
    }));
  };

  // --- Logic Mapping ---
  const processToolImpact = (name: string, result: any) => {
    if (name === 'list_devices') {
      const fetchedNames: string[] = result.result || [];
      setDevices(fetchedNames.map(n => ({ name: n, status: 'ONLINE' })));
    } else if (name === 'get_current_telemetry') {
      const telemetryData = result;
      setDevices(prev => prev.map(dev => {
        if (dev.name === selectedDevice) return { ...dev, lastTelemetry: telemetryData };
        return dev;
      }));
    } else if (name === 'get_active_alarms') {
      const activeAlarms: any[] = result.result || [];
      setAlarms(activeAlarms.map(a => ({
        id: a.id,
        device: a.originatorName,
        type: a.type,
        severity: a.severity,
        status: a.status,
        timestamp: a.timestamp,
        details: a.details
      })));
    } else if (name === 'create_device') {
      addLog('info', `Entity registered: ${result.name} (${result.profile})`);
      fetchInitialDevices();
    } else if (name === 'forecast_what_if') {
      if (result && result.status === 'success') {
        setPredictionReport(result);
        addLog('info', `What-If Analysis: Target ${result.target_metric} prediction loaded.`);
      } else {
        addLog('error', `What-If Analysis failed: ${result?.error || 'Unknown error'}`);
      }
    }
  };

  const addLog = (type: TerminalLog['type'], message: string) => {
    setTerminalLogs(prev => [
      { timestamp: new Date().toLocaleTimeString(), type, message },
      ...prev.slice(0, 50)
    ]);
  };

  const toggleSimulation = async () => {
    try {
      const endpoint = simulationRunning ? 'stop_all' : 'start_all';
      await fetch(`http://localhost:9005/simulation/${endpoint}`, { method: 'POST' });
      setSimulationRunning(!simulationRunning);
      addLog('status', `Telemetry Ingestion ${!simulationRunning ? 'DEPLOYED' : 'HALTED'}`);
    } catch {
      addLog('error', 'Ingestion relay unreachable.');
    }
  };

  const fetchSimulationStatus = async () => {
    try {
      const res = await fetch('http://localhost:9005/simulation/status');
      const data = await res.json();
      setSimulationRunning(Object.values(data.devices).some((d: any) => d.running));
    } catch {}
  };

  const handleSendPrompt = () => {
    if (!userInput.trim() || !wsRef.current) return;
    addLog('user', userInput);
    wsRef.current.send(JSON.stringify({ type: 'text', text: userInput }));
    setUserInput('');
  };

  // --- Sub-render Methods (Clean, Modular Code) ---

  const renderNavbar = () => (
    <header style={{ 
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
      padding: '16px 40px', borderBottom: '1px solid #e2e8f0',
      background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(10px)', zIndex: 100,
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ padding: '8px', background: 'rgba(37, 99, 235, 0.08)', borderRadius: '12px' }}>
          <Activity size={24} style={{ color: '#2563eb' }} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '0.5px', color: '#0f172a' }}>
            ThingsBoard <span style={{ color: '#2563eb', fontWeight: 500 }}>Industrial Copilot</span>
          </h1>
          <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px', fontWeight: 600 }}>v2.5 // UNIVERSAL CHRONOS ENGINE</div>
        </div>
      </div>
      
      <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontWeight: 700 }}>
          <Radio size={12} className={wsConnected ? 'glow-active' : ''} style={{ color: wsConnected ? '#2563eb' : '#ef4444' }} />
          <span style={{ color: '#475569' }}>LINK: {wsConnected ? 'SECURE' : 'DISCONNECTED'}</span>
        </div>
        
        <button 
          onClick={toggleSimulation}
          style={{
            background: simulationRunning ? '#fee2e2' : '#dbeafe',
            color: simulationRunning ? '#dc2626' : '#2563eb',
            border: 'none',
            borderRadius: '8px', padding: '8px 20px', fontSize: '12px', fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.2s',
            boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
          }}
        >
          {simulationRunning ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
          {simulationRunning ? 'STOP SIMULATION' : 'ENGAGE SIMULATION'}
        </button>
      </div>
    </header>
  );

  const renderFleetDiscovery = () => (
    <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <Layers size={18} style={{ color: '#2563eb' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#0f172a', letterSpacing: '0.5px' }}>Fleet Inventory</h2>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {devices.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>Scanning tenant workspace...</div>
        ) : (
          devices.map((dev, i) => (
            <div 
              key={i} 
              onClick={() => {
                setSelectedDevice(dev.name);
                setPredictionReport(null);
              }}
              style={{ 
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px', borderRadius: '12px', cursor: 'pointer',
                background: selectedDevice === dev.name ? 'rgba(37, 99, 235, 0.08)' : 'rgba(241, 245, 249, 0.5)',
                border: `1px solid ${selectedDevice === dev.name ? '#2563eb' : 'rgba(226, 232, 240, 0.8)'}`,
                transition: 'all 0.2s'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#1e293b' }}>{dev.name}</div>
                  <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 500 }}>{dev.type || 'Sensor Node'}</div>
                </div>
              </div>
              <ChevronRight size={14} style={{ color: selectedDevice === dev.name ? '#2563eb' : '#94a3b8' }} />
            </div>
          ))
        )}
      </div>
    </div>
  );

  const renderDiagnostics = () => (
    <div className="glass-card" style={{ height: '260px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <Settings size={18} style={{ color: '#475569' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#0f172a', letterSpacing: '0.5px' }}>Node Diagnostic Hub</h2>
      </div>
      <div style={{ fontSize: '12px', color: '#475569', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
        <div style={{ fontSize: '9px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '4px' }}>Demo Metrics</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 500 }}>
          <span>Memory Allocated</span>
          <span style={{ color: '#0f172a', fontWeight: 700 }}>1.2GB / 4.0GB</span>
        </div>
        <div style={{ width: '100%', height: '6px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
          <div style={{ width: '30%', height: '100%', background: '#2563eb', borderRadius: '4px' }}></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontWeight: 500 }}>
          <span>Inference Delay (CPU)</span>
          <span style={{ color: '#10b981', fontWeight: 700 }}>142ms</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 500 }}>
          <span>Network Telemetry Bandwidth</span>
          <span style={{ color: '#0f172a', fontWeight: 700 }}>2.4 MB/s</span>
        </div>
      </div>
    </div>
  );

  const renderTelemetryOverlook = () => {
    const keys = Object.keys(telemetry);
    return (
      <div className="glass-card" style={{ minHeight: '260px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <ShieldCheck size={20} style={{ color: '#10b981' }} />
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
              Telemetric Monitoring: <span style={{ color: '#2563eb' }}>{selectedDevice}</span>
            </h2>
          </div>
          <div style={{ fontSize: '10px', padding: '4px 10px', background: '#dcfce7', color: '#15803d', borderRadius: '6px', fontWeight: 700 }}>
            LIVE STREAM
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px' }}>
          {keys.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
              Connecting to telemetry pipeline...
            </div>
          ) : (
            keys.map((key, i) => {
              const val = telemetry[key];
              const isDangerous = (key === 'temperature' && val > TEMP_THRESHOLD) || (key === 'vibration' && val > VIB_THRESHOLD);
              const units: any = { temperature: '°C', humidity: '%', pressure: ' Bar', vibration: ' Gs' };

              return (
                <div key={i} style={{ 
                  padding: '16px', borderRadius: '12px', background: 'rgba(241, 245, 249, 0.5)', 
                  border: `1px solid ${isDangerous ? 'rgba(239, 68, 68, 0.2)' : 'rgba(226, 232, 240, 0.8)'}`,
                  textAlign: 'center', transition: 'all 0.2s'
                }}>
                  <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '6px', fontWeight: 700, letterSpacing: '0.5px' }}>{key}</div>
                  <div style={{ fontSize: '28px', fontWeight: 800, color: isDangerous ? '#dc2626' : '#0f172a' }}>
                    {val}
                    <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748b', marginLeft: '2px' }}>{units[key] || ''}</span>
                  </div>
                  {isDangerous && <div style={{ fontSize: '9px', color: '#dc2626', marginTop: '4px', fontWeight: 700 }}>WARNING LIMIT CROSS</div>}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  const renderWhatIfConsole = () => (
    <div className="glass-card" style={{ padding: '24px', background: 'rgba(255, 255, 255, 0.95)', border: '1px solid rgba(226, 232, 240, 0.9)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <RefreshCw size={18} style={{ color: '#2563eb' }} />
        <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>What-If Simulation Console</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <div>
          <label style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Target Prediction Metric</label>
          <select 
            value={targetMetric} 
            onChange={(e) => setTargetMetric(e.target.value)}
            style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff', outline: 'none', fontSize: '13px', color: '#0f172a' }}
          >
            {telemetryKeys.map(k => (
              <option key={k} value={k}>{k.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', display: 'block', marginBottom: '6px' }}>Horizon Window: {horizonSteps} steps ({Math.round(horizonSteps*15/60)} hrs)</label>
          <input 
            type="range" 
            min="24" 
            max="192" 
            step="24"
            value={horizonSteps} 
            onChange={(e) => setHorizonSteps(parseInt(e.target.value))}
            style={{ width: '100%', marginTop: '12px', accentColor: '#2563eb' }}
          />
        </div>
      </div>

      {/* Interventions Section */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase' }}>Covariate Interventions</span>
          <button 
            onClick={handleAddIntervention}
            style={{ background: '#dbeafe', color: '#2563eb', border: 'none', padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <Plus size={12} /> Add Metric
          </button>
        </div>

        {interventions.length === 0 ? (
          <div style={{ padding: '16px', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '10px', textAlign: 'center', fontSize: '12px', color: '#64748b' }}>
            No interventions added. Run will execute standard baseline forecast.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {interventions.map((intv, index) => (
              <div key={index} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: '#f8fafc', padding: '10px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <select 
                  value={intv.metric} 
                  onChange={(e) => handleUpdateIntervention(index, 'metric', e.target.value)}
                  style={{ flex: 1.2, padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', fontSize: '12px' }}
                >
                  {telemetryKeys.filter(k => k !== targetMetric).map(k => (
                    <option key={k} value={k}>{k.toUpperCase()}</option>
                  ))}
                </select>

                <select 
                  value={intv.action} 
                  onChange={(e) => handleUpdateIntervention(index, 'action', e.target.value)}
                  style={{ flex: 1, padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', fontSize: '12px' }}
                >
                  <option value="scale">SCALE (Multiplier)</option>
                  <option value="set">SET (Constant)</option>
                </select>

                <input 
                  type="number" 
                  step="0.05"
                  value={intv.value} 
                  onChange={(e) => handleUpdateIntervention(index, 'value', parseFloat(e.target.value) || 0.0)}
                  style={{ width: '80px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '12px', textAlign: 'center' }}
                />

                <button 
                  onClick={() => handleRemoveIntervention(index)}
                  style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button 
        onClick={handleRunSimulation}
        disabled={isSimulating}
        style={{
          width: '100%',
          padding: '12px',
          background: '#2563eb',
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          fontWeight: 700,
          cursor: isSimulating ? 'not-allowed' : 'pointer',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.2)'
        }}
      >
        {isSimulating ? 'SIMULATING CHRONOS-2...' : 'RUN SCENARIO SIMULATION'}
      </button>
    </div>
  );

  const renderPredictionReport = () => {
    if (!predictionReport) return null;
    const isVibration = predictionReport.target_metric === 'vibration';
    const isTemperature = predictionReport.target_metric === 'temperature';
    const unit = isVibration ? ' Gs' : isTemperature ? '°C' : '';

    return (
      <div className="glass-card" style={{ padding: '24px', background: 'rgba(37, 99, 235, 0.04)', border: '1px solid rgba(37, 99, 235, 0.15)', position: 'relative' }}>
        <button 
          onClick={() => setPredictionReport(null)}
          style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}
        >
          ✕
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Activity size={18} style={{ color: '#2563eb' }} />
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#0f172a', letterSpacing: '0.5px' }}>
            What-If Prediction Analytics: <span style={{ color: '#2563eb' }}>{predictionReport.target_metric}</span>
          </h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <div style={{ padding: '14px', background: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.02)' }}>
            <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Projected Peak</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>
              {predictionReport.metrics_summary.peak_value}
              <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 500 }}>{unit}</span>
            </div>
            <div style={{ fontSize: '10px', color: '#2563eb', marginTop: '4px', fontWeight: 600 }}>p90 upper: {predictionReport.metrics_summary.confidence_p90_at_peak}</div>
          </div>

          <div style={{ padding: '14px', background: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.02)' }}>
            <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Time of Peak</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', marginTop: '6px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
              {new Date(predictionReport.metrics_summary.peak_time).toLocaleTimeString()}
            </div>
            <div style={{ fontSize: '10px', color: '#64748b', marginTop: '6px', fontWeight: 500 }}>
              {new Date(predictionReport.metrics_summary.peak_time).toLocaleDateString()}
            </div>
          </div>

          <div style={{ padding: '14px', background: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.02)' }}>
            <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Recurrence Cycle</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>
              {predictionReport.metrics_summary.recurrence_period_hours}
              <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 500 }}> hrs</span>
            </div>
            <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px', fontWeight: 500 }}>
              {predictionReport.metrics_summary.peak_detected ? 'Periodic Peaks' : 'Single Peak Horizon'}
            </div>
          </div>
        </div>

        {predictionReport.metrics_summary.crossing_detected && (
          <div style={{ marginTop: '16px', padding: '12px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <AlertTriangle size={16} style={{ color: '#dc2626' }} />
            <span style={{ fontSize: '12px', color: '#b91c1c', fontWeight: 600 }}>
              Safety Flag: Excursion threshold crossed at {new Date(predictionReport.metrics_summary.crossing_time).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    );
  };

  const renderAIInterface = () => (
    <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 700 }}>STATUS: <span style={{ color: wsConnected ? '#2563eb' : '#dc2626' }}>{geminiStatus.toUpperCase()}</span></div>
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: wsConnected ? '#2563eb' : '#dc2626' }}></div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ margin: '0 0 10px 0', fontSize: '12px', textTransform: 'uppercase', color: '#475569', letterSpacing: '0.5px', fontWeight: 700 }}>Neural Audio Interface</h2>
        <div style={{ 
          flex: 1, minHeight: '100px', maxHeight: '180px', overflowY: 'auto', padding: '16px', 
          background: '#0f172a', borderRadius: '12px', border: '1px solid #cbd5e1',
          fontSize: '15px', lineHeight: '1.5', color: '#f8fafc', fontWeight: 300
        }}>
          {transcription ? (
            <span>{transcription}</span>
          ) : (
            <span style={{ color: '#64748b', fontStyle: 'italic', fontSize: '13px' }}>Waiting for speech query...</span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button 
          onMouseDown={startVoiceInput}
          onMouseUp={stopVoiceInput}
          className={isRecording ? 'glow-record' : ''}
          style={{
            width: '60px', height: '60px', borderRadius: '16px',
            background: isRecording ? '#dc2626' : '#2563eb',
            color: '#fff', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s',
            boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.2)'
          }}
        >
          {isRecording ? <MicOff size={24} /> : <Mic size={24} />}
        </button>

        <div style={{ flex: 1, position: 'relative' }}>
          <input 
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
            placeholder="Manual query intervention..."
            style={{
              width: '100%', padding: '14px 44px 14px 16px', borderRadius: '12px',
              background: '#ffffff', border: '1px solid #cbd5e1', color: '#0f172a',
              fontSize: '13px', outline: 'none', boxSizing: 'border-box'
            }}
          />
          <button 
            onClick={handleSendPrompt}
            style={{
              position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', border: 'none', cursor: 'pointer', color: '#2563eb'
            }}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
      <div style={{ textAlign: 'center', fontSize: '10px', color: '#64748b', fontWeight: 600 }}>HOLD BUTTON TO VERBALLY CONVERSE WITH ZEPHYR</div>
    </div>
  );

  const renderAlarms = () => (
    <div className="glass-card" style={{ flex: 1.5, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <Bell size={18} style={{ color: '#dc2626' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#0f172a', letterSpacing: '0.5px' }}>Active Alarms</h2>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {alarms.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: '#64748b', fontSize: '12px' }}>No active alarms detected. All systems clear.</div>
        ) : (
          alarms.map((alarm, i) => (
            <div key={i} style={{ 
              padding: '14px', borderRadius: '10px', background: 'rgba(239, 68, 68, 0.04)',
              border: '1px solid rgba(239, 68, 68, 0.1)', marginBottom: '8px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#b91c1c' }}>{alarm.type}</span>
                <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: '#dc2626', color: '#fff', fontWeight: 700 }}>{alarm.severity}</span>
              </div>
              <div style={{ fontSize: '11px', color: '#475569', fontWeight: 500 }}>{alarm.device}</div>
              <div style={{ fontSize: '9px', color: '#64748b', marginTop: '4px', fontWeight: 600 }}>{new Date(alarm.timestamp).toLocaleTimeString()}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const renderLogs = () => (
    <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <Terminal size={18} style={{ color: '#10b981' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, textTransform: 'uppercase', color: '#0f172a', letterSpacing: '0.5px' }}>Zephyr Copilot Logs</h2>
      </div>
      <div className="terminal-box" style={{ flex: 1, overflowY: 'auto', padding: '16px', fontSize: '11px' }}>
        {terminalLogs.map((log, i) => (
          <div key={i} style={{ marginBottom: '6px', fontFamily: 'monospace' }}>
            <span style={{ color: '#64748b', marginRight: '6px' }}>[{log.timestamp}]</span>
            <span style={{ 
              color: log.type === 'tool_start' ? '#fbbf24' : 
                     log.type === 'tool_complete' ? '#34d399' : 
                     log.type === 'error' ? '#f87171' : '#cbd5e1' 
            }}>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {renderNavbar()}

      {/* Main Responsive Grid Layout */}
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: '360px 1fr 360px', gap: '24px', padding: '24px', overflow: 'hidden' }}>
        
        {/* LEFT SECTION */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {renderFleetDiscovery()}
          {renderDiagnostics()}
        </section>

        {/* CENTER SECTION */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {renderTelemetryOverlook()}
          {renderWhatIfConsole()}
          {renderPredictionReport()}
          {renderAIInterface()}
        </section>

        {/* RIGHT SECTION */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {renderAlarms()}
          {renderLogs()}
        </section>

      </main>
    </div>
  );
}
