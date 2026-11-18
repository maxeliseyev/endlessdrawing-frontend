#!/usr/bin/env python3
"""Disposable local PostgreSQL/backend + bounded WS shaper. Never targets production.
Requires Python websockets==15.0.1, Docker dev PostgreSQL, a built backend and Playwright.
Only generated synthetic strokes are inserted; a fresh database is dropped on exit.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.request
import uuid
from websockets.asyncio.server import serve
from websockets.asyncio.client import connect

ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--backend", required=True, type=pathlib.Path)
parser.add_argument("--profile", choices=["v3", "v4"], default="v3")
parser.add_argument("--output", required=True, type=pathlib.Path)
parser.add_argument("--runs", type=int, default=5)
parser.add_argument(
    "--project", choices=["chromium", "firefox", "webkit", "all"], default="all"
)
parser.add_argument("--scenarios", default="cold,warm,pan,reconnect,empty")
parser.add_argument("--zooms", default="1")
parser.add_argument("--dprs", default="1")
parser.add_argument("--bytes-per-second", type=int, default=262144)
parser.add_argument(
    "--latency-ms",
    type=int,
    default=40,
    help="One-way propagation, shared bandwidth scheduling per connection",
)
args = parser.parse_args()
if args.runs < 1 or args.bytes_per_second < 1 or args.latency_ms < 0:
    parser.error("Invalid budget")
args.output = args.output.resolve()
args.output.parent.mkdir(parents=True, exist_ok=True)
if args.output.exists():
    parser.error("Output already exists; use a fresh path")
protocol = "endless-drawing.msgpack." + args.profile
database = "endless_loading_bench_" + uuid.uuid4().hex[:12]
container = os.environ.get(
    "BENCH_POSTGRES_CONTAINER", "endless-drawing-backend-postgres-1"
)


def sql(query, db="postgres"):
    return subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "canvas",
            "-d",
            db,
        ],
        input=query,
        text=True,
        check=True,
        capture_output=True,
    ).stdout


def fixture():
    statements = []
    for zoom, origin, base in [(1, 0, 0), (0.16, 100000, 1000), (4, 200000, 2000)]:
        for shift, offset in [(0, 0), (-2000, 500)]:
            for i in range(310):
                visible = i >= 300
                x = (
                    origin
                    + shift / zoom
                    + ((-300 + (i - 300) * 50) if visible else (-1350 + (i % 30) * 15))
                    / zoom
                )
                y = 0 if visible else (-800 + (i // 30) * 150) / zoom
                points = [[x + n * 0.125 / zoom, y] for n in range(64)]
                width = 4 / zoom
                pad = width / 2 + 1
                stroke_id = f"00000000-0000-4000-8000-{base + offset + i + 1:012x}"
                shape = json.dumps(points, separators=(",", ":"))
                statements.append(
                    f"INSERT INTO strokes(id,owner_digest,points,brush,width,color,opacity,bounds) VALUES ('{stroke_id}',decode(repeat('00',32),'hex'),'{shape}'::jsonb,'round',{width},'#202020',1,box(point({x - pad},{y - pad}),point({points[-1][0] + pad},{y + pad})));\n"
                )
    return "".join(statements)


async def proxy(client):
    try:
        async with connect(
            "ws://127.0.0.1:3300/ws",
            origin="http://127.0.0.1:5173",
            subprotocols=[protocol],
            compression=None,
            max_size=4194304,
            max_queue=2,
        ) as backend:

            async def upload():
                async for payload in client:
                    await asyncio.sleep(args.latency_ms / 1000)
                    await backend.send(payload)

            queue = asyncio.Queue(maxsize=2)

            async def receive():
                async for payload in backend:
                    await queue.put((time.monotonic(), payload))
                await queue.put(None)

            async def download():
                deadline = 0
                while True:
                    item = await queue.get()
                    if item is None:
                        return
                    arrival, payload = item
                    size = (
                        len(payload)
                        if isinstance(payload, bytes)
                        else len(payload.encode())
                    )
                    deadline = (
                        max(deadline, arrival + args.latency_ms / 1000)
                        + size / args.bytes_per_second
                    )
                    await asyncio.sleep(max(0, deadline - time.monotonic()))
                    await client.send(payload)

            tasks = [asyncio.create_task(fn()) for fn in (upload, receive, download)]
            try:
                completed, _ = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                for task in completed:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as error:
        # Log only type, never frames, handshake headers, session secret or credentials.
        if type(error).__name__ != "ConnectionClosedOK":
            print(
                "WS proxy:",
                type(error).__name__,
                "received_code=",
                getattr(getattr(error, "rcvd", None), "code", None),
                "sent_code=",
                getattr(getattr(error, "sent", None), "code", None),
                flush=True,
            )


async def benchmark():
    async with serve(
        proxy,
        "127.0.0.1",
        3301,
        subprotocols=[protocol],
        compression=None,
        max_size=131072,
        max_queue=2,
    ):
        env = os.environ | {
            "BENCH_OUTPUT": str(args.output),
            "BENCH_RUNS": str(args.runs),
            "BENCH_ZOOMS": args.zooms,
            "BENCH_DPRS": args.dprs,
            "BENCH_SCENARIOS": args.scenarios,
        }
        command = [
            "./node_modules/.bin/playwright",
            "test",
            "--config",
            "playwright.performance.config.ts",
            "--reporter=dot",
            "--output",
            str(args.output.parent / (args.output.stem + "-traces")),
        ]
        if args.project != "all":
            command += ["--project", args.project]
        process = await asyncio.create_subprocess_exec(*command, cwd=ROOT, env=env)
        try:
            result = await process.wait()
        finally:
            if process.returncode is None:
                process.terminate()
                await process.wait()
        if result:
            raise RuntimeError("Browser benchmark failed")


def main():
    endpoint = os.environ.get("DOCKER_HOST")
    if os.environ.get("DOCKER_CONTEXT") or not endpoint:
        endpoint = subprocess.check_output(
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            text=True,
        ).strip()
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Only a local Unix Docker endpoint is accepted")
    sql(f"CREATE DATABASE {database};")
    with tempfile.TemporaryFile(mode="w+") as log:
        env = os.environ | {
            "DATABASE_URL": f"postgres://canvas:canvas_dev_only@127.0.0.1:55432/{database}",
            "BIND_ADDR": "127.0.0.1:3300",
            "ALLOWED_ORIGINS": "http://127.0.0.1:5173",
            "DATABASE_MIGRATE_ON_START": "true",
            "DATABASE_REQUIRE_RUNTIME_ROLE": "false",
            "ADMIN_ENABLED": "false",
            "STATIC_DIR": str(ROOT / "dist"),
            "RUST_LOG": "warn",
        }
        process = None
        try:
            process = subprocess.Popen(
                [str(args.backend.resolve())],
                cwd=args.backend.parent,
                env=env,
                stdout=log,
                stderr=log,
            )
            for _ in range(100):
                try:
                    with urllib.request.urlopen(
                        "http://127.0.0.1:3300/readyz", timeout=0.5
                    ) as response:
                        if response.status == 200:
                            break
                except Exception:
                    pass
                if process.poll() is not None:
                    raise RuntimeError("Backend exited; inspect local private log")
                time.sleep(0.1)
            else:
                raise RuntimeError("Backend readiness timeout")
            data = fixture()
            sql(data, database)
            metadata = {
                "profile": args.profile,
                "fixture_sha256": hashlib.sha256(data.encode()).hexdigest(),
                "bytes_per_second": args.bytes_per_second,
                "one_way_latency_ms": args.latency_ms,
                "runs": args.runs,
                "zooms": args.zooms,
                "dprs": args.dprs,
                "scenarios": args.scenarios,
            }
            args.output.with_suffix(".metadata.json").write_text(
                json.dumps(metadata, indent=2) + "\n"
            )
            asyncio.run(benchmark())
        finally:
            if process is not None:
                process.terminate()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=10)
                if process.poll() is None:
                    process.kill()
                    process.wait()
            sql(f"DROP DATABASE {database} WITH (FORCE);")
    print("Benchmark complete; disposable database removed:", args.output, flush=True)


if __name__ == "__main__":
    main()
