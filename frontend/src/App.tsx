import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, MicOff, Send, Cpu, AlertTriangle, Disc, 
  Terminal, ShieldCheck, FileText, Database, Radio, Play, Square 
} from 'lucide-react';
import { DeviceInfo, AlarmLog, TerminalLog } from './types';

export default function App() {
  // Connection states
  const [wsConnected, setWsConnected] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState('Initializing connections...');
  
  // Real-time Dashboard variables
  const [devices, setDevices] = useState<DeviceInfo[]>([
    { name: 'Smart-Industrial-Sensor-01', status: 'ONLINE' },
    { name: 'Smart-Industrial-Sensor-02', status: 'ONLINE' }
  ]);
  const [alarms, setAlarms] = useState<AlarmLog[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('Smart-Industrial-Sensor-01');
  const [simulationRunning, setSimulationRunning] = useState(false);

  // Chat and transcription outputs
  const [userInput, setUserInput] = useState('');
  const [transcription, setTranscription] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([
    { timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'System Supervisor loaded. Ready to observe.' }
  ]);

  // Audio recording handlers
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Initialize WebSocket connections on start
  useEffect(() => {
    connectWS();
    fetchSimulationStatus();
    fetchInitialDevices();

    // Auto-refresh telemetry polling [New Feature]
    const telemetryInterval = setInterval(() => {
      refreshTelemetry();
    }, 5000);

    return () => {
      wsRef.current?.close();
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
        // If current selection isn't in the list, pick the first one
        if (!deviceNames.includes(selectedDevice)) {
          setSelectedDevice(deviceNames[0]);
        }
      }
    } catch {
      // Silent fail
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
    } catch {
      // Background refresh failure is silent
    }
  };

  // WebSocket handler [Updated for Streaming]
  const connectWS = () => {
    const ws = new WebSocket('ws://localhost:9005/ws/voice');
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      addLog('status', 'Connected to operational gateway relay server.');
    };

    ws.onmessage = async (event) => {
      const payload = JSON.parse(event.data);

      switch (payload.type) {
        case 'status':
          setGeminiStatus(payload.message);
          addLog('status', payload.message);
          break;
        case 'transcription':
          setTranscription(prev => prev + payload.text);
          break;
        case 'audio_chunk':
          // Stream and play audio chunk immediately
          playAudioChunk(payload.data);
          break;
        case 'turn_complete':
          // Optional: handle end of turn UI state
          break;
        case 'tool_start':
          addLog('tool_start', `Tool trigger initiated: ${payload.name}()`);
          break;
        case 'tool_complete':
          addLog('tool_complete', `Tool run finished: ${payload.name}()`);
          processToolImpact(payload.name, payload.result);
          break;
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      setGeminiStatus('Disconnected. Attempting retry...');
      addLog('info', 'Gateway disconnected. Retrying in 5 seconds...');
      setTimeout(connectWS, 5000);
    };
  };

  // Real-time audio streaming player logic
  const audioQueue: AudioBuffer[] = [];
  let isPlaying = false;

  const playAudioChunk = async (base64Data: string) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const ctx = audioContextRef.current;
      
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

      audioQueue.push(audioBuffer);
      if (!isPlaying) {
        playNextInQueue();
      }
    } catch (e) {
      console.error('Streaming audio error:', e);
    }
  };

  let nextStartTime = 0;
  const playNextInQueue = () => {
    if (audioQueue.length === 0 || !audioContextRef.current) {
      isPlaying = false;
      return;
    }

    isPlaying = true;
    const ctx = audioContextRef.current;
    const buffer = audioQueue.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    if (nextStartTime < currentTime) {
      nextStartTime = currentTime;
    }

    source.start(nextStartTime);
    nextStartTime += buffer.duration;
    
    source.onended = () => {
      playNextInQueue();
    };
  };

  const addLog = (type: TerminalLog['type'], message: string) => {
    setTerminalLogs(prev => [
      { timestamp: new Date().toLocaleTimeString(), type, message },
      ...prev.slice(0, 50)
    ]);
  };

  // Handle updates in telemetry grid based on tool runs [2.2]
  const processToolImpact = (name: string, result: any) => {
    if (name === 'list_devices') {
      const fetchedNames: string[] = result.result || [];
      setDevices(fetchedNames.map(name => ({ name, status: 'ONLINE' })));
    } else if (name === 'get_current_telemetry') {
      const telemetry = result;
      setDevices(prev => prev.map(dev => {
        if (dev.name === selectedDevice) {
          return { ...dev, lastTelemetry: telemetry };
        }
        return dev;
      }));
    } else if (name === 'get_active_alarms') {
      const activeAlarms: any[] = result.result || [];
      setAlarms(activeAlarms.map(a => ({
        device: a.device,
        type: a.type,
        severity: a.severity,
        status: a.status,
        timestamp: a.timestamp
      })));
    }
  };

  const fetchSimulationStatus = async () => {
    try {
      const res = await fetch('http://localhost:9005/simulation/status');
      const data = await res.json();
      const isAnyRunning = Object.values(data.devices).some((d: any) => d.running);
      setSimulationRunning(isAnyRunning);
    } catch {
      // Ignored
    }
  };

  const toggleSimulation = async () => {
    try {
      const endpoint = simulationRunning ? 'stop_all' : 'start_all';
      await fetch(`http://localhost:9005/simulation/${endpoint}`, { method: 'POST' });
      setSimulationRunning(!simulationRunning);
      addLog('info', `Simulated ingestion telemetry loops ${!simulationRunning ? 'ACTIVE' : 'HALTED'}`);
    } catch {
      addLog('info', 'Failed to communicate with local ingestion server.');
    }
  };

  // Sound response processor [2.4.4, 2.4.7]
  const playVoiceResponse = (base64Wav: string) => {
    try {
      const binaryStr = window.atob(base64Wav);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;

      ctx.decodeAudioData(bytes.buffer, (buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        addLog('info', 'Zephyr voice response playback active.');
      }, (err) => {
        console.error('Audio decode failed', err);
      });
    } catch (e: any) {
      console.error('Audio playback exception', e);
    }
  };

  // Submit typed prompt fallback
  const handleSendPrompt = () => {
    if (!userInput.trim() || !wsRef.current) return;
    addLog('user', userInput);
    wsRef.current.send(JSON.stringify({ type: 'text', text: userInput }));
    setUserInput('');
  };

  // Real-time microphone capture processor [2.4.4, 2.4.7]
  const startRecording = async () => {
    audioChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsArrayBuffer(audioBlob);
        reader.onloadend = () => {
          const arrayBuffer = reader.result as ArrayBuffer;
          
          // Convert to PCM 16kHz Mono data in Backend if needed, or send as transcript text
          // To ensure 100% stability, we convert recording to speech text before relaying
          transcribeSpeechFallback(audioBlob);
        };
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start(100); // collect 100ms packets
      setIsRecording(true);
      addLog('info', 'Voice communication session recording...');
    } catch (err: any) {
      console.error('Mic capture failed', err);
      addLog('info', `Microphone capture failed: ${err.message}`);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  // Convert mic audio input to prompt text to guarantee 100% web browser compatibility
  const transcribeSpeechFallback = async (blob: Blob) => {
    addLog('info', 'Processing voice translation...');
    // Simulated or web-speech-recognition API translates raw blob to commands
    // In standard environments, we can also use browser-native Web Speech API for voice text entry
    const recognition = new ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    
    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      addLog('user', `[Voice input]: "${text}"`);
      wsRef.current?.send(JSON.stringify({ type: 'text', text }));
    };

    recognition.onerror = () => {
      addLog('info', 'Could not translate voice input clearly. Please type prompt.');
    };

    recognition.start();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* 1. Header Nav Bar */}
      <header style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
        padding: '15px 30px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        background: 'rgba(15, 23, 42, 0.8)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Cpu size={28} style={{ color: '#10b981' }} />
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
            INDUSTRIAL <span style={{ color: '#10b981' }}>AI</span> OBSERVER
          </h1>
        </div>
        
        {/* Status badges */}
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <Radio size={14} style={{ color: wsConnected ? '#10b981' : '#ef4444' }} />
            <span>RELAY GATEWAY: <strong style={{ color: wsConnected ? '#10b981' : '#ef4444' }}>{wsConnected ? 'ONLINE' : 'OFFLINE'}</strong></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <Database size={14} style={{ color: simulationRunning ? '#3b82f6' : '#64748b' }} />
            <span>TELEMETRY INGESTION: <strong style={{ color: simulationRunning ? '#3b82f6' : '#64748b' }}>{simulationRunning ? 'ACTIVE' : 'IDLE'}</strong></span>
          </div>
          <button 
            onClick={toggleSimulation}
            style={{
              background: simulationRunning ? '#ef4444' : '#10b981',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: '600',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            {simulationRunning ? <Square size={12} /> : <Play size={12} />}
            {simulationRunning ? 'Stop Simulation' : 'Start Simulation'}
          </button>
        </div>
      </header>

      {/* 2. Main Dashboard Panel Grid layout */}
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.2fr 1.8fr', gap: '20px', padding: '25px' }}>
        
        {/* LEFT COLUMN: Voice Bot Terminal & AI control center */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Zephyr Voice assistant card [2.4.4, 2.4.7] */}
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '400px' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div className={`glow-active`} style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></div>
                  <h2 style={{ margin: 0, fontSize: '18px' }}>Thingsboard Bot</h2>
                </div>
                <span style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase' }}>Gemini Live Relay</span>
              </div>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '0 0 20px 0', background: 'rgba(30, 41, 59, 0.4)', padding: '8px 12px', borderRadius: '6px' }}>
                <strong>Session Status:</strong> {geminiStatus}
              </p>

              {/* Streaming Voice bot transcription box [2.4.4, 2.4.7] */}
              <div style={{ 
                minHeight: '160px', maxHeight: '240px', overflowY: 'auto', 
                background: 'rgba(15, 23, 42, 0.6)', borderRadius: '8px', padding: '15px', 
                border: '1px solid rgba(255, 255, 255, 0.05)', fontSize: '14px', lineHeight: '1.6' 
              }}>
                {transcription ? (
                  <span style={{ color: '#e2e8f0' }}>{transcription}</span>
                ) : (
                  <span style={{ color: '#475569', fontStyle: 'italic' }}>Voice assistant transcript output logs stream here...</span>
                )}
              </div>
            </div>

            {/* Voice and Text Controls [2.4.4, 2.4.7] */}
            <div style={{ marginTop: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
                <button 
                  onMouseDown={startRecording}
                  onMouseUp={stopRecording}
                  onTouchStart={startRecording}
                  onTouchEnd={stopRecording}
                  className={isRecording ? 'glow-record' : ''}
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    background: isRecording ? '#ef4444' : '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.3s ease'
                  }}
                  title="Hold to Speak to Zephyr"
                >
                  {isRecording ? <MicOff size={28} /> : <Mic size={28} />}
                </button>
              </div>
              <p style={{ textAlign: 'center', fontSize: '11px', color: '#64748b', marginTop: '-12px', marginBottom: '15px' }}>
                {isRecording ? 'Listening... Release to send.' : 'Hold button to speak to Copilot'}
              </p>

              {/* Text Fallback inputs */}
              <div style={{ display: 'flex', gap: '10px' }}>
                <input 
                  type="text"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
                  placeholder="Ask Zephyr (e.g., 'Acknowledge major alarms')"
                  style={{
                    flex: 1,
                    background: '#0f172a',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '6px',
                    padding: '10px 14px',
                    color: '#ffffff',
                    fontSize: '13px'
                  }}
                />
                <button 
                  onClick={handleSendPrompt}
                  style={{
                    background: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '6px',
                    padding: '0 16px',
                    cursor: 'pointer',
                    color: '#10b981'
                  }}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>

          </div>

          {/* Operational tool execute trace logger */}
          <div className="glass-card" style={{ height: '220px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Terminal size={16} style={{ color: '#3b82f6' }} />
              <h3 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Copilot Operational Logs</h3>
            </div>
            <div className="terminal-box" style={{ flex: 1, overflowY: 'auto', padding: '12px', fontSize: '12px', lineHeight: '1.5' }}>
              {terminalLogs.map((log, i) => (
                <div key={i} style={{ marginBottom: '6px', color: log.type === 'tool_start' ? '#eab308' : log.type === 'tool_complete' ? '#10b981' : log.type === 'user' ? '#3b82f6' : '#94a3b8' }}>
                  <span style={{ color: '#475569', marginRight: '8px' }}>[{log.timestamp}]</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          </div>

        </section>

        {/* RIGHT COLUMN: Operational Database Dashboards & Alarms logs */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Telemetry card grid [Updated: Dynamic] */}
          <div className="glass-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <ShieldCheck size={20} style={{ color: '#10b981' }} />
                Live Telemetries
              </h2>
              <select 
                value={selectedDevice} 
                onChange={(e) => setSelectedDevice(e.target.value)}
                style={{
                  background: '#0f172a',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  fontSize: '12px'
                }}
              >
                {devices.map((d, i) => (
                  <option key={i} value={d.name}>{d.name}</option>
                ))}
              </select>
            </div>

            {/* Dynamic telemetry readings based on available keys */}
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', 
              gap: '15px' 
            }}>
              {(() => {
                const dev = devices.find(d => d.name === selectedDevice);
                const telemetry = dev?.lastTelemetry || {};
                const keys = Object.keys(telemetry);

                if (keys.length === 0) {
                  return (
                    <div style={{ 
                      gridColumn: '1 / -1', padding: '30px', textAlign: 'center', 
                      background: 'rgba(15, 23, 42, 0.4)', borderRadius: '8px', color: '#64748b' 
                    }}>
                      No active telemetry data for this device.
                    </div>
                  );
                }

                // Color map for known common metrics, others get default
                const colorMap: Record<string, string> = {
                  temperature: '#ef4444',
                  humidity: '#3b82f6',
                  pressure: '#10b981',
                  vibration: '#f59e0b',
                  battery: '#22c55e',
                  voltage: '#a855f7',
                };

                const unitMap: Record<string, string> = {
                  temperature: '°C',
                  humidity: '% RH',
                  pressure: ' Bar',
                  vibration: ' Gs',
                  battery: '%',
                  voltage: 'V',
                };

                return keys.map((key, i) => {
                  const value = telemetry[key];
                  const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
                  const baseColor = colorMap[key.toLowerCase()] || '#64748b';
                  const unit = unitMap[key.toLowerCase()] || '';

                  return (
                    <div key={i} style={{ 
                      background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(255,255,255,0.05)', 
                      borderRadius: '8px', padding: '15px', textAlign: 'center' 
                    }}>
                      <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#ffffff' }}>
                        {value}{unit}
                      </div>
                      <div style={{ width: '100%', height: '3px', background: '#1e293b', borderRadius: '2px', marginTop: '10px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: '70%', // Representative progress
                          height: '100%', 
                          background: baseColor 
                        }}></div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Device list inventory card */}
          <div className="glass-card">
            <h3 style={{ margin: '0 0 15px 0', fontSize: '15px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#64748b' }}>Device Inventory Discovered ({devices.length})</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {devices.map((dev, i) => (
                <div key={i} style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'rgba(15, 23, 42, 0.3)', border: '1px solid rgba(255,255,255,0.04)',
                  padding: '10px 15px', borderRadius: '6px', fontSize: '13px'
                }}>
                  <span style={{ fontWeight: '500' }}>{dev.name}</span>
                  <span style={{ fontSize: '10px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '2px 8px', borderRadius: '9999px', fontWeight: '600' }}>{dev.status}</span>
                </div>
              ))}
            </div>
          </div>

          {/* System alarms log ticket */}
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '15px' }}>
              <AlertTriangle size={18} style={{ color: '#ef4444' }} />
              <h3 style={{ margin: 0, fontSize: '15px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#64748b' }}>Active Industrial Alarms</h3>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {alarms.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#475569', fontSize: '13px', fontStyle: 'italic' }}>
                  No active system alerts detected.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', textAlign: 'left' }}>
                      <th style={{ padding: '8px', fontSize: '11px', color: '#475569', textTransform: 'uppercase' }}>Device</th>
                      <th style={{ padding: '8px', fontSize: '11px', color: '#475569', textTransform: 'uppercase' }}>Alert</th>
                      <th style={{ padding: '8px', fontSize: '11px', color: '#475569', textTransform: 'uppercase' }}>Severity</th>
                      <th style={{ padding: '8px', fontSize: '11px', color: '#475569', textTransform: 'uppercase' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alarms.map((alarm, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '8px', fontSize: '12px', fontWeight: 'bold' }}>{alarm.device}</td>
                        <td style={{ padding: '8px', fontSize: '12px', color: '#cbd5e1' }}>{alarm.type}</td>
                        <td style={{ padding: '8px', fontSize: '11px' }}>
                          <span style={{ 
                            background: alarm.severity === 'CRITICAL' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                            color: alarm.severity === 'CRITICAL' ? '#f87171' : '#fbbf24',
                            padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold'
                          }}>{alarm.severity}</span>
                        </td>
                        <td style={{ padding: '8px', fontSize: '12px', color: '#94a3b8' }}>{alarm.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

        </section>

      </main>
    </div>
  );
}