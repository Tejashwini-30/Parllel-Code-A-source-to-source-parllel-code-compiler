"""Module A: Language Detection"""
import re

def detect_language(code: str) -> str:
    """Detect programming language from source code."""
    code = code.strip()

    # Java indicators
    if re.search(r'\bpublic\s+class\b|\bSystem\.out\.println\b|\bimport\s+java\.', code):
        return "java"

    # C++ indicators
    if re.search(r'#include\s*<(iostream|vector|string|algorithm)>|std::|cout\s*<<|cin\s*>>', code):
        return "cpp"

    # C indicators
    if re.search(r'#include\s*<(stdio|stdlib|string)\.h>|\bprintf\s*\(|\bscanf\s*\(|\bint\s+main\s*\(', code):
        return "c"

    # Python indicators
    if re.search(r'\bdef\s+\w+\s*\(|\bimport\s+\w+|\bprint\s*\(|\brange\s*\(|\bfor\s+\w+\s+in\b', code):
        return "python"

    # Fallback heuristics
    if '{' in code and ';' in code:
        if 'class' in code:
            return "java"
        return "c"
    return "python"
