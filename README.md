# 🚀 Antigravity Web Dashboard & Persistent Terminal

A sleek, real-time web dashboard for Google Antigravity, featuring live quota and rate limit meters, active task monitoring, interactive questions/notifications, and a persistent SSH web terminal connected via tmux.

Built in Nix using the **nix-parts dendritic module pattern** (`flake-parts` + `import-tree`), natively accessible across your Tailscale network and pre-configured for automated service launching.

---

## 🌐 Access Points

| Network | URL | Description |
| :--- | :--- | :--- |
| **Tailscale IP** | `http://100.109.108.22:9090` | Accessible from any device on your Tailnet (Mac, iOS, Android, PC) |
| **Tailscale MagicDNS** | `http://nixos:9090` | Accessible using your machine name on Tailscale |
| **Localhost** | `http://localhost:9090` | Direct local machine access |
| **Direct SSH Terminal** | `ssh alsesd@100.109.108.22 -t "tmux new -A -s agy"` | Native SSH directly attaching to the persistent dashboard session |

---

## ✨ Features

1. **Quota & Rate Limits**:
   - Live query to Antigravity Language Server via Connect RPC.
   - **Gemini Models**: Weekly and 5-hour limit percentages, countdown timers to full refresh.
   - **Claude & GPT Models**: 3p-weekly and 3p-5h limit percentages and reset countdowns.
   - Quota pool explanation and offline fallback caching.

2. **Current Task & Activity Feed**:
   - Active task title and conversation ID.
   - Real-time step counter and execution state (`RUNNING` / `IDLE`).
   - Active tool call display (command, file edit, summary).
   - Live timeline of steps with collapsible inputs/outputs.
   - Real-time Server-Sent Events (SSE) streaming updates without manual page refreshes.

3. **Interactive Questions & Notifications**:
   - Pending questions (`ask_question` tool calls) highlighted with an interactive form.
   - Select multiple-choice answers or enter custom instructions directly from your phone/browser.
   - Instant response submission back to the agent session.
   - System notifications log and unread notification badge.

4. **Persistent SSH Web Terminal**:
   - Embedded web terminal powered by `ttyd` and `tmux`.
   - **Connection Drop Proof**: All processes, running builds, tests, and shells persist inside `tmux` session `agy`.
   - Closing your browser, walking away, or switching devices reattaches immediately to the exact same shell.
   - Served through the dashboard's single reverse-proxy port (no separate terminal port exposure needed).

---

## 🌲 Dendritic Module Architecture

The flake utilizes the **vic/import-tree** dendritic pattern matching your NixOS configuration structure:

```
agy/
├── flake.nix                       # Flake entrypoint using mkFlake + import-tree ./modules
├── modules/
│   ├── parts.nix                   # Flake-parts systems and pkgs configuration
│   ├── packages/
│   │   └── dashboard.nix           # Derivation definition & apps.antigravity-dashboard
│   ├── services/
│   │   ├── nixos.nix               # NixOS module (services.antigravity-dashboard)
│   │   └── home-manager.nix        # Home-Manager module (systemd user daemon)
│   └── devshell.nix                # Development shell with python3, ttyd, tmux, tailscale
├── bin/
│   └── antigravity-dashboard       # Service control utility (install, start, status, logs)
└── src/
    ├── server.py                   # High-performance server, RPC bridge & WebSocket proxy
    └── static/
        ├── index.html              # Modern dashboard layout
        ├── style.css               # Dark theme responsive styles
        └── app.js                  # Real-time SSE client and UI logic
```

---

## 🛠️ CLI Management

The included helper `bin/antigravity-dashboard` provides full service control:

```bash
# Check service status
./bin/antigravity-dashboard service status

# Follow service logs
./bin/antigravity-dashboard service logs

# Restart service
./bin/antigravity-dashboard service restart

# Stop service
./bin/antigravity-dashboard service stop

# View Tailscale access details
./bin/antigravity-dashboard tailscale
```

---

## 📦 NixOS System Integration

To include this module directly into your system flake (`/home/alsesd/myNixos`):

1. Add the input in `/home/alsesd/myNixos/flake.nix`:
   ```nix
   inputs = {
     # ...
     antigravity-dashboard.url = "path:/home/alsesd/agy";
   };
   ```

2. Enable the service in any dendritic module under `/home/alsesd/myNixos/modules/features/services/antigravity.nix`:
   ```nix
   { inputs, ... }: {
     flake.nixosModules.antigravity = { ... }: {
       imports = [ inputs.antigravity-dashboard.nixosModules.default ];

       services.antigravity-dashboard = {
         enable = true;
         port = 9090;
         openFirewall = true;
       };
     };
   }
   ```
