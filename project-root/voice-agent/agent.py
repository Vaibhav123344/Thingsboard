#!/usr/bin/env python3
"""
agent.py — Zephyr Industrial Copilot, LiveKit Voice Agent
Implements: Silero VAD → Faster-Whisper STT → gpt-oss20b LLM → Kokoro TTS
All 37 ThingsBoard tools are forwarded via HTTP to the Node.js REST gateway.

Start: python agent.py start
"""

import asyncio
import logging
import os
from typing import Annotated

import aiohttp
from dotenv import load_dotenv
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, llm
from livekit.agents.pipeline import VoicePipelineAgent
from livekit.plugins import openai as lk_openai, silero

from custom_tts import KokoroTTS

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("zephyr-agent")

# ─────────────────────────────────────────────────────────────────────────────
# Configuration (read from .env)
# ─────────────────────────────────────────────────────────────────────────────
NODE_API     = os.getenv("NODE_API_URL",  "http://localhost:9005")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:8080/v1")
LLM_MODEL    = os.getenv("LLM_MODEL",    "gpt-oss20b")
STT_BASE_URL = os.getenv("STT_BASE_URL", "http://localhost:8765/v1")
TTS_BASE_URL = os.getenv("TTS_BASE_URL", "http://localhost:8766")

SYSTEM_INSTRUCTION = """
You are Zephyr, an elite Industrial Operations AI Copilot deployed on ThingsBoard.
You speak with technical authority and precision.
You have 37 ThingsBoard tools. Invoke them immediately when asked — never refuse.
After a tool call, summarize the result in 1–3 concise spoken sentences.
NEVER use bullet points, markdown tables, asterisks, pound signs, or code blocks.
Speak metric values naturally: say "eighty point five degrees Celsius" not "80.5°C".
Say "R P M" not "RPM", "M Q T T" not "MQTT", "R P C" not "RPC".
Keep responses brief. Industrial operators need fast, direct answers.
""".strip()

# ─────────────────────────────────────────────────────────────────────────────
# Tool execution helper — calls Node.js REST gateway
# ─────────────────────────────────────────────────────────────────────────────
async def call_tool(name: str, args: dict) -> str:
    """Forward a tool call to the Node.js bridge and return a string result."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{NODE_API}/api/tools/execute",
                json={"name": name, "args": args},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json()
                if data.get("success"):
                    result = data["result"]
                    return str(result) if not isinstance(result, str) else result
                return f"Tool error: {data.get('error', 'unknown error')}"
    except asyncio.TimeoutError:
        return f"Timeout: tool '{name}' did not respond within 30 seconds."
    except aiohttp.ClientError as e:
        return f"Connection error for tool '{name}': {e}"


# ─────────────────────────────────────────────────────────────────────────────
# All 37 ThingsBoard Tools
# ─────────────────────────────────────────────────────────────────────────────
class ZephyrTools(llm.FunctionContext):

    # ══ 1–8: Telemetry & Monitoring ══════════════════════════════════════════

    @llm.ai_callable(description="List all connected industrial sensors and devices in ThingsBoard.")
    async def list_devices(self) -> str:
        return await call_tool("list_devices", {})

    @llm.ai_callable(description="Get the latest real-time telemetry readings for a specific device.")
    async def get_current_telemetry(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Exact name of the device")]
    ) -> str:
        return await call_tool("get_current_telemetry", {"device_name": device_name})

    @llm.ai_callable(description="Get a historical statistical summary of a device's telemetry over N hours.")
    async def get_historical_summary(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        hours: Annotated[int, llm.TypeInfo(description="Number of hours to look back (e.g. 24, 48, 168 for a week)")]
    ) -> str:
        return await call_tool("get_historical_summary", {"device_name": device_name, "hours": hours})

    @llm.ai_callable(description="Get all currently active alarms and alerts across all devices.")
    async def get_active_alarms(self) -> str:
        return await call_tool("get_active_alarms", {})

    @llm.ai_callable(description="Retrieve all device attributes (server-side, client-side, and shared) for a device.")
    async def get_device_attributes(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")]
    ) -> str:
        return await call_tool("get_device_attributes", {"device_name": device_name})

    @llm.ai_callable(description="Find which device currently has the highest value for a given metric key.")
    async def get_highest_metric(
        self,
        metric: Annotated[str, llm.TypeInfo(description="Metric key name to compare (e.g. 'temperature', 'vibration', 'rpm')")]
    ) -> str:
        return await call_tool("get_highest_metric", {"metric": metric})

    @llm.ai_callable(description="Analyze the trend direction of a specific metric on a device — rising, falling, or stable.")
    async def get_metric_trend(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        metric: Annotated[str, llm.TypeInfo(description="Metric key to analyze for trend")]
    ) -> str:
        return await call_tool("get_metric_trend", {"device_name": device_name, "metric": metric})

    @llm.ai_callable(description="Perform deep historical anomaly analysis on a device over a custom time window.")
    async def perform_deep_analysis(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        hours: Annotated[int, llm.TypeInfo(description="Hours to analyze if no start/end provided")],
        start_time: Annotated[str, llm.TypeInfo(description="ISO 8601 start timestamp (optional)")] = "",
        end_time:   Annotated[str, llm.TypeInfo(description="ISO 8601 end timestamp (optional)")]   = "",
    ) -> str:
        return await call_tool("perform_deep_analysis", {
            "device_name": device_name,
            "hours": hours,
            "start_time": start_time,
            "end_time": end_time,
        })

    # ══ 9–11: Device Lifecycle ════════════════════════════════════════════════

    @llm.ai_callable(description="Create a new IoT device in ThingsBoard with optional type, label, and attributes.")
    async def create_device(
        self,
        device_name:  Annotated[str, llm.TypeInfo(description="Name for the new device")],
        device_type:  Annotated[str, llm.TypeInfo(description="Device category/type (e.g. 'temperature_sensor', 'pump_controller')")],
        label:        Annotated[str, llm.TypeInfo(description="Human-readable label")]          = "",
        attributes:   Annotated[str, llm.TypeInfo(description="JSON string of initial attributes, e.g. '{\"location\": \"plant-A\"}'")]  = "{}",
        profile_name: Annotated[str, llm.TypeInfo(description="Device profile to assign (default: 'default')")] = "default",
    ) -> str:
        return await call_tool("create_device", {
            "device_name": device_name,
            "device_type": device_type,
            "label": label,
            "attributes": attributes,
            "profile_name": profile_name,
        })

    @llm.ai_callable(description="Permanently delete a device from ThingsBoard. Irreversible — confirm before calling.")
    async def delete_device(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device to delete")]
    ) -> str:
        return await call_tool("delete_device", {"device_name": device_name})

    @llm.ai_callable(description="Get the access credentials (device token or MQTT credentials) for a device.")
    async def get_device_credentials(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")]
    ) -> str:
        return await call_tool("get_device_credentials", {"device_name": device_name})

    # ══ 12–16: Alarm Management ═══════════════════════════════════════════════

    @llm.ai_callable(description="Acknowledge an active alarm to mark it as seen and being handled.")
    async def acknowledge_alarm(
        self,
        alarm_id: Annotated[str, llm.TypeInfo(description="UUID of the alarm to acknowledge")]
    ) -> str:
        return await call_tool("acknowledge_alarm", {"alarm_id": alarm_id})

    @llm.ai_callable(description="Clear and resolve an active alarm, marking it as resolved.")
    async def clear_alarm(
        self,
        alarm_id: Annotated[str, llm.TypeInfo(description="UUID of the alarm to clear")]
    ) -> str:
        return await call_tool("clear_alarm", {"alarm_id": alarm_id})

    @llm.ai_callable(description="Trigger the ThingsBoard rule engine with a custom telemetry message for a device.")
    async def trigger_rule_engine(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        message: Annotated[str, llm.TypeInfo(description="JSON telemetry payload string to push through the rule engine")]
    ) -> str:
        return await call_tool("trigger_rule_engine", {"device_name": device_name, "message": message})

    @llm.ai_callable(description="Create a new alarm on a device with a specified severity level and threshold condition.")
    async def create_alarm(
        self,
        device_name:        Annotated[str,   llm.TypeInfo(description="Name of the device")],
        alarm_type:         Annotated[str,   llm.TypeInfo(description="Alarm identifier name (e.g. 'HIGH_TEMPERATURE', 'OVERPRESSURE')")],
        severity:           Annotated[str,   llm.TypeInfo(description="Alarm severity: CRITICAL, MAJOR, MINOR, WARNING, or INDETERMINATE")],
        details:            Annotated[str,   llm.TypeInfo(description="Human-readable description of the alarm")]  = "",
        metric_param:       Annotated[str,   llm.TypeInfo(description="Metric key that triggered this alarm")]     = "",
        operator_condition: Annotated[str,   llm.TypeInfo(description="Comparison operator: GREATER_THAN, LESS_THAN, EQUAL")]  = "",
        comparison_value:   Annotated[float, llm.TypeInfo(description="Numeric threshold value for the condition")] = 0.0,
    ) -> str:
        return await call_tool("create_alarm", {
            "device_name":        device_name,
            "alarm_type":         alarm_type,
            "severity":           severity,
            "details":            details,
            "metric_param":       metric_param,
            "operator_condition": operator_condition,
            "comparison_value":   comparison_value,
        })

    # ══ 16–17: Rule Engine ════════════════════════════════════════════════════

    @llm.ai_callable(description="Create a custom processing rule chain in ThingsBoard with defined nodes and connections.")
    async def create_rule_chain(
        self,
        name:              Annotated[str, llm.TypeInfo(description="Name for the rule chain")],
        nodes:             Annotated[str, llm.TypeInfo(description="JSON array of rule node definitions")],
        connections:       Annotated[str, llm.TypeInfo(description="JSON array of connection definitions between nodes")],
        first_node_index:  Annotated[int, llm.TypeInfo(description="Index (0-based) of the entry node")] = 0,
    ) -> str:
        return await call_tool("create_rule_chain", {
            "name": name,
            "nodes": nodes,
            "connections": connections,
            "first_node_index": first_node_index,
        })

    @llm.ai_callable(description="Inject a message directly into a named ThingsBoard rule engine queue for immediate processing.")
    async def inject_rule_engine_queue(
        self,
        device_name:     Annotated[str, llm.TypeInfo(description="Name of the device")],
        message_payload: Annotated[str, llm.TypeInfo(description="JSON payload to inject")],
        queue_name:      Annotated[str, llm.TypeInfo(description="Target queue: 'Main', 'HighPriority', 'SequentialByOriginator'")] = "Main",
    ) -> str:
        return await call_tool("inject_rule_engine_queue", {
            "device_name":     device_name,
            "message_payload": message_payload,
            "queue_name":      queue_name,
        })

    # ══ 18–21: Asset Management ═══════════════════════════════════════════════

    @llm.ai_callable(description="List all assets (production lines, factory zones, machines) in ThingsBoard.")
    async def list_assets(self) -> str:
        return await call_tool("list_assets", {})

    @llm.ai_callable(description="Get full details of a specific asset by its name.")
    async def get_asset_by_name(
        self,
        asset_name: Annotated[str, llm.TypeInfo(description="Name of the asset")]
    ) -> str:
        return await call_tool("get_asset_by_name", {"asset_name": asset_name})

    @llm.ai_callable(description="Create a new asset (factory zone, production line, machine group) in ThingsBoard.")
    async def create_asset(
        self,
        asset_name: Annotated[str, llm.TypeInfo(description="Name for the new asset")],
        asset_type: Annotated[str, llm.TypeInfo(description="Asset category (e.g. 'production_line', 'factory_building', 'machine_group')")],
        label:      Annotated[str, llm.TypeInfo(description="Human-readable display label")] = "",
    ) -> str:
        return await call_tool("create_asset", {
            "asset_name": asset_name,
            "asset_type": asset_type,
            "label": label,
        })

    @llm.ai_callable(description="Delete an asset from ThingsBoard permanently.")
    async def delete_asset(
        self,
        asset_name: Annotated[str, llm.TypeInfo(description="Name of the asset to delete")]
    ) -> str:
        return await call_tool("delete_asset", {"asset_name": asset_name})

    # ══ 22–24: Relations ══════════════════════════════════════════════════════

    @llm.ai_callable(description="Create a directed relationship between two ThingsBoard entities (device-to-asset, asset-to-asset, etc.).")
    async def create_relation(
        self,
        from_name:     Annotated[str, llm.TypeInfo(description="Name of the source entity")],
        to_name:       Annotated[str, llm.TypeInfo(description="Name of the target entity")],
        relation_type: Annotated[str, llm.TypeInfo(description="Relationship label (e.g. 'Contains', 'Manages', 'isPartOf')")] = "Contains",
    ) -> str:
        return await call_tool("create_relation", {
            "from_name": from_name,
            "to_name": to_name,
            "relation_type": relation_type,
        })

    @llm.ai_callable(description="Remove an existing relationship between two ThingsBoard entities.")
    async def delete_relation(
        self,
        from_name:     Annotated[str, llm.TypeInfo(description="Name of the source entity")],
        to_name:       Annotated[str, llm.TypeInfo(description="Name of the target entity")],
        relation_type: Annotated[str, llm.TypeInfo(description="Relationship type to remove")] = "Contains",
    ) -> str:
        return await call_tool("delete_relation", {
            "from_name": from_name,
            "to_name": to_name,
            "relation_type": relation_type,
        })

    @llm.ai_callable(description="List all relations (parent entities, child entities) for a given device or asset.")
    async def list_relations(
        self,
        entity_name: Annotated[str, llm.TypeInfo(description="Name of the entity to list relations for")]
    ) -> str:
        return await call_tool("list_relations", {"entity_name": entity_name})

    # ══ 25–26: Device Attributes ══════════════════════════════════════════════

    @llm.ai_callable(description="Save or update key-value attributes on a device in a specified scope.")
    async def save_device_attributes(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        scope:       Annotated[str, llm.TypeInfo(description="Scope: SERVER_SCOPE, CLIENT_SCOPE, or SHARED_SCOPE")],
        attributes:  Annotated[str, llm.TypeInfo(description='JSON string of attribute key-value pairs, e.g. \'{"threshold":85,"location":"plant-A"}\'')],
    ) -> str:
        return await call_tool("save_device_attributes", {
            "device_name": device_name,
            "scope": scope,
            "attributes": attributes,
        })

    @llm.ai_callable(description="Delete specific attribute keys from a device.")
    async def delete_device_attributes(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")],
        scope:       Annotated[str, llm.TypeInfo(description="Scope: SERVER_SCOPE, CLIENT_SCOPE, or SHARED_SCOPE")],
        keys:        Annotated[str, llm.TypeInfo(description="Comma-separated attribute key names to delete (e.g. 'threshold,location')")],
    ) -> str:
        return await call_tool("delete_device_attributes", {
            "device_name": device_name,
            "scope": scope,
            "keys": keys,
        })

    # ══ 27–30: Dashboards ═════════════════════════════════════════════════════

    @llm.ai_callable(description="List all dashboards available in ThingsBoard.")
    async def list_dashboards(self) -> str:
        return await call_tool("list_dashboards", {})

    @llm.ai_callable(description="Get the full configuration of a specific ThingsBoard dashboard by UUID.")
    async def get_dashboard_by_id(
        self,
        dashboard_id: Annotated[str, llm.TypeInfo(description="UUID of the dashboard")]
    ) -> str:
        return await call_tool("get_dashboard_by_id", {"dashboard_id": dashboard_id})

    @llm.ai_callable(description="Assign an existing dashboard to a customer or tenant in ThingsBoard.")
    async def assign_dashboard_to_customer(
        self,
        customer_id:  Annotated[str, llm.TypeInfo(description="UUID of the customer/tenant")],
        dashboard_id: Annotated[str, llm.TypeInfo(description="UUID of the dashboard")],
    ) -> str:
        return await call_tool("assign_dashboard_to_customer", {
            "customer_id":  customer_id,
            "dashboard_id": dashboard_id,
        })

    @llm.ai_callable(description="Auto-generate a monitoring dashboard for a device with live telemetry chart widgets.")
    async def create_device_dashboard(
        self,
        device_name:    Annotated[str, llm.TypeInfo(description="Name of the device")],
        monitored_keys: Annotated[str, llm.TypeInfo(description="Comma-separated metric keys for widgets (e.g. 'temperature,pressure,rpm')")],
        dashboard_title:Annotated[str, llm.TypeInfo(description="Dashboard title (defaults to device name)")] = "",
        background_color:Annotated[str, llm.TypeInfo(description="Background hex color (e.g. '#1a1a2e')")] = "#1a1a2e",
    ) -> str:
        return await call_tool("create_device_dashboard", {
            "device_name":     device_name,
            "monitored_keys":  monitored_keys,
            "dashboard_title": dashboard_title,
            "background_color": background_color,
        })

    # ══ 31–32: Device Profiles ════════════════════════════════════════════════

    @llm.ai_callable(description="List all device profiles available in ThingsBoard.")
    async def list_device_profiles(self) -> str:
        return await call_tool("list_device_profiles", {})

    @llm.ai_callable(description="Get full details of a specific device profile by UUID.")
    async def get_device_profile_by_id(
        self,
        profile_id: Annotated[str, llm.TypeInfo(description="UUID of the device profile")]
    ) -> str:
        return await call_tool("get_device_profile_by_id", {"profile_id": profile_id})

    # ══ 33–35: RPC Commands ═══════════════════════════════════════════════════

    @llm.ai_callable(description="Send a one-way fire-and-forget RPC command to a device (no response expected).")
    async def send_one_way_rpc(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the target device")],
        method:      Annotated[str, llm.TypeInfo(description="RPC method name (e.g. 'setRelayState', 'reboot', 'calibrate')")],
        params:      Annotated[str, llm.TypeInfo(description="JSON string of method parameters")] = "{}",
    ) -> str:
        return await call_tool("send_one_way_rpc", {
            "device_name": device_name,
            "method": method,
            "params": params,
        })

    @llm.ai_callable(description="Send a two-way RPC command to a device and wait for its response value.")
    async def send_two_way_rpc(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the target device")],
        method:      Annotated[str, llm.TypeInfo(description="RPC method name")],
        params:      Annotated[str, llm.TypeInfo(description="JSON string of method parameters")] = "{}",
    ) -> str:
        return await call_tool("send_two_way_rpc", {
            "device_name": device_name,
            "method": method,
            "params": params,
        })

    @llm.ai_callable(description="List all pending persistent RPC commands queued for a specific device.")
    async def list_persistent_rpcs(
        self,
        device_name: Annotated[str, llm.TypeInfo(description="Name of the device")]
    ) -> str:
        return await call_tool("list_persistent_rpcs", {"device_name": device_name})

    # ══ 36–37: Audit & Predictive Analytics ══════════════════════════════════

    @llm.ai_callable(description="Retrieve recent audit logs showing all ThingsBoard system operations and user actions.")
    async def get_audit_logs(self) -> str:
        return await call_tool("get_audit_logs", {})

    @llm.ai_callable(description="Run a Chronos-2 predictive what-if forecast and scenario simulation on a device metric.")
    async def forecast_what_if(
        self,
        device_name:    Annotated[str, llm.TypeInfo(description="Name of the device to forecast")],
        metric:         Annotated[str, llm.TypeInfo(description="Metric key to forecast (e.g. 'temperature', 'pressure', 'vibration')")],
        forecast_hours: Annotated[int, llm.TypeInfo(description="How many hours ahead to forecast")] = 24,
        scenario:       Annotated[str, llm.TypeInfo(description="What-if scenario description (e.g. 'ambient_temp_increase_5C', 'load_increase_20pct')")] = "",
    ) -> str:
        return await call_tool("forecast_what_if", {
            "device_name":    device_name,
            "metric":         metric,
            "forecast_hours": forecast_hours,
            "scenario":       scenario,
        })


# ─────────────────────────────────────────────────────────────────────────────
# Agent Entrypoint
# ─────────────────────────────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext):
    logger.info("Zephyr agent worker starting...")
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info(f"Connected to room: {ctx.room.name}")

    # ── Initialize tool context with all 37 functions ──────────────────────
    fnc_ctx = ZephyrTools()

    # ── STT: Local Faster-Whisper (OpenAI-compatible endpoint) ─────────────
    stt_engine = lk_openai.STT(
        model="whisper-1",
        base_url=STT_BASE_URL,
        api_key="local-whisper-key",    # dummy key, not validated locally
        language="en",
    )

    # ── LLM: llama.cpp OpenAI-compatible API ───────────────────────────────
    llm_engine = lk_openai.LLM(
        model=LLM_MODEL,
        base_url=LLM_BASE_URL,
        api_key="llama-cpp-key",
        temperature=0.6,
        max_tokens=512,
    )

    # ── TTS: Local Kokoro ONNX (custom adapter) ────────────────────────────
    tts_engine = KokoroTTS(
        base_url=TTS_BASE_URL,
        voice="af_bella",
        speed=1.1,
    )

    # ── Initial system context ─────────────────────────────────────────────
    initial_ctx = llm.ChatContext().append(
        role="system",
        text=SYSTEM_INSTRUCTION,
    )

    # ── Build Voice Pipeline Agent ─────────────────────────────────────────
    agent = VoicePipelineAgent(
        vad=silero.VAD.load(),
        stt=stt_engine,
        llm=llm_engine,
        tts=tts_engine,
        chat_ctx=initial_ctx,
        fnc_ctx=fnc_ctx,
        # Turn-taking config
        allow_interruptions=True,
        interrupt_speech_duration=0.5,      # 500ms of new speech triggers barge-in
        min_endpointing_delay=0.35,          # 350ms silence = end of turn
        max_endpointing_delay=6.0,           # 6s max wait (for industrial noise)
    )

    agent.start(ctx.room)
    logger.info("Voice pipeline started. Broadcasting greeting.")

    await agent.say(
        "Neural link established. Industrial Copilot Zephyr is online and ready.",
        allow_interruptions=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))