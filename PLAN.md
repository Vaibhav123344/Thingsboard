# Engineering Plan: Industrial AI Copilot Enhancements

## 1. Goal
Address 9 specific requirements to move the "What-If" analysis to an AI-driven tool, enable dynamic telemetry/simulation, fix dashboard creation, and implement continuous "live" audio streaming with a redesigned UI.

## 2. Component Changes

### A. Backend: Simulator (`src/simulator.ts`)
1.  **Dynamic Device Provisioning**:
    - Modify `autoProvisionDevices` to fetch *all* devices from the ThingsBoard tenant using `DeviceService`.
    - Populate `activeClients` dynamically for all discovered devices.
    - Implement a periodic refresh (every 5 mins) to pick up new devices created by the AI.
2.  **Dynamic Telemetry Generation**:
    - For each device, fetch its active telemetry keys using `bridge.getLatestTelemetry`.
    - If no keys exist, default to a standard set (temp, hum, press, vib).
    - Modify `generateSensorTelemetry` to accept a list of keys and generate random values within sensible bounds for each key.
3.  **Simulation Control**:
    - Ensure `start_all` and `stop_all` iterate over the dynamically discovered devices.

### B. Backend: Bridge & Tools (`src/bridge.ts`)
1.  **Dashboard Tool Fix (`createDeviceDashboard`)**:
    - Update the payload to use `typeFullFqn: "system.charts.timeseries_line_chart"`.
    - Use `entityAliasId` correctly.
    - Ensure the layout grid is properly defined to prevent "blank" dashboards.
2.  **What-If Integration**:
    - Ensure `forecastWhatIf` is robust and handles error cases gracefully (e.g., missing historical data).

### C. Live Agent (`src/live_agent_ws.ts`)
1.  **System Instruction Update**:
    - Refine Zephyr's personality to be more proactive.
    - Explicitly instruct how to parse "What-If" queries and present the complex results (peak, crossing, recurrence) clearly to the user.
2.  **Tool Declarations**:
    - Review and refine parameter descriptions for better AI understanding.

### D. Frontend (`frontend/src/App.tsx`)
1.  **UI Redesign**:
    - **Remove**: "Node Diagnostic Hub" and "What-If Simulation Console".
    - **Layout**: Expand the "Neural Audio Interface" and "Telemetric Monitoring" areas.
2.  **Live Audio Interface**:
    - Change push-to-talk to a "Live Mode" toggle.
    - When active, keep the microphone open and stream 16kHz PCM chunks to the backend continuously.
    - Update visuals to show a "Live" pulsating indicator.
3.  **Dynamic Telemetry UI**:
    - Ensure the telemetry grid adapts gracefully to any number of keys.

## 3. Database Strategy
- **Decision**: Continue using ThingsBoard's existing Postgres database via its REST API.
- **Rationale**: ThingsBoard is the source of truth for device credentials and telemetry. Introducing a separate table for simulation metadata adds complexity and synchronization risks. Dynamic fetching on startup/refresh is sufficient.

## 4. Verification Plan
- **Simulation**: Verify that newly created devices (via AI) automatically start receiving simulated telemetry.
- **What-If Tool**: Ask Zephyr "If vibration increases to 5.0, what happens?" and verify it calls the tool and explains the result.
- **Dashboards**: Create a dashboard and verify it shows data in the ThingsBoard UI.
- **Audio**: Verify "Live Mode" allows back-and-forth conversation without holding buttons.
- **Dynamic Schema**: Add a new telemetry key to a device and verify the UI shows it automatically.
