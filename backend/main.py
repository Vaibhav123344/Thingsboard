import torch
import timesfm
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Dict, List, Any

from preprocessor import preprocess_json_instances

# Thread-safe global layout reference container
engine_registry: Dict[str, Any] = {}

class ForecastRequest(BaseModel):
    instances: Dict[str, List[float]] = Field(
        ..., 
        description="Dictionary mapping column/metric names directly to historical sequence numerical arrays."
    )
    horizon: int = Field(
        5, 
        ge=1, 
        le=256, 
        description="The target prediction window horizon interval steps forward."
    )

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Safely mounts global GPU/RAM memory components exactly once during system activation.
    """
    print("Pre-loading optimized weights for TimesFM 2.5 200M Model...")
    torch.set_float32_matmul_precision("high")
    
    # Instantiate the flagship model architecture
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    
    # Configure compiler to utilize internal automated normalization sequences
    model.compile(timesfm.ForecastConfig(
        max_context=1024,
        max_horizon=256,
        normalize_inputs=True,            # Handles scaling and inverse transformations internally
        use_continuous_quantile_head=True, # Calculates dynamic uncertainty intervals
        force_flip_invariance=True,
        infer_is_positive=True,           # Ensures outputs remain physical/positive values
        fix_quantile_crossing=True
    ))
    
    engine_registry["timesfm_model"] = model
    print("TimesFM Core Neural Processing Unit Online.")
    yield
    engine_registry.clear()

app = FastAPI(title="JSON-Native Batch Forecasting Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict to your specific UI domain during cloud deployments
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/forecast", status_code=status.HTTP_200_OK)
def process_json_forecast(payload: ForecastRequest):
    """
    Consumes parsed JSON collections, pipelines arrays through standard data cleanup algorithms,
    and runs parallel batched inference via the TimesFM 2.5 foundational backend framework.
    """
    if "timesfm_model" not in engine_registry:
        raise HTTPException(
            status_code=503, 
            detail="Forecasting pipeline is currently offline or loading parameters."
        )

    # Process and sanitize input collections
    try:
        inputs, keys = preprocess_json_instances(payload.instances)
    except ValueError as val_err:
        raise HTTPException(status_code=422, detail=str(val_err))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Data sanitization layer fault: {str(e)}")

    # Feed sequences directly to the underlying parallel execution layer
    try:
        model = engine_registry["timesfm_model"]
        
        # Batch inference calculates predictions for all columns simultaneously
        point_forecast, quantile_forecast = model.forecast(horizon=payload.horizon, inputs=inputs)
        
        response_payload = {}
        for idx, name in enumerate(keys):
            response_payload[name] = {
                "point_forecast": point_forecast[idx].tolist(),
                "lower_bound_90pct": quantile_forecast[idx, :, 1].tolist(), # 10th percentile bound
                "upper_bound_90pct": quantile_forecast[idx, :, 9].tolist()  # 90th percentile bound
            }
            
        return JSONResponse(content={
            "status": "success",
            "columns_processed": len(keys),
            "horizon": payload.horizon,
            "predictions": response_payload
        })

    except Exception as model_err:
        raise HTTPException(status_code=500, detail=f"Model array pipeline crash: {str(model_err)}")
