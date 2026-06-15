import pandas as pd
import numpy as np
from typing import Dict, List, Tuple

def preprocess_json_instances(instances: Dict[str, List[float]]) -> Tuple[List[np.ndarray], List[str]]:
    """
    Validates, handles missing index entries, and converts raw JSON 
    input dictionary lines into cleansed NumPy matrices for batch processing.
    """
    if not instances:
        raise ValueError("The 'instances' object cannot be empty.")

    processed_series = []
    validated_keys = []

    for key, raw_values in instances.items():
        if not raw_values:
            continue  # Avoid processing completely empty metrics lists
            
        # Wrap into a Pandas series temporarily to utilize optimized forward/backward imputation fills
        series_data = pd.to_numeric(pd.Series(raw_values), errors='coerce')
        
        # Repair potential null gaps or disconnected points from data dropouts
        if series_data.isna().any():
            series_data = series_data.ffill().bfill().fillna(0.0)

        # Convert straight to a float32 representation
        array_data = series_data.to_numpy(dtype=np.float32)
        
        # TimesFM requires sequences to have at least a minimal data context to project trends
        if len(array_data) < 2:
            raise ValueError(f"Column '{key}' must contain at least 2 historical metrics data points.")

        processed_series.append(array_data)
        validated_keys.append(key)

    if not processed_series:
        raise ValueError("No valid numerical sequences found in the payload instances.")

    return processed_series, validated_keys