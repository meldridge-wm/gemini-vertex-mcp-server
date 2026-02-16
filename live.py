#!/usr/bin/env python3

"""
Gemini Live API — Dual Mode (Vertex AI / AI Studio)
Real-time audio/video streaming with Gemini.

Currently the native audio model is only available via AI Studio (API key).
When Google enables it on Vertex AI, set --vertex flag or GEMINI_USE_VERTEX=1.

Usage:
  export GEMINI_API_KEY=your-key
  python live.py                # camera + mic (default)
  python live.py --mode screen  # screen share + mic
  python live.py --mode none    # mic only
  python live.py --vertex       # use Vertex AI (when model is available)

Requires: pip install google-genai opencv-python pyaudio pillow mss
"""

import os
import asyncio
import base64
import io
import traceback
import argparse

import cv2
import pyaudio
import PIL.Image

from google import genai
from google.genai import types

# --- Config ---
PROJECT = os.environ.get("GEMINI_PROJECT", "gcp-virtual-production-lab")
# Preview models → global. When GA, switch to nearest region:
#   us-east4 (Northern Virginia), us-central1 (Iowa), us-west1 (Oregon)
# Set GEMINI_LOCATION env var or change default here.
LOCATION = os.environ.get("GEMINI_LOCATION", "global")
USE_VERTEX = os.environ.get("GEMINI_USE_VERTEX", "").lower() in ("1", "true", "yes")

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

DEFAULT_MODE = "camera"


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
            http_options={"api_version": "v1beta"},
            api_key=api_key,
        )


CONFIG = types.LiveConnectConfig(
    response_modalities=[
        "AUDIO",
    ],
    media_resolution="MEDIA_RESOLUTION_MEDIUM",
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Zephyr")
        )
    ),
    context_window_compression=types.ContextWindowCompressionConfig(
        trigger_tokens=25600,
        sliding_window=types.SlidingWindow(target_tokens=12800),
    ),
)

pya = pyaudio.PyAudio()


class AudioLoop:
    def __init__(self, video_mode=DEFAULT_MODE, use_vertex=False):
        self.video_mode = video_mode
        self.use_vertex = use_vertex
        self.client = make_client(use_vertex)

        # For Vertex AI, model name without 'models/' prefix
        # For AI Studio, needs 'models/' prefix
        self.model = MODEL if use_vertex else f"models/{MODEL}"

        self.audio_in_queue = None
        self.out_queue = None

        self.session = None

        self.send_text_task = None
        self.receive_audio_task = None
        self.play_audio_task = None

        self.audio_stream = None

    async def send_text(self):
        while True:
            text = await asyncio.to_thread(
                input,
                "message > ",
            )
            if text.lower() == "q":
                break
            if self.session is not None:
                await self.session.send(input=text or ".", end_of_turn=True)

    def _get_frame(self, cap):
        ret, frame = cap.read()
        if not ret:
            return None
        # Convert BGR to RGB (OpenCV captures BGR, PIL expects RGB)
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = PIL.Image.fromarray(frame_rgb)
        img.thumbnail([1024, 1024])

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        mime_type = "image/jpeg"
        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_frames(self):
        cap = await asyncio.to_thread(cv2.VideoCapture, 0)

        while True:
            frame = await asyncio.to_thread(self._get_frame, cap)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

        cap.release()

    def _get_screen(self):
        try:
            import mss
        except ImportError as e:
            raise ImportError("Please install mss: pip install mss") from e
        sct = mss.mss()
        monitor = sct.monitors[0]

        i = sct.grab(monitor)

        mime_type = "image/jpeg"
        image_bytes = mss.tools.to_png(i.rgb, i.size)
        img = PIL.Image.open(io.BytesIO(image_bytes))

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_screen(self):
        while True:
            frame = await asyncio.to_thread(self._get_screen)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

    async def send_realtime(self):
        while True:
            if self.out_queue is not None:
                msg = await self.out_queue.get()
                if self.session is not None:
                    await self.session.send(input=msg)

    async def listen_audio(self):
        mic_info = pya.get_default_input_device_info()
        self.audio_stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        if __debug__:
            kwargs = {"exception_on_overflow": False}
        else:
            kwargs = {}
        while True:
            data = await asyncio.to_thread(self.audio_stream.read, CHUNK_SIZE, **kwargs)
            if self.out_queue is not None:
                await self.out_queue.put({"data": data, "mime_type": "audio/pcm"})

    async def receive_audio(self):
        """Background task to read from the websocket and write pcm chunks to the output queue"""
        while True:
            if self.session is not None:
                turn = self.session.receive()
                async for response in turn:
                    if data := response.data:
                        self.audio_in_queue.put_nowait(data)
                        continue
                    if text := response.text:
                        print(text, end="")

                # On interruption, clear queued audio
                while not self.audio_in_queue.empty():
                    self.audio_in_queue.get_nowait()

    async def play_audio(self):
        stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=RECEIVE_SAMPLE_RATE,
            output=True,
        )
        while True:
            if self.audio_in_queue is not None:
                bytestream = await self.audio_in_queue.get()
                await asyncio.to_thread(stream.write, bytestream)

    async def run(self):
        backend = f"Vertex AI ({LOCATION})" if self.use_vertex else "AI Studio (API key)"
        print(f"Connecting to Gemini Live API...")
        print(f"  Backend: {backend}")
        print(f"  Model:   {self.model}")
        print(f"  Mode:    {self.video_mode}")
        print(f"  Voice:   Zephyr")
        print(f"Type 'q' + Enter to quit.\n")

        try:
            async with (
                self.client.aio.live.connect(model=self.model, config=CONFIG) as session,
                asyncio.TaskGroup() as tg,
            ):
                self.session = session
                print("Connected!\n")

                self.audio_in_queue = asyncio.Queue()
                self.out_queue = asyncio.Queue(maxsize=5)

                send_text_task = tg.create_task(self.send_text())
                tg.create_task(self.send_realtime())
                tg.create_task(self.listen_audio())
                if self.video_mode == "camera":
                    tg.create_task(self.get_frames())
                elif self.video_mode == "screen":
                    tg.create_task(self.get_screen())

                tg.create_task(self.receive_audio())
                tg.create_task(self.play_audio())

                await send_text_task
                raise asyncio.CancelledError("User requested exit")

        except asyncio.CancelledError:
            pass
        except ExceptionGroup as EG:
            if self.audio_stream is not None:
                self.audio_stream.close()
                traceback.print_exception(EG)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Gemini Live API — real-time audio/video"
    )
    parser.add_argument(
        "--mode",
        type=str,
        default=DEFAULT_MODE,
        help="pixels to stream from",
        choices=["camera", "screen", "none"],
    )
    parser.add_argument(
        "--vertex",
        action="store_true",
        default=USE_VERTEX,
        help="Use Vertex AI instead of AI Studio (requires model availability)",
    )
    args = parser.parse_args()
    main = AudioLoop(video_mode=args.mode, use_vertex=args.vertex)
    asyncio.run(main.run())
