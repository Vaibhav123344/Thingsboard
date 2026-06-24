"""
prompt_loader.py — Load system prompt from a markdown file.

Supports:
  - Default path: src/prompts/system_prompt.md
  - Override via SYSTEM_PROMPT env var (relative to src/ directory)
  - Validates file exists at startup
  - Logs which prompt file was loaded
"""

import logging
import os

logger = logging.getLogger("prompt-loader")

# Resolve the src/ directory (parent of this file)
_SRC_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_PROMPT = os.path.join(_SRC_DIR, "prompts", "system_prompt.md")


def load_system_prompt() -> str:
    """Load the system prompt from a markdown file.

    Resolution order:
      1. SYSTEM_PROMPT env var (absolute path, or relative to src/)
      2. Default: src/prompts/system_prompt.md

    Returns:
        The system prompt text content.

    Raises:
        FileNotFoundError: If the prompt file does not exist.
    """
    env_path = os.environ.get("SYSTEM_PROMPT")

    if env_path:
        # Support both absolute and relative (to src/) paths
        if os.path.isabs(env_path):
            prompt_path = env_path
        else:
            prompt_path = os.path.join(_SRC_DIR, env_path)
    else:
        prompt_path = _DEFAULT_PROMPT

    prompt_path = os.path.normpath(prompt_path)

    if not os.path.isfile(prompt_path):
        raise FileNotFoundError(
            f"System prompt file not found: {prompt_path}\n"
            f"Create the file or set SYSTEM_PROMPT env var to a valid path."
        )

    with open(prompt_path, encoding="utf-8") as f:
        content = f.read().strip()

    if not content:
        raise ValueError(f"System prompt file is empty: {prompt_path}")

    logger.info(f"Loaded system prompt from: {prompt_path} ({len(content)} chars)")
    return content
