#!/usr/bin/env python3
"""Stdio MCP server exposing Chrome's open tabs, read from the profile on disk.

The Claude in Chrome bridge can only see tabs inside its own tab group, and
attaching a debugger needs the user to turn on remote debugging. Neither is
required to answer "what is open": Chrome writes the live session to
<profile>/Sessions/Session_* and that file parses without a port or a group.

No third-party dependencies. Read only: this never drives a page.
"""

import glob
import json
import os
import struct
import sys
from urllib.parse import urlparse

SERVER_NAME = "chrome-tabs"
SERVER_VERSION = "0.3.0"
PROTOCOL_VERSION = "2024-11-05"

# chromium/components/sessions/core/session_service_commands.cc
CMD_SET_TAB_WINDOW = 0
CMD_UPDATE_TAB_NAVIGATION = 6
CMD_TAB_CLOSED = 16
CMD_WINDOW_CLOSED = 17


def user_data_dirs():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        roots = ["Library/Application Support/Google/Chrome",
                 "Library/Application Support/Chromium"]
    elif sys.platform.startswith("win"):
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        return [p for p in [os.path.join(local, "Google", "Chrome", "User Data")]
                if os.path.isdir(p)]
    else:
        roots = [".config/google-chrome", ".config/chromium"]
    return [os.path.join(home, r) for r in roots if os.path.isdir(os.path.join(home, r))]


def profile_dirs(user_data_dir):
    out = []
    for name in sorted(os.listdir(user_data_dir)):
        if name != "Default" and not name.startswith("Profile "):
            continue
        if os.path.isdir(os.path.join(user_data_dir, name, "Sessions")):
            out.append(name)
    return out


def newest_session_file(user_data_dir, profile):
    files = glob.glob(os.path.join(user_data_dir, profile, "Sessions", "Session_*"))
    return max(files, key=os.path.getmtime) if files else None


def _records(blob):
    """SNSS is a magic + version header, then uint16-length-prefixed commands."""
    if blob[:4] != b"SNSS":
        return
    off = 8
    while off + 2 <= len(blob):
        (size,) = struct.unpack_from("<H", blob, off)
        off += 2
        if size == 0 or off + size > len(blob):
            return
        yield blob[off], blob[off + 1:off + size]
        off += size


def _aligned(n):
    return n + (-n % 4)


def parse_session(path):
    with open(path, "rb") as fh:
        blob = fh.read()

    tab_to_window, closed_tabs, closed_windows, nav = {}, set(), set(), {}

    for cmd, payload in _records(blob):
        if cmd == CMD_SET_TAB_WINDOW and len(payload) >= 8:
            window, tab = struct.unpack_from("<ii", payload, 0)
            tab_to_window[tab] = window
        elif cmd == CMD_TAB_CLOSED and len(payload) >= 4:
            closed_tabs.add(struct.unpack_from("<i", payload, 0)[0])
        elif cmd == CMD_WINDOW_CLOSED and len(payload) >= 4:
            closed_windows.add(struct.unpack_from("<i", payload, 0)[0])
        elif cmd == CMD_UPDATE_TAB_NAVIGATION and len(payload) >= 16:
            entry = _navigation(payload)
            if entry:
                nav[entry[0]] = entry[1:]

    tabs = []
    for tab, window in sorted(tab_to_window.items(), key=lambda kv: (kv[1], kv[0])):
        if tab in closed_tabs or window in closed_windows:
            continue
        url, title = nav.get(tab, ("", ""))
        tabs.append({"tab_id": tab, "window_id": window, "url": url, "title": title})
    return tabs


def _navigation(payload):
    """Pickle layout: size, tab id, nav index, then url (utf-8) and title (utf-16)."""
    tab = struct.unpack_from("<i", payload, 4)[0]
    (url_len,) = struct.unpack_from("<i", payload, 12)
    if not 0 < url_len < 8192 or 16 + url_len > len(payload):
        return None
    try:
        url = payload[16:16 + url_len].decode("utf-8")
    except UnicodeDecodeError:
        return None

    title = ""
    off = 16 + _aligned(url_len)
    if off + 4 <= len(payload):
        (chars,) = struct.unpack_from("<i", payload, off)
        if 0 < chars < 4096 and off + 4 + chars * 2 <= len(payload):
            try:
                title = payload[off + 4:off + 4 + chars * 2].decode("utf-16-le")
            except UnicodeDecodeError:
                title = ""
    return tab, url, title


def collect(profile_filter=None):
    results = []
    for udd in user_data_dirs():
        for profile in profile_dirs(udd):
            if profile_filter and profile != profile_filter:
                continue
            path = newest_session_file(udd, profile)
            if not path:
                continue
            try:
                tabs = parse_session(path)
            except (OSError, struct.error):
                continue
            results.append({"user_data_dir": udd, "profile": profile,
                            "session_file": os.path.basename(path), "tabs": tabs})
    return results


def render(groups, include_urls=True):
    if not groups:
        return ("No Chrome session file found. Looked for "
                "<user data dir>/<profile>/Sessions/Session_*.")
    groups = [g for g in groups if g["tabs"]]
    if not groups:
        return "Chrome session files were found, but no profile has an open tab."
    out = []
    total = sum(len(g["tabs"]) for g in groups)
    out.append(f"{total} open tab(s) across {len(groups)} profile(s), read from disk.")
    out.append("This is a snapshot Chrome writes periodically, so it can lag by a little.")
    for g in groups:
        windows = {t["window_id"] for t in g["tabs"]}
        out.append("")
        out.append(f"## profile {g['profile']} ({len(g['tabs'])} tabs, "
                   f"{len(windows)} window(s), {g['session_file']})")
        hosts = {}
        for t in g["tabs"]:
            try:
                host = urlparse(t["url"]).hostname or "(none)"
            except ValueError:
                host = "(unparseable)"
            hosts[host] = hosts.get(host, 0) + 1
        top = sorted(hosts.items(), key=lambda kv: (-kv[1], kv[0]))
        out.append("hosts: " + ", ".join(f"{h} ({c})" for h, c in top[:15]))
        if include_urls:
            for t in g["tabs"]:
                label = t["title"] or "(no title)"
                out.append(f"  [w{t['window_id']}] {label[:70]} :: {t['url'][:160]}")
    return "\n".join(out)


TOOLS = [{
    "name": "list_open_tabs",
    "description": (
        "List every tab open in Chrome, across every window and profile, by reading "
        "the browser's session file from disk. Needs no remote debugging port, no "
        "extension and no tab group, so it sees tabs the Claude in Chrome bridge "
        "cannot. Use it for any read-only question about what is open. It cannot "
        "drive a page."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "profile": {"type": "string",
                        "description": "Limit to one Chrome profile directory, e.g. 'Default'."},
            "include_urls": {"type": "boolean", "default": True,
                             "description": "Include per-tab title and URL. False returns only counts and hosts."},
        },
    },
}]


def handle(request):
    method = request.get("method")
    if method == "initialize":
        return {"protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = request.get("params") or {}
        if params.get("name") != "list_open_tabs":
            raise ValueError(f"unknown tool: {params.get('name')}")
        args = params.get("arguments") or {}
        text = render(collect(args.get("profile")), args.get("include_urls", True))
        return {"content": [{"type": "text", "text": text}]}
    raise ValueError(f"unknown method: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" not in request:
            continue  # a notification, nothing to answer
        try:
            response = {"jsonrpc": "2.0", "id": request["id"], "result": handle(request)}
        except Exception as exc:  # surface the reason rather than dying silently
            response = {"jsonrpc": "2.0", "id": request["id"],
                        "error": {"code": -32603, "message": str(exc)}}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
