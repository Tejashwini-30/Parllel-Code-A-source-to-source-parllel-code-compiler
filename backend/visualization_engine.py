"""Module G: Visualization Engine — builds hierarchical AST + dependency graphs."""
import re
from ir_builder import IRProgram
from dependency_analyzer import DependencyReport
from typing import List


def build_ast_graph(ir: IRProgram, reports: List[DependencyReport]) -> dict:
    """
    Build a detailed 5-level hierarchical AST:
      Level 0: Program root
      Level 1: Function declarations (with return type + params)
      Level 2: Declarations, assignments, if-stmts, for-loops
      Level 3: Loop init/condition/update + body statements
      Level 4: Nested loop body / expression details
    """
    parallel_lines = {r.loop_line for r in reports if r.parallelizable}
    dep_lines      = {r.loop_line for r in reports if not r.parallelizable}
    dep_info_map   = {}
    for r in reports:
        if not r.parallelizable and r.dependencies:
            dep_info_map[r.loop_line] = {
                "dep_type": r.dependencies[0].dep_type.split("(")[0].strip(),
                "variable": r.dependencies[0].variable,
            }

    nodes, edges = [], []
    nid = [0]

    def add(label, ntype, line, color, extra=None):
        n = {"id": nid[0], "label": label, "type": ntype, "line": line, "color": color}
        if extra:
            n.update(extra)
        nodes.append(n)
        i = nid[0]; nid[0] += 1
        return i

    def link(src, tgt):
        edges.append({"source": src, "target": tgt})

    root_id = add(f"Program ({ir.language.upper()})", "root", 0, "root")

    if ir.language == "python":
        _python_tree(ir, root_id, nodes, edges, nid, parallel_lines, dep_lines, dep_info_map, add, link)
    else:
        _c_tree(ir, root_id, nodes, edges, nid, parallel_lines, dep_lines, dep_info_map, add, link)

    return {"nodes": nodes, "edges": edges}


def build_ast_text(ir: IRProgram, reports: List[DependencyReport]) -> str:
    """Build a printable ASCII tree representation of the AST for the PDF report."""
    graph = build_ast_graph(ir, reports)
    nodes = {n["id"]: n for n in graph["nodes"]}
    children = {}
    for e in graph["edges"]:
        src = e["source"]
        tgt = e["target"]
        children.setdefault(src, []).append(tgt)

    # Find root
    child_set = {e["target"] for e in graph["edges"]}
    root = next((n["id"] for n in graph["nodes"] if n["id"] not in child_set), None)
    if root is None:
        return "No AST available."

    lines = []
    def walk(nid, prefix="", is_last=True):
        n = nodes.get(nid, {})
        connector = "└── " if is_last else "├── "
        label = n.get("label", "?")
        ntype = n.get("type", "")
        line_num = n.get("line", 0)
        color_tag = ""
        if n.get("color") == "parallel":
            color_tag = " [PARALLEL ✓]"
        elif n.get("color") == "dependent":
            dep_t = n.get("dep_type", "")
            dep_v = n.get("variable", "")
            color_tag = f" [BLOCKED ✗ — {dep_t} on '{dep_v}']" if dep_v else " [BLOCKED ✗]"
        elif n.get("color") == "root":
            color_tag = ""
        line_str = f" (L{line_num})" if line_num and line_num > 0 else ""
        lines.append(f"{prefix}{connector}{ntype}: {label}{line_str}{color_tag}")
        kids = children.get(nid, [])
        child_prefix = prefix + ("    " if is_last else "│   ")
        for i, kid in enumerate(kids):
            walk(kid, child_prefix, i == len(kids) - 1)

    root_n = nodes.get(root, {})
    lines.append(f"{root_n.get('type','')}: {root_n.get('label','')}")
    kids = children.get(root, [])
    for i, kid in enumerate(kids):
        walk(kid, "", i == len(kids) - 1)

    return "\n".join(lines)


# ── Python ────────────────────────────────────────────────────────────────────

def _python_tree(ir, root_id, nodes, edges, nid, parallel_lines, dep_lines, dep_info_map, add, link):
    import ast as py_ast
    try:
        tree = py_ast.parse(ir.source)
    except Exception:
        nid[0] += 1
        nodes.append({"id": nid[0]-1, "label": "Parse Error", "type": "error", "line": 0, "color": "default"})
        link(root_id, nid[0]-1)
        return

    src_lines = ir.source.split('\n')
    fns_added = False

    for node in py_ast.walk(tree):
        if not isinstance(node, (py_ast.FunctionDef, py_ast.AsyncFunctionDef)):
            continue
        fns_added = True
        # Build richer function label with params
        args = [a.arg for a in node.args.args]
        params_str = ", ".join(args[:3]) + ("…" if len(args) > 3 else "")
        fn_label = f"def {node.name}({params_str})"
        fn_id = add(fn_label, "FuncDecl", node.lineno, "default")
        link(root_id, fn_id)
        _python_stmts(node.body, fn_id, parallel_lines, dep_lines, dep_info_map,
                      add, link, src_lines, depth=0)

    if not fns_added:
        _python_stmts(tree.body, root_id, parallel_lines, dep_lines, dep_info_map,
                      add, link, src_lines, depth=0)


def _python_stmts(stmts, parent_id, parallel_lines, dep_lines, dep_info_map, add, link, src_lines, depth=0):
    import ast as py_ast
    if depth > 3:
        return
    for stmt in stmts:
        line = getattr(stmt, 'lineno', 0)

        if isinstance(stmt, py_ast.For):
            var = stmt.target.id if isinstance(stmt.target, py_ast.Name) else "?"
            try:
                iter_s = py_ast.unparse(stmt.iter)
            except Exception:
                iter_s = "..."
            label = f"for {var} in {iter_s}"[:40]
            color = "parallel" if line in parallel_lines else "dependent" if line in dep_lines else "loop"
            extra = dep_info_map.get(line, {})
            loop_id = add(label, "ForLoop", line, color, extra)
            link(parent_id, loop_id)

            # Add loop header sub-nodes: iterator, variable
            iter_id = add(f"iter: {iter_s[:30]}", "LoopIter", line, "default")
            link(loop_id, iter_id)
            var_id = add(f"var: {var}", "LoopVar", line, "default")
            link(loop_id, var_id)

            # Body stmts (max 4)
            body_id = add("body", "LoopBody", line, "default")
            link(loop_id, body_id)
            count = 0
            for bs in stmt.body:
                if count >= 4:
                    break
                bline = getattr(bs, 'lineno', 0)
                try:
                    blabel = py_ast.unparse(bs)[:40]
                except Exception:
                    blabel = src_lines[bline-1].strip()[:40] if 0 < bline <= len(src_lines) else "stmt"
                btype = _py_stmt_type(bs)
                sid = add(blabel, btype, bline, "default")
                link(body_id, sid)
                count += 1

        elif isinstance(stmt, py_ast.Assign):
            try:
                lbl = py_ast.unparse(stmt)[:40]
            except Exception:
                lbl = "assignment"
            nid_val = add(lbl, "Assign", line, "default")
            link(parent_id, nid_val)

        elif isinstance(stmt, py_ast.AugAssign):
            try:
                lbl = py_ast.unparse(stmt)[:40]
            except Exception:
                lbl = "aug-assign"
            nid_val = add(lbl, "AugAssign", line, "default")
            link(parent_id, nid_val)

        elif isinstance(stmt, py_ast.If):
            try:
                test_s = py_ast.unparse(stmt.test)[:30]
            except Exception:
                test_s = "condition"
            if_id = add(f"if {test_s}", "IfStmt", line, "default")
            link(parent_id, if_id)
            # Add then/else branches
            then_id = add("then", "IfThen", line, "default")
            link(if_id, then_id)
            _python_stmts(stmt.body[:2], then_id, parallel_lines, dep_lines, dep_info_map,
                          add, link, src_lines, depth+1)
            if stmt.orelse:
                else_id = add("else", "IfElse", line, "default")
                link(if_id, else_id)
                _python_stmts(stmt.orelse[:2], else_id, parallel_lines, dep_lines, dep_info_map,
                              add, link, src_lines, depth+1)

        elif isinstance(stmt, py_ast.Return):
            try:
                val = py_ast.unparse(stmt.value)[:30] if stmt.value else ""
                lbl = f"return {val}"
            except Exception:
                lbl = "return"
            nid_val = add(lbl, "Return", line, "default")
            link(parent_id, nid_val)

        elif isinstance(stmt, (py_ast.Expr,)):
            try:
                lbl = py_ast.unparse(stmt)[:40]
            except Exception:
                lbl = "expr"
            nid_val = add(lbl, "Expr", line, "default")
            link(parent_id, nid_val)


def _py_stmt_type(stmt):
    import ast as py_ast
    if isinstance(stmt, py_ast.Assign):    return "Assign"
    if isinstance(stmt, py_ast.AugAssign): return "AugAssign"
    if isinstance(stmt, py_ast.Return):    return "Return"
    if isinstance(stmt, py_ast.If):        return "IfStmt"
    if isinstance(stmt, py_ast.For):       return "ForLoop"
    if isinstance(stmt, py_ast.Expr):      return "Expr"
    return type(stmt).__name__


# ── C / C++ / Java ────────────────────────────────────────────────────────────

def _c_tree(ir, root_id, nodes, edges, nid, parallel_lines, dep_lines, dep_info_map, add, link):
    lines = ir.source.split('\n')
    functions = _find_functions(lines)

    if not functions:
        functions = [{"name": "main()", "start": 0, "end": len(lines)-1, "line": 1}]

    for fn in functions:
        fn_id = add(fn["name"], "FuncDecl", fn["line"], "default")
        link(root_id, fn_id)

        fn_lines = lines[fn["start"]: fn["end"]+1]
        offset   = fn["start"]

        _parse_c_stmts(fn_lines, offset, fn_id, parallel_lines, dep_lines,
                       dep_info_map, add, link, depth=0)


def _parse_c_stmts(block_lines, offset, parent_id, parallel_lines, dep_lines,
                   dep_info_map, add, link, depth=0):
    """Parse C/C++/Java statements into a detailed AST."""
    if depth > 3:
        return

    i = 0
    while i < len(block_lines):
        raw      = block_lines[i]
        stripped = raw.strip()
        abs_line = offset + i + 1

        if not stripped or stripped in ('{', '}') or stripped.startswith('//') or stripped.startswith('/*') or stripped.startswith('#') or stripped.startswith('using') or stripped.startswith('*'):
            i += 1
            continue

        # ── For loop ──────────────────────────────────────────────────────────
        if re.match(r'for\s*\(', stripped):
            color = ("parallel"  if abs_line in parallel_lines else
                     "dependent" if abs_line in dep_lines else "loop")
            extra = dep_info_map.get(abs_line, {})
            label = re.sub(r'\s*\{?\s*$', '', stripped)[:44]
            loop_id = add(label, "ForLoop", abs_line, color, extra)
            link(parent_id, loop_id)

            # Parse loop header: init ; condition ; update
            m = re.match(r'for\s*\(([^;]*);([^;]*);([^)]*)\)', stripped)
            if m:
                init_id = add(f"init: {m.group(1).strip()[:30]}", "LoopInit", abs_line, "default")
                link(loop_id, init_id)
                cond_id = add(f"cond: {m.group(2).strip()[:30]}", "LoopCond", abs_line, "default")
                link(loop_id, cond_id)
                upd_id  = add(f"update: {m.group(3).strip()[:30]}", "LoopUpdate", abs_line, "default")
                link(loop_id, upd_id)

            # Collect body
            body, brace_depth, in_body = [], 0, False
            for j in range(i, min(i + 30, len(block_lines))):
                for ch in block_lines[j]:
                    if ch == '{': brace_depth += 1; in_body = True
                    elif ch == '}': brace_depth -= 1
                if in_body and j > i:
                    body.append((offset + j + 1, block_lines[j]))
                if in_body and brace_depth == 0:
                    i = j
                    break

            # Add body container node
            body_id = add("body { }", "LoopBody", abs_line, "default")
            link(loop_id, body_id)

            count = 0
            for (babs, braw) in body:
                bs = braw.strip()
                if not bs or bs in ('{', '}') or bs.startswith('//') or bs.startswith('/*'):
                    continue
                if count >= 4:
                    break
                btype = _c_stmt_type(bs)
                sid = add(bs[:40], btype, babs, "default")
                link(body_id, sid)
                count += 1

            i += 1
            continue

        # ── If statement ──────────────────────────────────────────────────────
        if re.match(r'if\s*\(', stripped):
            m = re.match(r'if\s*\(([^)]*)\)', stripped)
            cond = m.group(1)[:30] if m else "condition"
            if_id = add(f"if ({cond})", "IfStmt", abs_line, "default")
            link(parent_id, if_id)

            # Collect then-body
            body, brace_depth, in_body = [], 0, False
            for j in range(i, min(i + 20, len(block_lines))):
                for ch in block_lines[j]:
                    if ch == '{': brace_depth += 1; in_body = True
                    elif ch == '}': brace_depth -= 1
                if in_body and j > i:
                    body.append((offset + j + 1, block_lines[j]))
                if in_body and brace_depth == 0:
                    i = j
                    break

            then_id = add("then { }", "IfThen", abs_line, "default")
            link(if_id, then_id)
            count = 0
            for (babs, braw) in body:
                bs = braw.strip()
                if not bs or bs in ('{', '}') or bs.startswith('//'):
                    continue
                if count >= 3:
                    break
                sid = add(bs[:38], _c_stmt_type(bs), babs, "default")
                link(then_id, sid)
                count += 1

            i += 1
            continue

        # ── Variable declaration ──────────────────────────────────────────────
        if re.match(r'(int|double|float|long|char|bool|auto|string|vector)\s+\w+', stripped):
            nid_val = add(stripped[:40], "VarDecl", abs_line, "default")
            link(parent_id, nid_val)
            i += 1
            continue

        # ── Assignment / expression ───────────────────────────────────────────
        if '=' in stripped and not stripped.startswith('//'):
            btype = _c_stmt_type(stripped)
            nid_val = add(stripped[:40], btype, abs_line, "default")
            link(parent_id, nid_val)
            i += 1
            continue

        # ── Return statement ──────────────────────────────────────────────────
        if stripped.startswith('return'):
            nid_val = add(stripped[:40], "Return", abs_line, "default")
            link(parent_id, nid_val)

        i += 1


def _c_stmt_type(s):
    if re.match(r'(int|double|float|long|char|bool|auto|string|vector)\s+', s):
        return "VarDecl"
    if re.search(r'\+=|-=|\*=|/=', s):
        return "AugAssign"
    if '=' in s and not s.startswith('if') and not s.startswith('for'):
        return "Assign"
    if s.startswith('return'):
        return "Return"
    if re.match(r'\w+\s*\(', s):
        return "FuncCall"
    return "Stmt"


def _find_functions(lines):
    """Detect function declarations and return their line ranges."""
    functions = []
    pat = re.compile(
        r'^\s*(?:(?:public|private|protected|static|inline|virtual|override|explicit)\s+)*'
        r'(?:void|int|double|float|long|bool|auto|char|string|size_t|unsigned)\s+'
        r'(\w+)\s*\('
    )
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.match(r'\s*(class|struct|namespace|#)', line):
            i += 1
            continue
        m = pat.match(line)
        if m:
            name = m.group(1)
            if name in ('if', 'for', 'while', 'switch', 'return', 'sizeof'):
                i += 1
                continue
            brace_i = i
            for j in range(i, min(i+4, len(lines))):
                if '{' in lines[j]:
                    brace_i = j
                    break
            end = _matching_brace(lines, brace_i)
            ret_m = re.search(r'(void|int|double|float|long|bool|auto|char|string)\s+' + re.escape(name), line)
            ret   = ret_m.group(1) if ret_m else ""
            par_m = re.search(r'\(([^)]*)\)', line)
            params = (par_m.group(1)[:20] + "…" if par_m and len(par_m.group(1)) > 20
                      else par_m.group(1) if par_m else "")
            label = f"{ret} {name}({params})".strip()[:46]
            functions.append({"name": label, "start": i, "end": end, "line": i+1})
            i = end + 1
            continue
        i += 1
    return functions


def _matching_brace(lines, start):
    depth = 0
    for i in range(start, len(lines)):
        for ch in lines[i]:
            if ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return i
    return len(lines) - 1


# ── Dependency graph ──────────────────────────────────────────────────────────

def build_dependency_graph(ir: IRProgram, reports: List[DependencyReport]) -> dict:
    nodes, edges, seen = [], [], set()

    for report in reports:
        loop_nid = f"loop_{report.loop_id}"
        color    = "parallel" if report.parallelizable else "dependent"
        nodes.append({
            "id": loop_nid, "label": f"Loop  line {report.loop_line}",
            "type": "loop", "color": color,
            "status": "Parallelizable" if report.parallelizable else "Has Dependency",
            "parallelizable": report.parallelizable,
        })

        if report.parallelizable and not report.dependencies:
            safe_nid = f"safe_{report.loop_id}"
            nodes.append({"id": safe_nid, "label": "Independent", "type": "safe", "color": "safe"})
            edges.append({"source": loop_nid, "target": safe_nid, "label": "safe"})
        else:
            for dep in report.dependencies:
                dep_nid = f"dep_{dep.variable}_{dep.dep_type}_{report.loop_id}"
                if dep_nid not in seen:
                    seen.add(dep_nid)
                    dep_color = ("reduction" if dep.dep_type == "REDUCTION"
                                 else "raw" if "RAW" in dep.dep_type
                                 else "war" if "WAR" in dep.dep_type
                                 else "waw")
                    short_type = dep.dep_type.split("(")[0].strip() if "(" in dep.dep_type else dep.dep_type
                    code_line, code_line_num = _find_dep_line(ir.source, dep, report)
                    nodes.append({
                        "id": dep_nid, "label": dep.variable,
                        "type": short_type, "color": dep_color,
                        "desc": dep.description,
                        "code_line": code_line,
                        "code_line_num": code_line_num,
                        "variable": dep.variable,
                    })
                edges.append({"source": loop_nid, "target": dep_nid, "label": short_type})

    return {"nodes": nodes, "edges": edges}


def _find_dep_line(source: str, dep, report) -> tuple:
    """Return (stripped_line, line_number) of the line where the dependency occurs."""
    lines  = source.split('\n')
    var    = dep.variable
    dtype  = dep.dep_type
    start  = max(0, report.loop_line - 1)
    best_line, best_num = "", dep.source_line

    for i, raw in enumerate(lines[start: start + 30], start=start + 1):
        s = raw.strip()
        if not s or s.startswith('//') or s.startswith('#') or s.startswith('/*'):
            continue
        vr = re.escape(var)
        if "RAW" in dtype:
            if re.search(rf'\b{vr}\s*\[.*[+\-]', raw):
                return s, i
            if re.search(rf'\b{vr}\s*=(?!=)', raw) and not re.search(rf'\b{vr}\s*\[', raw):
                best_line, best_num = s, i
        elif "WAW" in dtype:
            if re.search(rf'\b{vr}\s*=(?!=)', raw) and not re.search(rf'\b{vr}\s*\[', raw):
                return s, i
        elif dtype == "REDUCTION":
            if re.search(rf'\b{vr}\s*(\+=|-=|\*=)', raw):
                return s, i
        else:
            if re.search(rf'\b{vr}\b', raw) and not best_line:
                best_line, best_num = s, i

    return best_line or f"{var} (line {dep.source_line})", best_num
