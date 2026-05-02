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

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => alert('Copied to clipboard ✅'))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  alert('Copied to clipboard ✅');
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

// ================= GROUPING =================
function groupByModel(results) {
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.model]) grouped[r.model] = [];
    grouped[r.model].push(r);
  }
  return grouped;
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

    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error("Underdetermined system");
    }

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

  for (let i = 0; i < n; i++) XtX[i][i] += 1e-8;

  return solveLinearSystem(XtX, Xty);
}

// ================= ODOO ENGINE =================
function generateOdooPricing(results, tolerance = 10) {
  if (!results || results.length === 0) {
    return null;
  }

  if (results.length === 1) {
    const only = results[0];
    return {
      model: only.model,
      basePrice: Number(only.price),
      anchorColour: only.code,
      anchorConfig: only.config,
      colourExtras: { [only.code]: 0 },
      configExtras: { [only.config]: 0 },
      validation: [{
        ...only,
        predicted: Number(only.price),
        diff: 0,
        fits: true
      }],
      mismatchCount: 0,
      maxDiff: 0,
      tolerance
    };
  }

  const colourCounts = {};
  const configCounts = {};

  for (const r of results) {
    colourCounts[r.code] = (colourCounts[r.code] || 0) + 1;
    configCounts[r.config] = (configCounts[r.config] || 0) + 1;
  }

  const colours = [...new Set(results.map(r => r.code))].sort((a, b) => {
    const diff = (colourCounts[b] || 0) - (colourCounts[a] || 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const configs = [...new Set(results.map(r => r.config))].sort((a, b) => {
    const diff = (configCounts[b] || 0) - (configCounts[a] || 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const anchorColour = colours[0];
  const anchorConfig = configs[0];

  const colourVars = colours.filter(c => c !== anchorColour);
  const configVars = configs.filter(k => k !== anchorConfig);

  const colourIndex = new Map(colourVars.map((c, i) => [c, i]));
  const configIndex = new Map(configVars.map((k, i) => [k, i]));

  const X = [];
  const y = [];

  for (const r of results) {
    const row = new Array(1 + colourVars.length + configVars.length).fill(0);
    row[0] = 1;

    if (r.code !== anchorColour && colourIndex.has(r.code)) {
      row[1 + colourIndex.get(r.code)] = 1;
    }

    if (r.config !== anchorConfig && configIndex.has(r.config)) {
      row[1 + colourVars.length + configIndex.get(r.config)] = 1;
    }

    X.push(row);
    y.push(Number(r.price));
  }

  let beta;
  try {
    beta = solveLeastSquares(X, y);
  } catch (err) {
    return {
      error: String(err),
      model: results[0].model,
      basePrice: 0,
      anchorColour,
      anchorConfig,
      colourExtras: {},
      configExtras: {},
      validation: results.map(r => ({
        ...r,
        predicted: null,
        diff: null,
        fits: false
      })),
      mismatchCount: results.length,
      maxDiff: null,
      tolerance
    };
  }

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

    const diff = predicted - Number(r.price);

    return {
      ...r,
      predicted,
      diff,
      fits: Math.abs(diff) <= tolerance
    };
  });

  const mismatchCount = validation.filter(v => !v.fits).length;
  const maxDiff = validation.length
    ? Math.max(...validation.map(v => Math.abs(v.diff)))
    : 0;

  return {
    model: results[0].model,
    basePrice,
    anchorColour,
    anchorConfig,
    colourExtras,
    configExtras,
    validation,
    mismatchCount,
    maxDiff,
    tolerance
  };
}

function generateEstifyPlans(results, tolerance = 10) {
  const grouped = groupByModel(results);
  const plans = {};

  for (const [model, rows] of Object.entries(grouped)) {
    const plan = generateOdooPricing(rows, tolerance);
    if (plan) plan.model = model;
    plans[model] = plan;
  }

  return plans;
}

// ================= COPY HELPERS =================
function buildPlanText(plan) {
  if (!plan || plan.error) {
    return plan?.error || 'No plan available';
  }

  const lines = [];
  lines.push(`MODEL: ${plan.model}`);
  lines.push(`BASE PRICE: ${formatValue(plan.basePrice)}`);
  lines.push(`ANCHOR COLOUR: ${plan.anchorColour}`);
  lines.push(`ANCHOR CONFIG: ${plan.anchorConfig}`);
  lines.push('');
  lines.push('COLOUR EXTRAS:');
  Object.entries(plan.colourExtras).forEach(([k, v]) => {
    lines.push(`${k} = ${formatValue(v)}`);
  });
  lines.push('');
  lines.push('CONFIG EXTRAS:');
  Object.entries(plan.configExtras).forEach(([k, v]) => {
    lines.push(`${k} = ${formatValue(v)}`);
  });

  return lines.join('\n');
}

function copyOdooPlan(modelKey) {
  const plan = window.estifyPlans?.[modelKey];
  if (!plan) return;
  copyText(buildPlanText(plan));
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

// ================= UI =================
function displayResults(data, plansByModel) {
  const tbody = document.querySelector("#output tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  data.forEach(d => {
    const plan = plansByModel?.[d.model];
    const base = plan && !plan.error ? Number(plan.basePrice) : null;
    const extra = base === null ? null : Number(d.price) - base;

    const validation = plan?.validation?.find(v =>
      v.model === d.model &&
      v.code === d.code &&
      v.config === d.config
    );

    const tr = document.createElement("tr");

    if (validation) {
      tr.classList.add(validation.fits ? "fit-row" : "mismatch-row");
    }

    if (base !== null && Math.abs(Number(d.price) - base) < 0.000001) {
      tr.classList.add("base-row");
    }

    tr.innerHTML = `
      <td>${escapeHtml(d.model)}</td>
      <td>${escapeHtml(d.code)}</td>
      <td>${escapeHtml(d.grade)}</td>
      <td>${escapeHtml(d.config)}</td>
      <td>${formatValue(d.price)}</td>
      <td>${formatValue(extra)}</td>
    `;

    tbody.appendChild(tr);
  });
}

function renderRowsFromEntries(obj, type) {
  const entries = Object.entries(obj || {});
  if (!entries.length) {
    return `<tr><td colspan="2">No ${type} extras found</td></tr>`;
  }

  return entries.map(([k, v]) => `
    <tr>
      <td>${escapeHtml(k)}</td>
      <td class="${
        Math.abs(Number(v)) < 0.000001
          ? 'neutral'
          : Number(v) > 0
            ? 'positive'
            : 'negative'
      }">${formatValue(v)}</td>
    </tr>
  `).join('');
}

function renderValidationRows(plan) {
  if (!plan || plan.error) {
    return `<tr><td colspan="6">${escapeHtml(plan?.error || 'No validation data')}</td></tr>`;
  }

  return plan.validation.map(v => `
    <tr class="${v.fits ? 'fit-row' : 'mismatch-row'}">
      <td>${escapeHtml(v.model)}</td>
      <td>${escapeHtml(v.code)}</td>
      <td>${escapeHtml(v.config)}</td>
      <td>${formatPrecise(v.price)}</td>
      <td>${formatPrecise(v.predicted)}</td>
      <td class="${v.fits ? 'fit' : 'mismatch'}">
        ${v.fits ? 'OK' : formatPrecise(v.diff)}
      </td>
    </tr>
  `).join('');
}

function displayOdoo(plansByModel) {
  const summary = pickEl("summary");
  const odooBase = pickEl("odooBase", "baseInfo");
  const odooFit = pickEl("odooFit");

  const colourBody = pickEl("colourOutputBody", "colourTable");
  const configBody = pickEl("configOutputBody", "configTable");
  const validationBody = pickEl("validationOutputBody", "validationTable");

  const models = Object.keys(plansByModel || {});

  if (!models.length) {
    if (summary) summary.textContent = "No valid rows found.";
    if (odooBase) odooBase.textContent = "";
    if (odooFit) odooFit.textContent = "";
    if (colourBody) colourBody.innerHTML = "";
    if (configBody) configBody.innerHTML = "";
    if (validationBody) validationBody.innerHTML = "";
    const host = document.getElementById("estifyPlans");
    if (host) host.innerHTML = "";
    return;
  }

  const firstValidPlan = models
    .map(m => plansByModel[m])
    .find(p => p && !p.error) || plansByModel[models[0]];

  if (summary) {
    summary.textContent = `Solved ${models.length} model(s).`;
  }

  if (odooBase) {
    odooBase.textContent = firstValidPlan && !firstValidPlan.error
      ? `Solved base price: ${formatValue(firstValidPlan.basePrice)} | Anchor colour: ${firstValidPlan.anchorColour} | Anchor config: ${firstValidPlan.anchorConfig}`
      : firstValidPlan?.error || "No solved base available.";
  }

  if (odooFit) {
    if (firstValidPlan && !firstValidPlan.error) {
      odooFit.textContent =
        firstValidPlan.mismatchCount === 0
          ? `All valid rows fit the Odoo attribute model within tolerance ±${firstValidPlan.tolerance}.`
          : `${firstValidPlan.mismatchCount} row(s) exceed tolerance ±${firstValidPlan.tolerance}. Max diff: ${formatPrecise(firstValidPlan.maxDiff)}`;
    } else {
      odooFit.textContent = "No solved attribute values available.";
    }
  }

  if (colourBody) {
    colourBody.innerHTML = firstValidPlan && !firstValidPlan.error
      ? renderRowsFromEntries(firstValidPlan.colourExtras, 'colour')
      : `<tr><td colspan="2">${escapeHtml(firstValidPlan?.error || 'No colour extras')}</td></tr>`;
  }

  if (configBody) {
    configBody.innerHTML = firstValidPlan && !firstValidPlan.error
      ? renderRowsFromEntries(firstValidPlan.configExtras, 'configuration')
      : `<tr><td colspan="2">${escapeHtml(firstValidPlan?.error || 'No configuration extras')}</td></tr>`;
  }

  if (validationBody) {
    validationBody.innerHTML = renderValidationRows(firstValidPlan);
  }

  let host = document.getElementById("estifyPlans");
  if (!host) {
    host = document.createElement("div");
    host.id = "estifyPlans";
    host.style.marginTop = "24px";
    document.body.appendChild(host);
  }

  host.innerHTML = models.map(modelKey => renderEstifyCard(modelKey, plansByModel[modelKey])).join('');
}

function renderEstifyCard(modelKey, plan) {
  const title = escapeHtml(modelKey);

  if (!plan || plan.error) {
    return `
      <section style="margin-top:20px;padding:16px;border-radius:14px;background:#020617;border:1px solid #334155;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <h3 style="margin:0;color:#38bdf8;">${title}</h3>
        </div>
        <div style="margin-top:10px;color:#fca5a5;font-weight:600;">
          ${escapeHtml(plan?.error || 'No plan available')}
        </div>
      </section>
    `;
  }

  return `
    <section style="margin-top:20px;padding:16px;border-radius:14px;background:#020617;border:1px solid #334155;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <h3 style="margin:0;color:#38bdf8;">${title}</h3>
        <button onclick='copyOdooPlan(${JSON.stringify(modelKey)})'>Copy Odoo Plan</button>
      </div>

      <div class="highlight" style="margin-top:12px;">
        Base: <strong>${formatValue(plan.basePrice)}</strong>
        &nbsp;|&nbsp; Anchor Colour: <strong>${escapeHtml(plan.anchorColour)}</strong>
        &nbsp;|&nbsp; Anchor Config: <strong>${escapeHtml(plan.anchorConfig)}</strong>
        &nbsp;|&nbsp; Status: <strong>${plan.mismatchCount === 0 ? 'Exact' : `Mismatch ${plan.mismatchCount}`}</strong>
      </div>

      <div class="grid" style="margin-top:16px;">
        <div class="card">
          <h3>Colour Extras</h3>
          <table>
            <thead>
              <tr><th>Colour</th><th>Extra</th></tr>
            </thead>
            <tbody>
              ${renderRowsFromEntries(plan.colourExtras, 'colour')}
            </tbody>
          </table>
        </div>

        <div class="card">
          <h3>Configuration Extras</h3>
          <table>
            <thead>
              <tr><th>Config</th><th>Extra</th></tr>
            </thead>
            <tbody>
              ${renderRowsFromEntries(plan.configExtras, 'configuration')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <h3>Validation</h3>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Code</th>
              <th>Config</th>
              <th>Actual</th>
              <th>Predicted</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${renderValidationRows(plan)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// Expose for HTML onclick
window.runCalculator = runCalculator;
window.copyOdooPlan = copyOdooPlan;
