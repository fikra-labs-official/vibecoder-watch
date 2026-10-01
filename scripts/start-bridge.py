"""Install this project's user LaunchAgent, bound only to loopback."""
import os
from pathlib import Path
import plistlib
import json
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
runtime = Path.home() / '.local/share/musafer-watch'
settings = json.loads((root / '.local/config.json').read_text())
backend = settings.setdefault('asrBackend', 'parakeet')
if backend == 'parakeet':
    runner_source = root / '.local/asr-parakeet-transcribe'
    model_directory = Path(settings.get('parakeetModelDir', Path.home() / 'Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3'))
    if not runner_source.is_file() or not model_directory.is_dir():
        raise SystemExit('Build the Parakeet runner first: node scripts/build-parakeet.mjs; install the local Parakeet V3 weights.')
    settings['parakeetRunner'] = str(runtime / 'bin/parakeet-transcribe')
    settings['parakeetModelDir'] = str(model_directory)

runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
(runtime / 'bridge').mkdir(exist_ok=True)
(runtime / '.local/models').mkdir(parents=True, exist_ok=True, mode=0o700)
for name in ['server.py', 'audio.py', 'orca_service.py', 'orca_projects.py', 'orca_intent.py', 'orca_trust.py', 'notify.py', 'lexicon.py', 'digest.py', 'claude_sessions.py', 'codex_sessions.py', 'permission_tool.py', 'watchdog.py', 'limits.py']:
    shutil.copy2(root / 'bridge' / name, runtime / 'bridge' / name)
if backend == 'parakeet':
    (runtime / 'bin').mkdir(exist_ok=True, mode=0o700)
    shutil.copy2(runner_source, runtime / 'bin/parakeet-transcribe')
    (runtime / 'bin/parakeet-transcribe').chmod(0o700)
# Whisper base is only the optional fallback backend; Parakeet does not need it.
model_source = Path(settings.get('model') or root / '.local/models/ggml-base.bin')
model_target = runtime / '.local/models/ggml-base.bin'
if model_source.is_file() and (not model_target.exists() or model_target.stat().st_size != model_source.stat().st_size):
    shutil.copy2(model_source, model_target)
settings['model'] = str(model_target)
private_config = runtime / '.local/config.json'
private_config.write_text(json.dumps(settings, indent=2) + '\n')
private_config.chmod(0o600)
label = 'com.fikra.musafer-watch'
target = f'gui/{os.getuid()}'
agents = Path.home() / 'Library/LaunchAgents'
agents.mkdir(exist_ok=True)
path = agents / (label + '.plist')
config = {
    'Label': label,
    'ProgramArguments': [str(Path(sys.executable).resolve()), str(runtime / 'bridge/server.py')],
    'WorkingDirectory': str(runtime),
    'EnvironmentVariables': {'PATH': str(Path.home() / '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'StandardOutPath': str(runtime / '.local/bridge.log'),
    'StandardErrorPath': str(runtime / '.local/bridge-error.log'),
}
if path.exists():
    old = plistlib.loads(path.read_bytes())
    old_arguments = old.get('ProgramArguments', [])
    if not old_arguments or old_arguments[-1] not in [str(root / 'bridge/server.py'), str(runtime / 'bridge/server.py')]:
        raise SystemExit('An existing agent uses this label; leave it unchanged.')
    subprocess.run(['launchctl', 'bootout', target, str(path)], capture_output=True)
path.write_bytes(plistlib.dumps(config))
path.chmod(0o600)
subprocess.run(['launchctl', 'bootstrap', target, str(path)], check=True)
print('Started', label, 'on 127.0.0.1:8768')
