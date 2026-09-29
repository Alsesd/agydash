{ self, ... }: {
  flake.homeManagerModules = rec {
    antigravity-dashboard = { config, lib, pkgs, ... }: let
      cfg = config.services.antigravity-dashboard;
    in {
      options.services.antigravity-dashboard = {
        enable = lib.mkEnableOption "Antigravity Web Dashboard & Persistent Terminal user service";

        package = lib.mkOption {
          type = lib.types.package;
          default = self.packages.${pkgs.system}.antigravity-dashboard;
          description = "The Antigravity Dashboard package to run.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 9090;
          description = "Port to listen on (accessible via Tailscale IP or localhost).";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host interface address to bind.";
        };
      };

      config = lib.mkIf cfg.enable {
        systemd.user.services.antigravity-dashboard = {
          Unit = {
            Description = "Antigravity Web Dashboard & Persistent Terminal User Daemon";
            After = [ "network.target" ];
            Wants = [ "network.target" ];
          };

          Service = {
            Type = "simple";
            Environment = [
              "PORT=${toString cfg.port}"
              "HOST=${cfg.host}"
            ];
            ExecStart = "${cfg.package}/bin/antigravity-dashboard --host ${cfg.host} --port ${toString cfg.port}";
            Restart = "always";
            RestartSec = "3s";
            KillMode = "mixed";
          };

          Install = {
            WantedBy = [ "default.target" ];
          };
        };
      };
    };

    default = antigravity-dashboard;
  };
}
