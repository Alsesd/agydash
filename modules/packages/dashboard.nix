{ self, ... }: {
  perSystem = { pkgs, lib, system, ... }: let
    dashboard = pkgs.stdenv.mkDerivation {
      pname = "antigravity-dashboard";
      version = "1.0.0";

      src = ../../src;

      nativeBuildInputs = [ pkgs.makeWrapper ];
      buildInputs = [ pkgs.python3 ];

      installPhase = ''
        mkdir -p $out/share/antigravity-dashboard $out/bin
        cp -r . $out/share/antigravity-dashboard/
        chmod +x $out/share/antigravity-dashboard/server.py

        makeWrapper ${pkgs.python3}/bin/python3 $out/bin/antigravity-dashboard \
          --add-flags "$out/share/antigravity-dashboard/server.py" \
          --prefix PATH : ${lib.makeBinPath [
            pkgs.python3
            pkgs.ttyd
            pkgs.tmux
            pkgs.sqlite
            pkgs.tailscale
            pkgs.procps
            pkgs.coreutils
          ]}
      '';

      meta = with lib; {
        description = "Antigravity Web Dashboard for Limits, Active Task, Questions & Persistent SSH Terminal";
        license = licenses.mit;
        mainProgram = "antigravity-dashboard";
      };
    };
  in {
    packages = {
      default = dashboard;
      antigravity-dashboard = dashboard;
    };

    apps = {
      default = {
        type = "app";
        program = "${dashboard}/bin/antigravity-dashboard";
      };
      antigravity-dashboard = {
        type = "app";
        program = "${dashboard}/bin/antigravity-dashboard";
      };
    };
  };
}
