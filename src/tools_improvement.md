# ThingsBoard Automation Tools Upgrade Specification

This document provides a detailed blueprint for refactoring the application's tool library to align perfectly with the [ThingsBoard REST API](https://thingsboard.io/docs/pe/reference/rest-api/). 

---

## 1. Core Architectural Transformations

To eliminate failures (such as blank dashboards or unresolvable entity errors), the application's execution logic must handle two fundamental platform behaviors before making raw REST calls:

### I. The Name-to-UUID Translation Layer
ThingsBoard controllers strictly require structured UUID strings (e.g., `784f394c-42b6-435a-983c-b7beff2784f9`). They do not accept human-readable names like `"Sensor_A1"`.
* **Implementation Rule:** Your backend wrapper must intercept any tool argument ending in `_name`, run a quick text-search look-up query using the `device-controller` or `asset-controller` APIs (`GET /api/tenant/devices?textSearch=...`), extract the authentic UUID, and pass that forward.

### II. Resolving Blank Dashboards
When you use `/api/dashboard`, ThingsBoard initializes a completely empty registry entry. It does not know which devices you want to see or what visual charts you want to display. To fix this, your tool must programmatically construct a complete, nested `configuration` object containing:
1. **`entityAliases`**: Maps a local alias ID to your target device or asset UUID.
2. **`widgets`**: An array containing a unique layout layout, data keys, and the exact full target path identifier (`typeFullFqn`) of the UI widget.

---

## 2. Comprehensive Tool Refinement Specification

### Telemetry & Monitoring

#### 1. get_current_telemetry
* **Problem:** Identifying devices by name will fail.
* **Fix:** Resolve `device_name` to `deviceId`. Add an optional `keys` parameter to limit payload size and improve network speed.
* **Target Controller:** `telemetry-controller`
* **HTTP Path:** `GET /api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries`
* **Upgraded Input Schema:**
```json
{
  "deviceId": "string (UUID)",
  "keys": "string (Optional, comma-separated, e.g., 'temperature,vibration')"
}





2. get_historical_summary
Problem: ThingsBoard does not accept relative intervals like "hours".

Fix: Convert your relative hours value into absolute millisecond UNIX timestamps (startTs and endTs). You must also explicitly provide an aggregation function (agg) and a step interval (interval).

Target Controller: telemetry-controller

HTTP Path: GET /api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries

Upgraded Input Schema:

JSON
{
  "deviceId": "string (UUID)",
  "keys": "string (Comma-separated list)",
  "startTs": "long (Epoch milliseconds)",
  "endTs": "long (Epoch milliseconds)",
  "agg": "string (NONE, AVG, MIN, MAX, SUM, COUNT)",
  "interval": "long (Window size in milliseconds, required if agg is not NONE)"
}


get_device_attributes
Problem: The platform separates attributes by scope (SERVER_SCOPE, SHARED_SCOPE, CLIENT_SCOPE). Passing just a name leaves the scope ambiguous.

Fix: Map device_name to deviceId. Query the base values endpoint, which automatically merges all scopes into a singular, consolidated response object.

Target Controller: telemetry-controller

HTTP Path: GET /api/plugins/telemetry/DEVICE/{deviceId}/values/attributes

Upgraded Input Schema:

JSON
{
  "deviceId": "string (UUID)"
}


Device Lifecycle
4. create_device
Problem: Providing a plain string for the device profile name causes validation errors.

Fix: The backend API strictly expects a structured, nested deviceProfileId object containing both the operational ID and the target entity type classification string.

Target Controller: device-controller

HTTP Path: POST /api/device

Upgraded Input Schema:

JSON
{
  "name": "string",
  "type": "string (e.g., 'default')",
  "label": "string (Optional)",
  "deviceProfileId": {
    "id": "string (UUID)",
    "entityType": "DEVICE_PROFILE"
  }
}



5. create_alarm
Problem: The system requires an explicit originator mapping structure (so it knows if the alarm belongs to a Device, Asset, or Tenant) along with an explicit initial state.

Fix: Restructure the input to build an originator entity descriptor block and provide an initialization state status.

Target Controller: alarm-controller

HTTP Path: POST /api/alarm

Upgraded Input Schema:

JSON
{
  "name": "string (Alarm Type Identifier)",
  "type": "string",
  "originator": {
    "id": "string (UUID)",
    "entityType": "string (DEVICE or ASSET)"
  },
  "severity": "string (CRITICAL, MAJOR, MINOR, WARNING, INDETERMINATE)",
  "status": "string (ACTIVE_UNACK, ACTIVE_ACK)"
}



Asset & Relations
6. create_relation
Problem: Flat string inputs (from_name, to_name) cannot be processed natively by the relation graph engine.

Fix: Map both anchor points to structured EntityId descriptors and declare the categorization group type explicitly.

Target Controller: entity-relation-controller

HTTP Path: POST /api/relation

Upgraded Input Schema:

JSON
{
  "from": {
    "id": "string (UUID)",
    "entityType": "string (e.g., 'ASSET')"
  },
  "to": {
    "id": "string (UUID)",
    "entityType": "string (e.g., 'DEVICE')"
  },
  "type": "string (e.g., 'Contains')",
  "typeGroup": "string (Default: 'COMMON')"
}




Dashboards & UI Automation
7. create_device_dashboard
Problem: Creating a dashboard with raw fields like device_name and monitored_keys results in a blank UI canvas because ThingsBoard expects a complete widget layout architecture.

Fix: Your backend automation logic must intercept these simple arguments and programmatically generate a fully structural configuration tree containing an entity alias filter and an operational chart configuration array.

Target Controller: dashboard-controller

HTTP Path: POST /api/dashboard

Complete Working Production Payload Example:

JSON
{
  "title": "Industrial Live Analytics Dashboard",
  "configuration": {
    "description": "Auto-generated runtime asset tracking canvas",
    "entityAliases": {
      "alias_device_target": {
        "id": "alias_device_target",
        "alias": "Primary Monitored Node",
        "filter": {
          "type": "singleEntity",
          "singleEntity": {
            "entityType": "DEVICE",
            "id": "4da692c0-bc11-11ee-8c44-ad3d6a213bc8"
          }
        }
      }
    },
    "widgets": [
      {
        "isSystemType": true,
        "bundleAlias": "charts",
        "typeFullFqn": "charts.timeseries",
        "title": "Real-Time Metric Stream",
        "sizeX": 12,
        "sizeY": 6,
        "config": {
          "datasources": [
            {
              "type": "entity",
              "entityAliasId": "alias_device_target",
              "dataKeys": [
                {
                  "name": "temperature",
                  "type": "timeseries",
                  "label": "Temperature (°C)",
                  "color": "#F44336"
                }
              ]
            }
          ],
          "timewindow": {
            "realtime": {
              "timewindowMs": 600000
            }
          }
        }
      }
    ]
  }
}


RPC Commands
8. send_two_way_rpc
Problem: Older RPC controller paths are outdated, and stringifying JSON arguments can corrupt complex nested data structures.

Fix: Update execution to use the V2 controller path. Accept the execution parameters directly as a native, un-serialized JSON object block.

Target Controller: rpc-v-2-controller

HTTP Path: POST /api/rpc/twoway/{deviceId}

Upgraded Input Schema:

JSON
{
  "deviceId": "string (UUID)",
  "requestBody": {
    "method": "string (Firmware action call name)",
    "params": "object (Direct JSON structure mapping payload values)",
    "timeout": "long (Optional, execution limit in milliseconds)"
  }
}


3. Recommended New Tools for System Expansion
To round out your automation engine, consider introducing these high-value infrastructure tools to your application:

Tool 38: query_entity_data
Description: Performs bulk telemetry fetching. Instead of looping multiple individual device calls (which risks hitting API rate limits), this tool uses a single execution path to fetch current metrics across an entire asset group or device array simultaneously.

Target Endpoint: POST /api/query/v1/entitiesData

Accepts: Filter rules, data keys array, pagination configuration.

Tool 39: get_rule_node_events
Description: Intercepts real-time error logs and diagnostic telemetry from the processing pipeline. Essential for debugging custom rule chains when payloads break down or fail to execute properly.

Target Endpoint: GET /api/events/RULE_NODE/{ruleNodeId}

Accepts: { ruleNodeId: string, limit: integer }

Tool 40: provision_customer_dashboard
Description: Streamlines multi-tenant permission assignment. After programmatically building a customized device layout dashboard, this tool assigns access and visibility rights directly to a target customer tenant.

Target Endpoint: POST /api/customer/{customerId}/dashboard/{dashboardId}

Accepts: { customerId: string, dashboardId: string }




Part 2: Upgraded Alarm Tool Specifications
Here is the precise refactoring for your alarm-centric tools, rewritten to utilize the structural parameters of the Alarm Query API.

4. get_active_alarms (Refactored to find_alarms)
What Changes: Your original tool only accepted {} and returned a fixed array. We are upgrading it to a fully dynamic search engine utilizing the POST /api/alarmsQuery/find structure. This allows your app to filter down to specific severities, search text, or time ranges on the fly.

Target Endpoint: POST /api/alarmsQuery/find

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "entityType",
    "entityType": "DEVICE"
  },
  "pageLink": {
    "pageSize": 10,
    "page": 0,
    "sortOrder": {
      "key": { "type": "ALARM_FIELD", "key": "createdTime" },
      "direction": "DESC"
    },
    "textSearch": "string (Optional - filter by specific text flag)",
    "severityList": ["CRITICAL", "MAJOR"],
    "statusList": ["ACTIVE"]
  },
  "alarmFields": [
    { "type": "ALARM_FIELD", "key": "createdTime" },
    { "type": "ALARM_FIELD", "key": "type" },
    { "type": "ALARM_FIELD", "key": "severity" },
    { "type": "ALARM_FIELD", "key": "status" }
  ],
  "entityFields": [
    { "type": "ENTITY_FIELD", "key": "name" }
  ]
}
15. create_alarm
What Changes: Requires a structured originator identity block mapping to an actual device UUID instead of a plain-text device name, along with a validated initial operational status.

Target Endpoint: POST /api/alarm

Complete Production Payload Schema:

JSON
{
  "name": "string (e.g., 'HIGH_TEMPERATURE')",
  "type": "string (Alarm identifier type matching profile rules)",
  "originator": {
    "id": "string (UUID - Resolved from device_name)",
    "entityType": "DEVICE"
  },
  "severity": "CRITICAL",
  "status": "ACTIVE_UNACK",
  "propagate": true,
  "details": {
    "description": "Manual threshold breach triggered by automation runner script."
  }
}
New Expansion Tool: count_alarms
Description: Sometimes your automation doesn't need to see the entire list of alarms; it just needs to know how many critical issues are happening right now to trigger safety procedures. This tool uses the optimized count signature from the reference docs.

Target Endpoint: POST /api/alarmsQuery/count

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "entityType",
    "entityType": "DEVICE"
  },
  "severityList": ["CRITICAL"],
  "statusList": ["ACTIVE"],
  "keyFilters": []
}



Part 1: Core Architectural Mapping for Data Queries
When implementing the Entity Data Query architecture into your application, you must handle the three structural pillars defined by the documentation:

I. The Core Query Structure (POST /api/entitiesQuery/find)
Every lookup or metrics tool should accept and construct this unified 5-layer schema:

entityFilter: Identifies which assets or devices to look up (by list, prefix, type, or relation).

keyFilters: Matches conditions based on values (e.g., temperature > 80).

pageLink: Handles sorting, pagination, and text-based searching.

entityFields: Returns core entity fields (name, label, type).

latestValues: Pulls the most up-to-date telemetry or attributes in the same single API request.

II. Native Predicate Matching
Instead of filtering datasets in your application code, push the computation down to the database using native predicates:

String Predicates: EQUAL, NOT_EQUAL, STARTS_WITH, ENDS_WITH, CONTAINS, IN.

Numeric Predicates: EQUAL, GREATER, LESS, GREATER_OR_EQUAL, LESS_OR_EQUAL.

Complex Predicates: Nest arrays using AND / OR structural logic wrappers.

Part 2: Upgraded Tool Specifications
Here is the exact refactoring required for your telemetry and metric lookup tools using the Entity Data Query API.

6. get_highest_metric (Refactored to find_highest_entity_metric)
The Upgrade: Your old tool pulled a single key for a single device name. We are upgrading this to query a whole group of devices (or an entire device profile type), sorting descending by that metric key, and returning the top result. This avoids rate-limiting loop structures.

Target Endpoint: POST /api/entitiesQuery/find

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "deviceType",
    "deviceTypes": ["industrial_sensor"],
    "deviceNameFilter": ""
  },
  "pageLink": {
    "pageSize": 1,
    "page": 0,
    "sortOrder": {
      "key": { "type": "TIME_SERIES", "key": "vibration" },
      "direction": "DESC"
    }
  },
  "entityFields": [
    { "type": "ENTITY_FIELD", "key": "name" }
  ],
  "latestValues": [
    { "type": "TIME_SERIES", "key": "vibration" }
  ],
  "keyFilters": []
}
38. query_entity_data (Your Bulk Execution Tool)
The Upgrade: Fully implements complex criteria matching. For instance, finding all devices within a factory zone where the battery level is critically low.

Target Endpoint: POST /api/entitiesQuery/find

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "relationsQuery",
    "rootEntity": {
      "entityType": "ASSET",
      "id": "784f394c-42b6-435a-983c-b7beff2784f9"
    },
    "direction": "FROM",
    "maxLevel": 2,
    "filters": [
      { "relationType": "Contains", "entityTypes": ["DEVICE"] }
    ]
  },
  "pageLink": {
    "pageSize": 50,
    "page": 0,
    "sortOrder": {
      "key": { "type": "ENTITY_FIELD", "key": "name" },
      "direction": "ASC"
    }
  },
  "entityFields": [
    { "type": "ENTITY_FIELD", "key": "name" },
    { "type": "ENTITY_FIELD", "key": "type" }
  ],
  "latestValues": [
    { "type": "TIME_SERIES", "key": "batteryLevel" },
    { "type": "ATTRIBUTE", "key": "active" }
  ],
  "keyFilters": [
    {
      "key": { "type": "TIME_SERIES", "key": "batteryLevel" },
      "valueType": "NUMERIC",
      "predicate": {
        "type": "NUMERIC",
        "operation": "LESS_OR_EQUAL",
        "value": { "defaultValue": 20.0 }
      }
    }
  ]
}
Part 3: High-Value Expansion Tools from this Reference
Adding these two native data-querying endpoints will significantly enhance your orchestration platform:

New Expansion Tool: count_entities
Description: Instantly counts entities matching a dynamic filter (e.g., getting the total number of offline devices) without pulling the full payload data structure.

Target Endpoint: POST /api/entitiesQuery/count

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "entityType",
    "entityType": "DEVICE"
  },
  "keyFilters": [
    {
      "key": { "type": "ATTRIBUTE", "key": "active" },
      "valueType": "BOOLEAN",
      "predicate": {
        "type": "BOOLEAN",
        "operation": "EQUAL",
        "value": { "defaultValue": false }
      }
    }
  ]
}
New Expansion Tool: find_available_keys
Description: Returns a complete mapping list of all telemetry and attribute keys currently saved on matching entities. This is perfect for keeping dashboard widget builders truly dynamic.

Target Endpoint: POST /api/v2/entitiesQuery/find/keys?includeTimeseries=true&includeAttributes=true

Complete Production Payload Schema:

JSON
{
  "entityFilter": {
    "type": "deviceType",
    "deviceTypes": ["thermostat"],
    "deviceNameFilter": ""
  },
  "keyFilter
