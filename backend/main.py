import torch
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Dict, List, Any, Optional
from chronos import Chronos2Pipeline
from scipy.signal import find_peaks

# Thread-safe global layout reference container
engine_registry: Dict[str, Any] = {}

class Intervention(BaseModel):
    metric: str = Field(..., description="The name of the covariate metric (e.g. pressure, speed)")
    action: str = Field(..., description="The action to perform: 'scale' or 'set'")
    value: float = Field(..., description="The factor to scale by or value to set to")

class HistoryData(BaseModel):
    timestamps: List[int] = Field(..., description="Epoch timestamps in milliseconds or seconds")
    target_values: List[float] = Field(..., description="Historical values of the target metric")
    covariates: Dict[str, List[float]] = Field(..., description="Historical values of the covariates")

class WhatIfRequest(BaseModel):
    target_name: str = Field(..., description="Target metric name to forecast (e.g. vibration)")
    frequency_minutes: int = Field(15, description="Frequency interval between data points in minutes")
    history: HistoryData = Field(..., description="Historical data containing target and covariates")
    simulation_horizon: int = Field(96, ge=1, le=1024, description="Steps ahead to predict (max 1024)")
    interventions: List[Intervention] = Field(default=[], description="List of covariate interventions")
    question_type: str = Field("peak", description="The type of question: 'peak', 'crossing', 'recurrence'")
    crossing_threshold: Optional[float] = Field(None, description="Threshold value if question_type is 'crossing'")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Safely mounts global GPU/RAM memory components exactly once during system activation.
    """
    print("Pre-loading optimized weights for Amazon Chronos-2 Model...")
    
    # Load the universal Chronos-2 foundation model
    # Uses bfloat16 and maps to CPU/GPU dynamically
    pipeline = Chronos2Pipeline.from_pretrained(
        "amazon/chronos-2",
        torch_dtype=torch.bfloat16,
        device_map="auto"
    )
    
    engine_registry["chronos_model"] = pipeline
    print("Chronos-2 Core Neural Processing Unit Online.")
    yield
    engine_registry.clear()

app = FastAPI(title="Chronos-2 What-If Forecasting Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/forecast_what_if", status_code=status.HTTP_200_OK)
def forecast_what_if(payload: WhatIfRequest):
    """
    Consumes historical sequences and simulates what-if interventions on covariates,
    running multivariate inference via Chronos-2 to project target metric outcomes.
    """
    if "chronos_model" not in engine_registry:
        raise HTTPException(
            status_code=503, 
            detail="Forecasting pipeline is currently offline or loading parameters."
        )

    pipeline = engine_registry["chronos_model"]

    # 1. Input validations
    timestamps = payload.history.timestamps
    target_values = payload.history.target_values
    covariates = payload.history.covariates

    n_samples = len(timestamps)
    if n_samples < 2:
        raise HTTPException(status_code=422, detail="History must contain at least 2 data points.")

    if len(target_values) != n_samples:
        raise HTTPException(status_code=422, detail="target_values length must match timestamps length.")

    for k, v in covariates.items():
        if len(v) != n_samples:
            raise HTTPException(status_code=422, detail=f"Covariate '{k}' length must match timestamps length.")

    # 2. Build future covariate tracks
    future_covariates = {}
    for key, values in covariates.items():
        last_val = values[-1] if len(values) > 0 else 0.0
        # Extrapolate holding the last historical value constant
        future_covariates[key] = [last_val] * payload.simulation_horizon

    # Apply scaling or setting interventions on future tracks
    for intv in payload.interventions:
        metric = intv.metric
        if metric in future_covariates:
            if intv.action == "set":
                future_covariates[metric] = [intv.value] * payload.simulation_horizon
            elif intv.action == "scale":
                future_covariates[metric] = [v * intv.value for v in future_covariates[metric]]

    # 3. Create context and future DataFrames for Chronos-2 predict_df
    # Chronos-2 uses datetime timestamp inputs to align context and future covs.
    is_ms = max(timestamps) > 1e11
    dt_history = pd.to_datetime(timestamps, unit='ms' if is_ms else 's')

    # Construct historical DataFrame (includes target + past covariates)
    context_data = {
        "item_id": ["device"] * n_samples,
        "timestamp": dt_history,
        "target": target_values
    }
    for key, values in covariates.items():
        context_data[key] = values
    context_df = pd.DataFrame(context_data)

    # Generate future timestamps sequence
    last_dt = dt_history[-1]
    freq_str = f"{payload.frequency_minutes}min"
    future_dts = pd.date_range(
        start=last_dt + pd.Timedelta(minutes=payload.frequency_minutes), 
        periods=payload.simulation_horizon, 
        freq=freq_str
    )

    # Construct future DataFrame (includes target padded with NaN + future covariates)
    future_data = {
        "item_id": ["device"] * payload.simulation_horizon,
        "timestamp": future_dts,
        "target": [np.nan] * payload.simulation_horizon
    }
    for key, values in future_covariates.items():
        future_data[key] = values
    future_df = pd.DataFrame(future_data)

    # 4. Chronos-2 Inference Execution
    try:
        forecast_df = pipeline.predict_df(
            context_df,
            future_df=future_df,
            prediction_length=payload.simulation_horizon,
            quantile_levels=[0.1, 0.5, 0.9],
            id_column="item_id",
            timestamp_column="timestamp",
            target="target"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference execution failed: {str(e)}")

    # Extract quantiles output (predict_df returns columns: item_id, timestamp, 0.1, 0.5, 0.9)
    try:
        p10 = forecast_df["0.1"].tolist()
        p50 = forecast_df["0.5"].tolist()
        p90 = forecast_df["0.9"].tolist()
    except KeyError as ke:
        raise HTTPException(
            status_code=500, 
            detail=f"Inference did not return expected quantile formats. Found columns: {forecast_df.columns.tolist()}"
        )

    # Convert future timestamps back to the caller's epoch format
    future_epochs = []
    for dt in future_dts:
        epoch = int(dt.timestamp() * 1000) if is_ms else int(dt.timestamp())
        future_epochs.append(epoch)

    # 5. Mathematical Feature Extraction (SciPy peaks and crossings)
    peaks, _ = find_peaks(p50, prominence=0.05)
    peak_val = None
    peak_time = None
    peak_detected = False
    peak_idx = None

    if len(peaks) > 0:
        # Find the index of the highest peak in the predicted median path
        highest_peak_idx = peaks[np.argmax([p50[p] for p in peaks])]
        peak_val = float(p50[highest_peak_idx])
        peak_time = future_epochs[highest_peak_idx]
        peak_detected = True
        peak_idx = highest_peak_idx
    else:
        # Fallback to the maximum predicted value over the horizon
        max_idx = np.argmax(p50)
        peak_val = float(p50[max_idx])
        peak_time = future_epochs[max_idx]
        peak_detected = False
        peak_idx = max_idx

    # Threshold crossing check
    crossing_detected = False
    crossing_time = None
    if payload.crossing_threshold is not None:
        threshold = payload.crossing_threshold
        for idx, val in enumerate(p50):
            if val >= threshold:
                crossing_detected = True
                crossing_time = future_epochs[idx]
                break

    # Recurrence intervals evaluation
    recurrence_period_hours = None
    if len(peaks) >= 2:
        # Average interval between consecutive local maxima peaks
        peak_diffs = np.diff(peaks)
        mean_steps = np.mean(peak_diffs)
        recurrence_period_hours = float((mean_steps * payload.frequency_minutes) / 60.0)
    elif len(peaks) == 1:
        # Hours from prediction start to the single peak
        recurrence_period_hours = float((peaks[0] * payload.frequency_minutes) / 60.0)
    else:
        # Hours from prediction start to maximum predicted target point
        recurrence_period_hours = float((peak_idx * payload.frequency_minutes) / 60.0)

    response_payload = {
        "status": "success",
        "target_metric": payload.target_name,
        "predictions": {
            "timestamps": future_epochs,
            "p10": p10,
            "p50": p50,
            "p90": p90
        },
        "metrics_summary": {
            "peak_detected": peak_detected,
            "peak_value": round(peak_val, 3) if peak_val is not None else None,
            "peak_time": peak_time,
            "crossing_detected": crossing_detected,
            "crossing_time": crossing_time,
            "recurrence_period_hours": round(recurrence_period_hours, 2) if recurrence_period_hours is not None else None,
            "confidence_p90_at_peak": round(float(p90[peak_idx]), 3)
        }
    }

    return JSONResponse(content=response_payload)
