Industrial AI Observer (v2.0)
An intelligent, dual-mode voice assistant ("Zephyr") and industrial supervisor engine integrated directly with ThingsBoard Community Edition (CE) and Google Gemini Live (v3.1 Flash Live Preview).
This application bridges physical IoT telemetry pipelines (MQTT) with real-time generative artificial intelligence. It features zero-configuration programmatic device provisioning, low-latency OS-native audio playback with real-time text transcription, and 35 robust API operational tools to query, manage, and audit your smart factory.
1. System Architecture & Flow
The system runs on a hybrid stack split between Docker containers (for high-availability system infrastructure) and the local Host OS (for low-latency native hardware speaker access and interactive terminal command loop).
code
Text
+-------------------------------------------------------------+
               |                       LOCAL HOST OS                         |
               |                                                             |
               |  +------------------------+      +-----------------------+  |
               |  |  Gemini Live Session   |      |  Ingestion Simulator  |  |
               |  |  (live_agent.ts)       |      |  (simulator.ts: 9001) |  |
               |  +-----------+------------+      +-----------+-----------+  |
               |              |                               |              |
               |              | Speak/Transcribe              | Auto-Provision /
               |              | (Port 443 WSS)                | MQTT Telemetry
               |              v                               | (Port 1883)
               |  +-----------+------------+                  |              |
               |  | Google Gemini Live API |                  |              |
               +--+------------------------+------------------+--------------+
                              |                               |
                              | REST API Calls                |
                              | (Port 8080)                   |
                              v                               v
               +--------------+-------------------------------+--------------+
               |                        DOCKER COMPOSE                       |
               |                                                             |
               |             +---------------------------------+             |
               |             |  ThingsBoard CE (tb-node)       |             |
               |             +----------------+----------------+             |
               |                              |                              |
               |                              | JDBC (Port 5432)             |
               |                              v                              |
               |             +---------------------------------+             |
               |             |  PostgreSQL Database (Alpine)   |             |
               |             +---------------------------------+             |
               +-------------------------------------------------------------+
Critical Communication Cycles:
Dynamic Auto-Provisioning: On startup, the simulator authenticates using tenant credentials, checks ThingsBoard for the targets (Smart-Industrial-Sensor-01 and 02), spawns them if missing, retrieves their valid Access Tokens, and automatically configures its own MQTT ingestion loops.
Double-Modality Loop: The Gemini Live session is locked to Modality.AUDIO to avoid backend schema mismatches. To support visibility, outputAudioTranscription streams the live text representing what Zephyr is saying, which is outputted to the console.
Turn-Based Sound Generation: Base64 raw audio chunks are captured, assembled into a structured WAV buffer on-the-fly, and written synchronously to audio.wav. On turnComplete, a native OS process executes asynchronously to play the audio back, resetting the buffer on the next turn to prevent old turns from playing.
2. Key Features
Zero-Configuration Provisioning: Eliminates the manual UI credential setup step. Device registration, database verification, and credentials/token extraction are done programmatically on boot.
Continuous Audio Ingestion & OS Playback: Writes the WAV stream synchronously (writeFileSync) to avoid Windows write-concurrency (EBUSY) locks, and plays audio through pre-installed OS players (PowerShell on Windows, afplay on macOS, aplay/paplay on Linux).
Multi-Sensor Simulation: Simulates dynamic industrial conditions (temperature, humidity, pressure, vibration) and streams them into ThingsBoard over MQTT.
REST Simulation Controller: Provides an HTTP interface (Port 9001) to start, stop, scale, or manually trigger telemetry anomaly injections.
3. Tool Documentation (The 35 Capabilities)
The AI Agent maps 35 granular operations. Zephyr evaluates your spoken or typed prompts and decides which tool to call:
Group A: Live Monitoring, Trends & Analytics
list_devices: Returns a list of all active industrial devices and sensors in the tenant workspace.
get_current_telemetry: Fetches the latest real-time telemetry readings for a specific device.
get_historical_summary: Provides an aggregated statistical summary (average, min, max) of telemetry over a specific time window.
get_active_alarms: Scans the system for active, unacknowledged, or acknowledged alarms, sorted by priority.
get_device_attributes: Retrieves device metadata (e.g., location, thresholds, configuration scope).
get_highest_metric: Sweeps all active devices to identify which one currently has the highest value for a specific metric (e.g., "highest temperature").
get_metric_trend: Computes if a specific telemetry metric is rising, falling, or stable compared to the last hour's baseline.
perform_deep_analysis: Generates a historical audit report over a given window, evaluates threshold excursions, and writes an interactive HTML report.
Group B: Device, Asset & Relation Management
create_device: Programmatically registers a new device or sensor.
delete_device: Removes a specified device from the database.
get_device_credentials: Extracts connectivity credentials (e.g. MQTT Access Token) for a device.
list_assets: Returns a list of registered organizational assets (e.g., "Factory Floor 1").
get_asset_by_name: Fetches metadata for a named asset.
create_asset: Creates a new organizational asset structure.
delete_asset: Deletes a named asset.
create_relation: Forms a relationship link (e.g., Contains, Manages) between any two entity IDs.
delete_relation: severs an active entity relationship.
list_relations: Lists relation mappings flowing from a target entity.
Group C: Alarms & Rule Engine Actions
create_alarm: Dispatches a custom system alarm with defined severity and details.
acknowledge_alarm: Acknowledges an active alarm.
clear_alarm: Clears an active alarm, marking it resolved.
trigger_rule_engine: Pushes custom JSON telemetry directly into the rule engine pipeline for immediate evaluation.
inject_rule_engine_queue: Directly queue payloads into specific, partitioned rule engine queues (e.g., HighPriority).
create_rule_chain: Creates a rule chain along with nodes and routing connections.
Group D: Attributes, Profiles & Dashboards
save_device_attributes: Writes attributes in specified scopes (e.g., SERVER_SCOPE, SHARED_SCOPE).
delete_device_attributes: Deletes targeted device attribute parameters.
list_dashboards: Lists active visualization dashboards.
get_dashboard_by_id: Fetches configuration parameters of a specific dashboard.
assign_dashboard_to_customer: Assigns access boundaries for a dashboard to a designated customer ID.
list_device_profiles: Lists all profile metadata schemas.
get_device_profile_by_id: Fetches details of a specific device profile ID.
Group E: Actuation (RPC) & Audit Logs
send_one_way_rpc: Dispatches a fire-and-forget actuation command to an edge node.
send_two_way_rpc: Transmits an actuation call and blocks waiting for physical hardware loop responses.
list_persistent_rpcs: Lists queued RPC executions.
get_audit_logs: Retrieves historical configuration changes, security events, and operator activity.
4. Environment Variables Configuration
Copy .env.example to a new file named .env in the root directory:
code
Bash
cp .env.example .env
Set the variables inside .env:
code
Ini
# ThingsBoard API Connection Parameters
THINGSBOARD_HOST=http://localhost:8080
THINGSBOARD_USERNAME=tenant@thingsboard.org
THINGSBOARD_PASSWORD=tenant

# MQTT Broker Routing (Localhost on Host OS, 'thingsboard-ce' inside Docker Compose)
THINGSBOARD_MQTT_HOST=localhost
THINGSBOARD_MQTT_PORT=1883

# Simulation Interval Timing
SIMULATION_INTERVAL_SECONDS=15

# Google Gemini API Keys
GEMINI_API_KEY=AIzaSyYourActualKeyHere
5. Setup and Launch Instructions
Prerequisites
Node.js v20.x or higher installed on your host system.
Docker Desktop (or Docker Engine + Docker Compose) installed.
Google Gemini API Key (obtained via Google AI Studio).
Execution Sequence
Step 1: Initialize Local NPM Packages
Install project dependencies on your host machine:
code
Bash
npm install
Step 2: Spin Up the Database Container
Launch the PostgreSQL database container first:
code
Bash
docker compose up -d postgres
Wait 10 seconds for the database engine to finish initializing.
Step 3: Run the ThingsBoard Schema Provisioner (Required on First Run)
Because the PostgreSQL database starts empty, run the ThingsBoard CE schema installation tool to build tables and load standard templates:
code
Bash
docker compose run --rm -e INSTALL_TB=true -e LOAD_DEMO=true thingsboard-ce
Wait until your console outputs: ThingsBoard installation successfully completed!
Step 4: Launch the Core ThingsBoard Container
Start up the main ThingsBoard monolithic container:
code
Bash
docker compose up -d thingsboard-ce
Wait ~30 seconds. Verify the web UI is responsive by navigating to http://localhost:8080 and logging in using: username: tenant@thingsboard.org, password: tenant.
Step 5: Start the Supervisor Application (Simulator + AI Agent)
From the root folder of your host machine, execute the supervisor bootstrap script:
code
Bash
npm run dev:agent
On execution, you will see the following automated actions:
The simulator authenticates via REST, checks for Smart-Industrial-Sensor-01 and 02, creates them dynamically if they do not exist, and extracts their active Access Tokens.
The MQTT clients connect to localhost:1883 using those tokens.
The Live Agent establishes an encrypted WebSocket handshake with Gemini.
Zephyr introduces itself over your computer speakers and types its response.
You can now type commands directly into the prompt.
6. Controlling the Ingestion Simulator
You can control and test the simulation layer using standard curl commands sent to the simulator controller endpoint on port 9001:
Start All Sensor Streams
Instruct both sensors to begin publishing simulated metrics (temperature, humidity, pressure, vibration) every 15 seconds:
code
Bash
curl -X POST http://localhost:9001/simulation/start_all
Stop All Sensor Streams
Pause the active ingestion loop:
code
Bash
curl -X POST http://localhost:9001/simulation/stop_all
Check Simulation Loop Status
Get a JSON state overview of active streams:
code
Bash
curl http://localhost:9001/simulation/status
Inject Anomaly Telemetry (Ad-hoc)
Manually publish a specific, high-vibration reading to test the AI Agent's threshold warning rules:
code
Bash
curl -H "Content-Type: application/json" -X POST -d "{\"device_name\":\"Smart-Industrial-Sensor-01\",\"telemetry\":{\"temperature\":72.5,\"humidity\":42.0,\"pressure\":1.1,\"vibration\":5.8}}" http://localhost:9001/simulation/publish
7. Audio Playback & Buffer Management Details
Standard Node.js applications run on a single-threaded event loop and cannot easily output sound without compiling custom native binary bindings. To solve this, the agent uses OS-native tools:
code
Text
+------------------------+
    | incoming AUDIO packet  |
    +-----------+------------+
                |
                v
    +-----------+------------+      Sync Write (Blocks Windows file locks)
    | append data to array   +----------------------------------------------+
    +-----------+------------+                                              |
                |                                                           v
                v                                                   +-------+--------+
    +-----------+------------+                                      |   audio.wav    |
    | turnComplete true?     |                                      +-------+--------+
    +-----------+------------+                                              |
                |                                                           | Play command
                v                                                           v
    +-----------+------------+                                      +-------+--------+
    | exec system cmd player +------------------------------------->| Native Player  |
    +-----------+------------+                                      +-------+--------+
                |
                v
    +-----------+------------+
    | reset buffer array     | (Ensures clean turn-by-turn playback)
    +------------------------+
The System Audio Playback Function
The execution is handled via a child process call to the system sound engine in a non-blocking manner:
code
TypeScript
function playAudioFile(fileName: string) {
  const currentPlatform = platform();
  let command = '';

  if (currentPlatform === 'win32') {
    command = `powershell -c "(New-Object Media.SoundPlayer '${fileName}').Play()"`;
  } else if (currentPlatform === 'darwin') {
    command = `afplay ${fileName}`;
  } else if (currentPlatform === 'linux') {
    command = `aplay ${fileName} || paplay ${fileName}`;
  }

  if (command) {
    exec(command, () => {});
  }
}
8. Troubleshooting
1. MQTT Client Error: Connection refused
Cause: The container was configured to use localhost inside Docker, or the auto-provisioner used invalid fallback credentials.
Fix: Ensure your host .env file lists THINGSBOARD_MQTT_HOST=localhost when running scripts on the host, and check that the core ThingsBoard service container is fully up and running (docker compose ps).
2. Output is completely silent
Cause: Your local OS terminal configuration cannot access the system audio card, or the audio player process failed.
Fix: Check if audio.wav is being generated and growing in size in your project's root folder. Open this file using a standard player (like VLC) to verify if the audio output stream is healthy. Ensure your system volume is turned up and PowerShell (on Windows) is accessible.
3. Invalid payload / Proto field error
Cause: A tool returned a raw Javascript array or a string instead of a valid JSON object map.
Fix: Ensure the tool return values are wrapped inside the type-safety block inside handleModelTurn. The Gemini Live server expects all responses to map to a flat Protobuf Struct object format.