#!/usr/bin/env python3

"""
Gemini Computer Use — Vertex AI Edition
Browser automation via Gemini 2.5 Computer Use preview model.
Uses Playwright to control a Chromium browser; model sees screenshots
and returns UI actions (click, type, scroll, navigate, etc.).

Region: global only (preview model).

Usage:
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
MODEL = "gemini-2.5-computer-use-preview-10-2025"

SCREEN_WIDTH = 1440
SCREEN_HEIGHT = 900
MAX_TURNS = 25

client = genai.Client(
    vertexai=True,
    project=PROJECT,
    location=LOCATION,
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


def build_function_responses(page, results):
    """Build FunctionResponse parts with a fresh screenshot."""
    screenshot = page.screenshot(type="png")
    url = page.url
    responses = []
    for name, result in results:
        response_data = {"url": url}
        response_data.update(result)
        responses.append(
            types.Part.from_function_response(
                name=name,
                response=response_data,
            )
        )
    # Attach screenshot as the last part
    screenshot_part = types.Part.from_bytes(data=screenshot, mime_type="image/png")
    return responses + [screenshot_part]


def run(task, start_url="https://www.google.com", headless=False):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: pip install playwright && playwright install chromium")
        sys.exit(1)

    print(f"Gemini Computer Use — Vertex AI ({LOCATION})")
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
            thinking_config=types.ThinkingConfig(include_thoughts=True),
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

            # Print any thinking or text output
            for part in candidate.content.parts:
                if hasattr(part, "thought") and part.thought:
                    print(f"  [thinking] {part.text[:200]}...")
                elif hasattr(part, "text") and part.text and not hasattr(part, "function_call"):
                    pass  # Will print final answer below

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

            # Execute actions
            results = execute_actions(candidate, page)
            response_parts = build_function_responses(page, results)
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
    args = parser.parse_args()
    run(task=" ".join(args.task), start_url=args.url, headless=args.headless)
