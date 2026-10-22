"""Server CalDAV di prova per i test (Radicale), con dati in una cartella temporanea.

Uso:  pip install radicale   poi   python3 test/server.py
Ascolta su http://127.0.0.1:5232 con utente "prova" e password "prova123".
"""
import os
import subprocess
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix="spunta-test-")
users = os.path.join(tmp, "users")
config = os.path.join(tmp, "config")
with open(users, "w") as f:
    f.write("prova:prova123\n")
with open(config, "w") as f:
    f.write(f"""[server]
hosts = 127.0.0.1:5232
[auth]
type = htpasswd
htpasswd_filename = {users}
htpasswd_encryption = plain
[storage]
filesystem_folder = {os.path.join(tmp, "data")}
[logging]
level = warning
""")
print(f"Server di prova su http://127.0.0.1:5232 (dati in {tmp})", flush=True)
sys.exit(subprocess.call([sys.executable, "-m", "radicale", "--config", config]))
