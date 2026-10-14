"""Module F: Code Generator - generates parallel code in original language"""
import re
from ir_builder import IRProgram, IRLoop
from dependency_analyzer import DependencyReport
from typing import List


def generate_parallel_code(ir: IRProgram, reports: List[DependencyReport]) -> str:
    lang = ir.language
    if lang == "python":
        return _gen_python(ir, reports)
    elif lang == "cpp":
        return _gen_cpp(ir, reports)
    elif lang == "c":
        return _gen_c(ir, reports)
    elif lang == "java":
        return _gen_java(ir, reports)
    return ir.source


def _clean_line(line: str, language: str) -> str:
    """Remove explanatory inline comments from a single line for output."""
    if language == 'python':
        # Remove trailing # explanatory comments
        cleaned = re.sub(
            r'\s*#\s*(PARALLELIZABLE|NOT PARALLELIZABLE|NOT PAR|AutoParallel|'
            r'no dependency|independent|loop-carried|dependency|reduction|'
            r'recurrence|RAW|WAW).*$', '', line)
    else:
        # Remove trailing // explanatory comments
        cleaned = re.sub(
            r'\s*//\s*(PARALLELIZABLE|NOT PARALLELIZABLE|NOT PAR|AutoParallel|'
            r'no dependency|independent|loop-carried|dependency|reduction|'
            r'recurrence|RAW|WAW).*$', '', line)
        # Remove inline /* ... */ comments
        cleaned = re.sub(r'\s*/\*[^*\n]*\*/', '', cleaned)
    return cleaned


def _strip_block_comments(source: str) -> str:
    """Remove /* ... */ block comments (multi-line) from C/C++/Java source."""
    return re.sub(r'/\*[\s\S]*?\*/', '', source)


# ── Python ──────────────────────────────────────────────────────────────────

def _gen_python(ir: IRProgram, reports: List[DependencyReport]) -> str:
    report_map = {r.loop_id: r for r in reports}
    # Build a line-number → loop map from original IR (1-indexed)
    loop_by_line = {loop.line: loop for loop in ir.loops}

    lines = ir.source.split('\n')
    result = []
    header_added = False
    any_parallelized = False

    i = 0
    while i < len(lines):
        line = lines[i]
        lineno = i + 1  # 1-indexed
        loop = loop_by_line.get(lineno)

        if loop and loop.parallelizable:
            report = report_map.get(loop.loop_id)
            reduction_vars = _get_reduction_vars(report)
            any_parallelized = True

            if not header_added:
                result.insert(0, "from multiprocessing import Pool\nimport os\n")
                header_added = True

            indent = len(line) - len(line.lstrip())
            ind = ' ' * indent

            # Collect loop body (lines more indented than the for line)
            body_lines = []
            j = i + 1
            while j < len(lines):
                bl = lines[j]
                if bl.strip() == '':
                    body_lines.append(bl)
                    j += 1
                    continue
                bl_indent = len(bl) - len(bl.lstrip())
                if bl_indent > indent:
                    body_lines.append(_clean_line(bl, 'python'))
                    j += 1
                else:
                    break
            # Trim trailing blank lines from body
            while body_lines and not body_lines[-1].strip():
                body_lines.pop()

            result.append(f"{ind}# [AutoParallel] Parallelized loop (line {loop.line})")
            result.append(f"{ind}def _parallel_body_{loop.loop_id}({loop.var}):")
            for bl in body_lines:
                result.append(bl)
            result.append(f"")
            result.append(f"{ind}_range_{loop.loop_id} = range({loop.start}, {loop.end})")
            result.append(f"{ind}with Pool(os.cpu_count()) as _pool:")
            if reduction_vars:
                result.append(f"{ind}    _results_{loop.loop_id} = _pool.map(_parallel_body_{loop.loop_id}, _range_{loop.loop_id})")
                result.append(f"{ind}    {reduction_vars[0]} = sum(r for r in _results_{loop.loop_id} if r is not None)")
            else:
                result.append(f"{ind}    _pool.map(_parallel_body_{loop.loop_id}, _range_{loop.loop_id})")
            i = j

        elif loop and not loop.parallelizable:
            report = report_map.get(loop.loop_id)
            dep_info = ""
            if report and report.dependencies:
                d = [x for x in report.dependencies if x.is_loop_carried]
                if d:
                    dep_info = f" [{d[0].dep_type} on '{d[0].variable}']"
            indent = len(line) - len(line.lstrip())
            ind = ' ' * indent
            result.append(f"{ind}# [AutoParallel] NOT parallelizable{dep_info} — kept sequential")
            result.append(_clean_line(line, 'python'))
            i += 1

        else:
            result.append(_clean_line(line, 'python'))
            i += 1

    if not any_parallelized:
        result = [
            "# [AutoParallel] No parallelizable loops found — all loops have dependencies.",
            "# See the Dependencies and Transform tabs for details.", ""
        ] + result

    return '\n'.join(result)


# ── C ───────────────────────────────────────────────────────────────────────

def _gen_c(ir: IRProgram, reports: List[DependencyReport]) -> str:
    report_map = {r.loop_id: r for r in reports}
    loop_by_line = {loop.line: loop for loop in ir.loops}

    # Strip block comments from source first (they don't affect line numbers
    # because we replace them with blank space to preserve line count)
    source = re.sub(r'/\*[\s\S]*?\*/', lambda m: '\n' * m.group().count('\n'), ir.source)
    lines = source.split('\n')
    result = []
    omp_needed = False

    for i, line in enumerate(lines):
        lineno = i + 1
        loop = loop_by_line.get(lineno)

        if loop and loop.parallelizable:
            report = report_map.get(loop.loop_id)
            reduction_vars = _get_reduction_vars(report)
            indent = ' ' * (len(line) - len(line.lstrip()))
            if reduction_vars:
                result.append(f"{indent}#pragma omp parallel for reduction(+:{','.join(reduction_vars)})")
            else:
                result.append(f"{indent}#pragma omp parallel for")
            omp_needed = True
            result.append(_clean_line(line, 'c'))

        elif loop and not loop.parallelizable:
            report = report_map.get(loop.loop_id)
            dep_info = ""
            if report and report.dependencies:
                d = [x for x in report.dependencies if x.is_loop_carried]
                if d:
                    dep_info = f" [{d[0].dep_type} on '{d[0].variable}']"
            indent = ' ' * (len(line) - len(line.lstrip()))
            result.append(f"{indent}// [AutoParallel] NOT parallelizable{dep_info}")
            result.append(_clean_line(line, 'c'))

        else:
            cleaned = _clean_line(line, 'c')
            # Skip lines that are now empty due to block comment removal
            if cleaned.strip() or line.strip() == '':
                result.append(cleaned)

    if omp_needed:
        has_omp = any('#include <omp.h>' in l for l in result)
        if not has_omp:
            result.insert(0, '#include <omp.h>')
        result.insert(0, '// Compile with: gcc -fopenmp -o output source.c')
    else:
        result.insert(0, '// [AutoParallel] No parallelizable loops — all loops have dependencies.')

    return '\n'.join(result)


# ── C++ ─────────────────────────────────────────────────────────────────────

def _gen_cpp(ir: IRProgram, reports: List[DependencyReport]) -> str:
    report_map = {r.loop_id: r for r in reports}
    loop_by_line = {loop.line: loop for loop in ir.loops}

    source = re.sub(r'/\*[\s\S]*?\*/', lambda m: '\n' * m.group().count('\n'), ir.source)
    lines = source.split('\n')
    result = []
    omp_needed = False

    for i, line in enumerate(lines):
        lineno = i + 1
        loop = loop_by_line.get(lineno)

        if loop and loop.parallelizable:
            report = report_map.get(loop.loop_id)
            reduction_vars = _get_reduction_vars(report)
            indent = ' ' * (len(line) - len(line.lstrip()))
            if reduction_vars:
                result.append(f"{indent}#pragma omp parallel for reduction(+:{','.join(reduction_vars)})")
            else:
                result.append(f"{indent}#pragma omp parallel for")
            omp_needed = True
            result.append(_clean_line(line, 'cpp'))

        elif loop and not loop.parallelizable:
            report = report_map.get(loop.loop_id)
            dep_info = ""
            if report and report.dependencies:
                d = [x for x in report.dependencies if x.is_loop_carried]
                if d:
                    dep_info = f" [{d[0].dep_type} on '{d[0].variable}']"
            indent = ' ' * (len(line) - len(line.lstrip()))
            result.append(f"{indent}// [AutoParallel] NOT parallelizable{dep_info}")
            result.append(_clean_line(line, 'cpp'))

        else:
            cleaned = _clean_line(line, 'cpp')
            if cleaned.strip() or line.strip() == '':
                result.append(cleaned)

    if omp_needed:
        has_omp = any('#include <omp.h>' in l for l in result)
        if not has_omp:
            result.insert(0, '#include <omp.h>')
        result.insert(0, '// Compile with: g++ -fopenmp -o output source.cpp')
    else:
        result.insert(0, '// [AutoParallel] No parallelizable loops — all loops have dependencies.')

    return '\n'.join(result)


# ── Java ────────────────────────────────────────────────────────────────────

def _gen_java(ir: IRProgram, reports: List[DependencyReport]) -> str:
    report_map = {r.loop_id: r for r in reports}
    loop_by_line = {loop.line: loop for loop in ir.loops}

    lines = ir.source.split('\n')
    result = []
    stream_import_added = False
    any_parallelized = False
    skip_until = -1  # line index to skip to after consuming a parallel loop body

    i = 0
    while i < len(lines):
        if i < skip_until:
            i += 1
            continue

        line = lines[i]
        lineno = i + 1
        loop = loop_by_line.get(lineno)

        if loop and loop.parallelizable:
            any_parallelized = True
            report = report_map.get(loop.loop_id)
            reduction_vars = _get_reduction_vars(report)
            indent = len(line) - len(line.lstrip())
            ind = ' ' * indent

            if not stream_import_added:
                result.insert(0, "import java.util.stream.IntStream;")
                stream_import_added = True

            # Collect the full loop body by brace matching
            body_lines = []
            j = i + 1
            brace_depth = 0
            in_body = False
            # Count opening brace on the for line itself
            for ch in line:
                if ch == '{':
                    brace_depth += 1
                    in_body = True
            while j < len(lines) and not (in_body and brace_depth == 0):
                for ch in lines[j]:
                    if ch == '{':
                        brace_depth += 1
                        in_body = True
                    elif ch == '}':
                        brace_depth -= 1
                body_lines.append(lines[j])
                j += 1

            # Extract just the body statements (skip braces)
            body_stmts = []
            for bl in body_lines:
                s = _clean_line(bl, 'java').strip()
                if s and s not in ('{', '}'):
                    body_stmts.append(s)

            result.append(f"{ind}// [AutoParallel] Parallelized with parallel stream (line {loop.line})")
            if reduction_vars:
                rv = reduction_vars[0]
                result.append(f"{ind}double {rv} = IntStream.range({loop.start}, {loop.end})")
                result.append(f"{ind}    .parallel()")
                result.append(f"{ind}    .mapToDouble({loop.var} -> {{")
                for s in body_stmts:
                    result.append(f"{ind}        {s}")
                result.append(f"{ind}    }}).sum();")
            else:
                result.append(f"{ind}IntStream.range({loop.start}, {loop.end}).parallel().forEach({loop.var} -> {{")
                for s in body_stmts:
                    result.append(f"{ind}    {s}")
                result.append(f"{ind}}});")

            skip_until = j
            i = j

        elif loop and not loop.parallelizable:
            report = report_map.get(loop.loop_id)
            dep_info = ""
            if report and report.dependencies:
                d = [x for x in report.dependencies if x.is_loop_carried]
                if d:
                    dep_info = f" [{d[0].dep_type} on '{d[0].variable}']"
            indent = len(line) - len(line.lstrip())
            ind = ' ' * indent
            result.append(f"{ind}// [AutoParallel] NOT parallelizable{dep_info} — kept sequential")
            result.append(_clean_line(line, 'java'))
            i += 1

        else:
            result.append(_clean_line(line, 'java'))
            i += 1

    if not any_parallelized:
        result.insert(0, "// [AutoParallel] No parallelizable loops — all loops have dependencies.")

    return '\n'.join(result)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _find_loop_at_line(loops: List[IRLoop], line: int):
    for loop in loops:
        if loop.line == line:
            return loop
    return None


def _get_reduction_vars(report: DependencyReport) -> List[str]:
    if not report:
        return []
    return [d.variable for d in report.dependencies if d.dep_type == "REDUCTION"]
