"""AutoParallel - FastAPI Backend Server"""
import sys
import os
from contextlib import asynccontextmanager
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional

from language_detector import detect_language
from ir_builder import build_ir
from dependency_analyzer import analyze_dependencies
from parallelization_engine import identify_parallel_loops
from code_generator import generate_parallel_code
from visualization_engine import build_ast_graph, build_dependency_graph, build_ast_text
from explanation_engine import generate_explanation
from performance_analyzer import estimate_performance
from validation_engine import validate_parallel_safety
from suggestion_engine import generate_suggestions
from database import init_db, save_analysis, get_history
from transformation_engine import generate_transformations

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="AutoParallel API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


class AnalyzeRequest(BaseModel):
    code: str
    language: Optional[str] = None


@app.get("/")
def root():
    index = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return {"message": "AutoParallel API v2.0 running. Visit /docs"}


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    if not req.code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty.")

    # Step 1 — Language Detection
    language = req.language if req.language else detect_language(req.code)

    # Step 2 — Parse + Build IR
    ir = build_ir(req.code, language)

    # Step 3 — Dependency Analysis (RAW / WAR / WAW / Reduction)
    dep_reports = analyze_dependencies(ir)

    # Step 4 — Parallelization Decision
    parallel_loops = identify_parallel_loops(ir, dep_reports)

    # Step 5 — Parallel Code Generation
    parallel_code = generate_parallel_code(ir, dep_reports)

    # Step 6 — Parallel Safety Validation
    validation = validate_parallel_safety(ir, dep_reports)

    # Step 7 — Performance Analysis (with core simulation)
    metrics = estimate_performance(ir, dep_reports)

    # Step 8 — Optimization Suggestions
    suggestions = generate_suggestions(dep_reports, language)

    # Step 9 — AI Explanation
    explanations = generate_explanation(dep_reports, language)

    # Step 10 — Visualization
    ast_graph = build_ast_graph(ir, dep_reports)
    dep_graph = build_dependency_graph(ir, dep_reports)
    ast_text  = build_ast_text(ir, dep_reports)

    # Step 11 — Loop Transformations (Feature 3)
    transformations = generate_transformations(ir, dep_reports)

    # Build dependency summary string
    dep_summary = _build_dep_summary(dep_reports)

    # Build parallelizable regions list
    parallelizable_regions = [
        {
            "loop_id":   r.loop_id,
            "line":      r.loop_line,
            "reason":    r.reason,
            "status":    "SAFE" if r.parallelizable else "UNSAFE"
        }
        for r in dep_reports
    ]

    # Per-loop detailed analysis (Features 1, 2, 4)
    loop_analysis = [
        {
            "loop_id": r.loop_id,
            "loop_line": r.loop_line,
            "bernstein": r.bernstein,
            "induction_vars": r.induction_vars,
            "dep_distances": [
                {
                    "variable": d.variable,
                    "distance": getattr(d, 'distance', 0),
                    "wavefront_possible": getattr(d, 'wavefront_possible', False)
                }
                for d in r.dependencies
            ]
        }
        for r in dep_reports
    ]

    # Save to DB
    try:
        program_id = save_analysis(language, req.code, dep_reports, dep_reports, metrics)
    except Exception:
        program_id = None

    # Strict JSON output
    return {
        # Meta
        "program_id":             program_id,
        "language":               language,
        "total_loops":            len(ir.loops),
        "parallel_loops":         len(parallel_loops),

        # Step 10 structured fields
        "ast":                    ir.ast_nodes,
        "parallelizable_regions": parallelizable_regions,
        "dependency_summary":     dep_summary,
        "parallel_code":          parallel_code,
        "validation":             validation,
        "performance": {
            "sequential_time":    f"{metrics['sequential_time_ms']} ms",
            "parallel_time":      f"{metrics['parallel_time_ms']} ms",
            "speedup":            f"{metrics['speedup']}x",
            "efficiency":         f"{metrics['efficiency']}%",
            "parallelizable_pct": f"{metrics['parallelizable_fraction']}%",
            "core_simulation": {
                "2_cores": f"{metrics['core_simulation']['2_cores']['estimated_speedup']}x speedup",
                "4_cores": f"{metrics['core_simulation']['4_cores']['estimated_speedup']}x speedup",
                "8_cores": f"{metrics['core_simulation']['8_cores']['estimated_speedup']}x speedup",
            },
            "_raw": metrics
        },
        "suggestions":            suggestions,
        "explanation":            explanations,

        # Visualization data
        "ast_graph":              ast_graph,
        "dep_graph":              dep_graph,
        "ast_text":               ast_text,
        "explanations":           explanations,
        "metrics":                metrics,

        # New features
        "transformations":        transformations,
        "performance_law_data":   metrics.get("performance_law_data", {}),
        "loop_analysis":          loop_analysis,
    }


def _build_dep_summary(reports) -> str:
    if not reports:
        return "No loops analyzed."
    lines = []
    for r in reports:
        status = "SAFE" if r.parallelizable else "UNSAFE"
        dep_types = list({d.dep_type for d in r.dependencies}) if r.dependencies else ["None"]
        lines.append(
            f"Loop @ line {r.loop_line}: {status} | "
            f"Dependencies: {', '.join(dep_types)} | {r.reason}"
        )
    return "\n".join(lines)


@app.get("/history")
def history():
    return get_history()


@app.get("/examples")
def examples_page():
    ex_file = os.path.join(FRONTEND_DIR, "examples.html")
    if os.path.exists(ex_file):
        return FileResponse(ex_file)
    return {"error": "Examples page not found"}


@app.get("/health")
def health():
    return {"status": "ok", "version": "2.0.0"}
