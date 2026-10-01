"""Bounded local decoding and whisper.cpp transcription for watch audio."""

from __future__ import annotations

import atexit
import ctypes
import ctypes.util
import json
import os
import select
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path

SAMPLE_RATE = 16_000
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = 301  # one second covers container/frame rounding around five minutes
MAX_SAMPLES = MAX_AUDIO_SECONDS * SAMPLE_RATE
MAX_OPUS_PACKET = 1275
MAX_OPUS_FRAME_SAMPLES = 120 * SAMPLE_RATE // 1000
FFMPEG_TIMEOUT = 120
WHISPER_TIMEOUT = 15 * 60
PARAKEET_START_TIMEOUT = 120
PARAKEET_REQUIRED_FILES = (
    "Preprocessor.mlmodelc",
    "Encoder.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "parakeet_vocab.json",
)

_parakeet_lock = threading.Lock()
_parakeet_process: subprocess.Popen[bytes] | None = None
_parakeet_buffer = bytearray()


class AudioError(ValueError):
    """The supplied audio cannot be safely decoded or transcribed."""


def _read_bounded(path: Path) -> bytes:
    try:
        with path.open("rb") as source:
            data = source.read(MAX_INPUT_BYTES + 1)
    except OSError as exc:
        raise AudioError(f"cannot read audio: {exc}") from exc
    if not data:
        raise AudioError("audio is empty")
    if len(data) > MAX_INPUT_BYTES:
        raise AudioError("audio exceeds 8 MiB")
    return data


def _opus() -> ctypes.CDLL:
    candidates = [
        ctypes.util.find_library("opus"),
        "/opt/homebrew/lib/libopus.dylib",
        "/usr/local/lib/libopus.dylib",
        "libopus.so.0",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            lib = ctypes.CDLL(candidate)
            break
        except OSError:
            pass
    else:
        raise AudioError("libopus is not installed")

    lib.opus_decoder_create.argtypes = (
        ctypes.c_int32,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_int),
    )
    lib.opus_decoder_create.restype = ctypes.c_void_p
    lib.opus_decoder_destroy.argtypes = (ctypes.c_void_p,)
    lib.opus_packet_get_nb_samples.argtypes = (
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.c_int32,
        ctypes.c_int32,
    )
    lib.opus_packet_get_nb_samples.restype = ctypes.c_int
    lib.opus_decode.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int16),
        ctypes.c_int,
        ctypes.c_int,
    )
    lib.opus_decode.restype = ctypes.c_int
    # opus_decoder_ctl is variadic; declaring only its fixed arguments keeps
    # the decoder pointer wide on 64-bit platforms.
    lib.opus_decoder_ctl.argtypes = (ctypes.c_void_p, ctypes.c_int)
    lib.opus_decoder_ctl.restype = ctypes.c_int
    return lib


def _decode_zepp(data: bytes, output: Path) -> None:
    lib = _opus()
    error = ctypes.c_int()
    decoder = lib.opus_decoder_create(SAMPLE_RATE, 1, ctypes.byref(error))
    if not decoder or error.value:
        raise AudioError(f"cannot create Opus decoder ({error.value})")

    pcm_parts: list[bytes] = []
    total_samples = 0
    position = 0
    packet_number = 0
    try:
        while position < len(data):
            packet_number += 1
            if len(data) - position < 8:
                raise AudioError(f"truncated Zepp header at packet {packet_number}")
            length, expected_range = struct.unpack_from(">II", data, position)
            position += 8
            if not 1 <= length <= MAX_OPUS_PACKET:
                raise AudioError(f"invalid Opus length at packet {packet_number}")
            end = position + length
            if end > len(data):
                raise AudioError(f"truncated Opus payload at packet {packet_number}")

            packet = (ctypes.c_ubyte * length).from_buffer_copy(data[position:end])
            position = end
            frame_samples = lib.opus_packet_get_nb_samples(packet, length, SAMPLE_RATE)
            if not 1 <= frame_samples <= MAX_OPUS_FRAME_SAMPLES:
                raise AudioError(f"invalid Opus frame at packet {packet_number}")
            if total_samples + frame_samples > MAX_SAMPLES:
                raise AudioError("audio exceeds five minutes")

            decoded = (ctypes.c_int16 * MAX_OPUS_FRAME_SAMPLES)()
            actual = lib.opus_decode(
                decoder, packet, length, decoded, MAX_OPUS_FRAME_SAMPLES, 0
            )
            if actual != frame_samples:
                raise AudioError(f"inconsistent Opus frame at packet {packet_number}")

            final_range = ctypes.c_uint32()
            if lib.opus_decoder_ctl(decoder, 4031, ctypes.byref(final_range)) != 0:
                raise AudioError("cannot validate Opus decoder state")
            if expected_range and final_range.value != expected_range:
                raise AudioError(f"Opus checksum mismatch at packet {packet_number}")

            pcm_parts.append(ctypes.string_at(decoded, actual * 2))
            total_samples += actual
    finally:
        lib.opus_decoder_destroy(decoder)

    if not packet_number:
        raise AudioError("audio has no Opus packets")
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(b"".join(pcm_parts))


def _check_wav(path: Path) -> None:
    try:
        with wave.open(str(path), "rb") as wav:
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getframerate() != SAMPLE_RATE
            ):
                raise AudioError("decoded audio has an unexpected PCM format")
            if wav.getnframes() > MAX_SAMPLES:
                raise AudioError("audio exceeds five minutes")
            if wav.getnframes() == 0:
                raise AudioError("decoded audio is empty")
    except wave.Error as exc:
        raise AudioError("decoder did not produce a valid WAV") from exc


def _run(command: list[str], timeout: int, label: str) -> None:
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AudioError(f"{label} failed: {exc}") from exc
    if result.returncode:
        detail = result.stderr.strip().splitlines()
        raise AudioError(f"{label} failed: {detail[-1] if detail else result.returncode}")


def _temporary_path(directory: Path, suffix: str = "", prefix: str = "tmp") -> Path:
    descriptor, name = tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=directory)
    os.close(descriptor)
    return Path(name)


def _parakeet_paths() -> tuple[Path, Path]:
    runner = Path(os.environ.get(
        "MUSAFIR_PARAKEET_RUNNER",
        Path.home() / ".local/share/musafer-watch/bin/parakeet-transcribe",
    ))
    model = Path(os.environ.get(
        "MUSAFIR_PARAKEET_MODEL_DIR",
        Path.home() / "Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3",
    ))
    return runner, model


def _read_parakeet_json(
    process: subprocess.Popen[bytes], timeout: float, request_id: str | None = None
) -> dict:
    global _parakeet_buffer
    if process.stdout is None:
        raise AudioError("Parakeet runner has no output pipe")
    deadline = time.monotonic() + timeout
    while True:
        if b"\n" in _parakeet_buffer:
            raw, _, remainder = _parakeet_buffer.partition(b"\n")
            _parakeet_buffer = bytearray(remainder)
            try:
                response = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(response, dict):
                continue
            if request_id is None and "ready" in response:
                return response
            if request_id is not None and response.get("id") == request_id:
                return response
            continue
        remaining = deadline - time.monotonic()
        descriptor = process.stdout.fileno()
        if remaining <= 0 or not select.select([descriptor], [], [], remaining)[0]:
            raise AudioError("Parakeet timed out")
        chunk = os.read(descriptor, 65_536)
        if not chunk:
            raise AudioError(f"Parakeet exited ({process.poll()})")
        _parakeet_buffer.extend(chunk)
        if len(_parakeet_buffer) > 1024 * 1024:
            raise AudioError("Parakeet output exceeds 1 MiB")


def _stop_parakeet() -> None:
    global _parakeet_buffer, _parakeet_process
    process, _parakeet_process = _parakeet_process, None
    _parakeet_buffer.clear()
    if process is None:
        return
    if process.stdin:
        try:
            process.stdin.close()
        except OSError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.stdout:
        process.stdout.close()


def close_asr() -> None:
    """Stop the warm local ASR helper without leaving an orphan process."""

    with _parakeet_lock:
        _stop_parakeet()


def _start_parakeet() -> subprocess.Popen[bytes]:
    global _parakeet_buffer, _parakeet_process
    if _parakeet_process is not None and _parakeet_process.poll() is None:
        return _parakeet_process
    _stop_parakeet()
    runner, model = _parakeet_paths()
    if not runner.is_file() or not os.access(runner, os.X_OK):
        raise AudioError("Parakeet runner is missing")
    if not model.is_dir() or any(not (model / name).exists() for name in PARAKEET_REQUIRED_FILES):
        raise AudioError("Parakeet V3 model is incomplete")
    try:
        _parakeet_buffer.clear()
        process = subprocess.Popen(
            [str(runner), str(model)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        response = _read_parakeet_json(process, PARAKEET_START_TIMEOUT)
        if response.get("ready") is not True:
            raise AudioError(f"Parakeet failed to load: {response.get('error', 'unknown error')}")
    except (OSError, AudioError) as exc:
        if "process" in locals():
            process.kill()
            process.wait()
            if process.stdin:
                process.stdin.close()
            if process.stdout:
                process.stdout.close()
        if isinstance(exc, AudioError):
            raise
        raise AudioError(f"Parakeet failed to start: {exc}") from exc
    _parakeet_process = process
    return process


def warm_asr() -> None:
    """Load the configured Parakeet model so the first recording stays fast."""

    if os.environ.get("MUSAFIR_ASR_BACKEND", "parakeet").strip().lower() != "parakeet":
        return
    with _parakeet_lock:
        _start_parakeet()


def asr_ready() -> bool:
    """Return whether the configured local ASR process is ready without starting it."""

    if os.environ.get("MUSAFIR_ASR_BACKEND", "parakeet").strip().lower() == "whisper":
        return True
    if not _parakeet_lock.acquire(blocking=False):
        return False
    try:
        return _parakeet_process is not None and _parakeet_process.poll() is None
    finally:
        _parakeet_lock.release()


def _transcribe_parakeet(wav_file: Path) -> str:
    with _parakeet_lock:
        process = _start_parakeet()
        if process.stdin is None:
            raise AudioError("Parakeet runner has no input pipe")
        request_id = uuid.uuid4().hex
        try:
            payload = json.dumps({
                "id": request_id,
                "audio_path": str(wav_file.resolve()),
                "language": os.environ.get("MUSAFIR_ASR_LANGUAGE", "auto"),
            }).encode("utf-8") + b"\n"
            process.stdin.write(payload)
            process.stdin.flush()
            response = _read_parakeet_json(process, WHISPER_TIMEOUT, request_id)
        except (OSError, AudioError):
            _stop_parakeet()
            raise
        if response.get("ok") is not True:
            raise AudioError(f"Parakeet failed: {response.get('error', 'unknown error')}")
        text = response.get("text")
        if not isinstance(text, str):
            raise AudioError("Parakeet returned an invalid transcript")
        return " ".join(text.split())


atexit.register(close_asr)


def decode_to_wav(source: Path, work_dir: Path) -> Path:
    """Decode Ogg Opus or Zepp's length-prefixed Opus into bounded mono WAV."""

    data = _read_bounded(Path(source))
    directory = Path(work_dir)
    directory.mkdir(parents=True, exist_ok=True)
    wav_file = _temporary_path(directory, suffix=".wav")
    try:
        if data.startswith(b"OggS"):
            ogg_file = _temporary_path(directory, suffix=".ogg")
            try:
                ogg_file.write_bytes(data)
                ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
                _run(
                    [
                        ffmpeg,
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-i",
                        str(ogg_file),
                        "-t",
                        str(MAX_AUDIO_SECONDS + 0.1),
                        "-ac",
                        "1",
                        "-ar",
                        str(SAMPLE_RATE),
                        "-c:a",
                        "pcm_s16le",
                        str(wav_file),
                    ],
                    FFMPEG_TIMEOUT,
                    "ffmpeg",
                )
            finally:
                ogg_file.unlink(missing_ok=True)
        else:
            _decode_zepp(data, wav_file)
        _check_wav(wav_file)
        return wav_file
    except Exception:
        wav_file.unlink(missing_ok=True)
        raise


def transcribe(source: Path, work_dir: Path, model: Path) -> str:
    """Transcribe at most five minutes with the configured local ASR backend."""

    directory = Path(work_dir)
    wav_file = decode_to_wav(Path(source), directory)
    try:
        backend = os.environ.get("MUSAFIR_ASR_BACKEND", "parakeet").strip().lower()
        if backend == "parakeet":
            return _transcribe_parakeet(wav_file)
        if backend != "whisper":
            raise AudioError("unknown ASR backend")
        model = Path(model)
        if not model.is_file():
            raise AudioError("Whisper model is missing")
        output_base = _temporary_path(directory, prefix="whisper-")
        output_base.unlink(missing_ok=True)
        transcript_file = output_base.with_suffix(".txt")
        whisper = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
        language = os.environ.get("MUSAFIR_WHISPER_LANGUAGE", "ru").strip().lower()
        try:
            _run(
                [
                    whisper,
                    "-m",
                    str(model),
                    "-f",
                    str(wav_file),
                    "-l",
                    language,
                    "--prompt",
                    "Мусафир Гермес Орка",
                    "-nt",
                    "-np",
                    "-otxt",
                    "-of",
                    str(output_base),
                ],
                WHISPER_TIMEOUT,
                "whisper.cpp",
            )
            try:
                text = transcript_file.read_text(encoding="utf-8")
            except OSError as exc:
                raise AudioError("whisper.cpp did not produce a transcript") from exc
            return " ".join(text.split())
        finally:
            transcript_file.unlink(missing_ok=True)
    finally:
        wav_file.unlink(missing_ok=True)
