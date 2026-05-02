let material_master = [];
let price_sheet = [];

window.estifyPlans = {};
window.estifyCurrentPlan = null;

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

function formatPrecise(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

function pickEl(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
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
    m => m.code.trim().toUpperCase() === code.trim().toUpperCase()
  );
  if (!item) throw `Invalid Code: ${code}`;
  return item.grade;
}

// ================= PRICE =================
function getFinalPrice(model, config, grade) {
  if (config.includes("+")) {
    return config.split("+").reduce((sum, part) => {
      const item = price_sheet.find(p =>
        p.model.trim() === model.trim() &&
        p.config.trim().toUpperCase() === part.trim() &&
        p.grade.trim() === grade.trim()
      );
      if (!item) throw `Missing part price: ${part}`;
      return sum + Number(item.price);
    }, 0);
  }

  const item = price_sheet.find(p =>
    p.model.trim() === model.trim() &&
    p.config.trim().toUpperCase() === config.trim() &&
    p.grade.trim() === grade.trim()
  );

  if (!item) throw `Price not found: ${model} | ${config} | ${grade}`;
  return Number(item.price);
}

// ================= 🔥 FIXED ENGINE =================
function generateOdooPricing(results, tolerance = 10) {
  if (!results || results.length === 0) return null;

  // group by config
  const configGroups = {};
  for (const r of results) {
    if (!configGroups[r.config]) configGroups[r.config] = [];
    configGroups[r.config].push(r);
  }

  // pick best config (max rows)
  const [anchorConfig, rows] = Object.entries(configGroups)
    .sort((a, b) => b[1].length - a[1].length)[0];

  // base = lowest price in that config
  const baseRow = rows.reduce((min, r) => r.price < min.price ? r : min, rows[0]);

  const basePrice = baseRow.price;
  const anchorColour = baseRow.code;

  const colourExtras = {};
  colourExtras[anchorColour] = 0;

  // compute colour extras
  for (const r of rows) {
    colourExtras[r.code] = r.price - basePrice;
  }

  // validation
  const validation = results.map(r => {
    const predicted = basePrice + (colourExtras[r.code] || 0);
    const diff = predicted - r.price;

    return {
      ...r,
      predicted,
      diff,
      fits: Math.abs(diff) <= tolerance
    };
  });

  const mismatchCount = validation.filter(v => !v.fits).length;
  const maxDiff = Math.max(...validation.map(v => Math.abs(v.diff)));

  return {
    model: results[0].model,
    basePrice,
    anchorColour,
    anchorConfig,
    colourExtras,
    configExtras: { [anchorConfig]: 0 },
    validation,
    mismatchCount,
    maxDiff,
    tolerance
  };
}

// ================= 🔥 GROUP BY MODEL + GRADE =================
function generateEstifyPlans(results, tolerance = 10) {
  const grouped = {};

  for (const r of results) {
    const key = `${r.model}__${r.grade}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  const plans = {};

  for (const [key, rows] of Object.entries(grouped)) {
    const plan = generateOdooPricing(rows, tolerance);
    if (plan) plan.model = key;
    plans[key] = plan;
  }

  return plans;
}

// ================= MAIN =================
async function runCalculator() {
  await loadData();

  const lines = document.getElementById("input").value
    .split("\n")
    .filter(l => l.trim());

  const results = [];

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

  const plansByModel = generateEstifyPlans(results, 10);
  window.estifyPlans = plansByModel;

  displayResults(results, plansByModel);
  displayOdoo(plansByModel);
}

// expose
window.runCalculator = runCalculator;
