# AutoParallel

A source-to-source parallelization compiler that analyzes sequential loops for data dependencies and automatically generates parallel code with OpenMP/threading directives. Supports Python, C, C++, and Java.

---

## What It Does

AutoParallel takes sequential code as input and runs it through an 11-stage analysis pipeline:

1. **Language Detection** — auto-detects Python, C, C++, or Java
2. **IR Construction** — builds an intermediate representation (loops, variables, AST nodes)
3. **Dependency Analysis** — classifies each loop dependency as RAW, WAR, WAW, or Reduction
4. **Parallelization Decision** — marks loops as safe or blocked using Bernstein's conditions
5. **Parallel Code Generation** — emits OpenMP pragmas (C/C++/Java) or multiprocessing (Python)
6. **Safety Validation** — verifies that generated parallel code is race-condition free
7. **Performance Estimation** — applies Amdahl's and Gustafson's laws; simulates 2/4/8/16/32 cores
8. **Optimization Suggestions** — per-loop fix recommendations for blocked loops
9. **Explanation Engine** — human-readable explanation of every dependency decision
10. **Visualization** — interactive AST and dependency graphs (D3.js); exportable as PNG/PDF/text
11. **Loop Transformations** — generates restructured parallel versions for blocked loops (scalar expansion, prefix-sum)

---

## Tech Stack

| Layer    | Technology                        |
|----------|-----------------------------------|
| Backend  | Python 3.10+, FastAPI, Pydantic   |
| Frontend | Vanilla JS, HTML5, CSS3, D3.js v7 |
| Database | SQLite (analysis history)         |
| Parsing  | Python `ast` module, regex-based IR for C/C++/Java |

---

## Project Structure

```
autoparallel/
├── backend/
│   ├── main.py                  # FastAPI server, 11-stage pipeline
│   ├── language_detector.py     # Auto language detection
│   ├── ir_builder.py            # Intermediate representation builder
│   ├── dependency_analyzer.py   # RAW / WAR / WAW / Reduction detection
│   ├── parallelization_engine.py# Loop parallelizability classifier
│   ├── code_generator.py        # Parallel code emitter
│   ├── validation_engine.py     # Parallel safety validation
│   ├── performance_analyzer.py  # Amdahl / Gustafson + core simulation
│   ├── suggestion_engine.py     # Per-loop optimization suggestions
│   ├── explanation_engine.py    # Human-readable dependency explanations
│   ├── visualization_engine.py  # AST + dependency graph builder
│   ├── transformation_engine.py # Loop restructuring (prefix-sum, scalar expansion)
│   └── database.py              # SQLite history layer
└── frontend/
    ├── index.html               # Main compiler UI
    ├── examples.html            # Curated code examples by dependency type
    ├── app.js                   # Frontend logic, D3 visualizations
    └── style.css                # UI styles
```

---

## Getting Started

### Prerequisites

- Python 3.10 or higher
- pip

### Install & Run

```bash
# Clone the repository
git clone https://github.com/your-username/autoparallel.git
cd autoparallel

# Install dependencies
pip install fastapi uvicorn pydantic

# Start the server
cd backend
uvicorn main:app --reload --port 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

### API

| Method | Endpoint   | Description                        |
|--------|------------|------------------------------------|
| POST   | `/analyze` | Analyze code and return full report |
| GET    | `/history` | Fetch past analysis records        |
| GET    | `/examples`| Load the examples page             |
| GET    | `/health`  | Health check                       |

**POST `/analyze` request body:**
```json
{
  "code": "for (int i = 0; i < n; i++) { b[i] = a[i] * 2; }",
  "language": "cpp"
}
```

---

## Key Features

**Dependency detection** — identifies all four dependency classes that affect loop parallelism:
- RAW (Read After Write) — loop-carried, blocks parallelism
- WAW (Write After Write) — scalar output dependency, blocks parallelism
- WAR (Write After Read) — anti-dependency, generally safe
- Reduction — accumulation pattern (`+=`, `*=`), safe with reduction clause

**Bernstein's conditions** — formally checks all three conditions (C1/C2/C3) and reports which are violated and why.

**Induction variable detection** — identifies variables that increment/decrement by a constant each iteration and excludes them from false dependency reports.

**Dependency distance** — extracts the numeric distance from offset subscripts like `a[i-2]` to determine if wavefront parallelism is possible.

**Performance laws** — estimates speedup using both Amdahl's law (fixed problem size) and Gustafson's law (scaled problem size) across 2 to 32 cores.

**Loop transformations** — for blocked loops, generates a restructured parallel version:
- RAW → prefix-sum / two-pass scan pattern
- WAW → scalar expansion (index the scalar into an array)

---

## Example

Input (C++):
```cpp
for (int i = 0; i < n; i++) {
    b[i] = a[i] * 2.0;  // independent — safe
}
for (int i = 1; i < n; i++) {
    a[i] = a[i-1] + b[i];  // RAW dependency — blocked
}
```

Output:
```cpp
#pragma omp parallel for
for (int i = 0; i < n; i++) {
    b[i] = a[i] * 2.0;
}
// Loop 2: blocked — RAW on 'a' (loop-carried dependency)
// Fix: use std::partial_sum() or a parallel prefix-sum algorithm
for (int i = 1; i < n; i++) {
    a[i] = a[i-1] + b[i];
}
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
