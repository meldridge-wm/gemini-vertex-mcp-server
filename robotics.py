#!/usr/bin/env python3

"""
Gemini Robotics ER — Dual Mode (Vertex AI / AI Studio)
Uses gemini-robotics-er-1.5-preview with Google Search grounding.

Currently only available via AI Studio (API key).
When Google enables it on Vertex AI, set --vertex flag or GEMINI_USE_VERTEX=1.

Usage:
  export GEMINI_API_KEY=your-key
  python robotics.py "your prompt here"
  python robotics.py                      # interactive mode
  python robotics.py --vertex             # use Vertex AI (when available)

Requires: pip install google-genai
"""

import os
import sys
import argparse
from google import genai
from google.genai import types

# --- Config ---
PROJECT = os.environ.get("GEMINI_PROJECT", "gcp-virtual-production-lab")
# Preview models → global. When GA, switch to nearest region:
#   us-east4 (Northern Virginia), us-central1 (Iowa), us-west1 (Oregon)
LOCATION = os.environ.get("GEMINI_LOCATION", "global")
USE_VERTEX = os.environ.get("GEMINI_USE_VERTEX", "").lower() in ("1", "true", "yes")
MODEL = os.environ.get("GEMINI_ROBOTICS_MODEL", "gemini-robotics-er-1.5-preview")


def make_client(use_vertex=False):
    if use_vertex:
        return genai.Client(
            vertexai=True,
            project=PROJECT,
            location=LOCATION,
        )
    else:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            print("ERROR: Set GEMINI_API_KEY env var, or use --vertex for Vertex AI auth.")
            print("  export GEMINI_API_KEY=your-key")
            raise SystemExit(1)
        return genai.Client(
            api_key=api_key,
        )


def generate(client, prompt, use_vertex=False):
    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=prompt),
            ],
        ),
    ]
    tools = [
        types.Tool(googleSearch=types.GoogleSearch()),
    ]
    generate_content_config = types.GenerateContentConfig(
        tools=tools,
    )

    backend = f"Vertex AI ({LOCATION})" if use_vertex else "AI Studio"
    print(f"[{MODEL} | {backend}]")
    for chunk in client.models.generate_content_stream(
        model=MODEL,
        contents=contents,
        config=generate_content_config,
    ):
        print(chunk.text, end="")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Gemini Robotics ER — embodied reasoning"
    )
    parser.add_argument(
        "prompt",
        nargs="*",
        help="Prompt text (omit for interactive mode)",
    )
    parser.add_argument(
        "--vertex",
        action="store_true",
        default=USE_VERTEX,
        help="Use Vertex AI instead of AI Studio (requires model availability)",
    )
    args = parser.parse_args()

    client = make_client(args.vertex)

    if args.prompt:
        generate(client, " ".join(args.prompt), args.vertex)
    else:
        backend = f"Vertex AI ({LOCATION})" if args.vertex else "AI Studio"
        print(f"Gemini Robotics ER — {backend}")
        print("Type your prompt, or 'q' to quit.\n")
        while True:
            try:
                prompt = input("prompt > ")
                if prompt.lower() == "q":
                    break
                if prompt.strip():
                    generate(client, prompt, args.vertex)
                    print()
            except (EOFError, KeyboardInterrupt):
                break
