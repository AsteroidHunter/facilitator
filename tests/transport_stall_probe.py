"""A real-TCP write-stall probe for the transport regression, run from
bridge-transport.test.cjs. The Node test runner cannot set a socket's receive
buffer, and this machine's loopback will buffer a whole large answer, so a
non-reading Node socket cannot force the server's write to pause here. Python
can: it clamps the client receive buffer small, so the server's write pauses
after a few hundred kilobytes and the write-stall deadline is exercised for
real.

It starts its own isolated fixture from the repository's server.py, on a free
loopback port, with the stall and keep-alive clocks passed in so both the
fast-clock and the production ordering (stall longer than keep-alive) can be
driven. It never touches port 8877 or any live service, and it removes its
fixture before it exits.

Usage: python3 transport_stall_probe.py <server.py> <stall_s> <keepalive_s>
It prints one JSON object of what it observed.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def main() -> None:
    server_py, stall_s, keepalive_s = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    outer = tempfile.mkdtemp(prefix="facilitator-stall-probe-")
    app = os.path.join(outer, "app")
    os.mkdir(app)
    source = open(server_py).read()
    for old, new in [
        ("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"),
        ("WRITE_STALL_TIMEOUT = 30.0", f"WRITE_STALL_TIMEOUT = {stall_s}"),
        ("KEEP_ALIVE_TIMEOUT = 5", f"KEEP_ALIVE_TIMEOUT = {keepalive_s}"),
    ]:
        assert old in source, old
        source = source.replace(old, new)
    open(os.path.join(app, "server.py"), "w").write(source)
    json.dump({"title": "stall probe",
               "items": [{"id": "0", "bucket": "meta", "title": "Standing", "owner": "facilitator"}]},
              open(os.path.join(app, "seed.json"), "w"))

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    origin = f"http://127.0.0.1:{port}"
    env = {**os.environ, "FACILITATOR_TEST_PORT": str(port),
           "FACILITATOR_LOG_DIR": os.path.join(app, "logs"), "FACILITATOR_LOG_LEVEL": "debug"}
    # the fixture runs under this same interpreter, which is the venv python the
    # test puts on PATH, so uvicorn and starlette are importable
    child = subprocess.Popen([sys.executable, os.path.join(app, "server.py")], cwd=app, env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def call(route, method="GET", body=None, timeout=10):
        request = urllib.request.Request(origin + route, data=body, method=method)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())

    def established():
        result = subprocess.run(["lsof", "-a", "-p", str(child.pid), "-i", f"tcp:{port}", "-n", "-P"],
                                capture_output=True, text=True)
        return sum(1 for line in result.stdout.splitlines() if "ESTABLISHED" in line)

    def hungup_lines():
        out = []
        folder = os.path.join(app, "logs")
        if os.path.isdir(folder):
            for name in sorted(os.listdir(folder)):
                for line in open(os.path.join(folder, name)):
                    if line.strip():
                        event = json.loads(line)
                        if event.get("kind") == "hungup":
                            out.append(event)
        return out

    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            if child.poll() is not None:
                raise SystemExit("fixture server exited early")
            try:
                if call("/state")[0] == 200:
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise SystemExit("fixture server never became ready")

        # a board far larger than the small client buffer, so the write pauses
        for n in range(4):
            box = call("/create?owner=facilitator", "POST", f"Big {n}".encode())[1]["id"]
            call(f"/reply?box={box}", "POST", b"x" * (900 * 1024))
        board_bytes = len(call("/state")[1] and json.dumps(call("/state")[1]))

        # the stalled reader: a small receive buffer, and it never reads
        peer = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        peer.connect(("127.0.0.1", port))
        peer.sendall(b"GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        time.sleep(0.3)
        established_during = established()

        # a command answers at once while the reader sits on its full socket
        started = time.monotonic()
        send_status = call("/send?box=0", "POST", b"sent behind the stall")[0]
        send_ms = round((time.monotonic() - started) * 1000, 1)

        # the server drops the connection at the deadline, on its own
        cut_deadline = time.time() + stall_s + 6
        server_cut = False
        while time.time() < cut_deadline:
            if established() == 0:
                server_cut = True
                break
            time.sleep(0.05)

        # the peer, resuming its read after the deadline, sees the reset
        peer.settimeout(4)
        peer_outcome = None
        read = 0
        try:
            while True:
                chunk = peer.recv(1 << 16)
                if not chunk:
                    peer_outcome = "eof"
                    break
                read += len(chunk)
        except ConnectionResetError:
            peer_outcome = "reset"
        except socket.timeout:
            peer_outcome = "timeout"
        peer.close()

        # commands still land after the cut
        after_status, after_state = call("/state")
        pending = [b for b in after_state["boxes"] if b["id"] == "0"][0]["pendingTexts"]

        started_stop = time.time()
        child.send_signal(signal.SIGTERM)
        stop_code = child.wait(10)
        stop_seconds = round(time.time() - started_stop, 2)

        print(json.dumps({
            "stall_s": stall_s, "keepalive_s": keepalive_s, "board_bytes": board_bytes,
            "established_during": established_during, "send_status": send_status, "send_ms": send_ms,
            "server_cut": server_cut, "peer_on_resume": peer_outcome, "peer_read_bytes": read,
            "hungup_lines": len(hungup_lines()),
            "board_after_cut": after_status, "pending_after_cut": pending,
            "stop_code": stop_code, "stop_seconds": stop_seconds,
        }))
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(6)
            except subprocess.TimeoutExpired:
                child.kill()
        shutil.rmtree(outer, ignore_errors=True)


if __name__ == "__main__":
    main()
