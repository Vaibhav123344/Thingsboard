"""
filler_prerender.py — Pre-renders filler audio clips into voice-agent/fillers/
Run once before starting the agent: python filler_prerender.py
"""

import io
import os
import requests

TTS_URL = "http://localhost:8766/tts"
OUT_DIR = os.path.join(os.path.dirname(__file__), "fillers")
os.makedirs(OUT_DIR, exist_ok=True)

FILLERS = {
    "checking":  "Checking the sensors now.",
    "scenarios": "Let me run the predictive scenario on that data. One moment.",
    "audit":     "Analyzing the historical data logs.",
    "alarms":    "Let me scan for active warnings.",
    "rpc":       "Sending the command to the device now.",
    "deep":      "Running deep analysis. This may take a few seconds.",
    "creating":  "Creating the resource in ThingsBoard.",
    "loading":   "Retrieving that information now.",
}

def main():
    print(f"Pre-rendering {len(FILLERS)} filler clips to {OUT_DIR}/")
    for key, text in FILLERS.items():
        out_path = os.path.join(OUT_DIR, f"{key}.wav")
        resp = requests.post(TTS_URL, json={"text": text, "voice": "af_bella", "speed": 1.1})
        resp.raise_for_status()
        with open(out_path, "wb") as f:
            f.write(resp.content)
        size_kb = os.path.getsize(out_path) / 1024
        print(f"  ✓ {key}.wav  ({size_kb:.1f} KB)  — \"{text}\"")
    print("Done. Fillers ready.")

if __name__ == "__main__":
    main()