"""Module K: Optimization Suggestions Engine — real, variable-specific suggestions"""
from typing import List
from dependency_analyzer import DependencyReport


def generate_suggestions(reports: List[DependencyReport], language: str) -> List[dict]:
    suggestions = []

    for report in reports:
        if report.parallelizable:
            suggestions.append(_safe_suggestion(report, language))
        else:
            suggestions.append(_blocked_suggestion(report, language))

    if not suggestions:
        suggestions.append({
            "loop_id":   -1,
            "loop_line": 0,
            "type":      "INFO",
            "title":     "No loops found",
            "detail":    "Submit code with for-loops to receive parallelization suggestions.",
            "tips":      [],
            "code_hint": ""
        })

    return suggestions


def _safe_suggestion(report: DependencyReport, language: str) -> dict:
    reduction_vars = [d.variable for d in report.dependencies if d.dep_type == "REDUCTION"]
    war_vars       = [d.variable for d in report.dependencies if "WAR" in d.dep_type]

    detail_parts = [report.reason]
    if reduction_vars:
        rv = ", ".join(f"'{v}'" for v in reduction_vars)
        detail_parts.append(
            f"Reduction variable(s) {rv} detected — "
            f"each iteration accumulates independently, safe with a reduction clause."
        )
    if war_vars:
        wv = ", ".join(f"'{v}'" for v in war_vars)
        detail_parts.append(
            f"Anti-dependency (WAR) on {wv} — does not block parallelism."
        )

    return {
        "loop_id":   report.loop_id,
        "loop_line": report.loop_line,
        "type":      "INFO",
        "title":     f"Loop at line {report.loop_line} is parallelizable",
        "detail":    " ".join(detail_parts),
        "tips":      [],
        "code_hint": _parallel_annotation(report, language)
    }


def _blocked_suggestion(report: DependencyReport, language: str) -> dict:
    blocking = [d for d in report.dependencies
                if d.is_loop_carried and d.dep_type not in ("REDUCTION", "WAR (Write After Read)")]

    tips = []
    for dep in blocking:
        if "RAW" in dep.dep_type:
            tips.append({
                "issue":      f"Loop-carried RAW dependency on '{dep.variable}'",
                "variables":  [dep.variable],
                "suggestion": (
                    f"'{dep.variable}' is read in iteration i from a value written in iteration i-1. "
                    f"To parallelize: store each iteration's output in a unique array slot "
                    f"(e.g., temp[i] = compute(i)), then combine results after the loop."
                ),
                "example": _raw_fix_example(dep.variable, language)
            })
        elif "WAW" in dep.dep_type:
            tips.append({
                "issue":      f"Write-After-Write (WAW) on '{dep.variable}'",
                "variables":  [dep.variable],
                "suggestion": (
                    f"'{dep.variable}' is written in multiple iterations to the same scalar location. "
                    f"Change to '{dep.variable}[i] = ...' so each iteration writes to a unique index."
                ),
                "example": _waw_fix_example(dep.variable, language)
            })

    if not tips:
        # Generic fallback with actual variable names
        vars_str = ", ".join(f"'{d.variable}'" for d in blocking) if blocking else "unknown"
        tips.append({
            "issue":      f"Loop-carried dependency on {vars_str}",
            "variables":  [d.variable for d in blocking],
            "suggestion": (
                f"Variable(s) {vars_str} create cross-iteration dependencies. "
                f"Review whether the computation can be restructured so each iteration "
                f"operates on independent data."
            ),
            "example": ""
        })

    return {
        "loop_id":   report.loop_id,
        "loop_line": report.loop_line,
        "type":      "WARNING",
        "title":     f"Loop at line {report.loop_line} cannot be parallelized",
        "detail":    report.reason,
        "tips":      tips,
        "code_hint": ""
    }


def _parallel_annotation(report: DependencyReport, language: str) -> str:
    reds = [d.variable for d in report.dependencies if d.dep_type == "REDUCTION"]
    if language == "python":
        if reds:
            rv = reds[0]
            return (
                f"from multiprocessing import Pool, cpu_count\n"
                f"with Pool(cpu_count()) as pool:\n"
                f"    results = pool.map(_loop_body, range(start, end))\n"
                f"{rv} = sum(r for r in results if r is not None)"
            )
        return (
            "from multiprocessing import Pool, cpu_count\n"
            "with Pool(cpu_count()) as pool:\n"
            "    pool.map(_loop_body, range(start, end))"
        )
    elif language in ("c", "cpp"):
        if reds:
            rv = ",".join(reds)
            return f"#pragma omp parallel for reduction(+:{rv})\n// Compile: gcc -fopenmp -O2 source.c"
        return "#pragma omp parallel for\n// Compile: gcc -fopenmp -O2 source.c"
    elif language == "java":
        return (
            "IntStream.range(start, end)\n"
            "    .parallel()\n"
            "    .forEach(i -> {\n"
            "        // loop body\n"
            "    });"
        )
    return ""


def _raw_fix_example(var: str, language: str) -> str:
    if language == "python":
        return (
            f"# BEFORE (sequential only):\n"
            f"for i in range(1, n):\n"
            f"    {var}[i] = {var}[i-1] + a[i]\n\n"
            f"# AFTER (parallelizable — use prefix sum or two-pass):\n"
            f"temp = [0] * n\n"
            f"for i in range(n):   # pass 1: independent\n"
            f"    temp[i] = a[i]\n"
            f"# pass 2: combine (sequential scan)\n"
            f"for i in range(1, n):\n"
            f"    temp[i] += temp[i-1]"
        )
    elif language in ("c", "cpp"):
        return (
            f"// BEFORE (sequential only):\n"
            f"for (int i = 1; i < n; i++)\n"
            f"    {var}[i] = {var}[i-1] + a[i];\n\n"
            f"// AFTER (parallelizable — two-pass prefix sum):\n"
            f"double temp[n];\n"
            f"#pragma omp parallel for\n"
            f"for (int i = 0; i < n; i++) temp[i] = a[i];  // pass 1\n"
            f"for (int i = 1; i < n; i++) temp[i] += temp[i-1]; // pass 2"
        )
    elif language == "java":
        return (
            f"// BEFORE (sequential only):\n"
            f"for (int i = 1; i < n; i++)\n"
            f"    {var}[i] = {var}[i-1] + a[i];\n\n"
            f"// AFTER: use Arrays.parallelPrefix()\n"
            f"System.arraycopy(a, 0, {var}, 0, n);\n"
            f"Arrays.parallelPrefix({var}, (x, y) -> x + y);"
        )
    return ""


def _waw_fix_example(var: str, language: str) -> str:
    if language == "python":
        return (
            f"# BEFORE (WAW — all iterations write to same '{var}'):\n"
            f"for i in range(n):\n"
            f"    {var} = compute(i)   # overwritten each iteration!\n\n"
            f"# AFTER (parallelizable — unique index per iteration):\n"
            f"{var} = [0] * n\n"
            f"for i in range(n):\n"
            f"    {var}[i] = compute(i)"
        )
    elif language in ("c", "cpp"):
        return (
            f"// BEFORE (WAW — all iterations write to same '{var}'):\n"
            f"for (int i = 0; i < n; i++)\n"
            f"    {var} = compute(i);  // overwritten each iteration!\n\n"
            f"// AFTER (parallelizable):\n"
            f"double {var}[n];\n"
            f"#pragma omp parallel for\n"
            f"for (int i = 0; i < n; i++)\n"
            f"    {var}[i] = compute(i);"
        )
    elif language == "java":
        return (
            f"// BEFORE: {var} = compute(i);  // WAW\n"
            f"// AFTER:\n"
            f"double[] {var} = new double[n];\n"
            f"IntStream.range(0, n).parallel().forEach(i -> {var}[i] = compute(i));"
        )
    return ""
