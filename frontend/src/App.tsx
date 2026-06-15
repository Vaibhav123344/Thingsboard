// frontend/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, MicOff, Send, Cpu, AlertTriangle, Disc, 
  Terminal, ShieldCheck, FileText, Database, Radio, Play, Square,
  Activity, Layers, Settings, ChevronRight, Bell
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

  // Initialize
  useEffect(() => {
    connectWS();
    fetchSimulationStatus();
    fetchInitialDevices();

    const telemetryInterval = setInterval(() => {
      if (selectedDevice) refreshTelemetry();
    }, 5000);

    const alarmInterval = setInterval(() => {
      refreshAlarms();
    }, 10000);

    return () => {
      wsRef.current?.close();
      clearInterval(telemetryInterval);
      clearInterval(alarmInterval);
      stopVoiceInput();
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
      const telemetry = await res.json();
      
      setDevices(prev => prev.map(dev => {
        if (dev.name === selectedDevice) {
          return { ...dev, lastTelemetry: telemetry };
        }
        return dev;
      }));
    } catch {}
  };

  const refreshAlarms = async () => {
    // This is often triggered by tools, but we poll as fallback
    if (wsRef.current?.readyState === WebSocket.OPEN) {
       // Optional: request update via tool-like message if needed
    }
  };

  // WebSocket handler [Updated for 16kHz Binary Streaming]
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

      // Force 16,000Hz (Gemini native requirement)
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

      const source = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
      
      // buffer size 4096 is stable for most browsers
      scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      scriptProcessorRef.current.onaudioprocess = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const float32Samples = event.inputBuffer.getChannelData(0);
        const int16Samples = new Int16Array(float32Samples.length);

        // Convert Float32 -> Int16 PCM
        for (let i = 0; i < float32Samples.length; i++) {
          const s = Math.max(-1, Math.min(1, float32Samples[i]));
          int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send raw binary buffer down the socket
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

  // --- Logic Mapping ---
  const processToolImpact = (name: string, result: any) => {
    if (name === 'list_devices') {
      const fetchedNames: string[] = result.result || [];
      setDevices(fetchedNames.map(n => ({ name: n, status: 'ONLINE' })));
    } else if (name === 'get_current_telemetry') {
      const telemetry = result;
      setDevices(prev => prev.map(dev => {
        if (dev.name === selectedDevice) return { ...dev, lastTelemetry: telemetry };
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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* 1. Industrial Navbar */}
      <header style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
        padding: '16px 40px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        background: 'rgba(2, 6, 23, 0.9)', backdropFilter: 'blur(10px)', zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '8px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '12px' }}>
            <Activity size={24} style={{ color: '#10b981' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>
              Thingsboard<span style={{ color: '#10b981', fontWeight: 400 }}>Industrial Bot</span>
            </h1>
            <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>v3.1.2-ALPHA // NEURAL-BRIDGE ACTIVE</div>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontWeight: 600 }}>
              <Radio size={12} className={wsConnected ? 'glow-active' : ''} style={{ color: wsConnected ? '#10b981' : '#ef4444' }} />
              <span style={{ color: '#94a3b8' }}>GATEWAY: {wsConnected ? 'SECURE' : 'OFFLINE'}</span>
            </div>
          </div>
          
          <button 
            onClick={toggleSimulation}
            style={{
              background: simulationRunning ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
              color: simulationRunning ? '#f87171' : '#10b981',
              border: `1px solid ${simulationRunning ? '#ef4444' : '#10b981'}`,
              borderRadius: '8px', padding: '8px 20px', fontSize: '12px', fontWeight: 'bold',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.3s'
            }}
          >
            {simulationRunning ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            {simulationRunning ? 'SHUTDOWN SIM' : 'ENGAGE SIM'}
          </button>
        </div>
      </header>

      {/* 2. Main Grid */}
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: '400px 1fr 400px', gap: '24px', padding: '30px', overflow: 'hidden' }}>
        
        {/* LEFT: System Inventory & Navigation */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <Layers size={18} style={{ color: '#3b82f6' }} />
              <h2 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>Fleet Discovery</h2>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {devices.map((dev, i) => (
                <div 
                  key={i} 
                  onClick={() => setSelectedDevice(dev.name)}
                  style={{ 
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px', borderRadius: '12px', cursor: 'pointer',
                    background: selectedDevice === dev.name ? 'rgba(59, 130, 246, 0.15)' : 'rgba(30, 41, 59, 0.4)',
                    border: `1px solid ${selectedDevice === dev.name ? '#3b82f6' : 'transparent'}`,
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }}></div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>{dev.name}</div>
                      <div style={{ fontSize: '10px', color: '#64748b' }}>{dev.type || 'Generic Sensor'}</div>
                    </div>
                  </div>
                  <ChevronRight size={14} style={{ color: selectedDevice === dev.name ? '#3b82f6' : '#334155' }} />
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card" style={{ height: '280px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <Settings size={18} style={{ color: '#94a3b8' }} />
              <h2 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>System Diagnostics</h2>
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Memory Allocation</span>
                <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>1.2GB / 4.0GB</span>
              </div>
              <div style={{ width: '100%', height: '4px', background: '#1e293b', borderRadius: '2px' }}>
                <div style={{ width: '30%', height: '100%', background: '#3b82f6', borderRadius: '2px' }}></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Inference Latency</span>
                <span style={{ color: '#10b981', fontWeight: 'bold' }}>142ms</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Telemetry Bandwidth</span>
                <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>2.4 MB/s</span>
              </div>
            </div>
          </div>
        </section>

        {/* CENTER: Main Operations & AI Interaction */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Telemetry Visualizer */}
          <div className="glass-card" style={{ minHeight: '300px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <ShieldCheck size={20} style={{ color: '#10b981' }} />
                <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold' }}>Telemetric Overlook: <span style={{ color: '#10b981' }}>{selectedDevice}</span></h2>
              </div>
              <div style={{ fontSize: '11px', padding: '4px 10px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', borderRadius: '6px', fontWeight: 'bold' }}>LIVE DATA FEED</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }}>
              {(() => {
                const dev = devices.find(d => d.name === selectedDevice);
                const telemetry = dev?.lastTelemetry || {};
                const keys = Object.keys(telemetry);

                if (keys.length === 0) return <div style={{ gridColumn: '1 / -1', padding: '60px', textAlign: 'center', color: '#475569' }}>Connecting to physical node data...</div>;

                return keys.map((key, i) => {
                  const val = telemetry[key];
                  const isDangerous = (key === 'temperature' && val > TEMP_THRESHOLD) || (key === 'vibration' && val > VIB_THRESHOLD);
                  const colors: any = { temperature: '#ef4444', humidity: '#3b82f6', pressure: '#10b981', vibration: '#f59e0b' };
                  const units: any = { temperature: '°C', humidity: '%', pressure: ' Bar', vibration: ' Gs' };

                  return (
                    <div key={i} style={{ 
                      padding: '20px', borderRadius: '16px', background: 'rgba(2, 6, 23, 0.4)', 
                      border: `1px solid ${isDangerous ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`,
                      textAlign: 'center', transition: 'all 0.3s'
                    }}>
                      <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '1px' }}>{key}</div>
                      <div style={{ fontSize: '32px', fontWeight: 800, color: isDangerous ? '#ef4444' : '#f8fafc' }}>
                        {val}<span style={{ fontSize: '14px', fontWeight: 400, color: '#64748b', marginLeft: '4px' }}>{units[key] || ''}</span>
                      </div>
                      {isDangerous && <div style={{ fontSize: '9px', color: '#ef4444', marginTop: '4px', fontWeight: 'bold' }}>EXCEEDS NOMINAL RANGE</div>}
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* AI Interface */}
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, right: 0, padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#64748b' }}>STATUS: <span style={{ color: wsConnected ? '#10b981' : '#ef4444' }}>{geminiStatus.toUpperCase()}</span></div>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: wsConnected ? '#10b981' : '#ef4444' }}></div>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <h2 style={{ margin: '0 0 16px 0', fontSize: '14px', textTransform: 'uppercase', color: '#64748b', letterSpacing: '1px' }}>Neural Interface Output</h2>
              <div style={{ 
                flex: 1, minHeight: '120px', maxHeight: '300px', overflowY: 'auto', padding: '24px', 
                background: 'rgba(0,0,0,0.3)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.03)',
                fontSize: '18px', lineHeight: '1.6', color: '#e2e8f0', fontWeight: 300
              }}>
                {transcription ? (
                  <span>{transcription}</span>
                ) : (
                  <span style={{ color: '#334155', fontStyle: 'italic' }}>Waiting for operator input...</span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <button 
                onMouseDown={startVoiceInput}
                onMouseUp={stopVoiceInput}
                className={isRecording ? 'glow-record' : ''}
                style={{
                  width: '72px', height: '72px', borderRadius: '24px',
                  background: isRecording ? '#ef4444' : '#10b981',
                  color: '#fff', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.3s'
                }}
              >
                {isRecording ? <MicOff size={32} /> : <Mic size={32} />}
              </button>

              <div style={{ flex: 1, position: 'relative' }}>
                <input 
                  type="text"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
                  placeholder="Transmit manual command query..."
                  style={{
                    width: '100%', padding: '16px 60px 16px 20px', borderRadius: '16px',
                    background: '#020617', border: '1px solid #1e293b', color: '#fff',
                    fontSize: '14px', outline: 'none', boxSizing: 'border-box'
                  }}
                />
                <button 
                  onClick={handleSendPrompt}
                  style={{
                    position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none', cursor: 'pointer', color: '#10b981'
                  }}
                >
                  <Send size={20} />
                </button>
              </div>
            </div>
            <div style={{ textAlign: 'center', fontSize: '11px', color: '#475569' }}>HOLD BUTTON FOR VOICE AUTHENTICATION AND STREAMING</div>
          </div>
        </section>

        {/* RIGHT: Alarms & Logs */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          <div className="glass-card" style={{ flex: 1.5, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <Bell size={18} style={{ color: '#ef4444' }} />
              <h2 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>Priority Alarms</h2>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {alarms.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#334155', fontSize: '12px' }}>No active priority alerts detected.</div>
              ) : (
                alarms.map((alarm, i) => (
                  <div key={i} style={{ 
                    padding: '16px', borderRadius: '12px', background: 'rgba(239, 68, 68, 0.05)',
                    border: '1px solid rgba(239, 68, 68, 0.1)', marginBottom: '10px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#f87171' }}>{alarm.type}</span>
                      <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: '#ef4444', color: '#fff' }}>{alarm.severity}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>{alarm.device}</div>
                    <div style={{ fontSize: '10px', color: '#475569', marginTop: '6px' }}>{new Date(alarm.timestamp).toLocaleTimeString()}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <Terminal size={18} style={{ color: '#10b981' }} />
              <h2 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>Zephyr Core Logs</h2>
            </div>
            <div className="terminal-box" style={{ flex: 1, overflowY: 'auto', padding: '16px', fontSize: '11px' }}>
              {terminalLogs.map((log, i) => (
                <div key={i} style={{ marginBottom: '8px' }}>
                  <span style={{ color: '#334155', marginRight: '8px' }}>[{log.timestamp}]</span>
                  <span style={{ 
                    color: log.type === 'tool_start' ? '#eab308' : 
                           log.type === 'tool_complete' ? '#10b981' : 
                           log.type === 'error' ? '#ef4444' : '#64748b' 
                  }}>{log.message}</span>
                </div>
              ))}
            </div>
          </div>

        </section>

      </main>
    </div>
  );
}
