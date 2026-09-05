// ==========================
// LOAD USER & TOKEN
// ==========================
let rawAuth = null;

try {
  rawAuth = JSON.parse(localStorage.getItem("user") || "null");
} catch (e) {
  rawAuth = null;
}

let currentUser = null;
let token = null;

// Support both shapes:
// 1) { user: {...}, token: "..." }
// 2) { id, name, role, status, token? }
if (rawAuth) {
  if (rawAuth.user && rawAuth.token) {
    currentUser = rawAuth.user;
    token = rawAuth.token;
  } else {
    currentUser = {
      id: rawAuth.id,
      name: rawAuth.name,
      role: rawAuth.role,
      status: rawAuth.status
    };
    token = rawAuth.token || null;
  }
}

window.user = currentUser;
window.token = token;

// Helper for fetch headers
function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}
window.authHeaders = authHeaders;

// ==========================
// IF NOT LOGGED IN, SOME PAGES MAY REDIRECT
// (we do NOT auto-redirect here; each HTML decides)
// ==========================

// ==========================
// NAV BAR (only if logged in)
// ==========================
if (currentUser) {
  const nav = document.createElement("div");
  nav.style.background = "#2563eb";
  nav.style.padding = "12px";
  nav.style.display = "flex";
  nav.style.flexWrap = "wrap";
  nav.style.alignItems = "center";
  nav.style.gap = "14px";

  const left = document.createElement("div");
  left.style.display = "flex";
  left.style.alignItems = "center";
  left.style.gap = "12px";

  const menuBtn = document.createElement("button");
  menuBtn.textContent = "☰";
  menuBtn.style.fontSize = "22px";
  menuBtn.style.background = "none";
  menuBtn.style.border = "none";
  menuBtn.style.color = "white";
  menuBtn.style.cursor = "pointer";
  menuBtn.style.display = "none";

  left.innerHTML = `<strong style="color:white;">Shift App</strong>`;
  left.prepend(menuBtn);

  const navLinks = document.createElement("div");
  navLinks.style.display = "flex";
  navLinks.style.gap = "14px";
  navLinks.style.flexWrap = "wrap";
  navLinks.style.alignItems = "center";

  function link(href, label) {
    return `<a href="${href}" style="color:white;text-decoration:none;font-weight:500;">${label}</a>`;
  }

  // Common link
  navLinks.innerHTML += link("/calendar.html", "Calendar");

  if (currentUser.role === "employee") {
    navLinks.innerHTML += link("/my_shifts.html", "My Shifts");
    navLinks.innerHTML += link("/timesheets.html", "Timesheet");
    navLinks.innerHTML += link("/dayoff.html", "Day-Off");
    navLinks.innerHTML += link("/payslip.html", "Payslips");
  }

  if (currentUser.role === "admin") {
    navLinks.innerHTML += link("/employees.html", "Employees");
    navLinks.innerHTML += link("/admin_registrations.html", "Registrations");
    navLinks.innerHTML += link("/admin_timesheets.html", "Admin Timesheets");
    navLinks.innerHTML += link("/admin_approvals.html", "Claimed Shifts");
    navLinks.innerHTML += link("/employee_profile.html", "Profile");
    navLinks.innerHTML += link("/admin_dayoff.html", "Day-Off Approvals");

    // ✅ NEW: Payroll & Admin Payslips
    navLinks.innerHTML += link("/payroll.html", "Payroll");
    navLinks.innerHTML += link("/admin_payslips.html", "Payslips");
  }

  const right = document.createElement("div");
  right.style.marginLeft = "auto";
  right.style.color = "white";
  const profileId = currentUser.id;

  right.innerHTML = `
    <a href="/profile.html?id=${profileId}"
       style="color:white;text-decoration:none;font-weight:600;">
      ${currentUser.name}
    </a>
    (${currentUser.role})
    <button onclick="logout()" style="margin-left:10px;">Logout</button>
  `;

  nav.appendChild(left);
  nav.appendChild(navLinks);
  nav.appendChild(right);
  document.body.prepend(nav);

  menuBtn.onclick = () => {
    navLinks.style.display = navLinks.style.display === "none" ? "flex" : "none";
  };

  function handleResize() {
    if (window.innerWidth < 768) {
      menuBtn.style.display = "block";
      navLinks.style.display = "none";
      navLinks.style.width = "100%";
      navLinks.style.flexDirection = "column";
    } else {
      menuBtn.style.display = "none";
      navLinks.style.display = "flex";
      navLinks.style.flexDirection = "row";
    }
  }

  window.addEventListener("resize", handleResize);
  handleResize();
}

// ==========================
// LOGOUT
// ==========================
function logout() {
  localStorage.removeItem("user");
  window.location.href = "/login.html";
}
window.logout = logout;