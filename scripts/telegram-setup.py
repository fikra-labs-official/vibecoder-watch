"""Connect Telegram notifications without touching the Bot API by hand.

Validates the bot token, waits for the owner's first message to the bot,
stores telegramBotToken/telegramChatId in .local/config.json (0600),
sends a test message and restarts the bridge.
"""
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
config_path = root / ".local/config.json"
token = (sys.argv[1] if len(sys.argv) > 1 else getpass.getpass("Токен бота от @BotFather: ")).strip()
if ":" not in token:
    raise SystemExit("Токен выглядит неверно: ожидается вид 123456789:ABC...")


def api(method, **params):
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(params).encode() if params else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            body = json.load(response)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Telegram отклонил {method}: HTTP {exc.code}. Проверьте токен целиком.") from exc
    if not body.get("ok"):
        raise SystemExit(f"Telegram: {body}")
    return body["result"]


me = api("getMe")
print(f"Бот @{me['username']} найден. Откройте его в Telegram, нажмите Start и отправьте любое сообщение.")
print("Жду до 3 минут...")
api("deleteWebhook")  # getUpdates only works while no webhook is set
chat_id, name, offset = None, "", None
deadline = time.time() + 180
while time.time() < deadline and chat_id is None:
    for update in api("getUpdates", timeout=20, **({"offset": offset} if offset else {})):
        offset = update["update_id"] + 1
        chat = (update.get("message") or update.get("edited_message") or {}).get("chat") or {}
        if chat.get("type") == "private":
            chat_id = chat["id"]
            name = chat.get("first_name") or chat.get("username") or ""
            break
if chat_id is None:
    raise SystemExit("Сообщение боту не пришло. Нажмите Start в чате с ботом и запустите снова.")

config = json.loads(config_path.read_text())
config["telegramBotToken"] = token
config["telegramChatId"] = chat_id
os.umask(0o077)
config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
config_path.chmod(0o600)
print(f"Чат {name} сохранён в .local/config.json")
api("sendMessage", chat_id=chat_id, text="Мусафир: уведомления с Mac подключены. Если это пришло на часы, всё готово.")
print("Тестовое сообщение отправлено. Перезапускаю мост...")
subprocess.run([sys.executable, str(root / "scripts/start-bridge.py")], check=True)
