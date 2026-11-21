#!/usr/bin/env python3
"""Static dev server for the game with caching off (python -m http.server lets
browsers cache index.html / js modules, so edits did not show up on reload).

  python3 serve.py [PORT] [--bind ADDR]   -> http://127.0.0.1:8765/
  --bind 0.0.0.0 opens it to the home network (phone: http://<this PC's LAN IP>:8765/).
/tiles/... serves the local 3D Tiles mirror ../berlin_mesh_2025_wab/ (the streamed level).
"""
import argparse, functools, http.server, os


HERE = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.join(os.path.dirname(HERE), "berlin_mesh_2025_wab")


class NoCache(http.server.SimpleHTTPRequestHandler):
    # keep-alive: files, 404s (send_error) and redirects all carry Content-Length; without
    # it every streamed tile paid a new TCP connection
    protocol_version = "HTTP/1.1"
    def translate_path(self, path):
        p = path.split("?", 1)[0].split("#", 1)[0]
        if p.startswith("/tiles/"):                            # mesh tiles from the local mirror
            return super().translate_path(p[len("/tiles"):]).replace(HERE, TILES, 1)
        return super().translate_path(path)

    def end_headers(self):
        if not self.path.split("?")[0].endswith((".glb", ".b3dm")):   # meshes may cache
            self.send_header("Cache-Control", "no-store")
        if self.path.startswith("/tiles/"):   # a copy of the site on another port may stream from here
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


ap = argparse.ArgumentParser(description="no-cache dev server for the game")
ap.add_argument("port", nargs="?", type=int, default=8765)
ap.add_argument("--bind", default="127.0.0.1", help="address to listen on (0.0.0.0 = whole LAN)")
args = ap.parse_args()
handler = functools.partial(NoCache, directory=HERE)
http.server.ThreadingHTTPServer((args.bind, args.port), handler).serve_forever()
