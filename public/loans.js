(async () => {
  if (!window.user || !window.token) { location.replace('/login.html'); return; }
  const admin = window.user.role === 'admin';
  const message = document.getElementById('message');
  const picker = document.getElementById('employee');
  const form = document.getElementById('entry');
  const fields = document.getElementById('fields');
  const openingFields = document.getElementById('opening-fields');
  const openingAmount = document.getElementById('opening-amount');
  const openingStatus = document.getElementById('opening-status');
  const table = document.getElementById('transactions');
  const balance = document.getElementById('balance');
  const money = value => Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let generation = 0;
  let pending = null;
  let saving = false;
  async function api(path, options = {}) {
    const response = await fetch(`/api/v2/loans${path}`, { ...options, headers: authHeaders({ 'Content-Type': 'application/json' }) });
    let body;
    try { body = await response.json(); } catch { throw new Error('The Loans service is not available yet. Start the configured V2 server.'); }
    if (!response.ok) throw new Error(body.error || 'Request failed.');
    return body;
  }
  function empty(text) {
    table.replaceChildren(); const row = table.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.textContent = text;
  }
  async function load(success = '') {
    const version = ++generation;
    openingFields.disabled = true; openingAmount.value = ''; openingStatus.textContent = '';
    fields.disabled = true; balance.textContent = '—'; empty('Loading…');
    if (admin && !picker.value) { empty('Choose an employee to view transactions.'); message.textContent = 'Select an employee above.'; return; }
    message.textContent = 'Loading ledger…';
    try {
      const data = await api(admin ? `?user_id=${encodeURIComponent(picker.value)}` : '');
      if (version !== generation) return;
      const opening = data.transactions.find(tx => tx.is_opening);
      openingFields.disabled = !admin || !!opening;
      if (opening) openingAmount.value = Number(opening.debit) - Number(opening.credit);
      openingStatus.textContent = opening ? 'Opening balance saved for April 30, 2026.' : 'Opening balance has not been entered. Current total includes recorded transactions only.';
      balance.textContent = `₱${money(data.balance)}`; table.replaceChildren();
      for (const tx of data.transactions) {
        const row = table.insertRow();
        [tx.transaction_date, tx.is_opening ? 'Opening balance' : tx.type === 'advance' ? 'Loan' : 'Repayment', tx.reference || '—', tx.remarks || '—', money(tx.debit), money(tx.credit), money(tx.balance)].forEach((text, index) => {
          const cell = row.insertCell(); cell.textContent = text; if (index >= 4) cell.className = 'money';
        });
      }
      if (!data.transactions.length) empty('No transactions recorded yet.');
      fields.disabled = !admin;
      message.textContent = success || (admin ? 'Ledger loaded. You can record a loan or repayment.' : 'Your ledger is read-only.');
    } catch (error) { if (version === generation) { empty('Ledger unavailable.'); message.textContent = success ? `${success} Refresh failed: ${error.message}` : error.message; } }
  }
  document.getElementById('opening-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !admin || !picker.value) return;
    const value = openingAmount.value;
    saving = true; fields.disabled = true; openingFields.disabled = true; picker.disabled = true;
    try {
      await api('/opening', {method:'POST',body:JSON.stringify({user_id:Number(picker.value),balance:value})});
      await load('Opening balance saved as of April 30, 2026.');
    } catch(error) { message.textContent = error.message; openingFields.disabled = false; fields.disabled = false; }
    finally { saving = false; picker.disabled = false; }
  });
  picker.addEventListener('change', () => { pending = null; load(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !admin || !picker.value) return;
    const payload = { ...Object.fromEntries(new FormData(form)), user_id: Number(picker.value) };
    const signature = JSON.stringify(payload);
    if (!pending || pending.signature !== signature) pending = { signature, request_id: crypto.randomUUID() };
    saving = true; fields.disabled = true; picker.disabled = true; message.textContent = 'Saving…';
    try {
      await api('', { method: 'POST', body: JSON.stringify({ ...payload, request_id: pending.request_id }) });
      pending = null; form.elements.amount.value = ''; form.elements.reference.value = ''; form.elements.remarks.value = '';
      await load('Transaction saved.');
    } catch (error) { message.textContent = error.message; fields.disabled = false; }
    finally { saving = false; picker.disabled = false; }
  });
  const now = new Date(); form.elements.transaction_date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (admin) {
    document.getElementById('opening-panel').hidden = false;
    document.getElementById('employee-picker').hidden = false;
    document.getElementById('entry-panel').hidden = false;
    try {
      const employees = await api('/employees');
      for (const employee of employees) { const option = document.createElement('option'); option.value = employee.id; option.textContent = employee.name; picker.append(option); }
    } catch (error) { message.textContent = error.message; empty('Ledger unavailable.'); return; }
  }
  await load();
})();
