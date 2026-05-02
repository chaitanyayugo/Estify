let material_master = [];
let price_sheet = [];

// ================= LOAD =================
async function loadData() {
  const [mRes, pRes] = await Promise.all([
    fetch('./material_master.json'),
    fetch('./price_sheet.json')
  ]);

  if (!mRes.ok) throw new Error('material_master.json failed');
  if (!pRes.ok) throw new Error('price_sheet.json failed');

  material_master = await mRes.json();
  price_sheet = await pRes.json();
}

// ================= HELPERS =================
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatValue(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : '—';
}

// ================= SMART CODE =================
function extractCode(fabricPart) {
  const text = fabricPart.trim().toUpperCase();

  const sorted = material_master
    .map(m => m.code.trim().toUpperCase())
    .sort((a, b) => b.length - a.length);

  for (let code of sorted) {
    if (
      text === code ||
      text.startsWith(code + "-") ||
      text.startsWith(code + " ")
    ) return code;
  }

  return text.split("-")[0];
}

// ================= PARSER =================
function parseVariant(input) {
  const brackets = input.match(/\(([^()]*)\)/g);
  if (!brackets || brackets.length < 2) throw "Invalid format";

  const prefix = brackets[0].replace(/[()]/g, "").trim();
  const modelName = input.split(")")[1].trim().split(" ")[0];
  const model = `${prefix}-${modelName}`;

  const last = brackets[brackets.length - 1].replace(/[()]/g, "");
  let [fabricPart, configPart] = last.split(",");

  if (!fabricPart || !configPart) throw "Invalid fabric/config";

  const code = extractCode(fabricPart);

  configPart = configPart.trim().toUpperCase();

  return { model, code, config: configPart };
}

// ================= GRADE =================
function getGrade(code) {
  const item = material_master.find(
    m => m.code.toUpperCase() === code.toUpperCase()
  );
  if (!item) throw `Invalid Code: ${code}`;
  return item.grade;
}

// ================= PRICE =================
function getFinalPrice(model, config, grade) {

  if (config.includes("+")) {
    return config.split("+").reduce((sum, part) => {
      const item = price_sheet.find(p =>
        p.model === model &&
        p.config.toUpperCase() === part.trim() &&
        p.grade === grade
      );
      if (!item) throw `Missing part price: ${part}`;
      return sum + Number(item.price);
    }, 0);
  }

  const item = price_sheet.find(p =>
    p.model === model &&
    p.config.toUpperCase() === config &&
    p.grade === grade
  );

  if (!item) throw `Price not found: ${model} | ${config} | ${grade}`;
  return Number(item.price);
}

// ================= MATH ENGINE =================
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((r, i) => r.concat([b[i]]));

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }

    if (Math.abs(M[pivot][col]) < 1e-12)
      throw new Error("Underdetermined system");

    [M[col], M[pivot]] = [M[pivot], M[col]];

    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map(r => r[n]);
}

function solveLeastSquares(X, y) {
  const n = X[0].length;

  const XtX = Array.from({ length: n }, () => Array(n).fill(0));
  const Xty = Array(n).fill(0);

  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < n; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < n; b++) {
        XtX[a][b] += X[i][a] * X[i][b];
      }
    }
  }

  return solveLinearSystem(XtX, Xty);
}

// ================= ODOO ENGINE =================
function generateOdooPricing(results, tolerance = 10) {

  const colours = [...new Set(results.map(r => r.code))];
  const configs = [...new Set(results.map(r => r.config))];

  const anchorColour = colours[0];
  const anchorConfig = configs[0];

  const colourVars = colours.slice(1);
  const configVars = configs.slice(1);

  const X = [];
  const y = [];

  for (const r of results) {
    const row = new Array(1 + colourVars.length + configVars.length).fill(0);
    row[0] = 1;

    const cIndex = colourVars.indexOf(r.code);
    if (cIndex !== -1) row[1 + cIndex] = 1;

    const kIndex = configVars.indexOf(r.config);
    if (kIndex !== -1) row[1 + colourVars.length + kIndex] = 1;

    X.push(row);
    y.push(r.price);
  }

  const beta = solveLeastSquares(X, y);

  const basePrice = beta[0];

  const colourExtras = { [anchorColour]: 0 };
  colourVars.forEach((c, i) => {
    colourExtras[c] = beta[1 + i];
  });

  const configExtras = { [anchorConfig]: 0 };
  configVars.forEach((k, i) => {
    configExtras[k] = beta[1 + colourVars.length + i];
  });

  const validation = results.map(r => {
    const predicted =
      basePrice +
      (colourExtras[r.code] || 0) +
      (configExtras[r.config] || 0);

    const diff = predicted - r.price;

    return {
      ...r,
      predicted,
      diff,
      fits: Math.abs(diff) <= tolerance
    };
  });

  return {
    basePrice,
    colourExtras,
    configExtras,
    validation
  };
}

// ================= MAIN =================
async function runCalculator() {
  await loadData();

  const lines = document.getElementById("input").value
    .split("\n")
    .filter(l => l.trim());

  let results = [];

  for (let line of lines) {
    try {
      const parsed = parseVariant(line);
      const grade = getGrade(parsed.code);
      const price = getFinalPrice(parsed.model, parsed.config, grade);

      results.push({ ...parsed, grade, price });

    } catch (e) {
      console.error(line, e);
    }
  }

  const plan = generateOdooPricing(results);

  displayResults(results, plan.basePrice);
  displayOdoo(plan);
}

// ================= UI =================
function displayResults(data, base) {
  const tbody = document.querySelector("#output tbody");
  tbody.innerHTML = "";

  data.forEach(d => {
    const extra = d.price - base;

    tbody.innerHTML += `
      <tr>
        <td>${d.model}</td>
        <td>${d.code}</td>
        <td>${d.grade}</td>
        <td>${d.config}</td>
        <td>${formatValue(d.price)}</td>
        <td>${formatValue(extra)}</td>
      </tr>
    `;
  });
}

function displayOdoo(plan) {
  console.log("BASE:", plan.basePrice);
  console.log("COLOURS:", plan.colourExtras);
  console.log("CONFIGS:", plan.configExtras);
}
