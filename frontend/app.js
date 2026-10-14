/* AutoParallel Frontend App */
const API = '';

const EXT_LANG = {
  py: 'python', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  java: 'java'
};

// Language validation: patterns that strongly indicate a language
const LANG_SIGNATURES = {
  python: [/\bdef\s+\w+\s*\(/, /\bimport\s+\w+/, /\bfor\s+\w+\s+in\s+/, /\bprint\s*\(/, /\brange\s*\(/],
  c:      [/#include\s*<\w+\.h>/, /\bprintf\s*\(/, /\bscanf\s*\(/, /\bint\s+main\s*\(/],
  cpp:    [/#include\s*<(iostream|vector|string|algorithm)>/, /std::/, /cout\s*<</, /cin\s*>>/],
  java:   [/\bpublic\s+class\b/, /System\.out\.print/, /\bimport\s+java\./, /\bpublic\s+static\s+void\s+main/]
};

const EXAMPLES = {
  python: `# Array scaling and dot product - parallelizable loops

def scale_array(a, scalar, n):
    for i in range(n):
        a[i] = a[i] * scalar
    return a

def dot_product(a, b, n):
    total = 0
    for i in range(n):
        total += a[i] * b[i]
    return total

n = 1000
a = list(range(n))
b = list(range(n))
scale_array(a, 2.0, n)
print(dot_product(a, b, n))`,

  c: `#include <stdio.h>
#include <stdlib.h>

void scale_array(double *a, double scalar, int n) {
    for (int i = 0; i < n; i++) {
        a[i] = a[i] * scalar;
    }
}

double array_sum(double *a, int n) {
    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        sum += a[i];
    }
    return sum;
}

int main() {
    int n = 1000;
    double *arr = malloc(n * sizeof(double));
    for (int i = 0; i < n; i++) arr[i] = i * 1.0;
    scale_array(arr, 2.0, n);
    printf("Sum: %f\\n", array_sum(arr, n));
    free(arr);
    return 0;
}`,

  cpp: `#include <iostream>
#include <vector>
using namespace std;

void matrix_multiply(vector<vector<double>>& C,
                     const vector<vector<double>>& A,
                     const vector<vector<double>>& B, int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            C[i][j] = 0;
            for (int k = 0; k < n; k++) {
                C[i][j] += A[i][k] * B[k][j];
            }
        }
    }
}

int main() {
    int n = 100;
    vector<vector<double>> A(n, vector<double>(n, 1.0));
    vector<vector<double>> B(n, vector<double>(n, 2.0));
    vector<vector<double>> C(n, vector<double>(n, 0.0));
    matrix_multiply(C, A, B, n);
    cout << "C[0][0] = " << C[0][0] << endl;
    return 0;
}`,

  java: `import java.util.Arrays;

public class ParallelExample {
    public static void scaleArray(double[] arr, double scalar) {
        for (int i = 0; i < arr.length; i++) {
            arr[i] *= scalar;
        }
    }

    public static double arraySum(double[] arr) {
        double sum = 0.0;
        for (int i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
        return sum;
    }

    public static void main(String[] args) {
        double[] data = new double[1000];
        Arrays.fill(data, 1.0);
        scaleArray(data, 3.0);
        System.out.println("Sum: " + arraySum(data));
    }
}`
};

let lastResult = null;
let uploadedFileName = null;
let selectedCores = 2; // default core selection
let selectedLaw = 'amdahl'; // default law: 'amdahl' or 'gustafson'

// ── Core Selector ─────────────────────────────────────────────────────────────

function selectCores(n, btn) {
  selectedCores = n;
  document.querySelectorAll('.core-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (lastResult && lastResult.metrics) {
    renderPerformance(lastResult.metrics);
  }
}

function selectLaw(law, btn) {
  selectedLaw = law;
  document.querySelectorAll('.law-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (lastResult && lastResult.metrics) {
    renderPerformance(lastResult.metrics);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Detect the actual language of the code by checking signatures.
 * Returns the detected language string or null if ambiguous.
 */
function detectCodeLanguage(code) {
  const scores = {};
  for (const [lang, patterns] of Object.entries(LANG_SIGNATURES)) {
    scores[lang] = patterns.filter(p => p.test(code)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * Validate that the code matches the selected language.
 * Returns an error message string, or null if valid.
 */
function validateCodeLanguage(code, selectedLang) {
  if (!selectedLang || !code.trim()) return null;

  const detected = detectCodeLanguage(code);
  if (!detected) return null; // can't determine, allow through

  // C and C++ are close — allow either when the other is selected
  const cFamily = ['c', 'cpp'];
  if (cFamily.includes(selectedLang) && cFamily.includes(detected)) return null;

  if (detected !== selectedLang) {
    const names = { python: 'Python', c: 'C', cpp: 'C++', java: 'Java' };
    const detectedName = names[detected] || detected;
    const selectedName = names[selectedLang] || selectedLang;
    return `Language mismatch: This looks like ${detectedName} code (detected ${detectedName} syntax), but you selected ${selectedName}. Please either change the language selector to "${detectedName}" or use "Auto Detect".`;
  }
  return null;
}

/**
 * Validate uploaded file extension against selected language.
 * Returns an error message string, or null if valid.
 */
function validateFileExtension(filename, selectedLang) {
  if (!selectedLang) return null;
  const ext = filename.split('.').pop().toLowerCase();
  const fileLang = EXT_LANG[ext];
  if (!fileLang) return `Unsupported file type ".${ext}". Accepted: .py .c .cpp .h .hpp .java`;

  const cFamily = ['c', 'cpp'];
  if (cFamily.includes(selectedLang) && cFamily.includes(fileLang)) return null;

  if (fileLang !== selectedLang) {
    const names = { python: 'Python', c: 'C', cpp: 'C++', java: 'Java' };
    return `File ".${ext}" is a ${names[fileLang]} file, but you selected ${names[selectedLang]}. Please match the language or use Auto Detect.`;
  }
  return null;
}

function showValidationError(msg) {
  const el = document.getElementById('validation-error');
  if (msg) {
    el.innerHTML = '<span style="font-weight:700;margin-right:6px">&#9888; Warning:</span>' + msg;
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    el.innerHTML = '';
    el.classList.add('hidden');
  }
}

// ── File Upload ───────────────────────────────────────────────────────────────

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  processFile(file);
}

function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const selectedLang = document.getElementById('lang-select').value;

  // Validate extension vs selected language
  const extError = validateFileExtension(file.name, selectedLang);
  if (extError) {
    showValidationError(extError);
    return;
  }

  // Check extension is supported at all
  if (!EXT_LANG[ext]) {
    showValidationError(`Unsupported file type ".${ext}". Accepted: .py .c .cpp .h .hpp .java`);
    return;
  }

  showValidationError(null);

  const reader = new FileReader();
  reader.onload = (e) => {
    const code = e.target.result;
    document.getElementById('code-input').value = code;
    uploadedFileName = file.name;

    // Auto-set language from extension if on Auto Detect
    if (!selectedLang && EXT_LANG[ext]) {
      document.getElementById('lang-select').value = EXT_LANG[ext];
    }

    const badge = document.getElementById('file-name-badge');
    badge.textContent = file.name;
    badge.classList.remove('hidden');

    updateDropZoneVisibility();
  };
  reader.onerror = () => showValidationError('Could not read file: ' + file.name);
  reader.readAsText(file);
}

function initDropZone() {
  const zone = document.getElementById('drop-zone');
  const textarea = document.getElementById('code-input');

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  // Left-click: open file picker
  // But if user clicks the "type here" link, switch to textarea
  zone.addEventListener('click', (e) => {
    if (e.target.id === 'type-here-link') {
      e.stopPropagation();
      zone.style.display = 'none';
      textarea.style.display = 'block';
      textarea.focus();
    } else {
      document.getElementById('file-input').click();
    }
  });
}

function updateDropZoneVisibility() {
  const code = document.getElementById('code-input').value;
  const zone = document.getElementById('drop-zone');
  const textarea = document.getElementById('code-input');
  if (code.trim()) {
    zone.style.display = 'none';
    textarea.style.display = 'block';
  } else {
    zone.style.display = 'flex';
    textarea.style.display = 'none';
  }
}

// Update file accept filter when language changes
function onLangChange() {
  const lang = document.getElementById('lang-select').value;
  const acceptMap = {
    python: '.py',
    c: '.c,.h',
    cpp: '.cpp,.cc,.cxx,.hpp,.h',
    java: '.java',
    '': '.py,.c,.cpp,.cc,.cxx,.h,.hpp,.java'
  };
  document.getElementById('file-input').setAttribute('accept', acceptMap[lang] || acceptMap['']);

  // Load the matching example automatically when language is switched
  const code = document.getElementById('code-input').value.trim();
  const isExample = Object.values(EXAMPLES).some(ex => code === ex.trim());
  if (!code || isExample) {
    loadExample();
  }

  // Re-validate existing code against new language selection
  const currentCode = document.getElementById('code-input').value.trim();
  if (currentCode && lang) {
    const err = validateCodeLanguage(currentCode, lang);
    showValidationError(err);
  } else {
    showValidationError(null);
  }
}

// ── Examples ──────────────────────────────────────────────────────────────────

function loadExample() {
  const lang = document.getElementById('lang-select').value || 'python';
  const code = EXAMPLES[lang] || EXAMPLES['python'];
  const textarea = document.getElementById('code-input');
  const zone     = document.getElementById('drop-zone');
  textarea.value = code;
  if (!document.getElementById('lang-select').value) {
    document.getElementById('lang-select').value = 'python';
  }
  document.getElementById('file-name-badge').classList.add('hidden');
  uploadedFileName = null;
  showValidationError(null);
  zone.style.display     = 'none';
  textarea.style.display = 'block';
}

// ── Analyze ───────────────────────────────────────────────────────────────────

async function analyze() {
  const code = document.getElementById('code-input').value.trim();
  if (!code) { showValidationError('Please enter or upload some code first.'); return; }

  const lang = document.getElementById('lang-select').value || null;

  // Validate language match before sending
  if (lang) {
    const err = validateCodeLanguage(code, lang);
    if (err) { showValidationError(err); return; }
  }
  showValidationError(null);
  setLoading(true);

  try {
    const res = await fetch(`${API}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: lang })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Server error');
    }
    lastResult = await res.json();
    try {
      renderResults(lastResult);
    } catch (renderErr) {
      // Rendering errors (e.g. visualization) should not block the UI
      console.warn('Render error (non-critical):', renderErr);
    }
  } catch (e) {
    // Don't show D3/visualization errors in the validation banner — they're non-critical
    if (!e.message || (!e.message.toLowerCase().includes('d3') && !e.message.toLowerCase().includes('d3 is not defined'))) {
      showValidationError('Error: ' + e.message);
    } else {
      console.warn('Visualization error (non-critical):', e);
    }
  } finally {
    setLoading(false);
  }
}

// ── Render Results ────────────────────────────────────────────────────────────

function renderResults(data) {
  document.getElementById('detected-lang').textContent =
    `Language: ${data.language.toUpperCase()}  |  Loops: ${data.total_loops}  |  Parallelizable: ${data.parallel_loops}`;

  const pct = data.total_loops > 0
    ? Math.round((data.parallel_loops / data.total_loops) * 100)
    : 0;
  const pctColor = pct === 100 ? '#4caf50' : pct >= 75 ? '#00d4aa' : pct >= 50 ? '#ffc107' : '#ff5c5c';

  document.getElementById('parallel-summary').innerHTML =
    `${data.parallel_loops} / ${data.total_loops} loops parallelized &nbsp;
     <span style="font-weight:800;color:${pctColor};font-size:0.9rem">${pct}% Parallelizable</span>`;

  renderParallelCode(data.parallel_code);
  try { renderAST(data.ast_graph); } catch(e) { console.warn('AST error:', e); }
  try { renderDepGraph(data.dep_graph); } catch(e) { console.warn('Dep graph error:', e); }
  try { renderExplanation(data.explanations); } catch(e) { console.warn('Explanation error:', e); }
  try { renderPerformance(data.metrics); } catch(e) { console.warn('Performance error:', e); }
  try { renderValidation(data.validation); } catch(e) { console.warn('Validation error:', e); }
  try { renderSuggestions(data.suggestions); } catch(e) { console.warn('Suggestions error:', e); }

  // New features (wrapped in try/catch so errors don't break core tabs)
  try { renderTransformTab(data.transformations || [], data.loop_analysis || []); } catch(e) { console.warn('Transform tab error:', e); }
  try { renderDiffView(document.getElementById('code-input').value, data.parallel_code || ''); } catch(e) { console.warn('Diff view error:', e); }

  switchTab('parallel-code');
}

// ── Parallel Code — plain pre output, no highlighting ────────────────────────

function renderParallelCode(code) {
  const container = document.getElementById('parallel-output');
  container.textContent = code;
}

// ── AST Visualization — Proper D3 Hierarchical Tree ─────────────────────────

function renderAST(graph) {
  const container = document.getElementById('ast-container');
  container.innerHTML = '';
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    container.innerHTML = '<p style="padding:20px;color:var(--muted)">No AST data available.</p>';
    return;
  }
  if (typeof d3 === 'undefined') {
    container.innerHTML = '<p style="padding:20px;color:var(--muted)">D3.js not loaded. AST visualization unavailable.</p>';
    return;
  }

  // Color scheme — extended for all node types
  const colorMap = {
    parallel:   { border: '#00e676', text: '#00e676', bg: 'rgba(0,230,118,0.15)', level: 'key' },
    dependent:  { border: '#ff5252', text: '#ff5252', bg: 'rgba(255,82,82,0.15)',  level: 'key' },
    loop:       { border: '#ffab40', text: '#ffab40', bg: 'rgba(255,171,64,0.12)', level: 'key' },
    root:       { border: '#7c4dff', text: '#c5b8ff', bg: 'rgba(124,77,255,0.18)', level: 'key' },
    FuncDecl:   { border: '#40c4ff', text: '#40c4ff', bg: 'rgba(64,196,255,0.12)', level: 'key' },
    LoopBody:   { border: '#546e7a', text: '#90a4ae', bg: 'rgba(84,110,122,0.10)', level: 'mid' },
    LoopInit:   { border: '#78909c', text: '#b0bec5', bg: 'rgba(120,144,156,0.08)', level: 'leaf' },
    LoopCond:   { border: '#78909c', text: '#b0bec5', bg: 'rgba(120,144,156,0.08)', level: 'leaf' },
    LoopUpdate: { border: '#78909c', text: '#b0bec5', bg: 'rgba(120,144,156,0.08)', level: 'leaf' },
    LoopIter:   { border: '#78909c', text: '#b0bec5', bg: 'rgba(120,144,156,0.08)', level: 'leaf' },
    LoopVar:    { border: '#78909c', text: '#b0bec5', bg: 'rgba(120,144,156,0.08)', level: 'leaf' },
    IfStmt:     { border: '#ce93d8', text: '#ce93d8', bg: 'rgba(206,147,216,0.10)', level: 'mid' },
    IfThen:     { border: '#a5d6a7', text: '#a5d6a7', bg: 'rgba(165,214,167,0.08)', level: 'mid' },
    IfElse:     { border: '#ef9a9a', text: '#ef9a9a', bg: 'rgba(239,154,154,0.08)', level: 'mid' },
    VarDecl:    { border: '#80cbc4', text: '#80cbc4', bg: 'rgba(128,203,196,0.08)', level: 'leaf' },
    Assign:     { border: '#546e7a', text: '#90a4ae', bg: 'rgba(84,110,122,0.06)',  level: 'leaf' },
    AugAssign:  { border: '#546e7a', text: '#90a4ae', bg: 'rgba(84,110,122,0.06)',  level: 'leaf' },
    Return:     { border: '#ef9a9a', text: '#ef9a9a', bg: 'rgba(239,154,154,0.08)', level: 'leaf' },
    FuncCall:   { border: '#80deea', text: '#80deea', bg: 'rgba(128,222,234,0.08)', level: 'leaf' },
    default:    { border: '#455a64', text: '#78909c', bg: 'rgba(69,90,100,0.08)',   level: 'leaf' }
  };

  // Build parent->children map from flat nodes + edges
  const nodeMap = {};
  graph.nodes.forEach(n => { nodeMap[n.id] = { ...n, children: [] }; });
  const childSet = new Set();
  graph.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (nodeMap[src] && nodeMap[tgt]) {
      nodeMap[src].children.push(nodeMap[tgt]);
      childSet.add(String(tgt));
    }
  });
  const rootData = graph.nodes.find(n => !childSet.has(String(n.id)));
  if (!rootData) {
    container.innerHTML = '<p style="padding:20px;color:var(--muted)">Could not build tree.</p>';
    return;
  }
  const rootNode = nodeMap[rootData.id];

  // Node box dimensions — wider nodes, more vertical spacing for clear hierarchy
  const NW = 190, NH = 50;
  const V_GAP = 100; // vertical gap between levels

  // Use d3.hierarchy + d3.tree for proper top-down layout
  const hierRoot = d3.hierarchy(rootNode, d => d.children && d.children.length ? d.children : null);
  const treeLayout = d3.tree()
    .nodeSize([NW + 24, NH + V_GAP])
    .separation((a, b) => {
      // More space between subtrees, tighter within same parent
      if (a.parent === b.parent) return 1.1;
      return 1.4;
    });
  treeLayout(hierRoot);

  // Compute canvas bounds
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  hierRoot.each(d => {
    minX = Math.min(minX, d.x);
    maxX = Math.max(maxX, d.x);
    maxY = Math.max(maxY, d.y);
  });

  const PAD = 60;
  const svgW = Math.max(maxX - minX + NW + PAD * 2, 600);
  const svgH = maxY + NH + PAD * 2;

  // Tooltip
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `
    position:absolute;display:none;background:#0d1b2a;color:#e0e0e0;
    padding:12px 16px;border-radius:10px;font-size:0.82rem;max-width:320px;
    line-height:1.7;border:1px solid #1e3a5f;z-index:999;pointer-events:none;
    box-shadow:0 6px 24px rgba(0,0,0,0.6);
  `;
  container.style.position = 'relative';
  container.appendChild(tooltip);

  const svg = d3.select('#ast-container').append('svg')
    .attr('width', svgW).attr('height', svgH)
    .style('background', 'var(--surface)');

  // Depth-level background bands to visually separate hierarchy levels
  const maxDepth = d3.max(hierRoot.descendants(), d => d.depth) || 0;
  const levelColors = ['rgba(124,77,255,0.04)', 'rgba(64,196,255,0.03)', 'rgba(255,171,64,0.03)', 'rgba(69,90,100,0.02)'];
  hierRoot.descendants().forEach(d => {
    const bandY = PAD - minX + d.y - V_GAP / 2;
    // only draw once per depth
  });

  // Offset so tree is centered: x coords from d3.tree are centered at 0
  const g = svg.append('g')
    .attr('transform', `translate(${PAD - minX},${PAD})`);

  svg.call(d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => g.attr('transform', e.transform)));

  // Draw edges — elbow connectors (right-angle) for clear hierarchy
  g.selectAll('.ast-link')
    .data(hierRoot.links())
    .enter().append('path')
    .attr('fill', 'none')
    .attr('stroke', d => {
      // Color edge by parent node type for visual grouping
      const pc = colorMap[d.source.data.color] || colorMap[d.source.data.type] || colorMap.default;
      return pc.border + '55';
    })
    .attr('stroke-width', d => d.source.depth === 0 ? 2 : 1.5)
    .attr('d', d => {
      const sx = d.source.x + NW / 2;
      const sy = d.source.y + NH;
      const tx = d.target.x + NW / 2;
      const ty = d.target.y;
      // Elbow: go down halfway, then horizontal, then down to target
      const midY = sy + (ty - sy) * 0.45;
      return `M${sx},${sy} L${sx},${midY} L${tx},${midY} L${tx},${ty}`;
    });

  // Draw nodes
  const nodes = g.selectAll('.ast-node')
    .data(hierRoot.descendants())
    .enter().append('g')
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('cursor', d => {
      const col = d.data.color;
      return (col === 'parallel' || col === 'dependent' || col === 'loop') ? 'pointer' : 'default';
    });

  // Helper: get color for a node — checks color field first, then type
  function nodeColor(d) {
    return colorMap[d.data.color] || colorMap[d.data.type] || colorMap.default;
  }
  function isColored(d) {
    return d.data.color !== 'default' || colorMap[d.data.type] !== undefined;
  }

  // Glow shadow for key nodes
  nodes.each(function(d) {
    const c = nodeColor(d);
    if (c.level !== 'key') return;
    d3.select(this).append('rect')
      .attr('x', 4).attr('y', 4).attr('width', NW).attr('height', NH)
      .attr('rx', 9).attr('fill', c.border).attr('opacity', 0.10);
  });

  // Main box — root/key nodes get rounded pill shape, leaves get smaller radius
  nodes.append('rect')
    .attr('width', NW).attr('height', NH)
    .attr('rx', d => {
      const c = nodeColor(d);
      return c.level === 'key' ? 10 : c.level === 'mid' ? 7 : 5;
    })
    .attr('fill', d => nodeColor(d).bg)
    .attr('stroke', d => nodeColor(d).border)
    .attr('stroke-width', d => {
      const c = nodeColor(d);
      return c.level === 'key' ? 2.5 : c.level === 'mid' ? 1.5 : 1;
    });

  // Top type-label strip inside the box (shows AST node type)
  nodes.each(function(d) {
    const c = nodeColor(d);
    const typeLabel = d.data.type || '';
    if (!typeLabel || typeLabel === 'default') return;
    // Small colored strip at top of box
    d3.select(this).append('rect')
      .attr('x', 0).attr('y', 0).attr('width', NW).attr('height', 16)
      .attr('rx', c.level === 'key' ? 10 : 5)
      .attr('fill', c.border).attr('opacity', 0.18);
    d3.select(this).append('text')
      .attr('x', NW / 2).attr('y', 11)
      .attr('text-anchor', 'middle')
      .attr('font-size', '8px').attr('font-weight', '700')
      .attr('font-family', 'Fira Code, Consolas, monospace')
      .attr('fill', '#ffffff').attr('opacity', 0.95)
      .text(typeLabel.toUpperCase());
  });

  // Line number badge (top-right)
  nodes.each(function(d) {
    if (!d.data.line || d.data.line <= 0) return;
    const c = nodeColor(d);
    const g2 = d3.select(this);
    g2.append('rect').attr('x', NW - 32).attr('y', -10).attr('width', 32).attr('height', 17)
      .attr('rx', 8).attr('fill', c.border).attr('opacity', 0.95);
    g2.append('text').attr('x', NW - 16).attr('y', 4)
      .attr('text-anchor', 'middle').attr('font-size', '9px').attr('font-weight', '700').attr('fill', '#ffffff')
      .text('L' + d.data.line);
  });

  // Type icon (left side)
  const ICONS = {
    parallel: '✓', dependent: '✗', loop: '⟳', root: '◈',
    FuncDecl: 'ƒ', IfStmt: '?', VarDecl: 'v', Return: '↩',
    LoopBody: '{}', LoopInit: '=', LoopCond: '<', LoopUpdate: '++',
    LoopIter: '∈', LoopVar: 'x', FuncCall: '()', AugAssign: '±'
  };
  nodes.each(function(d) {
    const icon = ICONS[d.data.color] || ICONS[d.data.type] || '';
    if (!icon) return;
    const c = nodeColor(d);
    d3.select(this).append('text')
      .attr('x', 8).attr('y', NH / 2 + 8)
      .attr('font-size', '11px').attr('fill', c.border).attr('opacity', 0.9)
      .text(icon);
  });

  // Main label text — two lines: type (small, top) + label (main, bottom)
  nodes.each(function(d) {
    const c = nodeColor(d);
    const raw = d.data.label || d.data.type || '';
    const label = raw.length > 22 ? raw.slice(0, 21) + '\u2026' : raw;
    d3.select(this).append('text')
      .attr('x', NW / 2 + 4).attr('y', NH / 2 + 10)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('font-family', 'Fira Code, Consolas, monospace')
      .attr('font-weight', '600')
      .attr('fill', c.text)
      .text(label);
  });

  // RAW/WAW badge on dependent nodes
  nodes.each(function(d) {
    if (d.data.color !== 'dependent') return;
    const dt = (d.data.dep_type || '').split('(')[0].trim().slice(0, 3).toUpperCase();
    if (!dt) return;
    const g2 = d3.select(this);
    g2.append('rect').attr('x', -2).attr('y', -10).attr('width', 34).attr('height', 18)
      .attr('rx', 9).attr('fill', '#ff5252').attr('opacity', 0.95);
    g2.append('text').attr('x', 15).attr('y', 4)
      .attr('text-anchor', 'middle').attr('font-size', '8px').attr('font-weight', '700').attr('fill', '#fff')
      .text(dt);
  });

  // Depth level indicator dot (left edge of node)
  nodes.each(function(d) {
    const c = nodeColor(d);
    d3.select(this).append('circle')
      .attr('cx', 0).attr('cy', NH / 2)
      .attr('r', 4)
      .attr('fill', c.border)
      .attr('opacity', 0.7);
  });

  // Hover — highlight the main rect (index 1 if glow exists, else 0)
  nodes.on('mouseover', function(event, d) {
    const c = nodeColor(d);
    const isKey = c.level === 'key';
    d3.select(this).select('rect:nth-child(' + (isKey ? '2' : '1') + ')')
      .attr('stroke-width', isKey ? 3.5 : 2)
      .attr('filter', `drop-shadow(0 0 8px ${c.border})`);
  }).on('mouseout', function(event, d) {
    const c = nodeColor(d);
    const isKey = c.level === 'key';
    d3.select(this).select('rect:nth-child(' + (isKey ? '2' : '1') + ')')
      .attr('stroke-width', isKey ? 2.5 : c.level === 'mid' ? 1.5 : 1)
      .attr('filter', null);
  });

  // Click tooltip
  nodes.on('click', function(event, d) {
    event.stopPropagation();
    const node = d.data;
    const depType = (node.dep_type || '').split('(')[0].trim().toUpperCase();
    const varName = node.variable || '';
    let msg = '';

    if (node.color === 'parallel') {
      msg = `<strong style="color:#00e676">&#10003; Parallelizable Loop</strong>
        <div style="color:#78909c;font-size:0.78rem;margin:3px 0">Line ${node.line}</div>
        All iterations are <strong>independent</strong> &mdash; each writes to a unique index.
        <div style="margin-top:8px;color:#00e676;font-size:0.78rem">&#8594; Safe to add <code>#pragma omp parallel for</code></div>`;
    } else if (node.color === 'dependent') {
      const fixes = {
        'RAW': 'Use <code>std::partial_sum()</code> / <code>Arrays.parallelPrefix()</code> / <code>itertools.accumulate()</code>',
        'WAW': 'Replace scalar with indexed array: <code>x[i] = ...</code> instead of <code>x = ...</code>',
        'WAR': 'Use private copies or restructure to eliminate cross-iteration reads',
      };
      const fix = fixes[depType] || 'Restructure to eliminate loop-carried dependency';
      msg = `<strong style="color:#ff5252">&#10007; Not Parallelizable &mdash; ${depType || 'Dependency'}</strong>
        <div style="color:#78909c;font-size:0.78rem;margin:3px 0">Line ${node.line}${varName ? ' &middot; var: <code style="color:#ff8a8a">' + varName + '</code>' : ''}</div>
        Iteration <strong>i</strong> depends on data from iteration <strong>i&minus;1</strong>.
        <div style="margin-top:8px;padding:6px 8px;background:rgba(255,193,7,0.1);border-radius:4px;font-size:0.78rem;color:#ffc107">Fix: ${fix}</div>`;
    } else if (node.color === 'loop') {
      msg = `<strong style="color:#ffab40">&#8635; Loop &mdash; Analyzing</strong>
        <div style="color:#78909c;font-size:0.78rem;margin:3px 0">Line ${node.line}</div>
        <code style="color:#ffab40;font-size:0.78rem">${(node.label || '').slice(0, 40)}</code>`;
    } else if (node.color === 'root') {
      msg = `<strong style="color:#7c4dff">&#9670; Program Root</strong>
        <div style="margin-top:6px;color:#90a4ae;font-size:0.82rem">Top-level AST node. All functions and statements are children.</div>`;
    } else if (node.type === 'FuncDecl') {
      msg = `<strong style="color:#90caf9">&#402; Function</strong>
        <div style="color:#78909c;font-size:0.78rem;margin:3px 0">Line ${node.line}</div>
        <code style="color:#90caf9;font-size:0.78rem">${(node.label || '').slice(0, 45)}</code>
        <div style="margin-top:6px;color:#78909c;font-size:0.78rem">Contains ${d.children ? d.children.length : 0} child node(s).</div>`;
    } else {
      msg = `<strong style="color:#78909c">${node.type || 'Statement'}</strong>
        <div style="color:#546e7a;font-size:0.78rem;margin:3px 0">Line ${node.line || 'N/A'}</div>
        <code style="color:#90a4ae;font-size:0.78rem">${(node.label || '').slice(0, 45)}</code>`;
    }

    tooltip.innerHTML = msg;
    tooltip.style.display = 'block';
    const cRect = container.getBoundingClientRect();
    const eRect = event.target.getBoundingClientRect();
    let left = eRect.left - cRect.left + 10;
    let top  = eRect.top  - cRect.top  + NH + 8;
    if (left + 330 > container.clientWidth)  left = container.clientWidth - 335;
    if (top  + 180 > container.clientHeight) top  = eRect.top - cRect.top - 185;
    tooltip.style.left = left + 'px';
    tooltip.style.top  = top  + 'px';
  });

  svg.on('click', () => { tooltip.style.display = 'none'; });

  // Legend
  const legendItems = [
    { color: '#00e676', label: 'Parallelizable loop' },
    { color: '#ff5252', label: 'Blocked (dependency)' },
    { color: '#ffab40', label: 'Loop (analyzing)' },
    { color: '#7c4dff', label: 'Program root' },
    { color: '#40c4ff', label: 'Function declaration' },
    { color: '#ce93d8', label: 'If statement' },
    { color: '#80cbc4', label: 'Variable declaration' },
    { color: '#546e7a', label: 'Assignment / Statement' },
  ];
  const leg = svg.append('g').attr('transform', 'translate(10,10)');
  leg.append('rect').attr('x', -4).attr('y', -4)
    .attr('width', 200).attr('height', legendItems.length * 18 + 28)
    .attr('rx', 6).attr('fill', 'rgba(0,0,0,0.5)');
  // Title
  leg.append('text').attr('x', 0).attr('y', -8 + 18)
    .attr('font-size', '9px').attr('font-weight', '700').attr('fill', '#90a4ae')
    .text('AST NODE TYPES');
  legendItems.forEach((item, i) => {
    const y = i * 18 + 20;
    leg.append('rect').attr('x', 0).attr('y', y).attr('width', 11).attr('height', 11)
      .attr('rx', 2).attr('fill', item.color + '33').attr('stroke', item.color).attr('stroke-width', 1.5);
    leg.append('text').attr('x', 16).attr('y', y + 9)
      .attr('font-size', '9.5px').attr('fill', '#78909c').text(item.label);
  });

  // Depth level guide (bottom-right)
  const depthGuide = svg.append('g').attr('transform', `translate(${svgW - 160}, ${svgH - 80})`);
  depthGuide.append('rect').attr('x', -4).attr('y', -4).attr('width', 155).attr('height', 72)
    .attr('rx', 5).attr('fill', 'rgba(0,0,0,0.4)');
  depthGuide.append('text').attr('x', 0).attr('y', 10)
    .attr('font-size', '8.5px').attr('font-weight', '700').attr('fill', '#90a4ae').text('HIERARCHY LEVELS');
  [
    { label: 'L0  Program root', color: '#7c4dff' },
    { label: 'L1  Functions', color: '#40c4ff' },
    { label: 'L2  Loops / Stmts', color: '#ffab40' },
    { label: 'L3  Body / Sub-nodes', color: '#546e7a' },
  ].forEach((row, i) => {
    depthGuide.append('circle').attr('cx', 4).attr('cy', 22 + i * 13).attr('r', 3).attr('fill', row.color);
    depthGuide.append('text').attr('x', 12).attr('y', 26 + i * 13)
      .attr('font-size', '8.5px').attr('fill', '#78909c').text(row.label);
  });
}

// ── Dependency Graph — clean table layout ────────────────────────────────────

function renderDepGraph(graph) {
  const container = document.getElementById('dep-container');
  container.innerHTML = '';

  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    container.innerHTML = '<p style="padding:20px;color:var(--muted)">No dependency data.</p>';
    return;
  }

  // Separate loop nodes from dep/var nodes
  const loopNodes = graph.nodes.filter(n => n.type === 'loop');
  const edgeMap   = {};  // loop_id -> [{target, label}]
  graph.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    if (!edgeMap[src]) edgeMap[src] = [];
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    const tgtNode = graph.nodes.find(n => n.id === tgt);
    if (tgtNode) edgeMap[src].push({ node: tgtNode, label: e.label });
  });

  const colorMap = {
    parallel:  { bg: 'rgba(76,175,80,0.12)',  border: '#4caf50', text: '#4caf50'  },
    dependent: { bg: 'rgba(255,92,92,0.12)',  border: '#ff5c5c', text: '#ff5c5c'  },
    raw:       { bg: 'rgba(255,92,92,0.08)',  border: '#ff5c5c', text: '#ff8a8a'  },
    war:       { bg: 'rgba(255,193,7,0.08)',  border: '#ffc107', text: '#ffc107'  },
    waw:       { bg: 'rgba(255,92,92,0.08)',  border: '#ff5c5c', text: '#ff8a8a'  },
    reduction: { bg: 'rgba(0,212,170,0.08)',  border: '#00d4aa', text: '#00d4aa'  },
    safe:      { bg: 'rgba(76,175,80,0.08)',  border: '#4caf50', text: '#4caf50'  },
  };

  const labelColor = {
    'RAW':       '#ff5c5c',
    'WAR':       '#ffc107',
    'WAW':       '#ff5c5c',
    'REDUCTION': '#00d4aa',
    'safe':      '#4caf50',
    'reads':     '#00d4aa',
    'writes':    '#ffc107',
  };

  // Build HTML rows
  const rows = loopNodes.map(loop => {
    const lc    = colorMap[loop.color] || colorMap.dependent;
    const deps  = edgeMap[loop.id] || [];
    const badge = loop.parallelizable
      ? `<span class="dep-status-badge safe">Parallelizable</span>`
      : `<span class="dep-status-badge blocked">Has Dependency</span>`;

    // Extract loop line number from label e.g. "Loop  line 6" → 6
    const loopLineMatch = (loop.label || '').match(/line\s+(\d+)/i);
    const loopLineNum   = loopLineMatch ? parseInt(loopLineMatch[1]) : 0;
    const loopClickAttr = loopLineNum
      ? ` onclick="highlightSourceLine(${loopLineNum})" style="cursor:pointer" title="Click to highlight line ${loopLineNum} in source"`
      : '';

    const depCells = deps.length === 0
      ? `<span style="color:var(--muted);font-size:0.8rem">No dependencies</span>`
      : deps.map(({ node, label }) => {
          const nc       = colorMap[node.color] || colorMap.raw;
          const lbl      = label || node.type || '';
          const lc2      = labelColor[lbl] || 'var(--muted)';
          const isBlocked = lbl === 'RAW' || lbl === 'WAW' || lbl === 'WAR';
          const varName  = node.variable || node.label || '';
          const codeLine = node.code_line || '';
          const lineNum  = node.code_line_num || '';

          // Highlight the dependency variable inside the code line
          let codeHtml = '';
          if (codeLine && varName) {
            let esc = codeLine
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
            esc = esc.split(varName).join('<mark class="dep-var-highlight">' + varName + '</mark>');
            codeHtml = '<div class="dep-code-line">'
              + (lineNum ? '<span class="dep-line-num">L' + lineNum + '</span>' : '')
              + '<code class="dep-code-snippet">' + esc + '</code>'
              + '</div>';
          }

          // Click: highlight the dep line in source AND show reason popup for blocked
          let chipClick = '';
          if (lineNum) {
            chipClick = ` onclick="highlightSourceLine(${lineNum});${isBlocked ? 'showDepGraphReason(\'' + lbl + '\',\'' + varName + '\')' : ''}" style="cursor:pointer"`;
          } else if (isBlocked) {
            chipClick = ` onclick="showDepGraphReason('${lbl}','${varName}')" style="cursor:pointer"`;
          }

          const tip = node.desc ? ' title="' + node.desc.replace(/"/g, '&quot;') + '"' : '';

          return '<div class="dep-var-chip' + (isBlocked ? ' dep-var-chip-blocked' : '') + '"' + tip + chipClick + '>'
            + '<div class="dep-chip-header">'
            + '<span class="dep-var-name" style="color:' + nc.text + '">' + varName + '</span>'
            + '<span class="dep-var-type" style="color:' + lc2 + '">' + lbl + (isBlocked ? ' ⓘ' : '') + '</span>'
            + '</div>'
            + codeHtml
            + '</div>';
        }).join('');

    return `
      <div class="dep-row">
        <div class="dep-loop-cell"${loopClickAttr} style="border-color:${lc.border};background:${lc.bg};${loopLineNum ? 'cursor:pointer;' : ''}">
          <div class="dep-loop-name">${loop.label}</div>
          ${badge}
          ${loopLineNum ? `<div style="font-size:0.68rem;color:var(--muted);margin-top:4px">Click to jump to source</div>` : ''}
        </div>
        <div class="dep-arrow">&#8594;</div>
        <div class="dep-vars-cell">${depCells}</div>
      </div>`;
  }).join('');

  // Legend
  const legend = `
    <div class="dep-legend">
      <span class="dep-legend-item"><span class="dep-dot" style="background:#4caf50"></span>Parallelizable</span>
      <span class="dep-legend-item"><span class="dep-dot" style="background:#ff5c5c"></span>RAW / WAW</span>
      <span class="dep-legend-item"><span class="dep-dot" style="background:#ffc107"></span>WAR</span>
      <span class="dep-legend-item"><span class="dep-dot" style="background:#00d4aa"></span>Reduction</span>
    </div>`;

  container.innerHTML = `${legend}<div class="dep-table">${rows}</div>`;
}

// ── Source Line Highlighter ───────────────────────────────────────────────────

function highlightSourceLine(lineNum) {
  if (!lineNum || lineNum <= 0) return;

  const codeInput = document.getElementById('code-input');
  if (!codeInput) return;

  const lines = codeInput.value.split('\n');
  if (lineNum > lines.length) return;

  // Make sure the textarea is visible
  const zone = document.getElementById('drop-zone');
  if (zone) zone.style.display = 'none';
  codeInput.style.display = 'block';

  // Calculate character offset to the target line
  let charOffset = 0;
  for (let i = 0; i < lineNum - 1; i++) {
    charOffset += lines[i].length + 1;
  }
  const lineLen = lines[lineNum - 1].length;

  // Select the line in the textarea
  codeInput.focus();
  codeInput.setSelectionRange(charOffset, charOffset + lineLen);

  // Scroll textarea to show the line
  const lineHeight = 22;
  codeInput.scrollTop = Math.max(0, (lineNum - 4) * lineHeight);

  // Show a toast notification
  const existing = document.getElementById('src-line-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'src-line-toast';
  toast.style.cssText = `
    position:fixed;bottom:24px;right:24px;
    background:var(--accent);color:#fff;
    padding:8px 16px;border-radius:8px;
    font-size:0.82rem;font-weight:700;
    z-index:9999;pointer-events:none;
    box-shadow:0 4px 16px rgba(0,0,0,0.4);
    animation:fadeIn 0.2s ease;
  `;
  toast.textContent = '→ Line ' + lineNum + ' highlighted in source';
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 2500);
}

// ── Explanation ───────────────────────────────────────────────────────────────

// Shared dep reason popup for the dependency graph tab
function showDepGraphReason(depType, varName) {
  const DEP_REASONS = {
    'RAW': { color: '#ff5c5c', title: 'RAW — Read After Write', why: `Iteration <strong>i</strong> reads a value written by iteration <strong>i−1</strong>. Each iteration must wait for the previous one to finish — cannot run in parallel.`, fix: 'Use prefix-sum: <code>std::partial_sum()</code> (C++), <code>Arrays.parallelPrefix()</code> (Java), <code>itertools.accumulate()</code> (Python).' },
    'WAW': { color: '#ff8a8a', title: 'WAW — Write After Write', why: 'Multiple iterations write to the <strong>same scalar variable</strong>. In parallel, the final value depends on which thread finishes last — race condition.', fix: 'Replace scalar with indexed array: <code>x[i] = ...</code> instead of <code>x = ...</code>' },
    'WAR': { color: '#ffc107', title: 'WAR — Write After Read', why: 'Iteration <strong>i</strong> writes a value that iteration <strong>i−1</strong> still needs to read. Reordering iterations would corrupt the result.', fix: 'Use private copies or restructure the loop to eliminate the cross-iteration dependency.' },
  };
  const r = DEP_REASONS[depType] || DEP_REASONS['RAW'];
  const existing = document.getElementById('dep-graph-reason-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'dep-graph-reason-popup';
  popup.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--surface2);border:1.5px solid ${r.color};border-radius:10px;
    padding:20px 24px;max-width:420px;width:90%;z-index:9999;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);animation:fadeIn 0.15s ease;
  `;
  popup.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <strong style="color:${r.color};font-size:0.95rem">${r.title}</strong>
      <button onclick="document.getElementById('dep-graph-reason-popup').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem">✕</button>
    </div>
    ${varName ? `<div style="font-size:0.8rem;color:var(--muted);margin-bottom:10px">Variable: <code style="color:${r.color}">${varName}</code></div>` : ''}
    <div style="font-size:0.83rem;color:var(--text);line-height:1.7;margin-bottom:10px">${r.why}</div>
    <div style="font-size:0.8rem;color:var(--muted);padding:8px 10px;background:var(--bg);border-radius:6px;border-left:3px solid ${r.color}">${r.fix}</div>
  `;
  document.body.appendChild(popup);
  document.addEventListener('click', function dismiss(e) {
    if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); }
  }, { once: true });
}

function renderExplanation(explanations) {
  const container = document.getElementById('explanation-container');
  container.innerHTML = '';
  if (!explanations || explanations.length === 0) {
    container.innerHTML = '<p style="color:var(--muted)">No explanation available.</p>';
    return;
  }

  explanations.forEach(exp => {
    const card = document.createElement('div');
    card.className = 'explain-card';

    const depsHtml = (exp.dependencies || []).map(d => {
      const cls = d.type.includes('REDUCTION') ? 'reduction' : d.type.includes('RAW') ? 'raw' : '';
      return `<span class="dep-tag ${cls}" title="${d.description}">${d.variable}: ${d.type}</span>`;
    }).join('');

    const statusColor = exp.color === 'green' ? 'var(--green)'
                      : exp.color === 'red'   ? 'var(--red)'
                      : 'var(--accent)';

    const statusDot = exp.color === 'green' ? 'status-dot green'
                    : exp.color === 'red'   ? 'status-dot red'
                    : 'status-dot blue';

    card.innerHTML = `
      <div class="status" style="color:${statusColor}">
        <span class="${statusDot}"></span>${exp.status}
      </div>
      <h3>Loop at line ${exp.loop_line}</h3>
      <div class="reason">${exp.reason}</div>
      ${depsHtml ? `<div style="margin:8px 0">${depsHtml}</div>` : ''}
      <div class="advice">${exp.advice}</div>
    `;
    container.appendChild(card);
  });
}

function renderPerformance(metrics) {
  const container = document.getElementById('perf-container');
  if (!metrics) { container.innerHTML = '<p style="color:var(--muted)">No metrics.</p>'; return; }

  const p = (metrics.parallelizable_fraction || 0) / 100;
  const amdahlFn    = (n) => p > 0 ? Math.round((1.0 / ((1 - p) + p / n)) * 100) / 100 : 1.0;
  const gustafsonFn = (n) => Math.round((n - (1 - p) * (n - 1)) * 100) / 100;
  const speedupFn   = selectedLaw === 'gustafson' ? gustafsonFn : amdahlFn;
  const lawLabel    = selectedLaw === 'gustafson' ? "Gustafson's Law" : "Amdahl's Law";
  const lawFormula  = selectedLaw === 'gustafson' ? 'S(n) = n − (1−p)×(n−1)' : 'S(n) = 1 / ((1−p) + p/n)';
  const lawColor    = selectedLaw === 'gustafson' ? '#00d4aa' : 'var(--accent)';

  const selSpeedup = speedupFn(selectedCores);
  const selParMs   = metrics.sequential_time_ms > 0
    ? Math.round((metrics.sequential_time_ms / selSpeedup) * 100) / 100 : 0;
  const selEff     = Math.round((selSpeedup / selectedCores) * 100);

  const maxTime = Math.max(metrics.sequential_time_ms, selParMs, 1);
  const seqPct  = Math.min((metrics.sequential_time_ms / maxTime * 100), 100).toFixed(1);
  const parPct  = Math.min((selParMs / maxTime * 100), 100).toFixed(1);

  const allCores   = [2, 4, 8, 16, 32];
  const maxSpeedup = Math.max(...allCores.map(n => speedupFn(n)), 1);

  const coreBars = allCores.map(n => {
    const sp  = speedupFn(n);
    const pct = ((sp / maxSpeedup) * 100).toFixed(1);
    const isSel = n === selectedCores;
    const estMs = metrics.sequential_time_ms > 0
      ? Math.round(metrics.sequential_time_ms / sp * 10) / 10 : 0;
    const eff = Math.round(sp / n * 100);
    return `
      <div class="core-bar-row${isSel ? ' core-bar-selected' : ''}">
        <div class="core-bar-meta">
          <span class="core-bar-cores">${n} Cores</span>
          <span class="core-bar-speedup" style="color:${lawColor}">${sp}x</span>
          <span class="core-bar-detail">~${estMs} ms &nbsp; ${eff}% eff</span>
          ${isSel ? '<span class="core-bar-tag">selected</span>' : ''}
        </div>
        <div class="perf-bar-bg">
          <div class="perf-bar par" style="width:${pct}%;background:${isSel ? lawColor : lawColor + '66'}"></div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="perf-grid">
      <div class="perf-card">
        <div class="value" style="color:${lawColor}">${selSpeedup}x</div>
        <div class="label">Speedup</div>
      </div>
      <div class="perf-card">
        <div class="value">${selectedCores}</div>
        <div class="label">Selected Cores</div>
      </div>
      <div class="perf-card">
        <div class="value">${selEff}%</div>
        <div class="label">Efficiency</div>
      </div>
      <div class="perf-card">
        <div class="value">${metrics.parallelizable_fraction}%</div>
        <div class="label">Parallelizable</div>
      </div>
    </div>

    <div class="perf-section-label">Time Comparison</div>
    <div class="perf-bar-wrap">
      <div class="perf-bar-label">Sequential &nbsp;<strong>${metrics.sequential_time_ms} ms</strong></div>
      <div class="perf-bar-bg"><div class="perf-bar seq" style="width:${seqPct}%"></div></div>
    </div>
    <div class="perf-bar-wrap" style="margin-top:8px">
      <div class="perf-bar-label" style="color:${lawColor}">
        Parallel (${selectedCores} cores) &nbsp;<strong>${selParMs} ms</strong>
      </div>
      <div class="perf-bar-bg"><div class="perf-bar par" style="width:${parPct}%;background:${lawColor}"></div></div>
    </div>

    <div class="perf-section-label" style="margin-top:18px">
      ${lawLabel} — All Core Counts
      <span style="font-weight:400;color:var(--muted)">(p = ${metrics.parallelizable_fraction}% parallelizable)</span>
    </div>
    <div class="core-bars">${coreBars}</div>

    <div class="perf-footer">
      <span>Loops: <strong style="color:${lawColor}">${metrics.parallel_loops}</strong> / ${metrics.total_loops} parallelizable</span>
      <span style="color:var(--border)">|</span>
      <span style="color:${lawColor}">${lawFormula}</span>
      <span style="color:var(--border)">|</span>
      <span>Actual: ${metrics.sequential_time_ms}ms seq / ${metrics.parallel_time_ms}ms par</span>
    </div>
  `;

  // Separate Amdahl / Gustafson charts below
  const lawData = metrics.performance_law_data;
  if (lawData && lawData.cores) {
    _renderSpeedupChart(container, lawData);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function renderValidation(validation) {
  const container = document.getElementById('validation-container');
  if (!validation) {
    container.innerHTML = '<p style="color:var(--muted)">No validation data.</p>';
    return;
  }

  const statusColor = validation.status === 'SAFE'   ? 'var(--green)'
                    : validation.status === 'UNSAFE' ? 'var(--red)'
                    : 'var(--muted)';

  const loopCards = (validation.loops || []).map(loop => {
    const lc = loop.status === 'SAFE'    ? 'var(--green)'
             : loop.status === 'MISMATCH'? 'var(--red)'
             : loop.status === 'SKIPPED' ? 'var(--muted)'
             : 'var(--yellow)';
    return `
      <div class="explain-card" style="margin-bottom:10px">
        <div class="status" style="color:${lc}">
          <span class="status-dot" style="background:${lc};box-shadow:0 0 6px ${lc}"></span>
          ${loop.status} — Loop at line ${loop.loop_line}
        </div>
        <div class="reason" style="margin-top:6px">${loop.details}</div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="explain-card" style="border-color:${statusColor};margin-bottom:16px">
      <div class="status" style="color:${statusColor};font-size:1.1rem">
        <span class="status-dot" style="background:${statusColor};box-shadow:0 0 8px ${statusColor}"></span>
        Overall: ${validation.status}
      </div>
      <div class="reason" style="margin-top:8px">${validation.summary}</div>
    </div>
    ${loopCards}
    <div style="font-size:0.75rem;color:var(--muted);margin-top:8px">
      Validation simulates sequential and parallel execution on N=8 iterations and compares outputs.
    </div>
  `;
}

// ── Suggestions ───────────────────────────────────────────────────────────────

function renderSuggestions(suggestions) {
  const container = document.getElementById('suggestion-container');
  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = '<p style="color:var(--muted)">No suggestions available.</p>';
    return;
  }

  const cards = suggestions.map(s => {
    const borderColor = s.type === 'WARNING' ? 'var(--red)' : 'var(--green)';
    const dotColor    = s.type === 'WARNING' ? 'var(--red)' : 'var(--green)';

    const tipsHtml = (s.tips || []).map(tip => `
      <div style="margin-top:10px;padding:10px 12px;background:var(--surface2);border-radius:6px">
        <div style="font-size:0.82rem;font-weight:600;color:var(--yellow);margin-bottom:4px">${tip.issue}</div>
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:6px">${tip.suggestion}</div>
        ${tip.example ? `<pre style="font-size:0.78rem;background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;white-space:pre-wrap">${tip.example}</pre>` : ''}
      </div>`).join('');

    const hintHtml = s.code_hint ? `
      <div style="margin-top:10px">
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px">Parallel annotation:</div>
        <pre style="font-size:0.8rem;background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;color:var(--accent2)">${s.code_hint}</pre>
      </div>` : '';

    return `
      <div class="explain-card" style="border-left-color:${borderColor};margin-bottom:12px">
        <div class="status" style="color:${dotColor}">
          <span class="status-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}"></span>
          ${s.title}
        </div>
        <div class="reason" style="margin-top:6px">${s.detail}</div>
        ${tipsHtml}
        ${hintHtml}
      </div>`;
  }).join('');

  container.innerHTML = cards;
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(`${API}/history`);
    const data = await res.json();
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = '';
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center">No history yet.</td></tr>';
      return;
    }
    data.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.program_id}</td>
        <td>${(row.language || '').toUpperCase()}</td>
        <td>${(row.created_at || '').slice(0, 19).replace('T', ' ')}</td>
        <td>${row.speedup ? row.speedup + 'x' : '-'}</td>
        <td>${row.sequential_time ? row.sequential_time.toFixed(1) : '-'}</td>
        <td>${row.parallel_time  ? row.parallel_time.toFixed(1)  : '-'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

  const btnEl = document.getElementById('tab-btn-' + name);
  if (btnEl) btnEl.classList.add('active');

  const contentEl = document.getElementById('tab-' + name);
  if (contentEl) contentEl.classList.add('active');
}

function showView(name) {
  document.getElementById('view-main').classList.toggle('hidden', name !== 'main');
  document.getElementById('view-history').classList.toggle('hidden', name !== 'history');
  if (name === 'history') loadHistory();
}

function setLoading(on) {
  document.getElementById('loading').classList.toggle('hidden', !on);
}

function copyCode() {
  if (!lastResult) return;
  navigator.clipboard.writeText(lastResult.parallel_code).then(() => {
    const btn = document.querySelector('.tab-toolbar button');
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function downloadCode() {
  if (!lastResult) return;
  const langExt = { python: 'py', c: 'c', cpp: 'cpp', java: 'java' };
  const ext = langExt[lastResult.language] || 'txt';
  const base = uploadedFileName
    ? uploadedFileName.replace(/\.[^.]+$/, '') + '_parallel'
    : 'parallel_output';
  const blob = new Blob([lastResult.parallel_code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── AST Download ──────────────────────────────────────────────────────────────

function downloadASTPNG() {
  const container = document.getElementById('ast-container');
  const svg = container && container.querySelector('svg');
  if (!svg) { alert('No AST to download. Please analyze some code first.'); return; }

  const w = parseFloat(svg.getAttribute('width'))  || 800;
  const h = parseFloat(svg.getAttribute('height')) || 600;

  // Clone SVG and embed all styles inline so it renders correctly
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Set explicit background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', '#1a1d27');
  clone.insertBefore(bg, clone.firstChild);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const svgB64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));

  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width  = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1d27';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  img.onload = () => {
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const base = uploadedFileName ? uploadedFileName.replace(/\.[^.]+$/, '') : 'code';
    canvas.toBlob(blob => {
      if (!blob) { downloadASTSVG(); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + '_ast.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  };
  img.onerror = () => downloadASTSVG();
  img.src = svgB64;
}

function downloadASTSVG() {
  const container = document.getElementById('ast-container');
  const svg = container && container.querySelector('svg');
  if (!svg) { alert('No AST to download.'); return; }

  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const w = svg.getAttribute('width') || 800;
  const h = svg.getAttribute('height') || 600;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', '#1a1d27');
  clone.insertBefore(bg, clone.firstChild);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const base = uploadedFileName ? uploadedFileName.replace(/\.[^.]+$/, '') : 'code';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '_ast.svg';
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadASTText() {
  if (!lastResult) { alert('No AST to download. Please analyze some code first.'); return; }
  const text = lastResult.ast_text || 'AST not available.';
  const blob = new Blob([text], { type: 'text/plain' });
  const base = uploadedFileName ? uploadedFileName.replace(/\.[^.]+$/, '') : 'code';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '_ast.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  initDropZone();

  // ── Always show textarea with example on load ──────────────────
  const textarea = document.getElementById('code-input');
  const zone     = document.getElementById('drop-zone');

  function showTextarea() {
    zone.style.display     = 'none';
    textarea.style.display = 'block';
  }

  // Load example from Examples page if passed via sessionStorage
  const storedCode = sessionStorage.getItem('ap_example_code');
  const storedLang = sessionStorage.getItem('ap_example_lang');
  if (storedCode) {
    textarea.value = storedCode;
    if (storedLang) document.getElementById('lang-select').value = storedLang;
    sessionStorage.removeItem('ap_example_code');
    sessionStorage.removeItem('ap_example_lang');
    showTextarea();
  } else {
    // Load default Python example
    textarea.value = EXAMPLES['python'];
    document.getElementById('lang-select').value = 'python';
    showTextarea();
  }

  // Handle ?view=history from examples page
  if (window.location.search.includes('view=history')) {
    showView('history');
  }

  // ── Input listeners ────────────────────────────────────────────
  textarea.addEventListener('input', () => {
    const code = textarea.value.trim();
    if (code) {
      showTextarea();
    } else {
      zone.style.display     = 'flex';
      textarea.style.display = 'none';
      document.getElementById('file-name-badge').classList.add('hidden');
      uploadedFileName = null;
      showValidationError(null);
    }
    if (code) {
      const lang = document.getElementById('lang-select').value;
      if (lang) showValidationError(validateCodeLanguage(code, lang));
    }
  });

  textarea.addEventListener('paste', () => {
    setTimeout(() => {
      const code = textarea.value.trim();
      const lang = document.getElementById('lang-select').value;
      if (code) {
        showTextarea();
        if (lang) showValidationError(validateCodeLanguage(code, lang));
      }
    }, 50);
  });
});

// ── Feature 5: Amdahl Chart (separate) ───────────────────────────────────────
function _renderSpeedupChart(container, lawData) {
  if (!lawData || !lawData.cores || !lawData.amdahl || !lawData.gustafson) return;
  if (typeof d3 === 'undefined') return;

  const existing = container.querySelector('.speedup-chart-wrap');
  if (existing) existing.remove();

  // ── Chart 1: Amdahl's Law ────────────────────────────────────────────────
  const wrap1 = document.createElement('div');
  wrap1.className = 'speedup-chart-wrap';
  wrap1.style.cssText = 'margin-top:20px;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;';
  container.appendChild(wrap1);

  const t1 = document.createElement('div');
  t1.style.cssText = 'font-size:0.85rem;font-weight:700;color:#ff7043;margin-bottom:10px;';
  t1.textContent = "Amdahl's Law — Fixed Problem Size";
  wrap1.appendChild(t1);
  const s1 = document.createElement('div');
  s1.style.cssText = 'font-size:0.75rem;color:var(--muted);margin-bottom:10px;';
  s1.textContent = 'S(n) = 1 / ((1−p) + p/n)  — speedup is bounded by the sequential fraction';
  wrap1.appendChild(s1);
  _drawSingleChart(wrap1, lawData.cores, lawData.amdahl, '#ff7043', 'Speedup');

  // ── Chart 2: Gustafson's Law ─────────────────────────────────────────────
  const wrap2 = document.createElement('div');
  wrap2.className = 'speedup-chart-wrap';
  wrap2.style.cssText = 'margin-top:0;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;';
  container.appendChild(wrap2);

  const t2 = document.createElement('div');
  t2.style.cssText = 'font-size:0.85rem;font-weight:700;color:#00d4aa;margin-bottom:10px;';
  t2.textContent = "Gustafson's Law — Scaled Problem Size";
  wrap2.appendChild(t2);
  const s2 = document.createElement('div');
  s2.style.cssText = 'font-size:0.75rem;color:var(--muted);margin-bottom:10px;';
  s2.textContent = 'S(n) = n − (1−p)×(n−1)  — speedup scales linearly with cores for large problems';
  wrap2.appendChild(s2);
  _drawSingleChart(wrap2, lawData.cores, lawData.gustafson, '#00d4aa', 'Speedup');

  if (lawData.crossover_n != null) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:0.75rem;color:#ffc107;margin-top:8px;padding:6px 10px;background:rgba(255,193,7,0.08);border-radius:4px;border-left:3px solid #ffc107;';
    note.textContent = `⚡ Crossover point: parallel execution becomes faster when n > ${lawData.crossover_n} iterations`;
    container.appendChild(note);
  }
}

function _drawSingleChart(wrap, cores, vals, color, yLabel) {
  const W = 480, H = 200, ML = 48, MR = 20, MT = 10, MB = 36;
  const iW = W - ML - MR, iH = H - MT - MB;
  const maxY = Math.max(...vals, 2);

  const xScale = (i) => ML + (i / (cores.length - 1)) * iW;
  const yScale = (v) => MT + iH - (v / maxY) * iH;

  const svg = d3.select(wrap).append('svg')
    .attr('width', W).attr('height', H)
    .style('overflow', 'visible');

  // Grid lines + Y labels
  const yTicks = [1, Math.round(maxY * 0.33), Math.round(maxY * 0.66), Math.round(maxY)];
  yTicks.forEach(v => {
    svg.append('line')
      .attr('x1', ML).attr('x2', ML + iW)
      .attr('y1', yScale(v)).attr('y2', yScale(v))
      .attr('stroke', 'rgba(46,50,80,0.7)').attr('stroke-width', 1);
    svg.append('text')
      .attr('x', ML - 6).attr('y', yScale(v) + 4)
      .attr('text-anchor', 'end').attr('font-size', '9px').attr('fill', '#78909c')
      .text(v + 'x');
  });

  // X axis labels
  cores.forEach((c, i) => {
    svg.append('text')
      .attr('x', xScale(i)).attr('y', MT + iH + 18)
      .attr('text-anchor', 'middle').attr('font-size', '9px').attr('fill', '#78909c')
      .text(c);
  });
  svg.append('text')
    .attr('x', ML + iW / 2).attr('y', H - 2)
    .attr('text-anchor', 'middle').attr('font-size', '9px').attr('fill', '#78909c')
    .text('Cores');

  // Area fill under line
  const area = d3.area()
    .x((d, i) => xScale(i))
    .y0(MT + iH)
    .y1(d => yScale(d));
  svg.append('path')
    .datum(vals)
    .attr('fill', color + '18')
    .attr('d', area);

  // Line
  const line = d3.line().x((d, i) => xScale(i)).y(d => yScale(d));
  svg.append('path')
    .datum(vals)
    .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2.5)
    .attr('d', line);

  // Dots with value labels
  vals.forEach((v, i) => {
    svg.append('circle').attr('cx', xScale(i)).attr('cy', yScale(v)).attr('r', 4)
      .attr('fill', color).attr('stroke', 'var(--surface)').attr('stroke-width', 1.5);
    if (i > 0) {
      svg.append('text')
        .attr('x', xScale(i)).attr('y', yScale(v) - 8)
        .attr('text-anchor', 'middle').attr('font-size', '8px').attr('fill', color)
        .text(v + 'x');
    }
  });
}

// ── Feature 3+6: Transform Tab ───────────────────────────────────────────────
function renderTransformTab(transformations, loopAnalysis) {
  const container = document.getElementById('transform-container');
  if (!container) return;
  container.innerHTML = '';

  if ((!transformations || transformations.length === 0) && (!loopAnalysis || loopAnalysis.length === 0)) {
    container.innerHTML = '<p style="color:var(--muted);padding:16px">No transformation data available.</p>';
    return;
  }

  // Build a map from loop_id to loop analysis data
  const analysisMap = {};
  (loopAnalysis || []).forEach(la => { analysisMap[la.loop_id] = la; });

  (transformations || []).forEach(t => {
    const la = analysisMap[t.loop_id] || {};
    const card = document.createElement('div');
    card.className = 'transform-card';

    // Header
    const statusColor = t.needed ? '#ff5c5c' : '#4caf50';
    const statusText  = t.needed ? 'Blocked — Transformation Available' : 'Parallelizable';
    let headerHtml = '<div class="transform-card-header">'
      + '<span class="transform-card-title">Loop at line ' + t.loop_line + '</span>'
      + '<span style="font-size:0.75rem;color:' + statusColor + ';font-weight:700">' + statusText + '</span>'
      + '</div>';

    // Bernstein conditions
    let bernsteinHtml = '';
    if (la.bernstein) {
      const b = la.bernstein;
      const rows = [
        { label: 'C1: W(i) ∩ R(i+1) = ∅ (no RAW)', ok: b.c1_ok, violation: b.c1_violation },
        { label: 'C2: R(i) ∩ W(i+1) = ∅ (no WAR)', ok: b.c2_ok, violation: b.c2_violation },
        { label: 'C3: W(i) ∩ W(i+1) = ∅ (no WAW)', ok: b.c3_ok, violation: b.c3_violation },
      ];
      const rowsHtml = rows.map(r =>
        '<div class="bernstein-row">'
        + '<span class="bernstein-check">' + (r.ok ? '✔' : '✗') + '</span>'
        + '<span class="bernstein-label" style="color:' + (r.ok ? '#4caf50' : '#ff5c5c') + '">' + r.label + '</span>'
        + (r.violation ? '<span class="bernstein-violation">var: ' + r.violation + '</span>' : '')
        + '</div>'
      ).join('');
      bernsteinHtml = '<div class="bernstein-card">'
        + '<div class="bernstein-title">Bernstein\'s Conditions</div>'
        + rowsHtml
        + '<div style="margin-top:8px;font-size:0.78rem;color:' + (b.all_ok ? '#4caf50' : '#ff5c5c') + '">' + b.summary + '</div>'
        + '</div>';
    }

    // Induction variables
    let inductionHtml = '';
    if (la.induction_vars && la.induction_vars.length > 0) {
      const badges = la.induction_vars.map(iv =>
        '<span class="induction-badge" title="step: ' + iv.step + ', type: ' + iv.type + '">'
        + iv.variable + ' (step ' + iv.step + ')</span>'
      ).join('');
      inductionHtml = '<div style="padding:10px 16px;border-top:1px solid var(--border)">'
        + '<span style="font-size:0.78rem;color:var(--muted);margin-right:8px">Induction vars:</span>'
        + badges + '</div>';
    }

    // Dependency distance badges
    let distanceHtml = '';
    if (la.dep_distances && la.dep_distances.length > 0) {
      const dbadges = la.dep_distances.map(dd => {
        const cls = dd.distance === 1 ? 'd1' : dd.distance === 2 ? 'd2' : 'd3p';
        const wf = dd.wavefront_possible ? ' ⟳' : '';
        return '<span class="distance-badge ' + cls + '" title="' + dd.variable + '">'
          + dd.variable + ' d=' + dd.distance + wf + '</span>';
      }).join('');
      distanceHtml = '<div style="padding:6px 16px;border-top:1px solid var(--border)">'
        + '<span style="font-size:0.78rem;color:var(--muted);margin-right:8px">Dep distances:</span>'
        + dbadges + '</div>';
    }

    // Before/after panels (only for blocked loops)
    let panelsHtml = '';
    if (t.needed && t.before && t.after) {
      panelsHtml = '<div class="transform-panels">'
        + '<div class="transform-panel before">'
        + '<div class="transform-panel-label">Before (Sequential)</div>'
        + '<pre class="transform-code">' + _escHtml(t.before) + '</pre>'
        + '</div>'
        + '<div class="transform-panel after">'
        + '<div class="transform-panel-label">After (Transformed)</div>'
        + '<pre class="transform-code">' + _escHtml(t.after) + '</pre>'
        + '</div>'
        + '</div>';
      if (t.explanation) {
        panelsHtml += '<div class="transform-explanation">' + _escHtml(t.explanation) + '</div>';
      }
    }

    card.innerHTML = headerHtml + bernsteinHtml + inductionHtml + distanceHtml + panelsHtml;
    container.appendChild(card);
  });
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ── Feature 4: Live Diff View ─────────────────────────────────────────────────
function renderDiffView(originalCode, parallelCode) {
  const container = document.getElementById('diff-container');
  if (!container) return;
  container.innerHTML = '';

  const origLines = (originalCode || '').split('\n');
  const parLines  = (parallelCode  || '').split('\n');

  // Simple diff: classify each parallel line
  const origSet = new Set(origLines.map(l => l.trim()));

  function classifyLine(line) {
    const t = line.trim();
    if (!t) return 'unchanged';
    if (t.startsWith('#pragma omp') || t.startsWith('import java.util.concurrent')
        || t.startsWith('from multiprocessing') || t.startsWith('import multiprocessing')
        || t.includes('parallel for') || t.includes('parallelStream')
        || t.includes('IntStream.range') || t.includes('Arrays.parallelPrefix')) {
      return 'added';
    }
    if (!origSet.has(t)) return 'added';
    return 'unchanged';
  }

  const leftPanel = document.createElement('div');
  leftPanel.className = 'diff-panel';
  leftPanel.innerHTML = '<div class="diff-panel-header">Original (Sequential)</div>';
  origLines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'diff-line';
    row.innerHTML = '<span class="diff-line-num">' + (i + 1) + '</span>'
      + '<span class="diff-line-content">' + _escHtml(line) + '</span>';
    leftPanel.appendChild(row);
  });

  const rightPanel = document.createElement('div');
  rightPanel.className = 'diff-panel';
  rightPanel.innerHTML = '<div class="diff-panel-header">Parallel (Generated)</div>';
  parLines.forEach((line, i) => {
    const cls = classifyLine(line);
    const row = document.createElement('div');
    row.className = 'diff-line ' + cls;
    const prefix = cls === 'added' ? '+ ' : cls === 'modified' ? '~ ' : '  ';
    row.innerHTML = '<span class="diff-line-num">' + (i + 1) + '</span>'
      + '<span class="diff-line-content">' + prefix + _escHtml(line) + '</span>';
    rightPanel.appendChild(row);
  });

  container.appendChild(leftPanel);
  container.appendChild(rightPanel);
}

// ── Feature 10: PDF Export ────────────────────────────────────────────────────
function exportPDF() {
  if (!lastResult) {
    alert('Please analyze some code first.');
    return;
  }

  const printWin = window.open('', '_blank', 'width=1000,height=800');
  if (!printWin) { alert('Please allow popups for PDF export.'); return; }

  const lang        = (lastResult.language || '').toUpperCase();
  const totalLoops  = lastResult.total_loops || 0;
  const parLoops    = lastResult.parallel_loops || 0;
  const pct         = totalLoops > 0 ? Math.round(parLoops / totalLoops * 100) : 0;
  const pctColor    = pct === 100 ? '#2e7d32' : pct >= 50 ? '#1565c0' : '#b71c1c';
  const now         = new Date().toLocaleString();
  const metrics     = lastResult.metrics || {};
  const lawData     = lastResult.performance_law_data || {};
  const loopAnalysis = lastResult.loop_analysis || [];
  const transforms  = lastResult.transformations || [];
  const explanations = lastResult.explanations || [];
  const suggestions  = lastResult.suggestions || [];

  // ── Section helpers ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── 1. Original source code ───────────────────────────────────────────────
  const origCode = esc(document.getElementById('code-input').value || '');

  // ── 1b. AST text tree + visual HTML tree ─────────────────────────────────
  const astText = esc(lastResult.ast_text || 'AST not available.');

  // Build a visual HTML tree from ast_graph for the report
  function buildHtmlAstTree(astGraph) {
    if (!astGraph || !astGraph.nodes || astGraph.nodes.length === 0) return '<p style="color:#888">No AST data.</p>';
    const nodeMap = {};
    astGraph.nodes.forEach(n => { nodeMap[n.id] = { ...n, children: [] }; });
    const childSet = new Set();
    astGraph.edges.forEach(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      if (nodeMap[src] && nodeMap[tgt]) {
        nodeMap[src].children.push(nodeMap[tgt]);
        childSet.add(String(tgt));
      }
    });
    const rootData = astGraph.nodes.find(n => !childSet.has(String(n.id)));
    if (!rootData) return '<p style="color:#888">Could not build tree.</p>';

    const COLOR_MAP = {
      parallel:  { border: '#2e7d32', bg: '#e8f5e9', text: '#1b5e20' },
      dependent: { border: '#b71c1c', bg: '#fff3f3', text: '#b71c1c' },
      loop:      { border: '#e65100', bg: '#fff8e1', text: '#e65100' },
      root:      { border: '#4527a0', bg: '#ede7f6', text: '#4527a0' },
      FuncDecl:  { border: '#0277bd', bg: '#e1f5fe', text: '#0277bd' },
      IfStmt:    { border: '#6a1b9a', bg: '#f3e5f5', text: '#6a1b9a' },
      LoopBody:  { border: '#37474f', bg: '#eceff1', text: '#37474f' },
      VarDecl:   { border: '#00695c', bg: '#e0f2f1', text: '#00695c' },
      default:   { border: '#546e7a', bg: '#f5f5f5', text: '#546e7a' },
    };

    const ICONS = {
      parallel: '✓', dependent: '✗', loop: '⟳', root: '◈',
      FuncDecl: 'ƒ', IfStmt: '?', VarDecl: 'v', Return: '↩',
      LoopBody: '{}', LoopInit: '=', LoopCond: '<', LoopUpdate: '++',
      LoopIter: '∈', LoopVar: 'x', FuncCall: '()', AugAssign: '±'
    };

    function renderNode(node, depth) {
      const c = COLOR_MAP[node.color] || COLOR_MAP[node.type] || COLOR_MAP.default;
      const icon = ICONS[node.color] || ICONS[node.type] || '·';
      const label = (node.label || node.type || '').slice(0, 36);
      const lineTag = node.line > 0 ? `<span style="font-size:7.5pt;color:#999;margin-left:6px">L${node.line}</span>` : '';
      const depTag = node.color === 'dependent'
        ? `<span style="font-size:7pt;font-weight:700;color:#b71c1c;background:#ffcdd2;padding:1px 5px;border-radius:8px;margin-left:4px">${(node.dep_type||'DEP').split('(')[0].trim()}</span>` : '';
      const typeTag = `<span style="font-size:7pt;color:${c.border};opacity:0.8;margin-right:4px">${node.type||''}</span>`;

      const nodeHtml = `<div style="
        display:inline-flex;align-items:center;gap:4px;
        background:${c.bg};border:1px solid ${c.border};border-radius:5px;
        padding:3px 8px;font-size:8.5pt;font-family:Consolas,monospace;
        color:${c.text};font-weight:${node.color==='parallel'||node.color==='dependent'?'700':'500'};
        max-width:340px;
      ">
        <span style="color:${c.border};font-size:9pt">${icon}</span>
        ${typeTag}<strong>${esc(label)}</strong>${lineTag}${depTag}
      </div>`;

      const kids = node.children || [];
      if (kids.length === 0) return `<li style="list-style:none;margin:2px 0">${nodeHtml}</li>`;

      const childrenHtml = kids.map(kid => renderNode(nodeMap[kid.id] || kid, depth + 1)).join('');
      return `<li style="list-style:none;margin:2px 0">
        ${nodeHtml}
        <ul style="margin:2px 0 2px 18px;padding:0;border-left:2px solid ${c.border}33">${childrenHtml}</ul>
      </li>`;
    }

    const root = nodeMap[rootData.id];
    return `<ul style="margin:0;padding:0;list-style:none">${renderNode(root, 0)}</ul>`;
  }

  const astHtmlTree = buildHtmlAstTree(lastResult.ast_graph);

  // ── 2. Parallel code ──────────────────────────────────────────────────────
  const parCode = esc(lastResult.parallel_code || '');

  // ── 3. Dependency analysis table ─────────────────────────────────────────
  const depGraph = lastResult.dep_graph || {};
  const loopNodes = (depGraph.nodes || []).filter(n => n.type === 'loop');
  const edgeMap = {};
  (depGraph.edges || []).forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    if (!edgeMap[src]) edgeMap[src] = [];
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    const tgtNode = (depGraph.nodes || []).find(n => n.id === tgt);
    if (tgtNode) edgeMap[src].push({ node: tgtNode, label: e.label });
  });

  const depRows = loopNodes.map(loop => {
    const deps = edgeMap[loop.id] || [];
    const statusColor = loop.parallelizable ? '#2e7d32' : '#b71c1c';
    const statusText  = loop.parallelizable ? '✓ Parallelizable' : '✗ Blocked';
    const depList = deps.map(({ node, label }) => {
      const codeLine = node.code_line ? ` — <code>${esc(node.code_line)}</code>` : '';
      return `<span style="color:${label==='RAW'?'#c62828':label==='WAW'?'#e65100':'#1565c0'}">${esc(node.variable)} [${esc(label)}]${codeLine}</span>`;
    }).join('<br>') || '<span style="color:#2e7d32">None</span>';
    return `<tr>
      <td style="font-weight:700">${esc(loop.label)}</td>
      <td style="color:${statusColor};font-weight:700">${statusText}</td>
      <td>${depList}</td>
    </tr>`;
  }).join('');

  // ── 4. Bernstein's conditions table ──────────────────────────────────────
  const bernRows = loopAnalysis.map(la => {
    const b = la.bernstein || {};
    const c1 = b.c1_ok ? '✔' : `✘ (${esc(b.c1_violation)})`;
    const c2 = b.c2_ok ? '✔' : `✘ (${esc(b.c2_violation)})`;
    const c3 = b.c3_ok ? '✔' : `✘ (${esc(b.c3_violation)})`;
    const overall = b.all_ok
      ? '<span style="color:#2e7d32;font-weight:700">All satisfied</span>'
      : '<span style="color:#b71c1c;font-weight:700">Violated</span>';
    const indVars = (la.induction_vars || []).map(iv =>
      `<code>${esc(iv.variable)}</code> (step ${iv.step})`
    ).join(', ') || '—';
    const distances = (la.dep_distances || []).filter(d => d.distance > 0).map(d =>
      `<code>${esc(d.variable)}</code>=<strong>${d.distance}</strong>${d.wavefront_possible ? ' ⟳' : ''}`
    ).join(', ') || '—';
    return `<tr>
      <td>Loop ${la.loop_id} (L${la.loop_line})</td>
      <td style="color:${b.c1_ok?'#2e7d32':'#b71c1c'}">${c1}</td>
      <td style="color:${b.c2_ok?'#2e7d32':'#b71c1c'}">${c2}</td>
      <td style="color:${b.c3_ok?'#2e7d32':'#b71c1c'}">${c3}</td>
      <td>${overall}</td>
      <td>${indVars}</td>
      <td>${distances}</td>
    </tr>`;
  }).join('');

  // ── 5. Loop transformations ───────────────────────────────────────────────
  const transformBlocks = transforms.filter(t => t.needed).map(t => `
    <div class="transform-block">
      <div class="transform-title">Loop ${t.loop_id} (Line ${t.loop_line}) — ${esc(t.dep_type)} on <code>${esc(t.variable)}</code></div>
      <div class="two-col">
        <div>
          <div class="col-label before">Before (Sequential)</div>
          <pre>${esc(t.before)}</pre>
        </div>
        <div>
          <div class="col-label after">After (Transformed)</div>
          <pre>${esc(t.after)}</pre>
        </div>
      </div>
      <div class="explanation">${esc(t.explanation)}</div>
    </div>`).join('') || '<p style="color:#666">No transformations needed — all loops are parallelizable.</p>';

  // ── 6. Performance metrics ────────────────────────────────────────────────
  const seqMs  = metrics.sequential_time_ms || 0;
  const parMs  = metrics.parallel_time_ms   || 0;
  const speedup = metrics.speedup || 1;
  const eff    = metrics.efficiency || 0;
  const p      = (metrics.parallelizable_fraction || 0);

  const coreRows = [2,4,8,16,32].map(n => {
    const amdahl = lawData.amdahl ? lawData.amdahl[[1,2,4,8,16,32].indexOf(n)] : '—';
    const gustafson = lawData.gustafson ? lawData.gustafson[[1,2,4,8,16,32].indexOf(n)] : '—';
    return `<tr>
      <td>${n} cores</td>
      <td>${typeof amdahl === 'number' ? amdahl.toFixed(2) + 'x' : amdahl}</td>
      <td>${typeof gustafson === 'number' ? gustafson.toFixed(2) + 'x' : gustafson}</td>
    </tr>`;
  }).join('');

  // ── 7. Explanations ───────────────────────────────────────────────────────
  const explBlocks = explanations.map(exp => `
    <div class="expl-card ${exp.color}">
      <div class="expl-status">${exp.status} — Loop at line ${exp.loop_line}</div>
      <div class="expl-reason">${esc(exp.reason)}</div>
      <div class="expl-advice">${esc(exp.advice)}</div>
    </div>`).join('');

  // ── 8. Suggestions ────────────────────────────────────────────────────────
  const suggBlocks = suggestions.map(s => `
    <div class="sugg-card ${s.type === 'WARNING' ? 'warn' : 'info'}">
      <div class="sugg-title">${esc(s.title)}</div>
      <div class="sugg-detail">${esc(s.detail)}</div>
      ${(s.tips||[]).map(tip => `<div class="sugg-tip"><strong>${esc(tip.issue)}</strong><br>${esc(tip.suggestion)}</div>`).join('')}
      ${s.code_hint ? `<pre class="hint">${esc(s.code_hint)}</pre>` : ''}
    </div>`).join('');

  // ── Build full HTML ───────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>AutoParallel Report — ${lang}</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; color: #1a1a2e; line-height: 1.5; }

  /* Cover strip */
  .cover { background: linear-gradient(135deg, #6c63ff 0%, #3f3d8f 100%); color: #fff; padding: 22px 24px 18px; border-radius: 6px; margin-bottom: 20px; }
  .cover h1 { font-size: 22pt; font-weight: 800; letter-spacing: -0.5px; }
  .cover .sub { font-size: 10pt; opacity: 0.85; margin-top: 4px; }
  .cover .meta-row { display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap; }
  .cover .meta-item { background: rgba(255,255,255,0.15); border-radius: 6px; padding: 6px 14px; font-size: 10pt; }
  .cover .meta-item strong { display: block; font-size: 14pt; font-weight: 800; }
  .pct-badge { display: inline-block; padding: 3px 14px; border-radius: 12px; font-weight: 800; font-size: 11pt; background: rgba(255,255,255,0.2); color: #fff; }

  /* Sections */
  h2 { font-size: 13pt; font-weight: 700; color: #3f3d8f; margin: 20px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #e8e8f0; }
  h3 { font-size: 11pt; font-weight: 700; color: #444; margin: 12px 0 5px; }

  /* Code blocks */
  pre { background: #f4f4f8; border: 1px solid #ddd; border-radius: 4px; padding: 10px 12px; font-family: 'Cascadia Code','Consolas',monospace; font-size: 8.5pt; white-space: pre-wrap; overflow-wrap: break-word; margin: 6px 0; }
  code { font-family: 'Cascadia Code','Consolas',monospace; font-size: 9pt; background: #f0f0f8; padding: 1px 4px; border-radius: 3px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0; }
  th { background: #f0f0f8; color: #3f3d8f; font-weight: 700; padding: 7px 10px; text-align: left; border: 1px solid #ddd; }
  td { padding: 6px 10px; border: 1px solid #ddd; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }

  /* Dep status */
  .ok   { color: #2e7d32; font-weight: 700; }
  .fail { color: #b71c1c; font-weight: 700; }

  /* Transform blocks */
  .transform-block { border: 1px solid #ddd; border-radius: 6px; margin: 10px 0; overflow: hidden; }
  .transform-title { background: #f0f0f8; padding: 8px 12px; font-weight: 700; font-size: 10pt; color: #3f3d8f; border-bottom: 1px solid #ddd; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .two-col > div { padding: 8px; border-right: 1px solid #ddd; }
  .two-col > div:last-child { border-right: none; }
  .col-label { font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .col-label.before { color: #b71c1c; }
  .col-label.after  { color: #2e7d32; }
  .explanation { padding: 8px 12px; font-size: 9pt; color: #555; background: #fffde7; border-top: 1px solid #ddd; }

  /* Explanation cards */
  .expl-card { border-left: 4px solid #ccc; padding: 8px 12px; margin: 8px 0; border-radius: 0 4px 4px 0; background: #fafafa; }
  .expl-card.green { border-color: #4caf50; background: #f1f8e9; }
  .expl-card.red   { border-color: #f44336; background: #fff3f3; }
  .expl-status { font-weight: 700; font-size: 10pt; margin-bottom: 4px; }
  .expl-card.green .expl-status { color: #2e7d32; }
  .expl-card.red   .expl-status { color: #b71c1c; }
  .expl-reason { font-size: 9.5pt; color: #444; margin-bottom: 4px; }
  .expl-advice { font-size: 9pt; color: #555; background: #fff; border-left: 3px solid #6c63ff; padding: 5px 8px; border-radius: 0 3px 3px 0; }

  /* Suggestion cards */
  .sugg-card { border: 1px solid #ddd; border-radius: 5px; padding: 8px 12px; margin: 8px 0; }
  .sugg-card.warn { border-color: #ffcdd2; background: #fff8f8; }
  .sugg-card.info { border-color: #c8e6c9; background: #f9fff9; }
  .sugg-title { font-weight: 700; font-size: 10pt; margin-bottom: 4px; }
  .sugg-card.warn .sugg-title { color: #b71c1c; }
  .sugg-card.info .sugg-title { color: #2e7d32; }
  .sugg-detail { font-size: 9pt; color: #555; margin-bottom: 4px; }
  .sugg-tip { font-size: 9pt; color: #444; margin: 4px 0; padding: 4px 8px; background: #f5f5f5; border-radius: 3px; }
  pre.hint { background: #e8f5e9; border-color: #a5d6a7; color: #1b5e20; }

  /* Performance */
  .perf-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 10px 0; }
  .perf-card { border: 1px solid #ddd; border-radius: 6px; padding: 10px; text-align: center; background: #fafafa; }
  .perf-card .val { font-size: 18pt; font-weight: 800; color: #6c63ff; }
  .perf-card .lbl { font-size: 8.5pt; color: #888; margin-top: 2px; }

  /* Footer */
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 8.5pt; color: #999; display: flex; justify-content: space-between; }

  @media print { button { display: none !important; } .no-print { display: none !important; } }
</style>
</head>
<body>

<!-- COVER -->
<div class="cover">
  <h1>AutoParallel Analysis Report</h1>
  <div class="sub">Source-to-Source Automatic Parallelization Compiler</div>
  <div class="meta-row">
    <div class="meta-item"><strong>${lang}</strong>Language</div>
    <div class="meta-item"><strong>${totalLoops}</strong>Total Loops</div>
    <div class="meta-item"><strong>${parLoops}</strong>Parallelized</div>
    <div class="meta-item"><strong><span class="pct-badge" style="background:${pctColor}">${pct}%</span></strong>Parallelizable</div>
    <div class="meta-item"><strong>${speedup}x</strong>Speedup</div>
    <div class="meta-item"><strong>${seqMs}ms</strong>Sequential</div>
    <div class="meta-item"><strong>${parMs}ms</strong>Parallel</div>
  </div>
  <div style="margin-top:10px;font-size:9pt;opacity:0.7">Generated: ${now}</div>
</div>

<!-- 1. ORIGINAL SOURCE CODE -->
<h2>1. Original Source Code</h2>
<pre>${origCode}</pre>

<!-- 1b. AST TREE -->
<h2>2. Abstract Syntax Tree (AST)</h2>
<p style="font-size:9pt;color:#666;margin-bottom:8px">
  Hierarchical tree: Program → Functions → Loops (with init/cond/update) → Body Statements.<br>
  <span style="color:#2e7d32;font-weight:700">✓ PARALLEL</span> = safe to parallelize &nbsp;|&nbsp;
  <span style="color:#b71c1c;font-weight:700">✗ BLOCKED</span> = has loop-carried dependency &nbsp;|&nbsp;
  <span style="color:#e65100;font-weight:700">⟳ LOOP</span> = loop node &nbsp;|&nbsp;
  <span style="color:#0277bd;font-weight:700">ƒ FUNC</span> = function declaration
</p>
<div style="background:#fafafa;border:1px solid #e0e0e0;border-radius:6px;padding:12px 16px;overflow-x:auto">
  ${astHtmlTree}
</div>
<h3 style="margin-top:14px;font-size:10pt;color:#666">ASCII Tree (text form)</h3>
<pre style="font-size:7.5pt;line-height:1.6;background:#f8f8ff;border-color:#e0e0f0">${astText}</pre>

<!-- 2. GENERATED PARALLEL CODE -->
<h2>3. Generated Parallel Code</h2>
<pre>${parCode}</pre>

<!-- 3. DEPENDENCY ANALYSIS -->
<h2>4. Dependency Analysis</h2>
<table>
  <thead><tr><th>Loop</th><th>Status</th><th>Dependencies (variable, type, code line)</th></tr></thead>
  <tbody>${depRows || '<tr><td colspan="3" style="color:#888">No loops analyzed.</td></tr>'}</tbody>
</table>

<!-- 4. BERNSTEIN'S CONDITIONS -->
<h2>5. Bernstein's Conditions Checker</h2>
<p style="font-size:9pt;color:#666;margin-bottom:8px">
  C1: W(i) ∩ R(i+1) = ∅ (no RAW) &nbsp;|&nbsp;
  C2: R(i) ∩ W(i+1) = ∅ (no WAR) &nbsp;|&nbsp;
  C3: W(i) ∩ W(i+1) = ∅ (no WAW)
</p>
<table>
  <thead><tr><th>Loop</th><th>C1 (RAW)</th><th>C2 (WAR)</th><th>C3 (WAW)</th><th>Overall</th><th>Induction Vars</th><th>Dep Distances</th></tr></thead>
  <tbody>${bernRows || '<tr><td colspan="7" style="color:#888">No loop analysis data.</td></tr>'}</tbody>
</table>

<!-- 5. LOOP TRANSFORMATIONS -->
<h2>5. Loop Transformation Engine</h2>
${transformBlocks}

<!-- 6. PERFORMANCE ANALYSIS -->
<h2>6. Performance Analysis</h2>
<div class="perf-grid">
  <div class="perf-card"><div class="val">${speedup}x</div><div class="lbl">Speedup</div></div>
  <div class="perf-card"><div class="val">${eff}%</div><div class="lbl">Efficiency</div></div>
  <div class="perf-card"><div class="val">${p}%</div><div class="lbl">Parallelizable</div></div>
  <div class="perf-card"><div class="val">${seqMs}ms</div><div class="lbl">Sequential Time</div></div>
</div>
<h3>Amdahl's Law vs Gustafson's Law</h3>
<table>
  <thead><tr><th>Cores</th><th>Amdahl Speedup</th><th>Gustafson Speedup</th></tr></thead>
  <tbody>${coreRows}</tbody>
</table>
${lawData.crossover_n ? `<p style="font-size:9pt;color:#666;margin-top:6px">⚡ Crossover point: parallel is faster when n &gt; <strong>${lawData.crossover_n}</strong> iterations</p>` : ''}

<!-- 7. EXPLANATION -->
<h2>7. Loop-by-Loop Explanation</h2>
${explBlocks || '<p style="color:#888">No explanations available.</p>'}

<!-- 8. SUGGESTIONS -->
<h2>8. Optimization Suggestions</h2>
${suggBlocks || '<p style="color:#888">No suggestions available.</p>'}

<!-- FOOTER -->
<div class="footer">
  <span>AutoParallel — Source-to-Source Compiler v2.0</span>
  <span>${now}</span>
</div>

<div class="no-print" style="text-align:center;margin:20px">
  <button onclick="window.print()" style="padding:10px 28px;background:#6c63ff;color:#fff;border:none;border-radius:6px;font-size:11pt;cursor:pointer;font-weight:700">🖨 Print / Save as PDF</button>
  <button onclick="window.close()" style="padding:10px 20px;background:#eee;color:#333;border:none;border-radius:6px;font-size:11pt;cursor:pointer;margin-left:10px">Close</button>
</div>

<script>
  // Auto-trigger print dialog after a short delay for rendering
  setTimeout(function() { window.print(); }, 800);
<\/script>
</body>
</html>`;

  printWin.document.write(html);
  printWin.document.close();
}

