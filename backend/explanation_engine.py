"""Module H: Explanation Engine — real, specific, variable-aware explanations"""
from typing import List
from dependency_analyzer import DependencyReport


def generate_explanation(reports: List[DependencyReport], language: str) -> List[dict]:
    explanations = []

    for report in reports:
        deps_text = []
        for dep in report.dependencies:
            deps_text.append({
                "variable":    dep.variable,
                "type":        dep.dep_type,
                "description": dep.description,
                "loop_carried": dep.is_loop_carried
            })

        if report.parallelizable:
            status = "Parallelizable"
            color  = "green"
            reason = report.reason
            advice = _parallelizable_advice(report, language)
        else:
            status = "Not Parallelizable"
            color  = "red"
            reason = report.reason
            advice = _blocked_advice(report, language)

        explanations.append({
            "loop_id":      report.loop_id,
            "loop_line":    report.loop_line,
            "status":       status,
            "color":        color,
            "reason":       reason,
            "advice":       advice,
            "dependencies": deps_text
        })

    if not explanations:
        explanations.append({
            "loop_id":      -1,
            "loop_line":    0,
            "status":       "No loops found",
            "color":        "blue",
            "reason":       "No for-loops were detected in the submitted code.",
            "advice":       "Submit code containing for-loops to analyze parallelization opportunities.",
            "dependencies": []
        })

    return explanations


def _parallelizable_advice(report: DependencyReport, language: str) -> str:
    reduction_vars = [d.variable for d in report.dependencies if d.dep_type == "REDUCTION"]
    war_vars       = [d.variable for d in report.dependencies if "WAR" in d.dep_type]

    parts = []

    if reduction_vars:
        rv = ", ".join(f"'{v}'" for v in reduction_vars)
        parts.append(
            f"Variable(s) {rv} use a reduction pattern (+=). "
            f"Each iteration accumulates independently — safe to parallelize using a reduction clause."
        )

    if war_vars:
        wv = ", ".join(f"'{v}'" for v in war_vars)
        parts.append(
            f"Variable(s) {wv} have a WAR (Write After Read) anti-dependency, "
            f"which does not block parallelism since each iteration writes to a different index."
        )

    if not parts:
        parts.append(
            "Each loop iteration writes to a unique memory location and reads only "
            "from inputs that are not modified by other iterations. "
            "No cross-iteration data sharing detected."
        )

    # Language-specific annotation
    if language == "python":
        if reduction_vars:
            rv = reduction_vars[0]
            parts.append(
                f"Python: use multiprocessing.Pool.map() and sum the results. "
                f"Example: {rv} = sum(pool.map(fn, range(n)))"
            )
        else:
            parts.append(
                "Python: use multiprocessing.Pool.map(fn, range(n)) "
                "to distribute iterations across all CPU cores."
            )
    elif language in ("c", "cpp"):
        if reduction_vars:
            rv = ",".join(reduction_vars)
            parts.append(
                f"C/C++: add '#pragma omp parallel for reduction(+:{rv})' "
                f"before this loop. Compile with: gcc/g++ -fopenmp"
            )
        else:
            parts.append(
                "C/C++: add '#pragma omp parallel for' before this loop. "
                "Compile with: gcc/g++ -fopenmp"
            )
    elif language == "java":
        parts.append(
            f"Java: convert to IntStream.range({report.loop_line}, n)"
            f".parallel().forEach(i -> {{ ... }}); — requires Java 8+"
        )

    return " ".join(parts)


def _blocked_advice(report: DependencyReport, language: str) -> str:
    blocking = [d for d in report.dependencies
                if d.is_loop_carried and d.dep_type not in ("REDUCTION", "WAR (Write After Read)")]

    if not blocking:
        return (
            f"Loop at line {report.loop_line} has dependencies that prevent safe parallelization. "
            f"Review the loop body for cross-iteration data sharing."
        )

    parts = []
    for dep in blocking:
        if "RAW" in dep.dep_type:
            parts.append(
                f"Variable '{dep.variable}' is written in one iteration and read in the next "
                f"(Read After Write — loop-carried). "
                f"The value of '{dep.variable}' at iteration i depends on iteration i-1, "
                f"so iterations cannot run simultaneously."
            )
        elif "WAW" in dep.dep_type:
            parts.append(
                f"Variable '{dep.variable}' is written as a scalar in every iteration — "
                f"Write After Write (WAW) output dependency. "
                f"Multiple threads would overwrite each other's result unpredictably. "
                f"Fix: use '{dep.variable}[i] = ...' to give each iteration a unique output slot."
            )
        else:
            parts.append(
                f"Variable '{dep.variable}' has a {dep.dep_type} dependency across iterations."
            )

    # Fix suggestion
    raw_vars = [d.variable for d in blocking if "RAW" in d.dep_type]
    waw_vars = [d.variable for d in blocking if "WAW" in d.dep_type]

    if raw_vars:
        rv = raw_vars[0]
        if language == "python":
            parts.append(
                f"Fix: replace '{rv} = f({rv})' with 'temp[i] = f(input[i])' "
                f"so each iteration writes to a unique slot, then combine: '{rv} = sum(temp)'."
            )
        elif language in ("c", "cpp"):
            parts.append(
                f"Fix: replace '{rv} = f({rv})' with 'temp[i] = f(input[i]);' "
                f"then combine after the loop: 'for(i=0;i<n;i++) {rv} += temp[i];'"
            )
        elif language == "java":
            parts.append(
                f"Fix: use 'temp[i] = compute(i);' then '{rv} = Arrays.stream(temp).sum();'"
            )

    if waw_vars:
        wv = waw_vars[0]
        parts.append(
            f"Fix for '{wv}': change to '{wv}[i] = compute(i);' "
            f"so each iteration writes to a unique array index."
        )

    return " ".join(parts)
