if (!window.user || !window.token) {
  window.location.replace('/login.html');
} else {
  const admin = window.user.role === 'admin';
  document.getElementById('greeting').textContent = `Welcome, ${window.user.name || 'team member'}.`;
  const modules = [
    ['Scheduling', 'View the calendar, shifts, and team coverage.', '/calendar.html', false],
    ['Timesheets', admin ? 'Review attendance, overtime, and cutoff status.' : 'Review your attendance and timesheet.', admin ? '/admin_timesheets.html' : '/timesheets.html', false],
    [admin ? 'Payroll' : 'My Payroll', admin ? 'Review payroll calculations and manage cutoff records.' : 'View your available payroll records.', admin ? '/payroll.html' : '/payslip.html', false],
    ['Employee Advances', 'Record advances, repayments, and view running AR balances.', '/advances.html', 'setup'],
    ['Employee Loans', 'Record loans, repayments, and view running balances.', '/loans.html', 'setup'],
    [admin ? 'Employees' : 'My Profile', admin ? 'Manage employee records and profile information.' : 'View your profile and employee information.', admin ? '/employees.html' : `/profile.html?id=${encodeURIComponent(window.user.id)}`, false]
  ];
  for (const [title, description, href, preview] of modules) {
    const card = document.createElement('a');
    card.className = 'module'; card.href = href;
    const tag = document.createElement('span'); tag.className = `tag${preview ? ' preview' : ''}`; tag.textContent = preview === 'setup' ? 'DATABASE SETUP REQUIRED' : preview ? 'PREVIEW' : 'AVAILABLE';
    const heading = document.createElement('h2'); heading.textContent = title;
    const detail = document.createElement('p'); detail.textContent = description;
    const action = document.createElement('span'); action.className = 'action'; action.textContent = preview === 'setup' ? 'Open advances →' : preview ? 'Explore preview →' : 'Open module →';
    card.append(tag, heading, detail, action); document.getElementById('modules').append(card);
    if (preview === 'setup') {
      fetch(`/api/v2/advances?user_id=${encodeURIComponent(window.user.id)}`, { headers: authHeaders() })
        .then(response => { if (response.ok) { tag.textContent = 'AVAILABLE'; tag.className = 'tag'; } })
        .catch(() => {});
    }
  }
}
