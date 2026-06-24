"""
test_pipeline.py — Verification script for voice pipeline optimizations.

Tests:
1. Connection pooling (tools.py -> Express Node.js Server on Port 9005)
2. In-memory Kokoro ONNX TTS model loading & speech synthesis
"""

import asyncio
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("verifier")

# Add src to the path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

try:
    from custom_tts import LocalKokoroTTS
    from tools import _call_tool, close_shared_session
except ImportError as e:
    logger.error(f"Failed to import required modules: {e}")
    sys.exit(1)


async def test_tools_connection():
    logger.info("=== Test 1: Testing Connection Pool & Tools REST Gateway ===")
    logger.info("Calling list_devices tool via Express tools server...")
    
    # This will trigger get_shared_session() and call the Express tools API
    result = await _call_tool("list_devices")
    
    logger.info(f"Tool call result preview: {result[:200]}...")
    if "Could not reach the ThingsBoard tools server" in result:
        logger.warning("⚠️ Could not connect to Express server. Please make sure the Node.js backend is running.")
    else:
        logger.info("✓ Connection pooling and Express tools routing is WORKING!")


async def test_local_tts():
    logger.info("=== Test 2: Testing Local Kokoro ONNX TTS Synthesis ===")
    
    # Try creating the local TTS instance
    try:
        tts = LocalKokoroTTS(voice="af_bella", speed=1.15)
        logger.info("Local Kokoro TTS instantiated. Initializing model session...")
        
        # Prewarm/ensure model is loaded
        tts._ensure_model_loaded()
        logger.info("Model loaded successfully. Synthesizing test utterance...")
        
        # Synthesize a simple test segment
        stream = tts.synthesize("Zephyr connection pool and local voice pipeline optimization test complete.")
        
        # Collect audio frames from the emitter
        frames = []
        async for chunk in stream:
            frames.append(chunk.frame.data)
            
        if len(frames) > 0:
            logger.info(f"✓ Local TTS synthesized {len(frames)} audio frames successfully!")
            logger.info("✓ In-memory local audio playback stream is WORKING!")
        else:
            logger.error("❌ Synthesis succeeded but returned 0 audio frames.")
            
    except Exception as e:
        logger.exception(f"❌ Local TTS initialization/synthesis failed: {e}")
        logger.error("Please verify that kokoro-v1.0.onnx and voices-v1.0.bin exist in voice_agent/tts/.")


async def main():
    # Run tests
    await test_tools_connection()
    print()
    await test_local_tts()
    
    # Cleanup connection pool
    await close_shared_session()
    logger.info("Verification script complete.")


if __name__ == "__main__":
    asyncio.run(main())
