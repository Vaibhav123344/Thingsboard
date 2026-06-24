import React, { useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VoiceAssistantControlBar,
  useVoiceAssistant,
  useRoomContext
} from '@livekit/components-react';
import '@livekit/components-styles';

export function LiveKitIntegration() {
  // Use your local LiveKit server URL
  const serverUrl = 'ws://localhost:7880';
  
  // NOTE: You can dynamically fetch this token from your Express backend, 
  // or use `lk dev` generated tokens for local testing.
  const [token, setToken] = useState<string>('');

  if (token === '') {
    return (
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid #334155', padding: '16px', borderRadius: '12px' }}>
        <h4 style={{ color: '#f8fafc', margin: '0 0 8px 0', fontSize: '14px', letterSpacing: '0.5px' }}>Connect to Zephyr (LiveKit)</h4>
        <input 
          type="text" 
          placeholder="Enter LiveKit Token..." 
          onChange={(e) => setToken(e.target.value)}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #334155', background: '#0f172a', color: '#fff', outline: 'none' }}
        />
      </div>
    );
  }

  return (
    <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid #334155', borderRadius: '16px', padding: '24px' }}>
      <LiveKitRoom
        serverUrl={serverUrl}
        token={token}
        connect={true}
        audio={true}
        video={false}
      >
        <RoomAudioRenderer />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <AgentStateIndicator />
          <VoiceAssistantControlBar controls={{ leave: true, mic: true }} />
        </div>
      </LiveKitRoom>
    </div>
  );
}

function AgentStateIndicator() {
  const { state } = useVoiceAssistant();
  const room = useRoomContext();
  
  let color = '#64748b'; // disconnected
  if (state === 'listening') color = '#ef4444'; // red for listening
  if (state === 'speaking') color = '#38bdf8'; // blue for speaking
  if (state === 'thinking') color = '#fbbf24'; // yellow for thinking

  return (
    <div style={{ fontSize: '12px', color: color, fontWeight: 700, letterSpacing: '1px' }}>
      {state === 'disconnected' ? 'ZEPHYR OFFLINE' : `ZEPHYR: ${state.toUpperCase()}`}
    </div>
  );
}
