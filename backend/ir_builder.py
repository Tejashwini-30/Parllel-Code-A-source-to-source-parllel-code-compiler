"""Module C: Intermediate Representation"""
import ast as py_ast
import re
from dataclasses import dataclass, field
from typing import List, Optional

@dataclass
class IRLoop:
    loop_id: int
    line: int
    var: str
    start: str
    end: str
    step: str
    body_vars_read: List[str]
    body_vars_write: List[str]
    nested: bool = False
    parallelizable: Optional[bool] = None

@dataclass
class IRProgram:
    language: str
    source: str
    loops: List[IRLoop] = field(default_factory=list)
    ast_nodes: list = field(default_factory=list)  # raw AST for visualization


def build_ir_python(source: str) -> IRProgram:
    ir = IRProgram(language="python", source=source)
    try:
        tree = py_ast.parse(source)
        ir.ast_nodes = _ast_to_dict(tree)
        loop_id = 0
        for node in py_ast.walk(tree):
            if isinstance(node, py_ast.For):
                var = node.target.id if isinstance(node.target, py_ast.Name) else "i"
                start, end, step = "0", "N", "1"
                if isinstance(node.iter, py_ast.Call):
                    func = getattr(node.iter.func, 'id', '')
                    if func == 'range':
                        args = node.iter.args
                        if len(args) == 1:
                            end = py_ast.unparse(args[0])
                        elif len(args) >= 2:
                            start = py_ast.unparse(args[0])
                            end = py_ast.unparse(args[1])
                        if len(args) == 3:
                            step = py_ast.unparse(args[2])

                reads, writes = _collect_rw_python(node.body)
                ir.loops.append(IRLoop(
                    loop_id=loop_id,
                    line=node.lineno,
                    var=var,
                    start=start,
                    end=end,
                    step=step,
                    body_vars_read=reads,
                    body_vars_write=writes
                ))
                loop_id += 1
    except Exception as e:
        ir.ast_nodes = [{"error": str(e)}]
    return ir


def _collect_rw_python(stmts):
    reads, writes = set(), set()
    for stmt in stmts:
        for node in py_ast.walk(py_ast.Module(body=stmts, type_ignores=[])):
            if isinstance(node, py_ast.Assign):
                for t in node.targets:
                    if isinstance(t, py_ast.Name):
                        writes.add(t.id)
                    elif isinstance(t, py_ast.Subscript):
                        if isinstance(t.value, py_ast.Name):
                            writes.add(t.value.id)
            if isinstance(node, py_ast.Name) and isinstance(node.ctx, py_ast.Load):
                reads.add(node.id)
        break  # walk the whole body once
    return list(reads), list(writes)


def _ast_to_dict(node):
    if isinstance(node, py_ast.AST):
        result = {"type": type(node).__name__}
        for field, value in py_ast.iter_fields(node):
            if field in ('lineno', 'col_offset', 'end_lineno', 'end_col_offset', 'type_ignores'):
                continue
            result[field] = _ast_to_dict(value)
        if hasattr(node, 'lineno'):
            result['line'] = node.lineno
        return result
    elif isinstance(node, list):
        return [_ast_to_dict(n) for n in node]
    else:
        return node


def build_ir_c_cpp(source: str, language: str) -> IRProgram:
    ir = IRProgram(language=language, source=source)
    loop_id = 0
    lines = source.split('\n')
    for i, line in enumerate(lines, 1):
        # Match: for (int i = 0; i < N; i++)
        m = re.match(r'\s*for\s*\(\s*(?:int|long|size_t)?\s*(\w+)\s*=\s*([^;]+);\s*\w+\s*[<>]=?\s*([^;]+);\s*[^)]+\)', line)
        if m:
            var, start, end = m.group(1), m.group(2).strip(), m.group(3).strip()
            body_lines = _extract_c_body(lines, i - 1)  # i is 1-indexed, pass 0-indexed
            reads, writes = _collect_rw_c(body_lines)
            ir.loops.append(IRLoop(
                loop_id=loop_id, line=i, var=var,
                start=start, end=end, step="1",
                body_vars_read=reads, body_vars_write=writes
            ))
            loop_id += 1
    ir.ast_nodes = _c_simple_ast(source)
    return ir


def _extract_c_body(lines, start_idx):
    """Extract only the immediate body of the for-loop."""
    body = []
    depth = 0
    started = False
    for line in lines[start_idx:]:
        for ch in line:
            if ch == '{':
                depth += 1
                started = True
            elif ch == '}':
                depth -= 1
        if started:
            body.append(line)
        if started and depth == 0:
            break
        if len(body) > 25:
            break
    return body


def _collect_rw_c(lines):
    """
    Collect read/write variables from C/C++/Java loop body.
    Only tracks variables that are actually assigned (written) inside the loop.
    Reads are only flagged if the same variable is also written (potential RAW).
    This avoids false positives from function parameters and outer-scope variables.
    """
    reads, writes = set(), set()
    C_SKIP = {
        'int','float','double','char','long','short','void','bool',
        'unsigned','const','static','return','if','else','while','for',
        'printf','scanf','cout','cin','endl','std','NULL','true','false',
        'new','delete','malloc','free','sizeof','string','vector','size_t',
        'System','out','println','Arrays','Math','length','size','push_back',
        'begin','end','first','second','nullptr','auto','struct','class',
    }

    for line in lines:
        stripped = line.strip()
        # Skip comments and blank lines
        if not stripped or stripped.startswith('//') or stripped.startswith('/*'):
            continue

        # Detect writes: var = expr  OR  var[...] = expr  OR  var += etc.
        # Pattern: identifier optionally followed by [..] then assignment operator
        for m in re.finditer(
            r'\b([a-zA-Z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:\+=|-=|\*=|/=|=)(?!=)',
            line
        ):
            var = m.group(1)
            if var not in C_SKIP:  # removed len(var) > 1 to allow single-letter vars
                writes.add(var)

        for m in re.finditer(r'\b([a-zA-Z_]\w*)\b', line):
            var = m.group(1)
            if var not in C_SKIP:  # removed len(var) > 1
                reads.add(var)

    # Only keep reads that are meaningful (filter out pure function names etc.)
    # by intersecting with writes — the dependency analyzer handles the rest
    return list(reads), list(writes)


def _c_simple_ast(source):
    nodes = []
    for i, line in enumerate(source.split('\n'), 1):
        line = line.strip()
        if not line or line.startswith('//'):
            continue
        if re.match(r'for\s*\(', line):
            nodes.append({"type": "ForLoop", "line": i, "text": line[:60]})
        elif re.match(r'if\s*\(', line):
            nodes.append({"type": "IfStmt", "line": i, "text": line[:60]})
        elif re.match(r'\w+\s+\w+\s*\(', line):
            nodes.append({"type": "FuncDecl", "line": i, "text": line[:60]})
        else:
            nodes.append({"type": "Stmt", "line": i, "text": line[:60]})
    return nodes


def build_ir_java(source: str) -> IRProgram:
    ir = IRProgram(language="java", source=source)
    loop_id = 0
    lines = source.split('\n')
    for i, line in enumerate(lines, 1):
        m = re.match(r'\s*for\s*\(\s*(?:int|long)?\s*(\w+)\s*=\s*([^;]+);\s*\w+\s*[<>]=?\s*([^;]+);\s*[^)]+\)', line)
        if m:
            var, start, end = m.group(1), m.group(2).strip(), m.group(3).strip()
            body_lines = _extract_c_body(lines, i - 1)  # i is 1-indexed
            reads, writes = _collect_rw_c(body_lines)
            ir.loops.append(IRLoop(
                loop_id=loop_id, line=i, var=var,
                start=start, end=end, step="1",
                body_vars_read=reads, body_vars_write=writes
            ))
            loop_id += 1
    ir.ast_nodes = _c_simple_ast(source)
    return ir


def build_ir(source: str, language: str) -> IRProgram:
    if language == "python":
        return build_ir_python(source)
    elif language in ("c", "cpp"):
        return build_ir_c_cpp(source, language)
    elif language == "java":
        return build_ir_java(source)
    return IRProgram(language=language, source=source)
