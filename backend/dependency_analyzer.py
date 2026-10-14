"""Module D: Dependency Analysis — RAW, WAR, WAW, Reduction"""
import re
from dataclasses import dataclass, field
from typing import List, Optional
from ir_builder import IRProgram, IRLoop

C_KEYWORDS = {
    'int','float','double','char','long','short','void','if','else','while',
    'for','return','printf','scanf','cout','cin','endl','std','include',
    'define','NULL','true','false','class','public','private','static',
    'System','out','println','new','this','import','package','size_t',
    'unsigned','const','struct','typedef','enum','switch','case','break',
    'continue','do','goto','sizeof','malloc','free','string','vector',
    'Arrays','fill','length','append','range','print','len','list','dict',
    'set','tuple','None','True','False','self','super','extends','implements',
    'auto','bool','nullptr','template','typename','namespace','using',
}

@dataclass
class Dependency:
    dep_id: int
    loop_id: int
    variable: str
    dep_type: str
    source_line: int
    target_line: int
    is_loop_carried: bool
    description: str
    distance: int = 0
    wavefront_possible: bool = False

@dataclass
class DependencyReport:
    loop_id: int
    loop_line: int
    dependencies: List[Dependency] = field(default_factory=list)
    has_loop_carried: bool = False
    parallelizable: bool = True
    reason: str = ""
    suggestion: str = ""
    bernstein: Optional[dict] = None
    induction_vars: Optional[list] = None


def analyze_dependencies(ir: IRProgram) -> List[DependencyReport]:
    reports = []
    dep_id = 0

    for loop in ir.loops:
        report = DependencyReport(loop_id=loop.loop_id, loop_line=loop.line)
        writes = _filter_vars(loop.body_vars_write, loop.var)
        reads  = _filter_vars(loop.body_vars_read,  loop.var)

        write_set = set(writes)
        read_set  = set(reads)

        # Detect reduction patterns strictly inside the loop body
        reduction_vars = set(_detect_reduction_in_body(ir.source, loop))

        # Detect induction variables
        ind_vars = _detect_induction_vars(ir.source, loop)
        ind_var_names = {iv["variable"] for iv in ind_vars}
        report.induction_vars = ind_vars

        # Classify each written variable
        for var in write_set:
            # Skip induction variables — they are not WAW deps
            if var in ind_var_names and var != loop.var:
                continue

            if var in reduction_vars:
                # REDUCTION — safe accumulation
                dep = Dependency(
                    dep_id=dep_id, loop_id=loop.loop_id, variable=var,
                    dep_type="REDUCTION",
                    source_line=loop.line, target_line=loop.line,
                    is_loop_carried=False,
                    description=f"'{var}' is a reduction variable (+=/-=/*=). Safe with reduction clause."
                )
                report.dependencies.append(dep)
                dep_id += 1

            elif _is_waw_in_body(ir.source, var, loop):
                # WAW — scalar written every iteration, never read inside loop
                dep = Dependency(
                    dep_id=dep_id, loop_id=loop.loop_id, variable=var,
                    dep_type="WAW (Write After Write)",
                    source_line=loop.line, target_line=loop.line,
                    is_loop_carried=True,
                    description=f"'{var}' is written every iteration as a scalar — WAW output dependency. Fix: use {var}[{loop.var}] = ... to give each iteration a unique output slot.",
                    distance=1,
                    wavefront_possible=False
                )
                report.dependencies.append(dep)
                dep_id += 1

            elif var in read_set and _is_loop_carried_raw(ir.source, var, loop):
                # RAW — written in iteration i, read in iteration i+1 via offset
                distance = _get_raw_distance(ir.source, var, loop)
                dep = Dependency(
                    dep_id=dep_id, loop_id=loop.loop_id, variable=var,
                    dep_type="RAW (Read After Write)",
                    source_line=loop.line, target_line=loop.line,
                    is_loop_carried=True,
                    description=f"'{var}' is written in one iteration and read in the next — loop-carried RAW dependency.",
                    distance=distance,
                    wavefront_possible=(distance > 1)
                )
                report.dependencies.append(dep)
                dep_id += 1

        # Bernstein's conditions check
        report.bernstein = check_bernstein_conditions(loop, report, ir)

        # Determine parallelizability
        blocking = [d for d in report.dependencies
                    if d.is_loop_carried and d.dep_type not in ("REDUCTION",)]

        if blocking:
            report.has_loop_carried = True
            report.parallelizable = False
            vars_list = ', '.join(d.variable for d in blocking)
            dep_types = list({d.dep_type for d in blocking})
            report.reason = f"Loop-carried {', '.join(dep_types)} on: {vars_list}"
            report.suggestion = _build_suggestion(blocking, loop, ir.language)
        else:
            report.parallelizable = True
            reds = [d.variable for d in report.dependencies if d.dep_type == "REDUCTION"]
            report.reason = (f"Parallelizable with reduction on: {', '.join(reds)}"
                             if reds else
                             "No loop-carried dependencies detected. Safe to parallelize.")
            report.suggestion = ""

        loop.parallelizable = report.parallelizable
        reports.append(report)

    return reports


# ── Feature 1: Dependency Distance ───────────────────────────────────────────

def _get_raw_distance(source: str, var: str, loop: IRLoop) -> int:
    """Extract the numeric distance from array subscripts like a[i-1], a[i-2], a[i+3]."""
    body = _get_loop_body_lines(source, loop)
    lv = loop.var
    vr = re.escape(var)
    for line in body:
        m = re.search(rf'\b{vr}\s*\[\s*{lv}\s*[+\-]\s*(\d+)', line)
        if m:
            return int(m.group(1))
    # Scalar write — distance = 1
    return 1


# ── Feature 2: Bernstein's Conditions ────────────────────────────────────────

def check_bernstein_conditions(loop: IRLoop, report: DependencyReport, ir: IRProgram) -> dict:
    """
    Check Bernstein's three conditions for loop parallelizability.
    W(P) = write set, R(P) = read set for the loop body.
    C1: W ∩ R = ∅  (no RAW)
    C2: R ∩ W = ∅  (no WAR — symmetric, same check)
    C3: W ∩ W = ∅  (no WAW — scalar writes conflict)
    """
    writes = set(_filter_vars(loop.body_vars_write, loop.var))
    reads  = set(_filter_vars(loop.body_vars_read,  loop.var))

    # C1: no RAW — W(i) ∩ R(i+1) = ∅
    raw_vars = writes & reads
    # Only flag if there's an actual loop-carried RAW
    raw_carried = {d.variable for d in report.dependencies
                   if d.dep_type == "RAW (Read After Write)" and d.is_loop_carried}
    c1_violation = next(iter(raw_carried), "") if raw_carried else ""
    c1_ok = len(raw_carried) == 0

    # C2: no WAR — R(i) ∩ W(i+1) = ∅  (same variable set, symmetric)
    war_vars = reads & writes
    # Exclude variables that are safely indexed by the loop variable (a[i] = a[i]*2 is safe)
    # Also exclude reductions and RAW-carried vars
    reduction_vars = {d.variable for d in report.dependencies if d.dep_type == "REDUCTION"}
    indexed_safe = {v for v in war_vars if _is_indexed_by_loop_var(ir.source, v, loop)}
    war_candidates = war_vars - raw_carried - reduction_vars - indexed_safe
    c2_violation = next(iter(war_candidates), "") if war_candidates else ""
    c2_ok = len(war_candidates) == 0

    # C3: no WAW — W(i) ∩ W(i+1) = ∅
    waw_vars = {d.variable for d in report.dependencies
                if d.dep_type == "WAW (Write After Write)" and d.is_loop_carried}
    c3_violation = next(iter(waw_vars), "") if waw_vars else ""
    c3_ok = len(waw_vars) == 0

    all_ok = c1_ok and c2_ok and c3_ok

    # Override: if the loop is actually parallelizable (no blocking deps), mark all_ok=True
    # This handles cases where Bernstein's set-based check is overly conservative
    # (e.g., a[i] = a[i]*2 — same-index read/write is safe but appears in both sets)
    actually_parallelizable = not any(
        d.is_loop_carried and d.dep_type not in ("REDUCTION",)
        for d in report.dependencies
    )
    if actually_parallelizable:
        all_ok = True

    if all_ok:
        summary = "All Bernstein conditions satisfied — loop is parallelizable."
    else:
        violations = []
        if not c1_ok:
            violations.append(f"C1 violated (RAW on '{c1_violation}')")
        if not c2_ok:
            violations.append(f"C2 violated (WAR on '{c2_violation}')")
        if not c3_ok:
            violations.append(f"C3 violated (WAW on '{c3_violation}')")
        if actually_parallelizable:
            summary = "Bernstein conditions satisfied (indexed accesses are safe) — loop is parallelizable."
        else:
            summary = "Bernstein conditions NOT satisfied: " + "; ".join(violations)

    return {
        "c1_ok": c1_ok, "c1_violation": c1_violation,
        "c2_ok": c2_ok, "c2_violation": c2_violation,
        "c3_ok": c3_ok, "c3_violation": c3_violation,
        "all_ok": all_ok,
        "summary": summary
    }


# ── Feature 4: Induction Variable Detection ───────────────────────────────────

def _detect_induction_vars(source: str, loop: IRLoop) -> list:
    """Find variables that are induction variables (increment/decrement by constant each iteration)."""
    body = _get_loop_body_lines(source, loop)
    ind_vars = [{"variable": loop.var, "step": 1, "type": "loop_counter"}]
    seen = {loop.var}

    for line in body:
        # var += constant
        m = re.search(r'\b(\w+)\s*\+=\s*(\d+)', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": int(m.group(2)), "type": "additive"})
            seen.add(m.group(1))

        # var -= constant
        m = re.search(r'\b(\w+)\s*-=\s*(\d+)', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": -int(m.group(2)), "type": "subtractive"})
            seen.add(m.group(1))

        # var++ (not the loop variable itself)
        m = re.search(r'\b(\w+)\s*\+\+', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) != loop.var and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": 1, "type": "increment"})
            seen.add(m.group(1))

        # var-- (not the loop variable itself)
        m = re.search(r'\b(\w+)\s*--', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) != loop.var and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": -1, "type": "decrement"})
            seen.add(m.group(1))

        # var = var + constant
        m = re.search(r'\b(\w+)\s*=\s*\1\s*\+\s*(\d+)', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": int(m.group(2)), "type": "additive"})
            seen.add(m.group(1))

        # var = var - constant
        m = re.search(r'\b(\w+)\s*=\s*\1\s*-\s*(\d+)', line)
        if m and m.group(1) not in C_KEYWORDS and m.group(1) not in seen:
            ind_vars.append({"variable": m.group(1), "step": -int(m.group(2)), "type": "subtractive"})
            seen.add(m.group(1))

    return ind_vars


# ── Body extraction helpers ───────────────────────────────────────────────────

def _get_loop_body_lines(source: str, loop: IRLoop) -> List[str]:
    """Extract lines inside the loop body — handles both brace-based (C/C++/Java) and indentation-based (Python)."""
    lines = source.split('\n')
    start = max(0, loop.line - 1)   # 0-indexed position of the for() line

    for_line = lines[start] if start < len(lines) else ""
    if '{' not in for_line and ':' in for_line:
        # Python-style loop (ends with colon, no brace)
        for_indent = len(for_line) - len(for_line.lstrip())
        body = []
        for line in lines[start + 1: start + 30]:
            if not line.strip():
                continue   # skip blank lines
            line_indent = len(line) - len(line.lstrip())
            if line_indent > for_indent:
                body.append(line)
            else:
                break   # back to same or lower indent = outside loop
        return body

    # C/C++/Java: brace-depth based
    body  = []
    depth = 0
    in_body = False

    for line in lines[start:start + 30]:
        for ch in line:
            if ch == '{':
                depth += 1
                in_body = True
            elif ch == '}':
                depth -= 1
        if in_body:
            body.append(line)
        if in_body and depth <= 0:
            break

    return body


def _detect_reduction_in_body(source: str, loop: IRLoop) -> List[str]:
    """Detect reduction patterns (+=, -=, *=) strictly inside the loop body."""
    body = _get_loop_body_lines(source, loop)
    reduction_vars = []
    for line in body:
        m = re.search(r'\b(\w+)\s*(\+=|-=|\*=)', line)
        if m:
            var = m.group(1)
            if var not in C_KEYWORDS and var != loop.var and len(var) > 1:
                reduction_vars.append(var)
    return list(set(reduction_vars))


def _is_loop_carried_raw(source: str, var: str, loop: IRLoop) -> bool:
    """
    True only if var has a genuine loop-carried RAW dependency inside the loop body.
    - var[i] = expr  (unique index write) -> NOT loop-carried
    - var = expr     (scalar write)       -> loop-carried
    - var[i-1]       (offset read)        -> loop-carried
    """
    body = _get_loop_body_lines(source, loop)
    lv   = re.escape(loop.var)
    vr   = re.escape(var)

    has_scalar_write  = False
    has_indexed_write = False
    has_offset_index  = False

    for line in body:
        stripped = line.strip()
        if not stripped or stripped.startswith('//'):
            continue
        # Scalar write: var = ... (no [ on left side)
        if re.search(rf'\b{vr}\s*(?:\+=|-=|\*=|/=|=)(?!=)', line):
            if not re.search(rf'\b{vr}\s*\[', line):
                has_scalar_write = True
        # Indexed write: var[i] = ...
        if re.search(rf'\b{vr}\s*\[\s*{lv}\s*\]', line):
            has_indexed_write = True
        # Offset read: var[i-1], var[i+1], var[i - 1], var[i + 1]
        if re.search(rf'\b{vr}\s*\[\s*{lv}\s*[+\-]', line):
            has_offset_index = True
        # Also catch Python style: var[i - 1] with spaces
        if re.search(rf'\b{vr}\s*\[\s*{lv}\s+[+\-]', line):
            has_offset_index = True

        # Feature 1: extract distance from offset subscript
        m = re.search(rf'\b{vr}\s*\[\s*{lv}\s*[+\-]\s*(\d+)', line)
        if m:
            has_offset_index = True

    if has_scalar_write:
        return True
    if has_offset_index:
        return True
    return False


def _is_scalar_write_in_body(source: str, var: str, loop: IRLoop) -> bool:
    """Check if var is written as a plain scalar inside the loop body."""
    body = _get_loop_body_lines(source, loop)
    vr   = re.escape(var)
    for line in body:
        if re.search(rf'\b{vr}\s*=(?!=)', line):
            if not re.search(rf'\b{vr}\s*\[', line):
                return True
    return False


def _is_waw_in_body(source: str, var: str, loop: IRLoop) -> bool:
    """
    WAW: variable is written as a scalar inside the loop body
    AND is NOT read inside the loop body (if read, it would be RAW).
    Also must NOT be a reduction (+=/-=/*=).
    """
    body = _get_loop_body_lines(source, loop)
    vr   = re.escape(var)

    has_scalar_write = False
    has_read         = False
    has_reduction    = False

    for line in body:
        stripped = line.strip()
        if not stripped or stripped.startswith('//'):
            continue

        # Reduction pattern: var += / -= / *=
        if re.search(rf'\b{vr}\s*(\+=|-=|\*=)', line):
            has_reduction = True

        # Plain scalar write: var = ... (no array index on left)
        if re.search(rf'\b{vr}\s*=(?!=)', line):
            if not re.search(rf'\b{vr}\s*\[', line):
                if not re.search(rf'\b{vr}\s*(\+=|-=|\*=)', line):
                    has_scalar_write = True

        # Read: var appears on right side of assignment or in expression
        if re.search(rf'=.*\b{vr}\b', line) or re.search(rf'\b{vr}\b[^=\s]', line):
            if not re.match(rf'^\s*{vr}\s*=', line):
                has_read = True

    if has_reduction:
        return False
    return has_scalar_write and not has_read


# ── Other helpers ─────────────────────────────────────────────────────────────

def _filter_vars(vars_list, loop_var):
    return [v for v in vars_list
            if v != loop_var and v not in C_KEYWORDS
            and not v.isdigit()]


def _is_indexed_by_loop_var(source: str, var: str, loop: IRLoop) -> bool:
    body = _get_loop_body_lines(source, loop)
    for line in body:
        if re.search(rf'\b{re.escape(var)}\s*\[', line):
            return True
    return False


def _build_suggestion(blocking_deps, loop: IRLoop, language: str) -> str:
    dep_types = {d.dep_type for d in blocking_deps}
    vars_list = ', '.join(d.variable for d in blocking_deps)
    if "RAW (Read After Write)" in dep_types:
        return (
            f"Variable(s) [{vars_list}] create loop-carried RAW dependencies. "
            f"Consider using a temporary array indexed by [{loop.var}], "
            f"or a prefix-sum algorithm for cumulative patterns."
        )
    if "WAW (Write After Write)" in dep_types:
        return (
            f"Variable(s) [{vars_list}] are written without unique indexing. "
            f"Change to result[{loop.var}] = ... to make each iteration independent."
        )
    return f"Loop has dependencies on [{vars_list}]. Restructure to eliminate cross-iteration sharing."
