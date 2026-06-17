import subprocess
import os
import time
import sys

def start_local_livekit():
    # Exact path to your downloaded LiveKit server executable
    livekit_path = r"D:\Vaibhav\thingsboards\industrial-ai-observer\project-root\livekit_1.13.1_windows_amd64\livekit-server.exe" 
    
    if not os.path.exists(livekit_path):
        print(f"❌ ERROR: Could not find livekit-server.exe at {livekit_path}")
        sys.exit(1)

    print("🚀 Launching Local LiveKit Server (--dev mode)...")
    
    # Start the server in dev mode in a new detached console window
    subprocess.Popen(
        [livekit_path, "--dev"],
        creationflags=subprocess.CREATE_NEW_CONSOLE 
    )

def start_zephyr_agent():
    print("⏳ Waiting 3 seconds for LiveKit to boot...")
    time.sleep(3)

    # Set your session variables programmatically for the agent
    env = os.environ.copy()
    env["LIVEKIT_URL"] = "ws://localhost:7880"
    env["LIVEKIT_API_KEY"] = "devkey"
    env["LIVEKIT_API_SECRET"] = "secretkeydefaultvalue987654321012"
    
    print("🤖 Launching Zephyr Voice Agent...")
    
    # Run the agent in the current console
    agent_process = subprocess.Popen(
        [sys.executable, "agent.py", "start"],
        env=env
    )
    
    try:
        agent_process.wait()
    except KeyboardInterrupt:
        print("\n🛑 Shutting down Zephyr Agent...")
        agent_process.terminate()

if __name__ == "__main__":
    start_local_livekit()
    start_zephyr_agent()