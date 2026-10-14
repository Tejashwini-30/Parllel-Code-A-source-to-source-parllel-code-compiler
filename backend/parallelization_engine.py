"""Module E: Parallelization Engine"""
from typing import List
from ir_builder import IRProgram, IRLoop
from dependency_analyzer import DependencyReport

def identify_parallel_loops(ir: IRProgram, reports: List[DependencyReport]):
    """Mark loops as parallelizable based on dependency reports."""
    report_map = {r.loop_id: r for r in reports}
    parallel_loops = []
    for loop in ir.loops:
        report = report_map.get(loop.loop_id)
        if report and report.parallelizable:
            loop.parallelizable = True
            parallel_loops.append(loop)
        else:
            loop.parallelizable = False
    return parallel_loops
