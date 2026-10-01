import ctypes
import os
import shutil
import struct
import subprocess
import threading
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import bridge.audio as audio
from bridge.audio import (
    AudioError,
    MAX_AUDIO_SECONDS,
    MAX_INPUT_BYTES,
    MAX_SAMPLES,
    SAMPLE_RATE,
    WHISPER_TIMEOUT,
    _check_wav,
    decode_to_wav,
    transcribe,
)

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / ".local/models/ggml-base.bin"
JFK = Path("/opt/homebrew/share/whisper-cpp/jfk.wav")


def make_zepp_audio(frames: int = 2) -> bytes:
    lib = ctypes.CDLL("/opt/homebrew/lib/libopus.dylib")
    lib.opus_encoder_create.argtypes = (
        ctypes.c_int32,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_int),
    )
    lib.opus_encoder_create.restype = ctypes.c_void_p
    lib.opus_encoder_destroy.argtypes = (ctypes.c_void_p,)
    lib.opus_encode.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int16),
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.c_int32,
    )
    lib.opus_encode.restype = ctypes.c_int32
    lib.opus_encoder_ctl.argtypes = (ctypes.c_void_p, ctypes.c_int)
    lib.opus_encoder_ctl.restype = ctypes.c_int

    error = ctypes.c_int()
    encoder = lib.opus_encoder_create(16_000, 1, 2049, ctypes.byref(error))
    if not encoder or error.value:
        raise RuntimeError("cannot create test encoder")
    result = bytearray()
    try:
        for frame in range(frames):
            samples = (ctypes.c_int16 * 320)(
                *[1200 if (i + frame) % 40 < 20 else -1200 for i in range(320)]
            )
            packet = (ctypes.c_ubyte * 1275)()
            size = lib.opus_encode(encoder, samples, 320, packet, len(packet))
            final_range = ctypes.c_uint32()
            if size <= 0 or lib.opus_encoder_ctl(
                encoder, 4031, ctypes.byref(final_range)
            ):
                raise RuntimeError("cannot encode test packet")
            result += struct.pack(">II", size, final_range.value)
            result += bytes(packet[:size])
    finally:
        lib.opus_encoder_destroy(encoder)
    return bytes(result)


def make_fake_parakeet(directory: Path) -> tuple[Path, Path]:
    runner = directory / "fake-parakeet"
    runner.write_text(
        """#!/usr/bin/env python3
import json, os, sys, time
if os.environ.get("FAKE_PARAKEET_START_FAIL"):
    print(json.dumps({"ready": False, "error": "load failed"}), flush=True)
    raise SystemExit(1)
sys.stdout.write("framework log\\n{\\\"rea")
sys.stdout.flush()
time.sleep(0.15)
sys.stdout.write("dy\\\":true,\\\"load_ms\\\":150}\\n")
sys.stdout.flush()
for line in sys.stdin:
    request = json.loads(line)
    if "timeout" in request["audio_path"]:
        sys.stdout.write('{"id":')
        sys.stdout.flush()
        time.sleep(1)
        continue
    print(json.dumps({"id": request["id"], "ok": True, "text": "текст"}), flush=True)
""",
        encoding="utf-8",
    )
    runner.chmod(0o755)
    model = directory / "model"
    model.mkdir()
    for name in audio.PARAKEET_REQUIRED_FILES:
        path = model / name
        if name.endswith(".mlmodelc"):
            path.mkdir()
        else:
            path.write_text("{}", encoding="utf-8")
    return runner, model


class AudioTest(unittest.TestCase):
    def tearDown(self) -> None:
        audio.close_asr()

    def test_decodes_zepp_packets_and_rejects_corruption(self) -> None:
        raw = make_zepp_audio()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "watch.opus"
            source.write_bytes(raw)
            wav_path = decode_to_wav(source, directory)
            with wave.open(str(wav_path), "rb") as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels()), (16_000, 1))
                self.assertEqual(wav.getnframes(), 640)

            cases = {
                "short header": raw[:4],
                "zero packet": struct.pack(">II", 0, 0),
                "truncated payload": struct.pack(">II", 20, 0) + b"x",
                "bad checksum": raw[:4] + bytes([raw[4] ^ 1]) + raw[5:],
            }
            for name, damaged in cases.items():
                with self.subTest(name=name):
                    source.write_bytes(damaged)
                    with self.assertRaises(AudioError):
                        decode_to_wav(source, directory)

    def test_rejects_oversized_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "large.opus"
            source.write_bytes(b"x" * (MAX_INPUT_BYTES + 1))
            with self.assertRaisesRegex(AudioError, "8 MiB"):
                decode_to_wav(source, directory)

    def test_five_minute_pcm_is_accepted_and_overrun_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "five-minutes.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(SAMPLE_RATE)
                wav.writeframes(b"\0\0" * (300 * SAMPLE_RATE))
            _check_wav(path)

            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(SAMPLE_RATE)
                wav.writeframes(b"\0\0" * (MAX_SAMPLES + 1))
            with self.assertRaisesRegex(AudioError, "five minutes"):
                _check_wav(path)
        self.assertEqual(MAX_AUDIO_SECONDS, 301)

    def test_transcribe_allows_five_minute_whisper_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "watch.opus"
            source.write_bytes(b"audio")
            model = directory / "model.bin"
            model.write_bytes(b"model")
            wav_path = directory / "decoded.wav"
            wav_path.write_bytes(b"wav")
            seen = {}

            def fake_run(command, timeout, label):
                seen.update(command=command, timeout=timeout, label=label)
                output = Path(command[command.index("-of") + 1]).with_suffix(".txt")
                output.write_text("полный текст", encoding="utf-8")

            with patch.dict(os.environ, {"MUSAFIR_ASR_BACKEND": "whisper"}), \
                    patch("bridge.audio.decode_to_wav", return_value=wav_path), \
                    patch("bridge.audio._run", side_effect=fake_run):
                self.assertEqual(transcribe(source, directory, model), "полный текст")
            self.assertEqual(seen["timeout"], WHISPER_TIMEOUT)
            self.assertEqual(seen["label"], "whisper.cpp")
            self.assertEqual(seen["command"][seen["command"].index("-l") + 1], "ru")
            self.assertIn("Мусафир Гермес Орка", seen["command"])

    def test_transcribe_uses_parakeet_by_default_without_whisper_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "watch.opus"
            source.write_bytes(b"audio")
            wav_path = directory / "decoded.wav"
            wav_path.write_bytes(b"wav")
            with patch.dict(os.environ, {"MUSAFIR_ASR_BACKEND": "parakeet"}), \
                    patch("bridge.audio.decode_to_wav", return_value=wav_path), \
                    patch("bridge.audio._transcribe_parakeet", return_value="текст") as run:
                self.assertEqual(
                    transcribe(source, directory, directory / "missing-whisper.bin"),
                    "текст",
                )
            run.assert_called_once_with(wav_path)
            self.assertFalse(wav_path.exists())

    def test_parakeet_protocol_warmup_is_nonblocking_and_cleans_up(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            runner, model = make_fake_parakeet(directory)
            environment = {
                "MUSAFIR_ASR_BACKEND": "parakeet",
                "MUSAFIR_PARAKEET_RUNNER": str(runner),
                "MUSAFIR_PARAKEET_MODEL_DIR": str(model),
            }
            errors = []
            with patch.dict(os.environ, environment):
                worker = threading.Thread(
                    target=lambda: errors.append(audio.warm_asr())
                )
                worker.start()
                time.sleep(0.03)
                started = time.monotonic()
                self.assertFalse(audio.asr_ready())
                self.assertLess(time.monotonic() - started, 0.05)
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [None])
                self.assertTrue(audio.asr_ready())

                wav = directory / "ok.wav"
                wav.write_bytes(b"wav")
                self.assertEqual(audio._transcribe_parakeet(wav), "текст")
                audio.close_asr()
                self.assertFalse(audio.asr_ready())

    def test_parakeet_timeout_resets_child_and_start_failure_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            runner, model = make_fake_parakeet(directory)
            environment = {
                "MUSAFIR_ASR_BACKEND": "parakeet",
                "MUSAFIR_PARAKEET_RUNNER": str(runner),
                "MUSAFIR_PARAKEET_MODEL_DIR": str(model),
            }
            with patch.dict(os.environ, environment), \
                    patch("bridge.audio.WHISPER_TIMEOUT", 0.05):
                timeout_wav = directory / "timeout.wav"
                timeout_wav.write_bytes(b"wav")
                with self.assertRaisesRegex(AudioError, "timed out"):
                    audio._transcribe_parakeet(timeout_wav)
                self.assertFalse(audio.asr_ready())

                ok_wav = directory / "ok.wav"
                ok_wav.write_bytes(b"wav")
                self.assertEqual(audio._transcribe_parakeet(ok_wav), "текст")

            audio.close_asr()
            with patch.dict(os.environ, {**environment, "FAKE_PARAKEET_START_FAIL": "1"}):
                with self.assertRaisesRegex(AudioError, "load failed"):
                    audio.warm_asr()
                self.assertFalse(audio.asr_ready())

    @unittest.skipUnless(
        MODEL.is_file() and JFK.is_file() and shutil.which("ffmpeg"),
        "local whisper.cpp smoke-test assets are unavailable",
    )
    def test_local_whisper_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            ogg = directory / "jfk.ogg"
            subprocess.run(
                [
                    shutil.which("ffmpeg") or "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(JFK),
                    "-t",
                    "6",
                    "-c:a",
                    "libopus",
                    "-b:a",
                    "24k",
                    str(ogg),
                ],
                check=True,
                timeout=20,
            )
            with patch.dict(os.environ, {
                "MUSAFIR_ASR_BACKEND": "whisper",
                "MUSAFIR_WHISPER_LANGUAGE": "en",
            }):
                text = transcribe(ogg, directory, MODEL).lower()
            self.assertTrue({"fellow", "americans", "country"} & set(text.split()), text)


if __name__ == "__main__":
    unittest.main()
