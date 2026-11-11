#!/usr/bin/env python3
"""Builds the custom performance report (one self-contained HTML file) from the engine's results.json and,
optionally, the k6 web-dashboard export (k6-dashboard.html) which holds the time series.

    python report/build_report.py --results api-repo/results.json --dashboard api-repo/k6-dashboard.html \
        --out api-repo/report.html --build-url https://...

Python standard library only. The output is self-contained (inline CSS, JS and SVG). Its only external request is the optional Inter web font
(three <link> lines in report-template.html); offline, or with those lines removed, it falls back to the system UI font.
Never fails the pipeline: on any problem it prints a warning and exits 0 without a report.
"""
import argparse
import base64
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "report-template.html")


def read_dashboard_events(path):
    """The dashboard export keeps its data as gzip + base64 NDJSON inside <script id="data">."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    match = re.search(r'<script id="data"[^>]*>(.*?)</script>', text, re.S)
    if not match:
        raise ValueError("no data block in the dashboard export")
    raw = gzip.decompress(base64.b64decode(match.group(1).strip())).decode("utf-8")
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


def extract_series(path):
    """Per-window (k6 'period', 5 s by default) series: VUs plus, overall and per endpoint, requests, errors and response times.

    The events must be replayed in order, exactly like the dashboard does: the list of metric names grows while the test runs
    (a metric only appears after its first sample) and every snapshot is positional against the names known at that moment.
    """
    events = read_dashboard_events(path)
    aggregates = next(e["data"] for e in events if e["event"] == "param")["aggregates"]
    types, names = {}, []
    windows = []
    for event in events:
        if event["event"] == "metric":
            types.update({n: m["type"] for n, m in event["data"].items()})
            names = sorted(types)
        elif event["event"] == "snapshot":
            row = {}
            for index, name in enumerate(names):
                if index < len(event["data"]):
                    row[name] = dict(zip(aggregates[types[name]], event["data"][index]))
            windows.append(row)
    if not windows:
        return None

    def get(window, metric, key):
        value = window.get(metric, {}).get(key)
        return value if isinstance(value, (int, float)) else None

    first_time = get(windows[0], "time", "value")
    period = 1.0
    if len(windows) > 1:
        gap = (get(windows[1], "time", "value") or 0) - (first_time or 0)
        period = gap / 1000.0 if gap > 0 else 5.0

    def r(value, digits=2):
        return None if value is None else round(value, digits)

    t = [r(((get(w, "time", "value") or 0) - (first_time or 0)) / 1000.0 + period, 1) for w in windows]
    series = {"period": r(period, 1), "t": t, "vus": [get(w, "vus", "value") for w in windows], "all": {}, "endpoints": {}}

    # overall
    reqs = [get(w, "http_reqs", "count") or 0 for w in windows]
    series["all"] = {
        "requests": reqs,
        "rps": [r(get(w, "http_reqs", "rate")) for w in windows],
        "errorPct": [r((get(w, "http_req_failed", "rate") or 0) * 100) if reqs[i] else None for i, w in enumerate(windows)],
        "latency": {
            "avg": [r(get(w, "http_req_duration", "avg")) if reqs[i] else None for i, w in enumerate(windows)],
            "p95": [r(get(w, "http_req_duration", "p(95)")) if reqs[i] else None for i, w in enumerate(windows)],
            "p99": [r(get(w, "http_req_duration", "p(99)")) if reqs[i] else None for i, w in enumerate(windows)],
        },
        "latencyOk": {
            "avg": [r(get(w, "ok_duration", "avg")) if get(w, "ok_duration", "avg") else None for w in windows],
            "p95": [r(get(w, "ok_duration", "p(95)")) if get(w, "ok_duration", "avg") else None for w in windows],
            "p99": [r(get(w, "ok_duration", "p(99)")) if get(w, "ok_duration", "avg") else None for w in windows],
        },
    }

    # per endpoint: ep1_, ep2_ ...
    indexes = sorted({int(m.group(1)) for n in types for m in [re.match(r"ep(\d+)_requests$", n)] if m})
    for n in indexes:
        count = [get(w, f"ep{n}_requests", "count") or 0 for w in windows]
        ok = [get(w, f"ep{n}_ok", "count") or 0 for w in windows]

        def trend(metric, stat):
            return [r(get(w, metric, stat)) if count[i] and get(w, metric, "avg") else None for i, w in enumerate(windows)]

        series["endpoints"][str(n)] = {
            "requests": count,
            "rps": [r(get(w, f"ep{n}_requests", "rate")) for w in windows],
            "errorPct": [r((count[i] - ok[i]) / count[i] * 100) if count[i] else None for i in range(len(windows))],
            "latency": {"avg": trend(f"ep{n}_duration", "avg"), "p95": trend(f"ep{n}_duration", "p(95)"), "p99": trend(f"ep{n}_duration", "p(99)")},
            "latencyOk": {"avg": trend(f"ep{n}_ok_duration", "avg"), "p95": trend(f"ep{n}_ok_duration", "p(95)"), "p99": trend(f"ep{n}_ok_duration", "p(99)")},
        }
    return series


def read_k6_version(explicit, results_path):
    """'v1.2.3' from --k6-version or from k6-version.txt next to results.json (first line of `k6 version`). '' when unknown."""
    text = explicit
    if not text:
        candidate = os.path.join(os.path.dirname(os.path.abspath(results_path)), "k6-version.txt")
        if os.path.exists(candidate):
            with open(candidate, encoding="utf-8", errors="replace") as f:
                text = f.readline()
    match = re.search(r"v?(\d+\.\d+\.\d+[\w.+-]*)", text or "")
    return "v" + match.group(1) if match else ""


def strip_internal(results):
    """Copy of results.json without the engine's own verdict block (`engineVerdict`); the report explains problems from the per-endpoint data."""
    return {k: v for k, v in results.items() if k != "engineVerdict"}


def main():
    parser = argparse.ArgumentParser(description="Build the custom performance report (HTML).")
    parser.add_argument("--results", required=True, help="results.json written by the k6 engine")
    parser.add_argument("--dashboard", default="", help="k6 web-dashboard export (k6-dashboard.html); supplies the time series. Optional")
    parser.add_argument("--out", required=True, help="Output HTML file")
    # The report carries no build verdict banner and no exit code: it explains what happened from the measurements (findings per endpoint).
    # These three flags are still accepted and ignored so that older pipeline files keep working.
    parser.add_argument("--status", default="", help=argparse.SUPPRESS)
    parser.add_argument("--detail", default="", help=argparse.SUPPRESS)
    parser.add_argument("--exit-code", default="", help=argparse.SUPPRESS)
    parser.add_argument("--build-url", default="", help="Link to the CI build")
    parser.add_argument("--k6-version", default="", help="k6 version text (default: read k6-version.txt next to results.json)")
    args = parser.parse_args()

    if not os.path.exists(args.results):
        print(f"[WARNING] {args.results} not found (the test stopped before it produced results). No custom report built.")
        return 0
    try:
        with open(args.results, encoding="utf-8") as f:
            results = json.load(f)
    except Exception as e:
        print(f"[WARNING] Could not read {args.results}: {e}. No custom report built.")
        return 0

    series = None
    if args.dashboard and os.path.exists(args.dashboard):
        try:
            series = extract_series(args.dashboard)
        except Exception as e:
            print(f"[WARNING] Could not read the time series from {args.dashboard}: {e}. The report is built without charts over time.")

    payload = {
        "results": strip_internal(results),
        "series": series,
        "meta": {"buildUrl": args.build_url,
                 "k6Version": read_k6_version(args.k6_version, args.results)},
    }
    # The JSON sits inside a <script> element: neutralise anything that could end it or open an HTML comment.
    blob = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    with open(TEMPLATE, encoding="utf-8") as f:
        template = f.read()
    title = results.get("profile", {}).get("apiName") or "API"
    html_out = template.replace("__REPORT_TITLE__", re.sub(r"[<>&\"']", "", title)).replace("__REPORT_DATA__", blob)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html_out)
    print(f"Custom report written: {args.out} ({len(html_out) // 1024} KB, {len(results.get('endpoints', []))} endpoint(s), "
          f"{'with' if series else 'without'} time series)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # the report is a convenience: never fail the pipeline because of it
        print(f"[WARNING] Custom report could not be built: {exc}")
        sys.exit(0)
