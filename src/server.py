#!/usr/bin/env python3
"""
Antigravity Web Dashboard Server
Provides:
- Quota & limits monitoring (Gemini, Claude, GPT, 5h & weekly limits)
- Active task monitoring & live transcript timeline
- Notifications & interactive question answering
- Web SSH terminal with session persistence via tmux and ttyd
- Tailscale discovery and single-port reverse proxy
"""

import json
import os
import re
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Paths
DEFAULT_APP_DATA_DIR = Path(os.environ.get("ANTIGRAVITY_APP_DATA_DIR", Path.home() / ".gemini" / "antigravity-cli"))
CACHE_DIR = DEFAULT_APP_DATA_DIR / "cache"
BRAIN_DIR = DEFAULT_APP_DATA_DIR / "brain"
LOG_DIR = DEFAULT_APP_DATA_DIR / "log"
SUMMARIES_DB = DEFAULT_APP_DATA_DIR / "conversation_summaries.db"
QUOTA_CACHE_FILE = CACHE_DIR / "dashboard_quota_cache.json"
SESSION_CACHE_FILE = CACHE_DIR / "dashboard_session_cache.json"

STATIC_DIR = Path(__file__).resolve().parent / "static"

TTYD_PORT = 17682
TMUX_SESSION_NAME = "agy"

class TailscaleHelper:
    @staticmethod
    def get_info():
        info = {
            "available": False,
            "ip": None,
            "hostname": None,
            "status": "offline",
            "peers": []
        }
        try:
            cmd = shutil.which("tailscale") or "/run/current-system/sw/bin/tailscale"
            if not os.path.exists(cmd):
                return info
            
            # Get IP
            res = subprocess.run([cmd, "ip", "-4"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2)
            if res.returncode == 0 and res.stdout.strip():
                info["ip"] = res.stdout.strip().split("\n")[0]
                info["available"] = True
                info["status"] = "connected"

            # Get Status JSON
            res2 = subprocess.run([cmd, "status", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2)
            if res2.returncode == 0 and res2.stdout.strip():
                data = json.loads(res2.stdout)
                self_node = data.get("Self", {})
                info["hostname"] = self_node.get("HostName", socket.gethostname())
                info["tailscale_ips"] = self_node.get("TailscaleIPs", [])
                
                # List peers on tailnet
                peers = []
                for p in data.get("Peer", {}).values():
                    peers.append({
                        "hostname": p.get("HostName", ""),
                        "ip": p.get("TailscaleIPs", [""])[0] if p.get("TailscaleIPs") else "",
                        "os": p.get("OS", ""),
                        "online": p.get("Online", False)
                    })
                info["peers"] = peers
        except Exception as e:
            pass
        
        if not info["hostname"]:
            info["hostname"] = socket.gethostname()
        return info


class AntigravityMonitor:
    def __init__(self, app_data_dir=DEFAULT_APP_DATA_DIR):
        self.app_data_dir = Path(app_data_dir)
        self.ls_address = None
        self.csrf_token = None
        self.last_quota_data = None
        self.last_quota_time = 0
        self.cached_quota = self._load_cached_quota()

    def _load_cached_quota(self):
        if QUOTA_CACHE_FILE.exists():
            try:
                with open(QUOTA_CACHE_FILE, "r") as f:
                    return json.load(f)
            except Exception:
                pass
        return None

    def _save_cached_quota(self, data):
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            with open(QUOTA_CACHE_FILE, "w") as f:
                json.dump(data, f, indent=2)
        except Exception:
            pass

    def discover_credentials(self):
        # 1. Environment variables
        addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
        token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
        if addr and token:
            self.ls_address = addr
            self.csrf_token = token
            return True

        # 2. Check cached credentials if still valid
        if SESSION_CACHE_FILE.exists():
            try:
                with open(SESSION_CACHE_FILE, "r") as f:
                    cached = json.load(f)
                    c_addr = cached.get("ls_address")
                    c_token = cached.get("csrf_token")
                    if c_addr and c_token:
                        # Quick check if it responds
                        if self._test_connection(c_addr, c_token):
                            self.ls_address = c_addr
                            self.csrf_token = c_token
                            return True
            except Exception:
                pass

        # 3. Discover from /proc/*/environ
        try:
            token_candidate = None
            addr_candidate = None
            proc_dir = Path("/proc")
            for pid_dir in proc_dir.glob("[0-9]*"):
                environ_file = pid_dir / "environ"
                try:
                    if not os.access(environ_file, os.R_OK):
                        continue
                    with open(environ_file, "rb") as ef:
                        content = ef.read()
                        if b"ANTIGRAVITY_CSRF_TOKEN=" in content:
                            entries = content.split(b"\x00")
                            for entry in entries:
                                try:
                                    s = entry.decode("utf-8", errors="ignore")
                                    if s.startswith("ANTIGRAVITY_CSRF_TOKEN="):
                                        token_candidate = s.split("=", 1)[1]
                                    elif s.startswith("ANTIGRAVITY_LS_ADDRESS="):
                                        addr_candidate = s.split("=", 1)[1]
                                except Exception:
                                    pass
                            if token_candidate and addr_candidate:
                                break
                except (PermissionError, FileNotFoundError, ProcessLookupError):
                    continue

            if token_candidate:
                self.csrf_token = token_candidate
            if addr_candidate:
                self.ls_address = addr_candidate
        except Exception:
            pass

        # 4. If we have token but not addr, inspect cli.log for port
        if not self.ls_address:
            cli_log = self.app_data_dir / "cli.log"
            if cli_log.exists():
                try:
                    with open(cli_log, "r", errors="ignore") as f:
                        lines = f.readlines()
                        # scan backwards for "Language server listening on random port at (\d+) for HTTP"
                        for line in reversed(lines):
                            m = re.search(r"Language server listening on random port at (\d+) for HTTP", line)
                            if m:
                                self.ls_address = f"localhost:{m.group(1)}"
                                break
                except Exception:
                    pass

        # 5. Check if we also find token in recent step outputs
        if not self.csrf_token:
            for step_out in self.app_data_dir.glob("brain/*/.system_generated/steps/*/output.txt"):
                try:
                    with open(step_out, "r", errors="ignore") as f:
                        txt = f.read()
                        m = re.search(r"ANTIGRAVITY_CSRF_TOKEN=([a-zA-Z0-9\-]+)", txt)
                        if m:
                            self.csrf_token = m.group(1)
                            break
                except Exception:
                    pass

        if self.ls_address and self.csrf_token:
            # Cache it
            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                with open(SESSION_CACHE_FILE, "w") as f:
                    json.dump({"ls_address": self.ls_address, "csrf_token": self.csrf_token}, f)
            except Exception:
                pass
            return True
        return False

    def _test_connection(self, addr, token):
        try:
            url = f"http://{addr}/exa.language_server_pb.LanguageServerService/GetStatus"
            req = urllib.request.Request(url, data=b"{}", headers={
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-codeium-csrf-token": token
            })
            with urllib.request.urlopen(req, timeout=1) as resp:
                return resp.status == 200
        except Exception:
            return False

    def get_limits_and_usage(self):
        now = time.time()
        # Refresh quota at most every 5 seconds
        if self.last_quota_data and (now - self.last_quota_time < 5):
            return self.last_quota_data

        # Try live query
        self.discover_credentials()
        if self.ls_address and self.csrf_token:
            try:
                url = f"http://{self.ls_address}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
                req = urllib.request.Request(url, data=b"{}", headers={
                    "Content-Type": "application/json",
                    "Connect-Protocol-Version": "1",
                    "x-codeium-csrf-token": self.csrf_token
                })
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        raw = json.loads(resp.read().decode("utf-8"))
                        quota_resp = raw.get("response", {})
                        data = {
                            "status": "live",
                            "timestamp": now,
                            "groups": quota_resp.get("groups", []),
                            "description": quota_resp.get("description", ""),
                            "ls_address": self.ls_address
                        }
                        self.last_quota_data = data
                        self.last_quota_time = now
                        self._save_cached_quota(data)
                        return data
            except Exception as e:
                pass

        # Return cached quota if available
        if self.cached_quota:
            cached = dict(self.cached_quota)
            cached["status"] = "cached"
            return cached

        # Fallback template if fresh installation without live server yet
        return {
            "status": "offline",
            "timestamp": now,
            "groups": [
                {
                    "displayName": "Gemini Models",
                    "description": "Models within this group: Gemini Flash, Gemini Pro",
                    "buckets": [
                        {"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "remainingFraction": 1.0, "resetTime": ""},
                        {"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "remainingFraction": 1.0, "resetTime": ""}
                    ]
                },
                {
                    "displayName": "Claude and GPT models",
                    "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                    "buckets": [
                        {"bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "remainingFraction": 1.0, "resetTime": ""},
                        {"bucketId": "3p-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "remainingFraction": 1.0, "resetTime": ""}
                    ]
                }
            ],
            "description": "Quota pools for Antigravity models."
        }

    def get_recent_conversations(self, limit=10):
        convs = []
        if SUMMARIES_DB.exists():
            try:
                conn = sqlite3.connect(f"file:{SUMMARIES_DB}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT conversation_id, title, preview, step_count, status, last_modified_time, not_fully_idle, killed
                    FROM conversation_summaries
                    ORDER BY last_modified_time DESC
                    LIMIT ?
                """, (limit,))
                for row in cursor.fetchall():
                    convs.append({
                        "id": row[0],
                        "title": row[1] or "Untitled Conversation",
                        "preview": row[2],
                        "step_count": row[3],
                        "status": row[4],
                        "last_modified": row[5],
                        "not_fully_idle": bool(row[6]),
                        "killed": bool(row[7])
                    })
                conn.close()
            except Exception as e:
                pass
        return convs

    def get_active_conversation_id(self):
        # 1. Environment variable if present
        if os.environ.get("ANTIGRAVITY_CONVERSATION_ID"):
            return os.environ.get("ANTIGRAVITY_CONVERSATION_ID")

        # 2. Check conversation_summaries.db for actively running conversation (not_fully_idle = 1)
        if SUMMARIES_DB.exists():
            try:
                conn = sqlite3.connect(f"file:{SUMMARIES_DB}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT conversation_id FROM conversation_summaries
                    WHERE not_fully_idle = 1 OR status = 'CASCADE_RUN_STATUS_RUNNING'
                    ORDER BY last_modified_time DESC
                    LIMIT 1
                """)
                row = cursor.fetchone()
                if row and row[0]:
                    conn.close()
                    return row[0]

                # If no running conversation, select the one with most recent activity and steps
                cursor.execute("""
                    SELECT conversation_id FROM conversation_summaries
                    WHERE step_count > 0
                    ORDER BY last_modified_time DESC
                    LIMIT 1
                """)
                row = cursor.fetchone()
                conn.close()
                if row and row[0]:
                    return row[0]
            except Exception:
                pass

        # 3. Check presence locks
        presence_dir = self.app_data_dir / "presence"
        if presence_dir.exists():
            locks = list(presence_dir.glob("*.lock"))
            if locks:
                locks.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                return locks[0].stem

        # 4. Check cache/last_conversations.json
        last_conv_file = CACHE_DIR / "last_conversations.json"
        if last_conv_file.exists():
            try:
                with open(last_conv_file, "r") as f:
                    data = json.load(f)
                    cwd = os.getcwd()
                    if cwd in data:
                        return data[cwd]
                    if "/home/alsesd/agy" in data:
                        return data["/home/alsesd/agy"]
                    vals = list(data.values())
                    if vals:
                        return vals[-1]
            except Exception:
                pass

        return None

    def get_task_details(self, conv_id=None):
        if not conv_id:
            conv_id = self.get_active_conversation_id()
        if not conv_id:
            return {"active": False, "message": "No active conversation found"}

        res = {
            "active": True,
            "conversation_id": conv_id,
            "title": "Current Task",
            "status": "UNKNOWN",
            "not_fully_idle": False,
            "user_request": "",
            "steps_count": 0,
            "recent_steps": [],
            "pending_question": None,
            "notifications": [],
            "current_action": None
        }

        # Query summary
        if SUMMARIES_DB.exists():
            try:
                conn = sqlite3.connect(f"file:{SUMMARIES_DB}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT title, status, step_count, not_fully_idle
                    FROM conversation_summaries WHERE conversation_id = ?
                """, (conv_id,))
                row = cursor.fetchone()
                if row:
                    res["title"] = row[0] or "Antigravity Session"
                    res["status"] = row[1]
                    res["steps_count"] = row[2]
                    res["not_fully_idle"] = bool(row[3])
                conn.close()
            except Exception:
                pass

        # Read transcript
        transcript_file = BRAIN_DIR / conv_id / ".system_generated" / "logs" / "transcript.jsonl"
        if transcript_file.exists():
            try:
                with open(transcript_file, "r", errors="ignore") as f:
                    steps = []
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            s = json.loads(line)
                            steps.append(s)
                        except Exception:
                            pass
                    
                    res["steps_count"] = len(steps)
                    if steps:
                        # Extract first user request
                        for st in steps:
                            if st.get("type") == "USER_INPUT" and st.get("content"):
                                res["user_request"] = st.get("content")
                                break

                        # Scan for pending questions or latest actions
                        # Recent 25 steps
                        res["recent_steps"] = steps[-25:]
                        
                        # Find latest model step
                        for st in reversed(steps):
                            tool_calls = st.get("tool_calls", [])
                            if tool_calls:
                                tc = tool_calls[0]
                                res["current_action"] = {
                                    "step_index": st.get("step_index"),
                                    "tool": tc.get("name"),
                                    "action": tc.get("args", {}).get("toolAction", ""),
                                    "summary": tc.get("args", {}).get("toolSummary", ""),
                                    "args": tc.get("args", {})
                                }
                                break

                        # Check for pending ask_question
                        # A question is pending if an ask_question step occurred after the last USER_INPUT step
                        last_user_idx = -1
                        last_question = None
                        for st in steps:
                            if st.get("type") == "USER_INPUT":
                                last_user_idx = st.get("step_index", 0)
                            for tc in st.get("tool_calls", []):
                                if tc.get("name") == "ask_question":
                                    last_question = {
                                        "step_index": st.get("step_index"),
                                        "tool": "ask_question",
                                        "questions": tc.get("args", {}).get("questions", []),
                                        "time": st.get("created_at")
                                    }

                        if last_question and last_question["step_index"] > last_user_idx:
                            res["pending_question"] = last_question

                        # Notifications (e.g. background tasks or reminders)
                        for st in steps[-20:]:
                            content = st.get("content", "")
                            if "Notification:" in content or "Completed" in content or "Task" in content:
                                res["notifications"].append({
                                    "step_index": st.get("step_index"),
                                    "type": st.get("type"),
                                    "snippet": content[:200]
                                })
            except Exception as e:
                res["error"] = str(e)

        return res


class TerminalManager:
    """Manages the background ttyd process running persistent tmux session."""
    def __init__(self, port=TTYD_PORT, session=TMUX_SESSION_NAME):
        self.port = port
        self.session = session
        self.process = None
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self):
        # Find binaries
        ttyd_bin = shutil.which("ttyd") or "/run/current-system/sw/bin/ttyd"
        tmux_bin = shutil.which("tmux") or "/run/current-system/sw/bin/tmux"

        # Check in nix profiles / nix store
        if not os.path.exists(ttyd_bin):
            for p in Path("/nix/store").glob("*-ttyd-*/bin/ttyd"):
                ttyd_bin = str(p)
                break
        if not os.path.exists(tmux_bin):
            for p in Path("/nix/store").glob("*-tmux-*/bin/tmux"):
                tmux_bin = str(p)
                break

        # Pre-create tmux session so it is persistent and ready immediately
        try:
            subprocess.run([tmux_bin, "new-session", "-d", "-s", self.session], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

        print(f"[TerminalManager] Using ttyd: {ttyd_bin}, tmux: {tmux_bin} on port {self.port}")

        while not self._stop_event.is_set():
            cmd = [
                ttyd_bin,
                "-p", str(self.port),
                "-i", "127.0.0.1",
                "-W",
                "-b", "/terminal",
                tmux_bin, "new-session", "-A", "-s", self.session
            ]
            try:
                self.process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.process.wait()
            except Exception as e:
                print(f"[TerminalManager] Error running ttyd: {e}")
            time.sleep(1)

    def stop(self):
        self._stop_event.set()
        if self.process:
            self.process.terminate()


class DashboardHandler(BaseHTTPRequestHandler):
    monitor = None
    terminal_port = TTYD_PORT

    def log_message(self, format, *args):
        # Suppress routine GET logging to keep logs clean
        pass

    def do_HEAD(self):
        url_path = self.path.split("?")[0]
        if url_path == "/" or url_path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
        elif url_path.startswith("/api/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()

    def do_GET(self):
        url_path = self.path.split("?")[0]

        if url_path == "/" or url_path == "/index.html":
            self._serve_static_file("index.html", "text/html")
        elif url_path.startswith("/static/"):
            rel = url_path[len("/static/"):]
            self._serve_static_file(rel)
        elif url_path == "/api/status":
            self._send_json(self.monitor.get_task_details())
        elif url_path == "/api/limits":
            self._send_json(self.monitor.get_limits_and_usage())
        elif url_path == "/api/conversations":
            self._send_json(self.monitor.get_recent_conversations(15))
        elif url_path == "/api/tailscale":
            self._send_json(TailscaleHelper.get_info())
        elif url_path == "/api/stream":
            self._handle_sse_stream()
        elif url_path.startswith("/terminal"):
            self._proxy_to_ttyd()
        else:
            self.send_error(404, "Not Found")

    def do_POST(self):
        url_path = self.path.split("?")[0]
        if url_path == "/api/answer":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                conv_id = data.get("conversationId") or self.monitor.get_active_conversation_id()
                answer = data.get("answer", "")
                
                # Try sending message via agentapi
                agentapi = Path.home() / ".gemini" / "antigravity-cli" / "bin" / "agentapi"
                if not agentapi.exists():
                    agentapi = shutil.which("agentapi")

                resp_out = "Answer received and logged."
                if agentapi and os.path.exists(str(agentapi)):
                    try:
                        res = subprocess.run(
                            [str(agentapi), "send-message", conv_id, answer],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5
                        )
                        resp_out = res.stdout if res.returncode == 0 else res.stderr
                    except Exception as ex:
                        resp_out = str(ex)

                self._send_json({"success": True, "output": resp_out})
            except Exception as e:
                self._send_json({"success": False, "error": str(e)}, status=400)
        else:
            self.send_error(404, "Endpoint not found")

    def _send_json(self, data, status=200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _serve_static_file(self, rel_path, content_type=None):
        file_path = STATIC_DIR / rel_path
        if not file_path.is_file():
            self.send_error(404, f"File {rel_path} not found")
            return

        if not content_type:
            ext = file_path.suffix.lower()
            types = {
                ".html": "text/html",
                ".css": "text/css",
                ".js": "application/javascript",
                ".json": "application/json",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon"
            }
            content_type = types.get(ext, "application/octet-stream")

        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, str(e))

    def _handle_sse_stream(self):
        """Server-Sent Events for real-time frontend updates."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            while True:
                task = self.monitor.get_task_details()
                limits = self.monitor.get_limits_and_usage()
                payload = json.dumps({"task": task, "limits": limits})
                self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(1.5)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _proxy_to_ttyd(self):
        """Reverse proxies HTTP & WebSocket requests to local ttyd."""
        is_websocket = self.headers.get("Upgrade", "").lower() == "websocket"
        backend_host = "127.0.0.1"
        backend_port = self.terminal_port

        try:
            target_sock = socket.create_connection((backend_host, backend_port), timeout=3)
        except Exception as e:
            self.send_error(502, f"Could not connect to terminal backend: {e}")
            return

        # Prepare request line and headers
        req_line = f"{self.command} {self.path} HTTP/1.1\r\n"
        headers_str = req_line
        for h, v in self.headers.items():
            if h.lower() == "host":
                v = f"{backend_host}:{backend_port}"
            headers_str += f"{h}: {v}\r\n"
        headers_str += "\r\n"

        target_sock.sendall(headers_str.encode("utf-8"))

        if is_websocket:
            # Upgrade connection and relay raw TCP bidirectionally
            self.close_connection = True
            client_sock = self.connection
            client_sock.setblocking(False)
            target_sock.setblocking(False)

            sockets = [client_sock, target_sock]
            try:
                while True:
                    r, _, x = select.select(sockets, [], sockets, 30.0)
                    if x:
                        break
                    if not r:
                        continue
                    for s in r:
                        other = target_sock if s is client_sock else client_sock
                        data = s.recv(16384)
                        if not data:
                            return
                        other.sendall(data)
            except Exception:
                pass
            finally:
                target_sock.close()
        else:
            # Standard HTTP response proxying
            target_sock.settimeout(5.0)
            try:
                resp_data = bytearray()
                while True:
                    chunk = target_sock.recv(16384)
                    if not chunk:
                        break
                    resp_data.extend(chunk)
                    if b"\r\n\r\n" in resp_data:
                        # Extract status and headers
                        head, body = resp_data.split(b"\r\n\r\n", 1)
                        lines = head.split(b"\r\n")
                        status_line = lines[0].decode("latin-1")
                        parts = status_line.split(" ", 2)
                        status_code = int(parts[1]) if len(parts) > 1 else 200

                        self.send_response(status_code)
                        content_len = None
                        for l in lines[1:]:
                            if b":" in l:
                                k, v = l.decode("latin-1").split(":", 1)
                                k_s = k.strip()
                                v_s = v.strip()
                                if k_s.lower() not in ("transfer-encoding", "connection"):
                                    self.send_header(k_s, v_s)
                                if k_s.lower() == "content-length":
                                    content_len = int(v_s)

                        self.end_headers()
                        if body:
                            self.wfile.write(body)
                        # Read remaining if content-length specified
                        if content_len is not None:
                            rem = content_len - len(body)
                            while rem > 0:
                                chunk = target_sock.recv(min(rem, 16384))
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                                rem -= len(chunk)
                        break
            except Exception as e:
                pass
            finally:
                target_sock.close()


def run_dashboard(host="0.0.0.0", port=9090):
    monitor = AntigravityMonitor()
    terminal_mgr = TerminalManager(port=TTYD_PORT, session=TMUX_SESSION_NAME)
    terminal_mgr.start()

    DashboardHandler.monitor = monitor
    DashboardHandler.terminal_port = TTYD_PORT

    server = HTTPServer((host, port), DashboardHandler)
    ts = TailscaleHelper.get_info()

    print("=" * 65)
    print(" 🚀 Antigravity Web Dashboard is running!")
    print(f" • Local Address:     http://localhost:{port}")
    if ts["available"] and ts["ip"]:
        print(f" • Tailscale Address: http://{ts['ip']}:{port}")
        if ts["hostname"]:
            print(f" • Tailscale DNS:     http://{ts['hostname']}:{port}")
    else:
        print(" • Tailscale:         Not currently connected (binding to 0.0.0.0)")
    print(f" • SSH Tmux Session:  tmux attach -t {TMUX_SESSION_NAME}")
    print("=" * 65)

    def shutdown(sig, frame):
        print("\nShutting down dashboard...")
        terminal_mgr.stop()
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    server.serve_forever()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Antigravity Web Dashboard")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "9090")), help="Port to listen (default: 9090)")
    args = parser.parse_args()

    run_dashboard(host=args.host, port=args.port)
