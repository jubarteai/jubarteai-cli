# Runs a command on a pseudo-terminal, the way a person's terminal would, for the one integration test that
# needs a real TTY (`jubarteai login --paste`). Usage: pty-paste.py <command> [args...]
# Everything the command prints is relayed to stdout. Each time it shows a "(input hidden)" prompt, one line
# is read from this script's own stdin and typed into it. The exit code is the command's.
import os
import pty
import select
import sys

argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

seen = b""
answered = 0
while True:
    ready, _, _ = select.select([fd], [], [], 30)
    if not ready:
        os.kill(pid, 9)
        sys.stderr.write("pty-paste: timed out\n")
        sys.exit(124)
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    seen += chunk
    if seen.count(b"(input hidden)") > answered:
        answered += 1
        line = sys.stdin.readline().rstrip("\n")
        os.write(fd, line.encode() + b"\r")

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
