#!/usr/bin/env python3
"""Compare synthetic loading runs; fail on scene/raster changes or geometry replay on warm loads."""

import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("baseline", type=Path)
parser.add_argument("priority", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()


def load(path):
    metadata = json.loads(path.with_suffix(".metadata.json").read_text())
    groups = defaultdict(list)
    for line in path.read_text().splitlines():
        row = json.loads(line)
        groups[(row["browser"], row["zoom"], row["dpr"], row["scenario"])].append(row)
    return metadata, groups


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def describe(rows):
    result = {
        "samples": len(rows),
        "renderer": sorted({r["renderer"] for r in rows}),
        "browser_version": sorted({r["browser_version"] for r in rows}),
        "raster_format": sorted({r.get("raster_format", "png") for r in rows}),
    }
    for field in [
        "first_geometry_ms",
        "first_paint_ms",
        "visible_paint_ms",
        "snapshot_end_ms",
        "bytes",
        "received_points",
        "handling_ms",
        "geometry_prepare_ms",
        "decode_replay_ms",
        "heap_bytes",
    ]:
        values = [r[field] for r in rows if r[field] is not None]
        result[field] = (
            None
            if not values
            else {
                "p50": round(statistics.median(values), 3),
                "p95": round(percentile(values, 0.95), 3),
            }
        )
    for field in ["frame_times_ms", "frame_intervals_ms"]:
        values = [value for row in rows for value in row[field]]
        result[field] = (
            None
            if not values
            else {
                "samples": len(values),
                "p50": round(statistics.median(values), 3),
                "p95": round(percentile(values, 0.95), 3),
            }
        )
    return result


baseline_meta, baseline = load(args.baseline)
priority_meta, priority = load(args.priority)
for field in [
    "fixture_sha256",
    "bytes_per_second",
    "one_way_latency_ms",
    "runs",
    "zooms",
    "dprs",
    "scenarios",
]:
    assert baseline_meta[field] == priority_meta[field], (
        f"Incomparable metadata: {field}"
    )
assert baseline.keys() == priority.keys(), "Missing comparison groups"
comparisons = []
for key, old in baseline.items():
    new = priority[key]
    assert len(old) == len(new), f"Sample count differs: {key}"
    for field in ["scene_hash", "raster_hash"]:
        assert {r[field] for r in old} == {r[field] for r in new}, (
            f"{field} differs: {key}"
        )
    assert {r["strokes"] for r in old} == {r["strokes"] for r in new}, (
        f"Membership differs: {key}"
    )
    assert all(not r["failures"] for r in old + new), f"Client notices: {key}"
    if key[3] == "warm":
        assert all(r["received_points"] == 0 for r in old + new), "Warm geometry replay"
    a, b = describe(old), describe(new)
    # Statistical acceptance is only applied to the preselected controlled cold-load case.
    target = key == ("chromium", 1, 1, "cold") and len(old) >= 30
    if target:
        assert b["first_paint_ms"]["p95"] <= a["first_paint_ms"]["p95"] * 0.5, (
            "Cold first-paint target missed"
        )
        assert b["snapshot_end_ms"]["p95"] <= a["snapshot_end_ms"]["p95"] * 1.15, (
            "Full-load regression"
        )
        assert b["bytes"]["p95"] <= a["bytes"]["p95"] * 1.01, "Download size regression"
    comparisons.append(
        {
            "browser": key[0],
            "zoom": key[1],
            "dpr": key[2],
            "scenario": key[3],
            "scene_and_raster_equal": True,
            "statistical_target_checked": target,
            "v3": a,
            "v4": b,
        }
    )
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(
    json.dumps({"metadata": baseline_meta, "comparisons": comparisons}, indent=2) + "\n"
)
print(
    f"{len(comparisons)} groups matched; scene/raster, warm cache and applicable timing gates passed: {args.output}"
)
