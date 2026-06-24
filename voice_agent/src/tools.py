"""
tools.py — ThingsBoard tool definitions for the LiveKit voice agent.

All tools execute via HTTP POST to the ThingsBoard Express server's
REST gateway at POST /api/tools/execute. This avoids duplicating any
bridge logic — the TypeScript bridge remains the single source of truth.

Usage:
    class Assistant(ThingsBoardTools, Agent):
        def __init__(self):
            super().__init__(instructions=...)
"""

import asyncio
import json
import logging
import os

import aiohttp
from livekit.agents import RunContext, function_tool

logger = logging.getLogger("tools")

# ThingsBoard tools server URL (the Express server with /api/tools/execute)
TOOLS_URL = os.environ.get("TOOLS_URL", "http://localhost:9005")
_EXECUTE_ENDPOINT = f"{TOOLS_URL}/api/tools/execute"

# HTTP timeout for tool calls (seconds)
_TOOL_TIMEOUT = aiohttp.ClientTimeout(total=30)

# Longer timeout for heavy analytics tools
_HEAVY_TOOL_TIMEOUT = aiohttp.ClientTimeout(total=120)

_HEAVY_TOOLS = frozenset({
    "perform_deep_analysis",
    "forecast_what_if",
    "query_entity_data",
})

# Global variables for connection pooling
_shared_session: aiohttp.ClientSession | None = None
_session_lock = asyncio.Lock()


async def get_shared_session() -> aiohttp.ClientSession:
    """Retrieve or initialize the global persistent ClientSession."""
    global _shared_session
    async with _session_lock:
        if _shared_session is None or _shared_session.closed:
            connector = aiohttp.TCPConnector(
                limit=10,
                keepalive_timeout=60.0,
                force_close=False,
            )
            # Create session without session-wide timeout to allow custom per-request timeouts
            _shared_session = aiohttp.ClientSession(connector=connector)
        return _shared_session


async def close_shared_session() -> None:
    """Close the global persistent ClientSession on agent shutdown."""
    global _shared_session
    async with _session_lock:
        if _shared_session is not None and not _shared_session.closed:
            await _shared_session.close()
            _shared_session = None


async def _call_tool(
    tool_name: str, args: dict | None = None
) -> str:
    """Execute a tool via HTTP POST to the ThingsBoard tools server.

    Args:
        tool_name: The registered tool name (e.g. "list_devices").
        args: Optional arguments dict to pass to the tool.

    Returns:
        A string representation of the tool result for the LLM to interpret.
    """
    payload = {"name": tool_name, "args": args or {}}
    timeout = _HEAVY_TOOL_TIMEOUT if tool_name in _HEAVY_TOOLS else _TOOL_TIMEOUT

    try:
        session = await get_shared_session()
        async with session.post(
            _EXECUTE_ENDPOINT,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout,
        ) as resp:
            body = await resp.json()

            if resp.status != 200 or not body.get("success"):
                error_msg = body.get("error", f"HTTP {resp.status}")
                logger.warning(
                    f"Tool {tool_name!r} failed: {error_msg}"
                )
                return f"Tool error: {error_msg}"

            result = body.get("result")

            # Format result for voice output
            if result is None:
                return "No data returned."
            if isinstance(result, str):
                return result
            # Compact JSON for the LLM to interpret
            return json.dumps(result, default=str, ensure_ascii=False)

    except aiohttp.ClientError as e:
        logger.error(f"Tool {tool_name!r} HTTP error: {e}")
        return (
            f"Could not reach the ThingsBoard tools server at {TOOLS_URL}. "
            f"Error: {e}"
        )
    except Exception as e:
        logger.exception(f"Tool {tool_name!r} unexpected error:")
        return f"Unexpected error executing tool: {e}"


# ═══════════════════════════════════════════════════════════════════════════
# ThingsBoard Tools Mixin
# ═══════════════════════════════════════════════════════════════════════════
# Each method is a @function_tool() with a docstring matching the
# toolDeclarations from live_agent_ws.ts. The LLM uses these docstrings
# to decide when to call each tool.
# ═══════════════════════════════════════════════════════════════════════════


class ThingsBoardTools:
    """Mixin class providing all ThingsBoard tools as @function_tool methods."""

    # ── Device telemetry & monitoring ─────────────────────────────────────

    @function_tool()
    async def list_devices(self, context: RunContext) -> str:
        """Returns a list of all active industrial devices and sensors
        in the system."""
        return await _call_tool("list_devices")

    @function_tool()
    async def get_current_telemetry(
        self, context: RunContext, device_name: str, keys: str = ""
    ) -> str:
        """Fetches the latest real-time telemetry readings for a specific
        device.

        Args:
            device_name: The exact name of the device.
            keys: Optional comma-separated metric keys list,
                e.g. "temperature,vibration".
        """
        args = {"device_name": device_name}
        if keys:
            args["keys"] = keys
        return await _call_tool("get_current_telemetry", args)

    @function_tool()
    async def get_historical_summary(
        self,
        context: RunContext,
        device_name: str,
        hours: int = 1,
        keys: str = "",
        start_ts: int = 0,
        end_ts: int = 0,
        agg: str = "",
        interval: int = 0,
    ) -> str:
        """Provides an aggregated summary (average, min, max) of telemetry
        over a specific time window.

        Args:
            device_name: The name of the device.
            hours: The number of past hours to analyze (default 1).
            keys: Optional comma-separated metric keys list.
            start_ts: Optional absolute start Epoch milliseconds timestamp.
            end_ts: Optional absolute end Epoch milliseconds timestamp.
            agg: Optional aggregation function: NONE, AVG, MIN, MAX,
                SUM, COUNT.
            interval: Optional aggregation interval in milliseconds.
        """
        args: dict = {"device_name": device_name, "hours": hours}
        if keys:
            args["keys"] = keys
        if start_ts:
            args["startTs"] = start_ts
        if end_ts:
            args["endTs"] = end_ts
        if agg:
            args["agg"] = agg
        if interval:
            args["interval"] = interval
        return await _call_tool("get_historical_summary", args)

    @function_tool()
    async def get_active_alarms(self, context: RunContext) -> str:
        """Checks the entire system for any currently active or critical
        industrial alarms."""
        return await _call_tool("get_active_alarms")

    @function_tool()
    async def get_device_attributes(
        self, context: RunContext, device_name: str
    ) -> str:
        """Retrieves metadata like installation location, model number,
        and static configuration for a device.

        Args:
            device_name: The name of the device.
        """
        return await _call_tool("get_device_attributes", {"device_name": device_name})

    @function_tool()
    async def get_highest_metric(
        self, context: RunContext, metric: str, device_type: str = ""
    ) -> str:
        """Compares all devices and identifies which one currently has the
        highest value for a specific metric.

        Args:
            metric: The metric to compare, e.g. "temperature" or "vibration".
            device_type: Optional device type filter.
        """
        args = {"metric": metric}
        if device_type:
            args["device_type"] = device_type
        return await _call_tool("get_highest_metric", args)

    @function_tool()
    async def get_metric_trend(
        self, context: RunContext, device_name: str, metric: str
    ) -> str:
        """Analyzes if a specific metric is rising, falling, or stable
        compared to the last hour.

        Args:
            device_name: The name of the device.
            metric: The metric to analyze.
        """
        return await _call_tool(
            "get_metric_trend", {"device_name": device_name, "metric": metric}
        )

    @function_tool()
    async def perform_deep_analysis(
        self,
        context: RunContext,
        device_name: str,
        hours: int = 24,
        start_time: str = "",
        end_time: str = "",
    ) -> str:
        """Performs a deep compliance audit over a specific time window.
        Outputs interactive HTML charts.

        Args:
            device_name: Exact name of the device.
            hours: Relative window in hours (default 24).
            start_time: Optional ISO-8601 start time.
            end_time: Optional ISO-8601 end time.
        """
        args: dict = {"device_name": device_name, "hours": hours}
        if start_time:
            args["start_time"] = start_time
        if end_time:
            args["end_time"] = end_time
        return await _call_tool("perform_deep_analysis", args)

    # ── Device lifecycle ──────────────────────────────────────────────────

    @function_tool()
    async def create_device(
        self,
        context: RunContext,
        device_name: str,
        device_type: str,
        label: str = "",
        profile_name: str = "",
        attributes: str = "",
    ) -> str:
        """Registers a new industrial device. Supports profile name linking
        and initial configuration server-scope attributes.

        Args:
            device_name: Unique descriptive name.
            device_type: The category or model of device.
            label: Optional descriptive physical label.
            profile_name: Optional device profile name to bind with.
            attributes: Optional JSON string of initial configuration attributes.
        """
        args: dict = {"device_name": device_name, "device_type": device_type}
        if label:
            args["label"] = label
        if profile_name:
            args["profile_name"] = profile_name
        if attributes:
            try:
                args["attributes"] = (
                    json.loads(attributes)
                    if isinstance(attributes, str)
                    else attributes
                )
            except json.JSONDecodeError:
                return "Error: attributes must be a valid JSON object."
        return await _call_tool("create_device", args)

    @function_tool()
    async def delete_device(
        self, context: RunContext, device_name: str
    ) -> str:
        """Remove a device from the ThingsBoard database.

        Args:
            device_name: Name of the device to delete.
        """
        return await _call_tool("delete_device", {"device_name": device_name})

    @function_tool()
    async def get_device_credentials(
        self, context: RunContext, device_name: str
    ) -> str:
        """Retrieve connection credentials for a device.

        Args:
            device_name: Name of the device.
        """
        return await _call_tool(
            "get_device_credentials", {"device_name": device_name}
        )

    # ── Alarms ────────────────────────────────────────────────────────────

    @function_tool()
    async def acknowledge_alarm(
        self, context: RunContext, alarm_id: str
    ) -> str:
        """Acknowledge an alarm to mark it as being investigated.

        Args:
            alarm_id: Internal UUID of the alarm.
        """
        return await _call_tool("acknowledge_alarm", {"alarm_id": alarm_id})

    @function_tool()
    async def clear_alarm(
        self, context: RunContext, alarm_id: str
    ) -> str:
        """Resolve an alarm once the condition is fixed.

        Args:
            alarm_id: Internal UUID of the alarm.
        """
        return await _call_tool("clear_alarm", {"alarm_id": alarm_id})

    @function_tool()
    async def trigger_rule_engine(
        self, context: RunContext, device_name: str, message: str
    ) -> str:
        """Push custom JSON telemetry data or commands directly into the
        active rule chains.

        Args:
            device_name: Name of the device.
            message: JSON payload string to push.
        """
        try:
            msg_obj = json.loads(message) if isinstance(message, str) else message
        except json.JSONDecodeError:
            msg_obj = {"raw": message}
        return await _call_tool(
            "trigger_rule_engine", {"device_name": device_name, "message": msg_obj}
        )

    @function_tool()
    async def create_alarm(
        self,
        context: RunContext,
        device_name: str,
        alarm_type: str,
        severity: str,
        metric_param: str = "",
        operator_condition: str = "",
        comparison_value: float = 0.0,
        details: str = "",
        status: str = "",
    ) -> str:
        """Creates a structured alarm. Accepts comparison thresholds to replicate UI validation rules.

        Args:
            device_name: Name of the originator device.
            alarm_type: Categorized type, e.g. HighTemperature.
            severity: CRITICAL, MAJOR, MINOR, or WARNING.
            metric_param: Optional telemetry parameter to trigger upon, e.g. temperature.
            operator_condition: Optional comparison operator: GREATER, LESS, EQUALS.
            comparison_value: Optional threshold benchmark value.
            details: Optional JSON string of metadata log payload.
            status: Optional alarm status.
        """
        args: dict = {
            "device_name": device_name,
            "alarm_type": alarm_type,
            "severity": severity,
        }
        if metric_param:
            args["metric_param"] = metric_param
        if operator_condition:
            args["operator_condition"] = operator_condition
        if comparison_value:
            args["comparison_value"] = comparison_value
        if details:
            try:
                args["details"] = (
                    json.loads(details)
                    if isinstance(details, str)
                    else details
                )
            except json.JSONDecodeError:
                args["details"] = {"raw": details}
        if status:
            args["status"] = status
        return await _call_tool("create_alarm", args)

    @function_tool()
    async def find_alarms(
        self,
        context: RunContext,
        entity_name: str = "",
        severity_list: str = "",
        status_list: str = "",
        page_size: int = 10,
    ) -> str:
        """Search and filter active or cleared alarms dynamically by entity,
        severity, status, or text search.

        Args:
            entity_name: Optional filter by specific entity name.
            severity_list: Optional comma-separated severities,
                e.g. "CRITICAL,MAJOR".
            status_list: Optional comma-separated statuses,
                e.g. "ACTIVE_UNACK,ACTIVE_ACK".
            page_size: Number of alarms to fetch (default 10).
        """
        args: dict = {"page_size": page_size}
        if entity_name:
            args["entity_name"] = entity_name
        if severity_list:
            args["severity_list"] = severity_list
        if status_list:
            args["status_list"] = status_list
        return await _call_tool("find_alarms", args)

    @function_tool()
    async def count_alarms(
        self,
        context: RunContext,
        entity_name: str = "",
        severity_list: str = "CRITICAL",
        status_list: str = "ACTIVE_UNACK,ACTIVE_ACK",
    ) -> str:
        """Count active alarms on devices or assets matching severity
        and status filters.

        Args:
            entity_name: Optional filter by specific entity name.
            severity_list: Comma-separated severities (default "CRITICAL").
            status_list: Comma-separated statuses
                (default "ACTIVE_UNACK,ACTIVE_ACK").
        """
        args: dict = {
            "severity_list": severity_list,
            "status_list": status_list,
        }
        if entity_name:
            args["entity_name"] = entity_name
        return await _call_tool("count_alarms", args)

    # ── Rule engine ───────────────────────────────────────────────────────

    @function_tool()
    async def create_rule_chain(
        self,
        context: RunContext,
        name: str,
        nodes: str,
        connections: str,
        first_node_index: int = 0,
    ) -> str:
        """Creates a new rule chain.

        Args:
            name: Name of the rule chain.
            nodes: JSON array string of node definitions.
            connections: JSON array string of connection definitions.
            first_node_index: Optional index of the first node.
        """
        try:
            nodes_obj = json.loads(nodes) if isinstance(nodes, str) else nodes
            conns_obj = (
                json.loads(connections)
                if isinstance(connections, str)
                else connections
            )
        except json.JSONDecodeError:
            return "Error: nodes and connections must be valid JSON arrays."
        args: dict = {
            "name": name,
            "nodes": nodes_obj,
            "connections": conns_obj,
        }
        if first_node_index:
            args["first_node_index"] = first_node_index
        return await _call_tool("create_rule_chain", args)

    @function_tool()
    async def inject_rule_engine_queue(
        self,
        context: RunContext,
        device_name: str,
        message_payload: str,
        queue_name: str,
    ) -> str:
        """Pushes JSON payloads straight into custom Rule Engine queues.

        Args:
            device_name: Name of the device.
            message_payload: JSON payload string to inject.
            queue_name: Target queue name.
        """
        try:
            payload_obj = (
                json.loads(message_payload)
                if isinstance(message_payload, str)
                else message_payload
            )
        except json.JSONDecodeError:
            payload_obj = {"raw": message_payload}
        return await _call_tool(
            "inject_rule_engine_queue",
            {
                "device_name": device_name,
                "message_payload": payload_obj,
                "queue_name": queue_name,
            },
        )

    # ── Assets ────────────────────────────────────────────────────────────

    @function_tool()
    async def list_assets(self, context: RunContext) -> str:
        """Returns a list of all active asset structures registered
        in the tenant environment."""
        return await _call_tool("list_assets")

    @function_tool()
    async def get_asset_by_name(
        self, context: RunContext, asset_name: str
    ) -> str:
        """Fetches complete metadata configuration for a named asset.

        Args:
            asset_name: Exact asset name.
        """
        return await _call_tool("get_asset_by_name", {"asset_name": asset_name})

    @function_tool()
    async def create_asset(
        self,
        context: RunContext,
        asset_name: str,
        asset_type: str,
        label: str = "",
    ) -> str:
        """Creates a new asset structure node inside the factory schema map.

        Args:
            asset_name: Name of the asset.
            asset_type: Physical or logical type.
            label: Optional descriptive label.
        """
        args: dict = {"asset_name": asset_name, "asset_type": asset_type}
        if label:
            args["label"] = label
        return await _call_tool("create_asset", args)

    @function_tool()
    async def delete_asset(
        self, context: RunContext, asset_name: str
    ) -> str:
        """Deletes an asset structure from the ThingsBoard environment.

        Args:
            asset_name: Name of the asset.
        """
        return await _call_tool("delete_asset", {"asset_name": asset_name})

    # ── Relations ─────────────────────────────────────────────────────────

    @function_tool()
    async def create_relation(
        self,
        context: RunContext,
        from_name: str,
        to_name: str,
        relation_type: str,
    ) -> str:
        """Establishes a semantic relationship between two entities.
        Automatically resolves entity names to UUIDs.

        Args:
            from_name: The device or asset name originating the relationship.
            to_name: The device or asset name target of the relationship.
            relation_type: Relation descriptor, e.g. Contains, ManagedBy.
        """
        return await _call_tool(
            "create_relation",
            {
                "from_name": from_name,
                "to_name": to_name,
                "relation_type": relation_type,
            },
        )

    @function_tool()
    async def delete_relation(
        self,
        context: RunContext,
        from_name: str,
        to_name: str,
        relation_type: str,
    ) -> str:
        """Removes a mapped relationship between two named entities.

        Args:
            from_name: The source entity name.
            to_name: The target entity name.
            relation_type: Relationship identifier.
        """
        return await _call_tool(
            "delete_relation",
            {
                "from_name": from_name,
                "to_name": to_name,
                "relation_type": relation_type,
            },
        )

    @function_tool()
    async def list_relations(
        self, context: RunContext, entity_name: str
    ) -> str:
        """Lists all outgoing relationship mappings from a named entity.

        Args:
            entity_name: The named device or asset to scan.
        """
        return await _call_tool("list_relations", {"entity_name": entity_name})

    # ── Device attributes ─────────────────────────────────────────────────

    @function_tool()
    async def save_device_attributes(
        self,
        context: RunContext,
        device_name: str,
        scope: str,
        attributes: str,
    ) -> str:
        """Writes attributes within selected scoping metrics
        (SERVER_SCOPE, SHARED_SCOPE).

        Args:
            device_name: Name of the device.
            scope: Scoping metric (e.g. SERVER_SCOPE).
            attributes: JSON string of metadata configurations payload.
        """
        try:
            attrs_obj = (
                json.loads(attributes) if isinstance(attributes, str) else attributes
            )
        except json.JSONDecodeError:
            return "Error: attributes must be valid JSON."
        return await _call_tool(
            "save_device_attributes",
            {"device_name": device_name, "scope": scope, "attributes": attrs_obj},
        )

    @function_tool()
    async def delete_device_attributes(
        self,
        context: RunContext,
        device_name: str,
        scope: str,
        keys: str,
    ) -> str:
        """Deletes specific attribute parameters mapped to a target device.

        Args:
            device_name: Name of the device.
            scope: Attribute scope (e.g. SERVER_SCOPE).
            keys: Comma-separated list of attribute keys to delete.
        """
        keys_list = [k.strip() for k in keys.split(",") if k.strip()]
        return await _call_tool(
            "delete_device_attributes",
            {"device_name": device_name, "scope": scope, "keys": keys_list},
        )

    # ── Dashboards ────────────────────────────────────────────────────────

    @function_tool()
    async def list_dashboards(self, context: RunContext) -> str:
        """List configuration profiles of active monitoring dashboards."""
        return await _call_tool("list_dashboards")

    @function_tool()
    async def get_dashboard_by_id(
        self, context: RunContext, dashboard_id: str
    ) -> str:
        """Fetches the structured config profile for a dashboard.

        Args:
            dashboard_id: UUID of the dashboard.
        """
        return await _call_tool(
            "get_dashboard_by_id", {"dashboard_id": dashboard_id}
        )

    @function_tool()
    async def assign_dashboard_to_customer(
        self, context: RunContext, customer_id: str, dashboard_id: str
    ) -> str:
        """Assigns access controls for a dashboard to a specified
        customer user group.

        Args:
            customer_id: UUID of the customer.
            dashboard_id: UUID of the dashboard.
        """
        return await _call_tool(
            "assign_dashboard_to_customer",
            {"customer_id": customer_id, "dashboard_id": dashboard_id},
        )

    @function_tool()
    async def create_device_dashboard(
        self,
        context: RunContext,
        device_name: str,
        monitored_keys: str = "",
        dashboard_title: str = "",
        background_color: str = "",
    ) -> str:
        """Builds a structured real-time line chart monitoring dashboard.

        Args:
            device_name: Exact name of the device.
            monitored_keys: Comma-separated telemetry fields to plot.
            dashboard_title: Optional operational title.
            background_color: Optional visual style Hex code.
        """
        args: dict = {"device_name": device_name}
        if monitored_keys:
            args["monitored_keys"] = [
                k.strip() for k in monitored_keys.split(",") if k.strip()
            ]
        if dashboard_title:
            args["dashboard_title"] = dashboard_title
        if background_color:
            args["background_color"] = background_color
        return await _call_tool("create_device_dashboard", args)

    # ── Device profiles ───────────────────────────────────────────────────

    @function_tool()
    async def list_device_profiles(self, context: RunContext) -> str:
        """Lists all device profiles established in the database context."""
        return await _call_tool("list_device_profiles")

    @function_tool()
    async def get_device_profile_by_id(
        self, context: RunContext, profile_id: str
    ) -> str:
        """Fetches configuration parameters for a specific device profile.

        Args:
            profile_id: UUID of the device profile.
        """
        return await _call_tool(
            "get_device_profile_by_id", {"profile_id": profile_id}
        )

    # ── RPC ───────────────────────────────────────────────────────────────

    @function_tool()
    async def send_one_way_rpc(
        self,
        context: RunContext,
        device_name: str,
        method: str,
        params: str = "{}",
    ) -> str:
        """Issues a fire-and-forget remote action directly to a physical
        device node.

        Args:
            device_name: Name of the device.
            method: The RPC method to invoke.
            params: JSON string of parameters.
        """
        try:
            params_obj = json.loads(params) if isinstance(params, str) else params
        except json.JSONDecodeError:
            params_obj = {}
        return await _call_tool(
            "send_one_way_rpc",
            {"device_name": device_name, "method": method, "params": params_obj},
        )

    @function_tool()
    async def send_two_way_rpc(
        self,
        context: RunContext,
        device_name: str,
        method: str,
        params: str = "{}",
        timeout: int = 0,
    ) -> str:
        """Issues a command and waits for physical loop status response.

        Args:
            device_name: Name of the device.
            method: The RPC method to invoke.
            params: JSON string of parameters.
            timeout: Optional response timeout in milliseconds.
        """
        try:
            params_obj = json.loads(params) if isinstance(params, str) else params
        except json.JSONDecodeError:
            params_obj = {}
        args = {"device_name": device_name, "method": method, "params": params_obj}
        if timeout:
            args["timeout"] = timeout
        return await _call_tool("send_two_way_rpc", args)

    @function_tool()
    async def list_persistent_rpcs(
        self, context: RunContext, device_name: str
    ) -> str:
        """Lists queued device remote controller command records.

        Args:
            device_name: Name of the device.
        """
        return await _call_tool(
            "list_persistent_rpcs", {"device_name": device_name}
        )

    # ── Audit & analytics ─────────────────────────────────────────────────

    @function_tool()
    async def get_audit_logs(self, context: RunContext) -> str:
        """Fetches structured log files mapping changes and interactions
        with system configurations."""
        return await _call_tool("get_audit_logs")

    @function_tool()
    async def forecast_what_if(
        self,
        context: RunContext,
        device_name: str,
        target_metric: str,
        prediction_horizon_steps: int = 96,
        question_type: str = "",
        crossing_threshold: float = 0.0,
        interventions: str = "",
    ) -> str:
        """Performs a What-if predictive analysis using multivariate
        forecasting. Simulates interventions on covariates over a
        prediction horizon and projects the target metric.

        Args:
            device_name: The exact name of the device.
            target_metric: The target telemetry parameter to forecast
                (e.g. vibration, temperature).
            prediction_horizon_steps: Number of time steps (15-min intervals)
                to forecast (default 96 = 24 hours).
            question_type: Analytical question type: peak, crossing,
                or recurrence.
            crossing_threshold: Threshold value for crossing question type.
            interventions: JSON array string of intervention objects, each
                with metric, action (scale or set), and value.
        """
        args: dict = {
            "device_name": device_name,
            "target_metric": target_metric,
            "prediction_horizon_steps": prediction_horizon_steps,
        }
        if question_type:
            args["question_type"] = question_type
        if crossing_threshold:
            args["crossing_threshold"] = crossing_threshold
        if interventions:
            try:
                args["interventions"] = (
                    json.loads(interventions)
                    if isinstance(interventions, str)
                    else interventions
                )
            except json.JSONDecodeError:
                return "Error: interventions must be a valid JSON array."
        return await _call_tool("forecast_what_if", args)

    # ── Advanced query tools ──────────────────────────────────────────────

    @function_tool()
    async def find_highest_entity_metric(
        self,
        context: RunContext,
        metric: str,
        device_type: str = "",
    ) -> str:
        """Find which device or asset currently has the highest value
        for a specific metric key.

        Args:
            metric: Metric key name to compare
                (e.g. "temperature", "vibration").
            device_type: Optional device type filter,
                e.g. "industrial_sensor".
        """
        args: dict = {"metric": metric}
        if device_type:
            args["device_type"] = device_type
        return await _call_tool("find_highest_entity_metric", args)

    @function_tool()
    async def query_entity_data(
        self, context: RunContext, query_json: str
    ) -> str:
        """Bulk fetch telemetry and attribute data using filter rules,
        page constraints, and predicates.

        Args:
            query_json: Full JSON query structure including entityFilter,
                latestValues, pageLink, keyFilters.
        """
        try:
            payload = json.loads(query_json)
        except json.JSONDecodeError:
            return "Error: query_json must be valid JSON."
        return await _call_tool("query_entity_data", payload)

    @function_tool()
    async def count_entities(
        self, context: RunContext, entity_filter_json: str
    ) -> str:
        """Count devices or assets matching attribute or telemetry filters.

        Args:
            entity_filter_json: JSON structure of entityFilter.
        """
        try:
            ef = json.loads(entity_filter_json)
        except json.JSONDecodeError:
            return "Error: entity_filter_json must be valid JSON."
        return await _call_tool("count_entities", {"entity_filter_json": json.dumps(ef)})

    @function_tool()
    async def find_available_keys(
        self, context: RunContext, entity_filter_json: str
    ) -> str:
        """Retrieve all telemetry and attribute keys currently saved
        on entities matching a filter.

        Args:
            entity_filter_json: JSON structure of entityFilter.
        """
        try:
            ef = json.loads(entity_filter_json)
        except json.JSONDecodeError:
            return "Error: entity_filter_json must be valid JSON."
        return await _call_tool(
            "find_available_keys", {"entity_filter_json": json.dumps(ef)}
        )

    @function_tool()
    async def get_rule_node_events(
        self, context: RunContext, rule_node_id: str, limit: int = 10
    ) -> str:
        """Retrieve real-time event logs and diagnostics from a custom
        rule node to debug rule chains.

        Args:
            rule_node_id: UUID of the rule node.
            limit: Max event logs to fetch (default 10).
        """
        return await _call_tool(
            "get_rule_node_events",
            {"ruleNodeId": rule_node_id, "limit": limit},
        )

    @function_tool()
    async def provision_customer_dashboard(
        self, context: RunContext, customer_id: str, dashboard_id: str
    ) -> str:
        """Assign access and visibility rights for a dashboard to a
        designated customer tenant.

        Args:
            customer_id: UUID of the customer.
            dashboard_id: UUID of the dashboard.
        """
        return await _call_tool(
            "provision_customer_dashboard",
            {"customerId": customer_id, "dashboardId": dashboard_id},
        )
