# ThingsBoard Industrial AI Copilot: Full Setup Guide

This guide provides the exact steps and commands needed to spin up the entire consolidated stack:
1. PostgreSQL Database
2. ThingsBoard Community Edition
3. Chronos-2 Forecasting Python Backend
4. Node.js Simulator & Gemini Voice Gateway
5. React Frontend Dashboard

---

## 1. Prerequisites

Before you begin, ensure you have the following installed on your host machine:
- **Node.js** (v20.x or higher)
- **Docker Desktop** (or Docker Engine + Docker Compose plugin)
- **Git**

You also need a **Google Gemini API Key** (from Google AI Studio) to enable the Zephyr Voice Copilot.

---

## 2. Environment Configuration

Copy the `.env.example` file to create a `.env` file in the project root:

```bash
cp .env.example .env
```

Open `.env` and fill in your details. It should look like this:

```ini
# ThingsBoard API Connection Parameters
THINGSBOARD_HOST=http://localhost:8080
THINGSBOARD_USERNAME=tenant@thingsboard.org
THINGSBOARD_PASSWORD=tenant

# MQTT Broker Routing ('thingsboard-ce' inside Docker Compose)
THINGSBOARD_MQTT_HOST=thingsboard-ce
THINGSBOARD_MQTT_PORT=1883

# Simulation Interval Timing
SIMULATION_INTERVAL_SECONDS=15
SIMULATOR_PORT=9005

# Google Gemini API Key
GEMINI_API_KEY=AIzaSyYourActualKeyHere
```

---

## 3. Docker Infrastructure (Backend Services)

The backend infrastructure is fully containerized. We will start the database first, run the ThingsBoard schema installation, and then spin up the rest of the stack.

### Step 3.1: Start the Database
Start only the PostgreSQL database container:

```bash
docker-compose up -d postgres
```
*Wait about 10 seconds for the database to fully initialize.*

### Step 3.2: Install ThingsBoard Schema (First Run Only)
Because the database starts completely empty, you must run the ThingsBoard installation script to create the necessary tables and default demo profiles:

```bash
docker-compose run --rm -e INSTALL_TB=true -e LOAD_DEMO=true thingsboard-ce
```
*Wait for this command to finish. It will take a minute or two. You will know it's done when you see the message: `ThingsBoard installation successfully completed!`*

### Step 3.3: Start the Full Backend Stack
Now, start ThingsBoard, the Python Chronos-2 Forecasting Engine, and the Node.js Simulator Gateway:

```bash
docker-compose up -d
```

> **Note**: On startup, the `iot-simulator` container will automatically authenticate with ThingsBoard, dynamically create `Smart-Industrial-Sensor-01` and `Smart-Industrial-Sensor-02` if they don't exist, extract their MQTT tokens, and begin publishing live telemetry. It also establishes the 16kHz WebSocket link to Gemini Live.

You can verify the backend services are running using:
```bash
docker-compose ps
```
You can view the logs for the Node.js gateway/Zephyr agent via:
```bash
docker-compose logs -f iot-simulator
```

---

## 4. Launch the Frontend Dashboard

Open a **new terminal window**, navigate to the `frontend` folder, and run the React application:

```bash
cd frontend

# Install frontend dependencies
npm install

# Start the Vite development server
npm run dev
```

---

## 5. Access the Applications

With everything running, you can access the various parts of the stack through your browser:

- **AI Operations Dashboard (React)**: [http://localhost:5173](http://localhost:5173) (Or whichever port Vite allocates, usually 5173. Interact with Zephyr and the What-If Console here).
- **ThingsBoard Web UI**: [http://localhost:8080](http://localhost:8080)
  - **Login:** `tenant@thingsboard.org`
  - **Password:** `tenant`
- **Chronos-2 Python Engine API**: [http://localhost:8000/docs](http://localhost:8000/docs) (Swagger UI for the predictive model).
- **Simulator REST API**: [http://localhost:9005/simulation/status](http://localhost:9005/simulation/status)

---

## 6. Shutdown

When you are finished, you can stop all backend services from the root directory:

```bash
docker-compose down
```

To preserve your data between runs, the PostgreSQL data is persisted in a local Docker volume (`tb-postgres-data`). Next time you start, you only need to run `docker-compose up -d` (skip Step 3.2).
