{ ... }: {
  perSystem = { pkgs, ... }: {
    devShells.default = pkgs.mkShell {
      packages = [
        pkgs.python3
        pkgs.ttyd
        pkgs.tmux
        pkgs.sqlite
        pkgs.tailscale
        pkgs.curl
        pkgs.git
      ];

      shellHook = ''
        echo "🚀 Antigravity Web Dashboard Dev Environment"
        echo "Run './bin/antigravity-dashboard start' or 'nix run' to start dashboard."
      '';
    };
  };
}
