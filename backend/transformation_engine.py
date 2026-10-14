"""Module T: Loop Transformation Engine — generates fixed parallel versions of blocked loops"""
import re
from typing import List
from dependency_analyzer import DependencyReport
from ir_builder import IRProgram


def generate_transformations(ir: IRProgram, reports: List[DependencyReport]) -> List[dict]:
    """For each blocked loop, generate a transformed parallel version."""
    results = []
    for report in reports:
        if report.parallelizable:
            results.append({
                "loop_id": report.loop_id,
                "loop_line": report.loop_line,
                "needed": False,
                "before": "",
                "after": "",
                "explanation": ""
            })
            continue

        blocking = [d for d in report.dependencies
                    if d.is_loop_carried and d.dep_type != "REDUCTION"]
        if not blocking:
            results.append({
                "loop_id": report.loop_id,
                "loop_line": report.loop_line,
                "needed": False,
                "before": "",
                "after": "",
                "explanation": ""
            })
            continue

        dep = blocking[0]
        before_code = _extract_loop_code(ir.source, report.loop_line)
        after_code = _transform_loop(ir.source, report, dep, ir.language)
        explanation = _transformation_explanation(dep, ir.language)

        results.append({
            "loop_id": report.loop_id,
            "loop_line": report.loop_line,
            "needed": True,
            "dep_type": dep.dep_type,
            "variable": dep.variable,
            "before": before_code,
            "after": after_code,
            "explanation": explanation
        })
    return results


def _extract_loop_code(source: str, loop_line: int) -> str:
    lines = source.split('\n')
    start = max(0, loop_line - 1)
    result = []
    depth = 0
    in_loop = False
    for line in lines[start:start + 20]:
        result.append(line)
        for ch in line:
            if ch == '{':
                depth += 1
                in_loop = True
            elif ch == '}':
                depth -= 1
        if in_loop and depth <= 0:
            break
    return '\n'.join(result)


def _transform_loop(source: str, report, dep, language: str) -> str:
    var = dep.variable
    if "RAW" in dep.dep_type:
        if language == "python":
            return (
                "# Transformed: prefix-sum pattern\n"
                "import itertools\n"
                "# Replace loop with parallel prefix-sum:\n"
                + var + " = list(itertools.accumulate(input_array))\n"
                "# Or use two-pass approach:\n"
                "temp = [compute(i) for i in range(n)]  # parallel\n"
                "for i in range(1, n):  # sequential combine\n"
                "    temp[i] += temp[i-1]\n"
                + var + " = temp"
            )
        elif language in ("c", "cpp"):
            return (
                "// Transformed: two-pass prefix sum\n"
                "double temp[n];\n"
                "#pragma omp parallel for\n"
                "for (int i = 0; i < n; i++) temp[i] = a[i];  // pass 1: parallel\n"
                "for (int i = 1; i < n; i++) temp[i] += temp[i-1]; // pass 2: scan\n"
                "// Or use: std::partial_sum(a, a+n, " + var + ");"
            )
        elif language == "java":
            return (
                "// Transformed: use Arrays.parallelPrefix()\n"
                "System.arraycopy(a, 0, " + var + ", 0, n);\n"
                "Arrays.parallelPrefix(" + var + ", (x, y) -> x + y);"
            )
    elif "WAW" in dep.dep_type:
        if language == "python":
            return (
                "# Transformed: scalar expansion\n"
                + var + "_arr = [0.0] * n\n"
                "for i in range(n):  # now parallelizable\n"
                "    " + var + "_arr[i] = compute(i)\n"
                + var + " = " + var + "_arr[n-1]  # get final value if needed"
            )
        elif language in ("c", "cpp"):
            return (
                "// Transformed: scalar expansion\n"
                "double " + var + "_arr[n];\n"
                "#pragma omp parallel for\n"
                "for (int i = 0; i < n; i++)\n"
                "    " + var + "_arr[i] = compute(i);  // now unique per iteration\n"
                + var + " = " + var + "_arr[n-1];  // get final value if needed"
            )
        elif language == "java":
            return (
                "// Transformed: scalar expansion\n"
                "double[] " + var + "Arr = new double[n];\n"
                "IntStream.range(0, n).parallel().forEach(i -> " + var + "Arr[i] = compute(i));\n"
                + var + " = " + var + "Arr[n-1];"
            )
    return "// Manual restructuring required for " + dep.dep_type + " on '" + var + "'"


def _transformation_explanation(dep, language: str) -> str:
    if "RAW" in dep.dep_type:
        return (
            "RAW dependency on '" + dep.variable + "' eliminated using prefix-sum pattern. "
            "The loop is split into two passes: (1) a parallel pass computing independent values, "
            "(2) a sequential scan combining results. "
            "This is the standard parallel prefix-sum (scan) algorithm."
        )
    elif "WAW" in dep.dep_type:
        return (
            "WAW dependency on '" + dep.variable + "' eliminated using scalar expansion. "
            "The scalar variable is replaced with an array indexed by the loop variable, "
            "giving each iteration a unique output slot. No thread conflicts possible."
        )
    return "Dependency on '" + dep.variable + "' requires manual restructuring."
