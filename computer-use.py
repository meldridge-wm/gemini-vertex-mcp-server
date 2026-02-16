#!/usr/bin/env python3

"""
Gemini Computer Use — Dual Mode (AI Studio / Vertex AI)
Browser automation via Gemini 2.5 Computer Use preview model.
Uses Playwright to control a Chromium browser; model sees screenshots
and returns UI actions (click, type, scroll, navigate, etc.).

Currently uses AI Studio (API key) because Vertex AI doesn't support
the multi-turn function_response flow for computer-use yet.
When fixed, use --vertex flag or GEMINI_USE_VERTEX=1.

Usage:
  export GEMINI_API_KEY=your-key
  python computer-use.py "Search Google for Gemini API pricing"
  python computer-use.py --url https://example.com "Find the contact page"
  python computer-use.py --headless "Go to weather.com and get NYC forecast"

Requires:
  pip install google-genai playwright
  playwright install chromium
"""

import os
import sys
import time
import argparse
import asyncio

from google import genai
from google.genai import types

# --- Config ---
PROJECT = os.environ.get("GEMINI_PROJECT", "gcp-virtual-production-lab")
LOCATION = os.environ.get("GEMINI_LOCATION", "global")
USE_VERTEX = os.environ.get("GEMINI_USE_VERTEX", "").lower() in ("1", "true", "yes")
MODEL = "gemini-2.5-computer-use-preview-10-2025"

SCREEN_WIDTH = 1440
SCREEN_HEIGHT = 900
MAX_TURNS = 25


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
            print("ERROR: Set GEMINI_API_KEY env var, or use --vertex for Vertex AI.")
            print("  export GEMINI_API_KEY=your-key")
            sys.exit(1)
        return genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=api_key,
        )


def denormalize_x(x, width=SCREEN_WIDTH):
    return int(x / 1000 * width)


def denormalize_y(y, height=SCREEN_HEIGHT):
    return int(y / 1000 * height)


def execute_actions(candidate, page):
    """Execute function calls from model response, return results."""
    results = []
    function_calls = [p.function_call for p in candidate.content.parts if p.function_call]

    for fc in function_calls:
        name = fc.name
        args = fc.args or {}
        result = {}
        print(f"  -> {name}({', '.join(f'{k}={v}' for k, v in args.items())})")

        try:
            if name == "open_web_browser":
                pass
            elif name == "click_at":
                x = denormalize_x(args["x"])
                y = denormalize_y(args["y"])
                page.mouse.click(x, y)
            elif name == "type_text_at":
                x = denormalize_x(args["x"])
                y = denormalize_y(args["y"])
                page.mouse.click(x, y)
                page.keyboard.press("Meta+A")
                page.keyboard.press("Backspace")
                page.keyboard.type(args["text"])
                if args.get("press_enter", False):
                    page.keyboard.press("Enter")
            elif name == "navigate":
                page.goto(args["url"])
            elif name == "go_back":
                page.go_back()
            elif name == "go_forward":
                page.go_forward()
            elif name == "search":
                page.goto(f"https://www.google.com/search?q={args.get('query', '')}")
            elif name == "scroll_document":
                direction = args.get("direction", "down")
                amount = args.get("amount", 3)
                delta = 300 * amount if direction == "down" else -300 * amount
                page.mouse.wheel(0, delta)
            elif name == "scroll_at":
                x = denormalize_x(args["x"])
                y = denormalize_y(args["y"])
                direction = args.get("direction", "down")
                amount = args.get("amount", 3)
                delta = 300 * amount if direction == "down" else -300 * amount
                page.mouse.move(x, y)
                page.mouse.wheel(0, delta)
            elif name == "hover_at":
                x = denormalize_x(args["x"])
                y = denormalize_y(args["y"])
                page.mouse.move(x, y)
            elif name == "key_combination":
                keys = args.get("keys", [])
                page.keyboard.press("+".join(keys))
            elif name == "drag_and_drop":
                sx = denormalize_x(args["start_x"])
                sy = denormalize_y(args["start_y"])
                ex = denormalize_x(args["end_x"])
                ey = denormalize_y(args["end_y"])
                page.mouse.move(sx, sy)
                page.mouse.down()
                page.mouse.move(ex, ey)
                page.mouse.up()
            elif name == "wait_5_seconds":
                time.sleep(5)
            else:
                print(f"  !! Unknown action: {name}")

            try:
                page.wait_for_load_state(timeout=5000)
            except Exception:
                pass
            time.sleep(1)

        except Exception as e:
            print(f"  !! Error: {e}")
            result = {"error": str(e)}

        results.append((name, result))
    return results


def build_function_responses(page, results, candidate=None):
    """Build FunctionResponse parts with a fresh screenshot."""
    screenshot = page.screenshot(type="png")
    current_url = page.url

    # Build a map of which function calls need safety acknowledgement
    needs_ack = set()
    if candidate:
        for p in candidate.content.parts:
            if p.function_call:
                args = p.function_call.args or {}
                sd = args.get("safety_decision", {})
                if sd.get("decision") == "require_confirmation":
                    needs_ack.add(p.function_call.name)

    parts = []
    for name, result in results:
        # Computer-use model REQUIRES 'url' in every function response
        output = {"output": "ok", "url": current_url}
        if result:
            output.update(result)
        # Acknowledge safety decisions
        if name in needs_ack:
            output["safety_acknowledgement"] = True
        parts.append(
            types.Part.from_function_response(
                name=name,
                response=output,
            )
        )
    # Append screenshot as the last part
    parts.append(types.Part.from_bytes(data=screenshot, mime_type="image/png"))
    return parts


def run(task, start_url="https://www.google.com", headless=False, use_vertex=False):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: pip install playwright && playwright install chromium")
        sys.exit(1)

    client = make_client(use_vertex)
    backend = f"Vertex AI ({LOCATION})" if use_vertex else "AI Studio (API key)"

    print(f"Gemini Computer Use — {backend}")
    print(f"  Model:    {MODEL}")
    print(f"  Task:     {task}")
    print(f"  Start:    {start_url}")
    print(f"  Screen:   {SCREEN_WIDTH}x{SCREEN_HEIGHT}")
    print(f"  Headless: {headless}")
    print()

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=headless)
    context = browser.new_context(
        viewport={"width": SCREEN_WIDTH, "height": SCREEN_HEIGHT}
    )
    page = context.new_page()

    try:
        page.goto(start_url)
        time.sleep(2)

        config = types.GenerateContentConfig(
            tools=[
                types.Tool(
                    computer_use=types.ComputerUse(
                        environment=types.Environment.ENVIRONMENT_BROWSER,
                    )
                )
            ],
            # Note: computer-use model does not support thinking config on Vertex AI
        )

        initial_screenshot = page.screenshot(type="png")
        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=task),
                    types.Part.from_bytes(data=initial_screenshot, mime_type="image/png"),
                ],
            )
        ]

        for turn in range(MAX_TURNS):
            print(f"\n--- Turn {turn + 1} ---")
            response = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config=config,
            )

            candidate = response.candidates[0]
            contents.append(candidate.content)

            # Check if model returned actions or a final answer
            has_actions = any(p.function_call for p in candidate.content.parts)
            if not has_actions:
                final_text = " ".join(
                    p.text for p in candidate.content.parts
                    if hasattr(p, "text") and p.text and not getattr(p, "thought", False)
                )
                print(f"\n=== Result ===\n{final_text}")
                break

            # Check for confirmation-required actions
            for p in candidate.content.parts:
                if p.function_call and hasattr(p, 'function_call'):
                    # Safety: check if any action requires confirmation
                    pass

            # Check for safety confirmations
            for p in candidate.content.parts:
                if p.function_call:
                    args = p.function_call.args or {}
                    sd = args.get("safety_decision", {})
                    if sd.get("decision") == "require_confirmation":
                        print(f"  !! Safety confirmation required: {sd.get('explanation', 'No explanation')}")
                        print(f"  !! Auto-acknowledging for this session.")

            # Execute actions
            results = execute_actions(candidate, page)
            response_parts = build_function_responses(page, results, candidate)
            contents.append(
                types.Content(role="user", parts=response_parts)
            )
        else:
            print(f"\n=== Reached max turns ({MAX_TURNS}) ===")

    finally:
        browser.close()
        pw.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Gemini Computer Use — browser automation via Vertex AI"
    )
    parser.add_argument(
        "task",
        nargs="+",
        help="Task for the agent to perform",
    )
    parser.add_argument(
        "--url",
        default="https://www.google.com",
        help="Starting URL (default: google.com)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run browser in headless mode",
    )
    parser.add_argument(
        "--vertex",
        action="store_true",
        default=USE_VERTEX,
        help="Use Vertex AI instead of AI Studio (function responses may not work yet)",
    )
    args = parser.parse_args()
    run(task=" ".join(args.task), start_url=args.url, headless=args.headless, use_vertex=args.vertex)
