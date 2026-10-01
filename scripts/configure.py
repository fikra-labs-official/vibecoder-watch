"""Create the bridge key and the phone-side connection file.

The key is printed only with --show-key (for the app settings in Zepp).
--url=https://<mac>.<tailnet>.ts.net:8443 overrides the address taken from Tailscale.
--rotate-token issues a new key; old installs lose access at once.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
os.umask(0o077)
folder = root / '.local'
folder.mkdir(exist_ok=True, mode=0o700)
path = folder / 'config.json'
args = sys.argv[1:]


def tailnet_url():
    """https://<this Mac>.<tailnet>.ts.net:8443 from `tailscale status --json`, or ''."""
    for exe in ('tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'):
        try:
            out = subprocess.run([exe, 'status', '--json'], capture_output=True, text=True, timeout=10)
            name = json.loads(out.stdout)['Self']['DNSName'].rstrip('.')
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            continue
        if name:
            return f'https://{name}:8443'
    return ''


config = json.loads(path.read_text()) if path.exists() else {
    'token': secrets.token_urlsafe(32),
    'hermesEnv': str(Path.home() / '.hermes/.env'),
    'model': str(folder / 'models/ggml-base.bin'),
}
url = next((a.split('=', 1)[1] for a in args if a.startswith('--url=')), None) or config.get('url') or tailnet_url()
if not url.startswith('https://'):
    raise SystemExit('Tailscale is not running on this Mac. Start it, or pass --url=https://<mac>.<tailnet>.ts.net:8443')
config['url'] = url.rstrip('/')
if '--rotate-token' in args:
    config['token'] = secrets.token_urlsafe(32)
path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\n')
path.chmod(0o600)
side = root / 'app-side/connection.js'
side.write_text('export const bridgeURL = ' + json.dumps(config['url']) + '\n'
                + 'export const deviceToken = ' + json.dumps(config['token']) + '\n')
side.chmod(0o600)
print('Bridge address:', config['url'])
print('Device key:', config['token'] if '--show-key' in args else 'hidden (add --show-key to print it for the app settings in Zepp)')
