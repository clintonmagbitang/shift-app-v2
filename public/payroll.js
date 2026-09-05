
/* =====================
   AUTH
===================== */
const readOnly = window.user?.role !== "admin" || /\/payslips?\.html$/.test(location.pathname);
if (!window.user) {
  location.href = "/login.html";
}

/* =====================
   STATE
===================== */
let employeesById = {};
let payrollGeneration = 0;
let lastBaseIncome = 0;
let lastLayout = "simple_cutoff";
let currentPayrollContext = null;   // holds { employeeId, from, to, summary, layout, payroll_record }

/* =====================
   HELPERS
===================== */
function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function currency(n) {
  n = Number(n || 0);
  return "₱" + n.toFixed(2);
}

/* cutoff options: same pattern as other pages */
function buildCutoffOptions() {
  const sel = document.getElementById("cutoffSelect");
  sel.innerHTML = "";

  const today = new Date();
  const monthsBack = Math.max(3, (today.getFullYear() - 2026) * 12 + today.getMonth() - 4);
  const monthsAhead = 1;
  const options = [];

  for (let offset = -monthsBack; offset <= monthsAhead; offset++) {
    const base = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const y = base.getFullYear();
    const m = base.getMonth();

    const first = new Date(y, m, 1);
    const fifteenth = new Date(y, m, 15);
    const sixteenth = new Date(y, m, 16);
    const last = new Date(y, m + 1, 0);

    options.push({
      label: `${first.toLocaleString(undefined, { month: "short" })} 1–15 ${y}`,
      from: toISO(first),
      to: toISO(fifteenth)
    });

    options.push({
      label: `${sixteenth.toLocaleString(undefined, { month: "short" })} 16–${last.getDate()} ${y}`,
      from: toISO(sixteenth),
      to: toISO(last)
    });
  }

  let selectedIndex = 0;
  const todayISO = toISO(today);

  options.forEach((c, idx) => {
    const o = document.createElement("option");
    o.value = `${c.from}|${c.to}`;
    o.textContent = c.label;
    sel.appendChild(o);

    if (todayISO >= c.from && todayISO <= c.to) {
      selectedIndex = idx;
    }
  });

  sel.selectedIndex = selectedIndex;
}

function getSelectedCutoffRange() {
  const sel = document.getElementById("cutoffSelect");
  if (!sel.value) return null;
  const [from, to] = sel.value.split("|");
  return { from, to };
}

/* =====================
   LOAD EMPLOYEES
===================== */
async function loadEmployees() {
  if (readOnly) {
    const sel = document.getElementById("employeeSelect");
    const option = document.createElement("option"); option.value = window.user.id; option.textContent = window.user.name; sel.replaceChildren(option);
    sel.parentElement.hidden = true; return;
  }
  const sel = document.getElementById("employeeSelect");
  sel.innerHTML = `<option value="">Select employee</option>`;

  const res = await fetch("/employees", { headers: authHeaders() });
  if (!res.ok) return;

  const data = await res.json();
  data.forEach(e => {
    employeesById[e.id] = e;
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = `${e.name} (${e.employee_id || "—"})`;
    sel.appendChild(opt);
  });
}

/* =====================
   MAIN GENERATE
===================== */
async function generatePayroll() {
  invalidatePayroll();
  const generation = payrollGeneration;
  const empSel = document.getElementById("employeeSelect");
  const empId = empSel.value;
  if (!empId) {
    alert("Select an employee");
    return;
  }

  const range = getSelectedCutoffRange();
  if (!range) {
    alert("Select a cutoff");
    return;
  }
  const { from, to } = range;

  const params = new URLSearchParams({ user_id: empId, from, to });

  const res = await fetch(`${readOnly ? "/api/v2/my-payroll" : "/admin/payroll-preview"}?${params.toString()}`, {
    headers: authHeaders()
  });

  const payload = await res.json().catch(() => ({}));
  if (generation !== payrollGeneration) return;
  if (!res.ok) {
    alert(payload.error || "Failed to generate payroll preview.");
    return;
  }

  const { employee, days, summary, layout, payroll_record } = payload;
  lastLayout = layout || "simple_cutoff";

    // store context for finalize/unlock
  currentPayrollContext = {
    employeeId: Number(empId),
    from,
    to,
    summary,
    layout: lastLayout,
    payroll_record
  };
  

  // INFO CARD
  document.getElementById("infoName").textContent      = employee.name || "";
  document.getElementById("infoDailyRate").textContent = currency(employee.daily_rate || 0);
  document.getElementById("infoPeriod").textContent    = `${employee.cutoff_from} to ${employee.cutoff_to}`;
  document.getElementById("infoOTHrRate").textContent  = currency(employee.overtime_rate || 0);

  document.getElementById("infoCard").style.display    = "block";
  document.getElementById("dailyCard").style.display   = "block";
  document.getElementById("summaryCard").style.display = "block";
  document.getElementById("balanceCard").style.display = "block";

  // DAILY BREAKDOWN
  const tbody = document.getElementById("dailyRows");
  tbody.innerHTML = "";

  days.forEach(d => {
    const tr = document.createElement("tr");
    [d.date, d.attendance_label || (d.attendance || '').toUpperCase(), currency(d.basic_pay), d.overtime_hours ? Number(d.overtime_hours).toFixed(2) : '', d.overtime_hours ? currency(d.overtime_pay) : '', currency(d.total_pay)].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; tr.append(cell); });
    tbody.appendChild(tr);
    });
    
  // footer totals row
  const totalRow = document.createElement("tr");
  totalRow.className = "totals-row";
  totalRow.innerHTML = `
      <td colspan="2" style="text-align:right;">TOTAL</td>
      <td>${currency(summary.total_basic)}</td>
      <td></td>
      <td>${currency(summary.total_overtime)}</td>
      <td>${currency(summary.total_income)}</td>
  `;
  tbody.appendChild(totalRow);

  // Hint text explaining logic
  const hint = document.getElementById("dailyHint");
  if (layout === "first_half_1_20") {
    hint.textContent =
      "Days 1–5: absences show as negative (deduction for previously paid days). " +
      "Days 6–15: actual basic based on attendance. Days 16–20: advance basic pay (assumed present). " +
      "OT is paid only for approved OT in the 1–15 cutoff.";
  } else if (layout === "second_half_16_5") {
    hint.textContent =
      "Days 16–20: adjustments vs the previous advance (present full day = ₱0; absent = -daily rate). " +
      "Days 21–month end: actual basic based on attendance. Next month, days 1–5: advance basic pay (assumed present). " +
      "OT is paid only for approved OT within the 16–end cutoff.";
  } else {
    hint.textContent =
      "Daily basic is based on attendance within the cutoff. Overtime uses approved OT hours only.";
  }

  // SUMMARY
  document.getElementById("sumBasic").textContent  = currency(summary.total_basic);
  document.getElementById("sumOT").textContent     = currency(summary.total_overtime);
  document.getElementById("sumIncome").textContent = currency(summary.total_income);

    lastBaseIncome = summary.total_income || 0;

  for (const key of extraFields) document.getElementById(key).value = payload.payroll_record?.[key] ?? 0;
  document.getElementById('remarks').value = payload.payroll_record?.remarks || '';
  const valeAmtEl  = document.getElementById("valeAmt");
  const loanAmtEl  = document.getElementById("loanAmt");
  const otherAmtEl = document.getElementById("otherAmt");
  const valeRefEl  = document.getElementById("valeRef");
  const loanRefEl  = document.getElementById("loanRef");
  const otherPartEl = document.getElementById("otherPart");
  const bankRefEl  = document.getElementById("bankRef");
  const statusEl   = document.getElementById("payrollStatus");
  const finalizeBtn = document.getElementById("finalizeBtn");
  const unlockBtn   = document.getElementById("unlockBtn");

  // default: everything editable, "Draft"
  let status = "draft";

  if (payload.payroll_record) {
    const pr = payload.payroll_record;

    // pre-fill adjustments & bank ref from stored record
    valeAmtEl.value  = pr.vale_amount  != null ? pr.vale_amount  : 0;
    loanAmtEl.value  = pr.loan_amount  != null ? pr.loan_amount  : 0;
    otherAmtEl.value = pr.other_amount != null ? pr.other_amount : 0;

    valeRefEl.value      = pr.vale_ref           || "";
    loanRefEl.value      = pr.loan_ref           || "";
    otherPartEl.value    = pr.other_particulars  || "";
    bankRefEl.value      = pr.bank_ref           || "";

    status = pr.status || "draft";

    // If finalized, show stored net; otherwise, recalc from inputs
    if (status === "finalized" && pr.final_income != null) {
      document.getElementById("netPay").textContent = currency(pr.final_income);
    } else {
      recalcNet();
    }
  } else {
    // no stored record yet
    valeAmtEl.value  = 0;
    loanAmtEl.value  = 0;
    otherAmtEl.value = 0;

    valeRefEl.value   = "";
    loanRefEl.value   = "";
    otherPartEl.value = "";
    bankRefEl.value   = "";

    recalcNet();
  }

  // status pill + button states
  if (statusEl) {
    statusEl.style.display = "inline-block";
    statusEl.textContent = status.toUpperCase();
    statusEl.classList.remove("status-finalized", "status-draft");
    statusEl.classList.add(status === "finalized" ? "status-finalized" : "status-draft");
  }

  const isFinalized = status === "finalized";

  // lock / unlock inputs
  [
    valeAmtEl, loanAmtEl, otherAmtEl,
    valeRefEl, loanRefEl, otherPartEl, bankRefEl
  ].forEach(el => {
    if (el) el.disabled = isFinalized || readOnly;
  });

  for (const key of [...extraFields, 'remarks']) document.getElementById(key).disabled = isFinalized || readOnly;
  document.getElementById('draftBtn').style.display = isFinalized || readOnly ? 'none' : 'inline-block';
  for (const [module,id] of [['advances','valeBal'],['loans','loanBal']]) {
    const field = document.getElementById(id); field.disabled = true; field.value = '';
    try { const response = await fetch(`/api/v2/${module}?user_id=${encodeURIComponent(empId)}`, {headers:authHeaders()});
      if (response.ok && currentPayrollContext?.employeeId === Number(empId)) field.value = (await response.json()).balance;
    } catch {}
  }
  // buttons
  if (finalizeBtn) {
    finalizeBtn.style.display = isFinalized || readOnly ? "none" : "inline-block";
    finalizeBtn.disabled = isFinalized || readOnly;
  }

  if (unlockBtn) {
    unlockBtn.style.display = isFinalized && !readOnly ? "inline-block" : "none";
  }
}

/* =====================
   NET PAY RECALC
===================== */
function recalcNet() {
  const base = lastBaseIncome || 0;

  const vale  = parseFloat(document.getElementById("valeAmt").value  || "0");
  const loan  = parseFloat(document.getElementById("loanAmt").value  || "0");
  const other = parseFloat(document.getElementById("otherAmt").value || "0");

  const net = base - vale - loan - other - extraDeduction();
  document.getElementById("netPay").textContent = currency(net);
}

/* =====================
   FINALIZE / UNLOCK PAYROLL
===================== */
async function finalizePayroll(draft = false) {
  if (readOnly) return;
  if (!currentPayrollContext) {
    alert("Generate a payroll first.");
    return;
  }

  const { employeeId, from, to, summary } = currentPayrollContext;

  const valeAmt  = parseFloat(document.getElementById("valeAmt").value  || "0");
  const loanAmt  = parseFloat(document.getElementById("loanAmt").value  || "0");
  const otherAmt = parseFloat(document.getElementById("otherAmt").value || "0");

  const valeRef   = document.getElementById("valeRef").value  || "";
  const loanRef   = document.getElementById("loanRef").value  || "";
  const otherPart = document.getElementById("otherPart").value || "";
  const bankRef   = document.getElementById("bankRef").value  || "";

  const base = summary.total_income || 0;
  const net  = base - valeAmt - loanAmt - otherAmt - extraDeduction();

  if (!draft && !confirm(`Finalize payroll? Net pay will be ${currency(net)}.`)) {
    return;
  }

  const body = {
    user_id: employeeId,
    from,
    to,
    final_basic: summary.total_basic || 0,
    final_overtime: summary.total_overtime || 0,
    final_income: net,          // NET PAY
    vale_amount: valeAmt,
    vale_ref: valeRef,
    loan_amount: loanAmt,
    loan_ref: loanRef,
    other_amount: otherAmt,
    other_particulars: otherPart,
    bank_ref: bankRef,
    ...Object.fromEntries(extraFields.map(key => [key, document.getElementById(key).value || "0"])),
    remarks: document.getElementById("remarks").value
  };

  const res = await fetch(draft ? "/admin/payroll-draft" : "/admin/payroll-finalize", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || "Failed to finalize payroll.");
    return;
  }

  alert(draft ? "Draft saved." : "Payroll finalized.");
  // reload to pick up stored status + values
  generatePayroll();
}

async function unlockPayroll() {
  if (readOnly) return;
  if (!currentPayrollContext) {
    alert("Generate a payroll first.");
    return;
  }

  const { employeeId, from, to } = currentPayrollContext;

  if (!confirm("Unlock this payroll so you can edit and re-finalize?")) {
    return;
  }

  const body = { user_id: employeeId, from, to };

  const res = await fetch("/admin/payroll-unlock", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || "Failed to unlock payroll.");
    return;
  }

  alert("Payroll unlocked.");
  generatePayroll();
}

/* =====================
   INIT
===================== */
const extraFields = ['withholding_tax','sss','philhealth','pagibig','other_adjustment'];
function extraDeduction() {
  return extraFields.reduce((sum,key) => sum + (key === 'other_adjustment' ? -1 : 1) * Number(document.getElementById(key).value || 0),0);
}
function invalidatePayroll() {
  payrollGeneration++;
  currentPayrollContext = null;
  for (const id of ['infoCard','dailyCard','summaryCard','balanceCard']) document.getElementById(id).style.display = 'none';
}
document.getElementById('employeeSelect').addEventListener('change',invalidatePayroll);
document.getElementById('cutoffSelect').addEventListener('change',invalidatePayroll);
buildCutoffOptions();
loadEmployees();
if (readOnly) {
  document.title = 'My Payslip';
  document.querySelector('h1').textContent = 'My Payslip';
  document.getElementById('finalizeBtn').hidden = true;
  document.getElementById('unlockBtn').hidden = true;
  document.getElementById('draftBtn').hidden = true;
  document.querySelectorAll('#summaryCard input, #summaryCard textarea').forEach(el => el.disabled = true);
  (async () => {
    try {
      const response = await fetch('/api/v2/my-payroll-history', {headers:authHeaders()});
      if (!response.ok) throw new Error();
      const records = await response.json(); const sel = document.getElementById('cutoffSelect'); sel.replaceChildren();
      for (const record of records) { const option = document.createElement('option'); option.value = `${record.cutoff_from}|${record.cutoff_to}`; option.textContent = `${record.cutoff_from} to ${record.cutoff_to}`; sel.append(option); }
      if (records.length) await generatePayroll();
      else document.getElementById('payrollNotice').textContent = 'No finalized V2 payslips yet. Your payroll will appear here after finalization.';
    } catch { document.getElementById('payrollNotice').textContent = 'Unable to load payslips. Please refresh or sign in again.'; }
  })();
}


// Keep failed requests recoverable and prevent repeated action clicks.
let payrollActionPending = false;
for (const actionName of ['finalizePayroll','unlockPayroll']) {
  const action = window[actionName];
  window[actionName] = async (...args) => {
    if (payrollActionPending || readOnly) return;
    payrollActionPending = true;
    try { await action(...args); }
    catch { alert('The request failed. Reload this cutoff to check its saved status before retrying.'); }
    finally { payrollActionPending = false; }
  };
}
const generateAction = generatePayroll;
generatePayroll = async () => { try { await generateAction(); } catch { invalidatePayroll(); alert('Unable to load payroll. Please try again.'); } };
