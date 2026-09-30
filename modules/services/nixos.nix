{ self, ... }: {
  flake.nixosModules = rec {
    antigravity-dashboard = { config, lib, pkgs, ... }: let
      cfg = config.services.antigravity-dashboard;
    in {
      options.services.antigravity-dashboard = {
        enable = lib.mkEnableOption "Antigravity Web Dashboard & Persistent Terminal service";

        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${pkgs.system}.antigravity-dashboard;
          description = "The Antigravity Dashboard package to run.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 8765;
          description = "Port to listen on (strictly bound to localhost).";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Host interface address to bind strictly on localhost.";
        };

        user = lib.mkOption {
          type = lib.types.str;
          default = "alsesd";
          description = "User to run the daemon as (needed to access ~/.gemini and processes).";
        };

        openFirewall = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Automatically open the dashboard port in firewall.";
        };
      };

      config = lib.mkIf cfg.enable {
        networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

        systemd.services.antigravity-dashboard = {
          description = "Antigravity Web Dashboard & Persistent Terminal Daemon";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" "tailscale.service" ];
          wants = [ "network.target" ];

          environment = {
            PORT = toString cfg.port;
            HOST = cfg.host;
            HOME = "/home/${cfg.user}";
          };

          serviceConfig = {
            Type = "simple";
            User = cfg.user;
            Group = "users";
            WorkingDirectory = "/home/${cfg.user}";
            ExecStart = "${cfg.package}/bin/antigravity-dashboard --host ${cfg.host} --port ${toString cfg.port}";
            Restart = "always";
            RestartSec = "3s";
            KillMode = "mixed";
          };
        };
      };
    };

    default = antigravity-dashboard;
  };
}
