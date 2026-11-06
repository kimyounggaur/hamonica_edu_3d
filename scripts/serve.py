"""Serve the local source app for development and browser QA."""
from argparse import ArgumentParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=4173)
parser.add_argument("--strictPort", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
handler = partial(SimpleHTTPRequestHandler, directory=root)
with ThreadingHTTPServer((args.host, args.port), handler) as server:
    print(f"http://{args.host}:{args.port}/", flush=True)
    server.serve_forever()
