/**
 * index.js — FULL WORKING SERVER (supports all HTML pages)
 * - Static HTML served from /public (login.html, calendar.html, admin pages, etc.)
 * - JWT auth (Bearer token)
 * - Optional auth on read-only calendar endpoints so calendar can still load if token missing
 * - Admin-only protections
 * - Shifts + claims + cancellations
 * - Day-offs + approvals
 * - Employees + profile + bank accounts
 * - Payslips upload/list/download
 * - CSV shift import
 * - Timesheets + admin review/lock + OT approve/reject + CSV export
 */

require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL missing in .env");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET missing in .env");
  process.exit(1);
}

const PDFDocument = require("pdfkit");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { neon } = require("@neondatabase/serverless");
const multer = require("multer");
const fs = require("fs");
const { parse } = require("csv-parse/sync");

// ✅ ensure upload folders exist (multer will NOT create them)
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "uploads", "payslips"), { recursive: true });

const app = express();
const sql = neon(process.env.DATABASE_URL);

// ---- middleware
app.use(cors());
app.use(express.json());

// ✅ SERVE STATIC HTML/CSS/JS
app.use(express.static(path.join(__dirname, "public")));

// ✅ DEFAULT PAGE
app.get("/", (req, res) => res.redirect("/login.html"));

/* =========================
   AUTH MIDDLEWARE
========================= */

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, name, iat, exp }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}



// ✅ Optional auth (lets calendar load even if frontend forgot token)
// If token present and valid -> req.user is set. If not present -> continue anonymous.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type === "Bearer" && token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // ignore invalid token for read-only endpoints
      req.user = null;
    }
  } else {
    req.user = null;
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

/* =========================
   UPLOAD CONFIGS
========================= */

const upload = multer({ dest: "uploads/" });

const payslipUpload = multer({
  dest: "uploads/payslips/",
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/* =========================
   EXCEL / CSV NORMALIZERS
========================= */

function normalizeDate(value) {
  if (!value) return null;

  // Excel serial date → YYYY-MM-DD
  if (typeof value === "number") {
    const excelBase = 25569;
    const unixDays = Math.floor(value - excelBase);
    const seconds = unixDays * 86400;

    const d = new Date(seconds * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");

    return `${y}-${m}-${day}`;
  }

  // MM/DD/YY or MM/DD/YYYY
  if (typeof value === "string" && value.includes("/")) {
    const [m, d, y] = value.split("/");
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return value.toString().slice(0, 10);
}

function normalizeTime(value) {
  if (!value) return null;

  // Excel serial time
  if (typeof value === "number") {
    const totalMinutes = Math.round(value * 24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  let v = value.toString().trim().toLowerCase();

  // 7:00 → 07:00
  if (/^\d{1,2}:\d{2}$/.test(v)) {
    const [h, m] = v.split(":");
    return `${h.padStart(2, "0")}:${m}`;
  }

  // 7:00 am / pm
  if (v.includes("am") || v.includes("pm")) {
    const d = new Date(`1970-01-01 ${v}`);
    return d.toISOString().slice(11, 16);
  }

  return null;
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  mins = Math.max(0, Math.min(24 * 60 - 1, mins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Nearest 30 mins, but exactly :15 rounds DOWN
function roundTo30Minutes(t) {
  const mins = timeToMinutes(t);
  const r = mins % 30;
  if (r <= 15) return minutesToTime(mins - r);
  return minutesToTime(mins + (30 - r));
}

// "07:30" -> 730, "13:00" -> 1300
function timeToPayrollNumber(t) {
  if (!t) return "";
  const [h, m] = t.split(":");
  return parseInt(`${parseInt(h, 10)}${m}`, 10);
}

/* =========================
   ATTENDANCE LABEL HELPER
   - full: "Late in Early out - Overtime"
   - short: "LIEO-Overtime"
========================= */
function buildAttendanceLabels(ts) {
  // ts: { attendance, shift_start, shift_end, time_in, time_out, worked_hours, overtime_status, overtime_hours }

  const attRaw = (ts.attendance || "").toLowerCase();

  // Explicit absent
  if (attRaw === "absent") {
    return { full: "Absent", short: "ABSENT" };
  }

  const shiftStart = ts.shift_start;
  const shiftEnd   = ts.shift_end;
  const timeIn     = ts.time_in;
  const timeOut    = ts.time_out;

  const worked =
    ts.worked_hours != null ? Number(ts.worked_hours) : null;

  const otStatus = (ts.overtime_status || "none").toLowerCase();
  const otHours  =
    ts.overtime_hours != null ? Number(ts.overtime_hours) : 0;

  const fullParts  = [];
  const shortParts = [];

  // Late In / Early In
  if (shiftStart && timeIn) {
    if (timeIn > shiftStart) {
      fullParts.push("Late in");
      shortParts.push("LI");
    } else if (timeIn < shiftStart) {
      fullParts.push("Early in");
      shortParts.push("EI");
    }
  }

  // Early Out / Late Out
  if (shiftEnd && timeOut) {
    if (timeOut < shiftEnd) {
      fullParts.push("Early out");
      shortParts.push("EO");
    } else if (timeOut > shiftEnd) {
      fullParts.push("Late out");
      shortParts.push("LO");
    }
  }

  // Decide suffix: -Overtime or -Undertime
  let suffixFull  = "";
  let suffixShort = "";

  if (otStatus === "approved" && otHours > 0) {
    suffixFull  = " - Overtime";
    suffixShort = "-Overtime";
  } else if (worked != null && worked > 0 && worked < 8) {
    // Less than 8 regular hours worked ⇒ undertime
    suffixFull  = " - Undertime";
    suffixShort = "-Undertime";
  }

  // If no flags at all → Present
  if (!fullParts.length && !suffixFull) {
    return { full: "Present", short: "Present" };
  }

  const baseFull  = fullParts.length ? fullParts.join(" ") : "Present";
  const baseShort = shortParts.length ? shortParts.join("") : "Present";

  return {
    full:  baseFull  + suffixFull,   // e.g. "Late in Early out - Overtime"
    short: baseShort + suffixShort   // e.g. "LIEO-Overtime"
  };
}



/* =========================
   AUTH ROUTES
========================= */

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const rows = await sql`
      SELECT id, name, email, password_hash, role, status
      FROM users
      WHERE email = ${email}
    `;

    if (!rows.length) return res.status(401).json({ error: "Invalid login" });

    const user = rows[0];

    if (!user.password_hash) {
      return res.status(401).json({ error: "No password set" });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid login" });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        error: "Account pending approval or deactivated"
      });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        status: user.status
      }
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* =========================
   EMPLOYEE REGISTRATION
========================= */

app.post("/register", async (req, res) => {
  const {
    name,
    email,
    password,
    phone,
    date_hired,
    position,
    employment_type,
    street,
    barangay,
    city,
    province,
    country,
    postal_code
  } = req.body;

  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length) return res.status(400).json({ error: "Email already registered" });

    const year = new Date(date_hired).getFullYear().toString().slice(-2);

    const count = await sql`
      SELECT COUNT(*)::int AS total
      FROM users
      WHERE EXTRACT(YEAR FROM date_hired) =
            EXTRACT(YEAR FROM ${date_hired}::date)
    `;

    const seq = String(count[0].total + 1).padStart(3, "0");
    const employee_id = `${year}${seq}`;

    const password_hash = bcrypt.hashSync(password, 10);

    await sql`
      INSERT INTO users (
        employee_id,
        name,
        email,
        password_hash,
        role,
        phone,
        date_hired,
        position,
        employment_type,
        street,
        barangay,
        city,
        province,
        country,
        postal_code,
        status
      )
      VALUES (
        ${employee_id},
        ${name},
        ${email},
        ${password_hash},
        'employee',
        ${phone || null},
        ${date_hired || null},
        ${position || null},
        ${employment_type || null},
        ${street || null},
        ${barangay || null},
        ${city || null},
        ${province || null},
        ${country || null},
        ${postal_code || null},
        'pending'
      )
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* =========================
   EMPLOYEES (ADMIN ONLY)
========================= */

app.get("/employees", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT
        u.id,
        u.employee_id,
        u.name,
        u.email,
        u.role,
        u.phone,
        u.date_hired,
        u.employment_type,
        u.status,
        u.created_at,
        u.daily_rate,
        COALESCE(
          json_agg(
            json_build_object(
              'id', b.id,
              'bank_name', b.bank_name,
              'account_name', b.account_name,
              'account_number', b.account_number
            )
          ) FILTER (WHERE b.id IS NOT NULL),
          '[]'
        ) AS bank_accounts
      FROM users u
      LEFT JOIN user_bank_accounts b
        ON b.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `;

    res.json(rows);
  } catch (err) {
    console.error("LOAD EMPLOYEES ERROR:", err);
    res.status(500).json({ error: "Failed to load employees" });
  }
});

/* =========================
   EMPLOYEE PROFILE (OWNER OR ADMIN)
========================= */

app.get("/employee/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const rows = await sql`
      SELECT
        id,
        employee_id,
        name,
        email,
        role,
        status,
        phone,
        date_hired,
        position,
        employment_type,
        street,
        barangay,
        city,
        province,
        country,
        postal_code,
        daily_rate
      FROM users
      WHERE id = ${id}::int
    `;

    if (!rows.length) return res.status(404).json({ error: "Employee not found" });

    res.json(rows[0]);
  } catch (err) {
    console.error("LOAD PROFILE ERROR:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

app.post("/employee/:id/update", requireAuth, async (req, res) => {
  const employeeId = req.params.id;

  if (req.user.role !== "admin" && String(req.user.id) !== String(employeeId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const {
    name,
    phone,
    position,
    employment_type,

    // admin-only fields
    role,
    status,

    // address fields
    street,
    barangay,
    city,
    province,
    country,
    postal_code,

    // new
    daily_rate
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  try {
    if (req.user.role === "admin") {
      await sql`
        UPDATE users
        SET
          name = ${name},
          phone = ${phone || null},
          position = ${position || null},
          employment_type = ${employment_type || null},
          role = ${role || 'employee'},
          status = ${status || 'active'},
          daily_rate = ${daily_rate != null ? Number(daily_rate) : null},
          street = ${street || null},
          barangay = ${barangay || null},
          city = ${city || null},
          province = ${province || null},
          country = ${country || null},
          postal_code = ${postal_code || null}
        WHERE id = ${employeeId}::int
      `;
    } else {
      // Non-admin: can update basic info but NOT role/status/daily_rate
      await sql`
        UPDATE users
        SET
          name = ${name},
          phone = ${phone || null},
          position = ${position || null},
          employment_type = ${employment_type || null},
          street = ${street || null},
          barangay = ${barangay || null},
          city = ${city || null},
          province = ${province || null},
          country = ${country || null},
          postal_code = ${postal_code || null}
        WHERE id = ${employeeId}::int
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("UPDATE PROFILE ERROR:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

/* =========================
   BANK ACCOUNTS (OWNER OR ADMIN)
========================= */

app.get("/employee/:id/banks", requireAuth, async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const rows = await sql`
      SELECT id, bank_name, account_name, account_number
      FROM user_bank_accounts
      WHERE user_id = ${id}::int
      ORDER BY id DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error("LOAD BANKS ERROR:", err);
    res.status(500).json({ error: "Failed to load banks" });
  }
});

// Replace all banks (owner or admin)
app.post("/employee/:id/banks", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { rows } = req.body;

  if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    await sql`DELETE FROM user_bank_accounts WHERE user_id = ${id}::int`;

    for (const r of rows || []) {
      await sql`
        INSERT INTO user_bank_accounts
          (user_id, bank_name, account_name, account_number)
        VALUES
          (${id}::int, ${r.bank_name || null}, ${r.account_name || null}, ${r.account_number || null})
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("SAVE BANKS ERROR:", err);
    res.status(500).json({ error: "Failed to save banks" });
  }
});

/* =========================
   ADMIN – ACTIVATE / DEACTIVATE USER
========================= */

app.post("/admin/toggle-user", requireAuth, requireAdmin, async (req, res) => {
  const { user_id, status } = req.body;

  try {
    await sql`
      UPDATE users
      SET status = ${status}
      WHERE id = ${user_id}::int
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("TOGGLE USER ERROR:", err);
    res.status(500).json({ error: "Failed to update user status" });
  }
});

/* =========================
   SHIFTS + CALENDAR
========================= */

// Read shifts for a week
// ✅ optionalAuth so calendar can load even if token missing
app.get("/shifts", optionalAuth, async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Missing week" });

  const userId = req.user?.id || null;

  try {
    const shifts = await sql`
      SELECT
        s.id,
        TO_CHAR(s.shift_date::date, 'YYYY-MM-DD') AS shift_date,
        s.start_time,
        s.end_time,
        s.slots,
        s.area,

        COUNT(*) FILTER (
          WHERE sa_all.status IN ('approved', 'pending')
        )::int AS claimed,

        STRING_AGG(u_all.name, ', ')
          FILTER (WHERE sa_all.status IN ('approved', 'pending')) AS claimed_names,

        sa_user.status AS my_status,
        sa_user.cancellation_status,
        CASE WHEN sa_user.user_id IS NOT NULL THEN true ELSE false END AS is_mine

      FROM shifts s
      LEFT JOIN shift_assignments sa_all ON sa_all.shift_id = s.id
      LEFT JOIN users u_all ON u_all.id = sa_all.user_id

      LEFT JOIN shift_assignments sa_user
        ON sa_user.shift_id = s.id
        AND sa_user.user_id = ${userId}

      WHERE s.shift_date::date BETWEEN ${week}::date
        AND (${week}::date + INTERVAL '6 days')

      GROUP BY s.id, sa_user.status, sa_user.cancellation_status, sa_user.user_id
      ORDER BY s.shift_date, s.start_time
    `;

    const dayOffs = await sql`
      SELECT
        TO_CHAR(d.off_date::date, 'YYYY-MM-DD') AS off_date,
        d.status,
        u.name
      FROM day_off_requests d
      JOIN users u ON u.id = d.user_id
      WHERE d.status != 'rejected'
        AND d.off_date BETWEEN ${week}::date
        AND (${week}::date + INTERVAL '6 days')
      ORDER BY d.off_date, u.name
    `;

    res.json({ shifts, dayOffs });
  } catch (err) {
    console.error("LOAD SHIFTS ERROR:", err);
    res.status(500).json({ error: "Failed to load shifts" });
  }
});

// Admin create shift
app.post("/shifts", requireAuth, requireAdmin, async (req, res) => {
  const { date, start_time, end_time, slots, area } = req.body;
  const adminId = req.user.id;

  if (!date || !start_time || !end_time || !slots) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await sql`
      INSERT INTO shifts (shift_date, start_time, end_time, slots, area, created_by)
      VALUES (${date}, ${start_time}, ${end_time}, ${slots}, ${area || "barista"}, ${adminId})
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("CREATE SHIFT ERROR:", err);
    res.status(500).json({ error: "Failed to create shift" });
  }
});

// Claim shift
app.post("/shifts/:id/claim", requireAuth, async (req, res) => {
  const shiftId = req.params.id;
  const user_id = req.user.id;

  try {
    const [user] = await sql`SELECT status FROM users WHERE id = ${user_id}::int`;
    if (!user || user.status !== "active") {
      return res.status(403).json({ error: "Account not active" });
    }

    const [shift] = await sql`
      SELECT shift_date::date AS shift_date
      FROM shifts
      WHERE id = ${shiftId}::int
    `;
    if (!shift) return res.status(404).json({ error: "Shift not found" });

    // block duplicate same-day shift if pending/approved and not cancelled
    const [existing] = await sql`
      SELECT sa.id
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
      WHERE sa.user_id = ${user_id}::int
        AND s.shift_date::date = ${shift.shift_date}
        AND sa.status IN ('pending', 'approved')
        AND sa.cancellation_status IS NULL
      LIMIT 1
    `;
    if (existing) {
      return res.status(400).json({
        error: "You already have a shift on this day. Request cancellation first."
      });
    }

    const [count] = await sql`
      SELECT
        slots,
        COUNT(sa.id) FILTER (WHERE sa.status IN ('pending', 'approved'))::int AS claimed
      FROM shifts s
      LEFT JOIN shift_assignments sa ON sa.shift_id = s.id
      WHERE s.id = ${shiftId}::int
      GROUP BY s.id
    `;

    if (!count) return res.status(404).json({ error: "Shift not found" });
    if (count.claimed >= count.slots) {
      return res.status(400).json({ error: "Shift is already full" });
    }

    await sql`
      INSERT INTO shift_assignments (shift_id, user_id, status)
      VALUES (${shiftId}::int, ${user_id}::int, 'pending')
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("CLAIM SHIFT ERROR:", err);
    res.status(500).json({ error: "Failed to claim shift" });
  }
});

// Delete shift (admin)
app.delete("/shifts/:id", requireAuth, requireAdmin, async (req, res) => {
  const shiftId = req.params.id;

  try {
    await sql`DELETE FROM shift_assignments WHERE shift_id = ${shiftId}::int`;
    await sql`DELETE FROM shifts WHERE id = ${shiftId}::int`;
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE SHIFT ERROR:", err);
    res.status(500).json({ error: "Failed to delete shift" });
  }
});

// Request cancellation (employee)
app.post("/shifts/:id/request-cancel", requireAuth, async (req, res) => {
  const shiftId = req.params.id;
  const user_id = req.user.id;

  try {
    const [row] = await sql`
      SELECT id, status
      FROM shift_assignments
      WHERE shift_id = ${shiftId}::int
        AND user_id = ${user_id}::int
        AND cancellation_status IS NULL
      LIMIT 1
    `;

    if (!row) return res.status(400).json({ error: "No shift found to cancel" });

    // Pending -> delete immediately
    if (row.status === "pending") {
      await sql`DELETE FROM shift_assignments WHERE id = ${row.id}::int`;
      return res.json({ ok: true, cancelled: true });
    }

    // Approved -> request cancel
    if (row.status === "approved") {
      await sql`
        UPDATE shift_assignments
        SET cancellation_status = 'requested'
        WHERE id = ${row.id}::int
      `;
      return res.json({ ok: true, requested: true });
    }

    res.status(400).json({ error: "Invalid shift state" });
  } catch (err) {
    console.error("REQUEST CANCEL ERROR:", err);
    res.status(500).json({ error: "Failed to cancel shift" });
  }
});

// My shifts
app.get("/my-shifts", requireAuth, async (req, res) => {
  const user_id = req.user.id;

  try {
    const rows = await sql`
      SELECT
        sa.id AS assignment_id,
        s.id AS shift_id,
        TO_CHAR(s.shift_date::date, 'YYYY-MM-DD') AS shift_date,
        s.start_time,
        s.end_time,
        sa.status,
        sa.cancellation_status
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
      WHERE sa.user_id = ${user_id}::int
      ORDER BY s.shift_date, s.start_time
    `;
    res.json(rows);
  } catch (err) {
    console.error("MY SHIFTS ERROR:", err);
    res.status(500).json({ error: "Failed to load my shifts" });
  }
});

/* =========================
   ADMIN – SHIFT CLAIMS / APPROVALS
========================= */

app.get("/admin/shift-claims", requireAuth, requireAdmin, async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Missing week" });

  try {
    const rows = await sql`
      SELECT
        sa.id AS assignment_id,
        sa.user_id AS employee_id,
        u.name AS employee_name,
        s.id AS shift_id,
        s.shift_date::date AS shift_date,
        s.start_time,
        s.end_time,
        sa.status,
        sa.cancellation_status
      FROM shift_assignments sa
      JOIN users u ON u.id = sa.user_id
      JOIN shifts s ON s.id = sa.shift_id
      WHERE
        s.shift_date::date BETWEEN ${week}::date
        AND (${week}::date + INTERVAL '6 days')
        AND (
          sa.status = 'pending'
          OR sa.cancellation_status = 'requested'
          OR sa.status = 'approved'
        )
      ORDER BY u.name, s.shift_date, s.start_time
    `;
    res.json(rows);
  } catch (err) {
    console.error("ADMIN SHIFT CLAIMS ERROR:", err);
    res.status(500).json({ error: "Failed to load shift claims" });
  }
});

app.post("/admin/approve-shift", requireAuth, requireAdmin, async (req, res) => {
  const { assignment_id } = req.body;
  if (!assignment_id) return res.status(400).json({ error: "Missing assignment_id" });

  try {
    await sql`
      UPDATE shift_assignments
      SET status='approved'
      WHERE id=${assignment_id}::int
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    res.status(500).json({ error: "Approval failed" });
  }
});

app.post("/admin/reject-shift", requireAuth, requireAdmin, async (req, res) => {
  const { assignment_id } = req.body;
  if (!assignment_id) return res.status(400).json({ error: "Missing assignment_id" });

  try {
    await sql`
      DELETE FROM shift_assignments
      WHERE id=${assignment_id}::int
        AND status='pending'
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("REJECT ERROR:", err);
    res.status(500).json({ error: "Rejection failed" });
  }
});

app.post("/admin/approve-cancel", requireAuth, requireAdmin, async (req, res) => {
  const { assignment_id } = req.body;
  if (!assignment_id) return res.status(400).json({ error: "Missing assignment_id" });

  try {
    await sql`
      DELETE FROM shift_assignments
      WHERE id=${assignment_id}::int
        AND cancellation_status='requested'
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("APPROVE CANCEL ERROR:", err);
    res.status(500).json({ error: "Failed to approve cancellation" });
  }
});

app.post("/admin/reject-cancel", requireAuth, requireAdmin, async (req, res) => {
  const { assignment_id } = req.body;
  if (!assignment_id) return res.status(400).json({ error: "Missing assignment_id" });

  try {
    await sql`
      UPDATE shift_assignments
      SET cancellation_status='rejected'
      WHERE id=${assignment_id}::int
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("REJECT CANCEL ERROR:", err);
    res.status(500).json({ error: "Failed to reject cancellation" });
  }
});

app.post("/admin/approve-shifts-batch", requireAuth, requireAdmin, async (req, res) => {
  const { assignment_ids } = req.body;

  if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
    return res.status(400).json({ error: "No assignments provided" });
  }

  try {
    await sql`
      UPDATE shift_assignments
      SET status = 'approved'
      WHERE id = ANY(${assignment_ids})
        AND status = 'pending'
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("BATCH APPROVE ERROR:", err);
    res.status(500).json({ error: "Batch approve failed" });
  }
});

/* =========================
   DAY-OFF REQUESTS
========================= */

// Employee request day-off
app.post("/day-off", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { off_date, reason } = req.body;

  if (!off_date) return res.status(400).json({ error: "Missing off_date" });

  try {
    await sql`
      INSERT INTO day_off_requests (user_id, off_date, reason, status, created_at)
      VALUES (${user_id}::int, ${off_date}, ${reason || null}, 'pending', NOW())
    `;
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "You already filed a day-off for this date" });
    }
    console.error("DAY OFF ERROR:", err);
    res.status(500).json({ error: "Failed to file day-off" });
  }
});

// Calendar week view day-offs (read-only; optionalAuth)
app.get("/day-offs", optionalAuth, async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).json({ error: "Missing week" });

  try {
    const rows = await sql`
      SELECT
        TO_CHAR(d.off_date::date, 'YYYY-MM-DD') AS off_date,
        d.status,
        u.name
      FROM day_off_requests d
      JOIN users u ON u.id = d.user_id
      WHERE d.status != 'rejected'
        AND d.off_date BETWEEN ${week}::date
        AND (${week}::date + INTERVAL '6 days')
      ORDER BY d.off_date, u.name
    `;
    res.json(rows);
  } catch (err) {
    console.error("LOAD DAY OFFS (CAL) ERROR:", err);
    res.status(500).json({ error: "Failed to load day-offs" });
  }
});

// Admin view all day-offs
app.get("/admin/day-offs", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT d.id, d.off_date, d.status, d.reason, u.name, u.employee_id
      FROM day_off_requests d
      JOIN users u ON u.id = d.user_id
      ORDER BY d.off_date, u.name
    `;
    res.json(rows);
  } catch (err) {
    console.error("LOAD DAY OFFS ERROR:", err);
    res.status(500).json({ error: "Failed to load day-offs" });
  }
});

app.post("/admin/day-off/approve", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    await sql`UPDATE day_off_requests SET status='approved' WHERE id=${id}::int`;
    res.json({ ok: true });
  } catch (err) {
    console.error("APPROVE DAY OFF ERROR:", err);
    res.status(500).json({ error: "Failed to approve day-off" });
  }
});

app.post("/admin/day-off/reject", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    await sql`UPDATE day_off_requests SET status='rejected' WHERE id=${id}::int`;
    res.json({ ok: true });
  } catch (err) {
    console.error("REJECT DAY OFF ERROR:", err);
    res.status(500).json({ error: "Failed to reject day-off" });
  }
});

/* =========================
   ADMIN – REGISTRATION APPROVAL
========================= */

app.get("/admin/pending-users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, name, email, date_hired, created_at
      FROM users
      WHERE status='pending'
      ORDER BY created_at ASC
    `;
    res.json(rows);
  } catch (err) {
    console.error("LOAD PENDING USERS ERROR:", err);
    res.status(500).json({ error: "Failed to load pending users" });
  }
});

app.post("/admin/approve-user", requireAuth, requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    await sql`UPDATE users SET status='active' WHERE id=${user_id}::int`;
    res.json({ ok: true });
  } catch (err) {
    console.error("APPROVE USER ERROR:", err);
    res.status(500).json({ error: "Failed to approve user" });
  }
});

/* =========================
   PAYSLIPS
========================= */

// Admin upload payslip
app.post(
  "/admin/payslips/upload",
  requireAuth,
  requireAdmin,
  payslipUpload.single("file"),
  async (req, res) => {
    const { employee_id } = req.body;

    try {
      if (!employee_id) return res.status(400).json({ error: "Missing employee_id" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      await sql`
        INSERT INTO payslips (user_id, filename, original_name)
        VALUES (${employee_id}::int, ${req.file.filename}, ${req.file.originalname})
      `;

      res.json({ ok: true });
    } catch (err) {
      console.error("UPLOAD PAYSLIP ERROR:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// Employee list own payslips OR admin view someone else's
app.get("/payslips", requireAuth, async (req, res) => {
  const requester = req.user;            // { id, role, ... }
  const { user_id } = req.query;

  let targetId = requester.id;

  // If admin passes ?user_id=, allow viewing that employee's payslips
  if (user_id && requester.role === "admin") {
    const parsed = Number(user_id);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "Invalid user_id" });
    }
    targetId = parsed;
  }

  try {
    const rows = await sql`
      SELECT id, original_name, created_at
      FROM payslips
      WHERE user_id = ${targetId}::int
      ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error("LOAD PAYSLIPS ERROR:", err);
    res.status(500).json({ error: "Failed to load payslips" });
  }
});

// Employee download own payslip
// Employee OR admin download payslip
app.get("/payslips/:id/download", requireAuth, async (req, res) => {
  const { id } = req.params;
  const requester = req.user;

  try {
    let rows;

    if (requester.role === "admin") {
      // Admin can download any payslip by id
      rows = await sql`
        SELECT *
        FROM payslips
        WHERE id = ${id}::int
      `;
    } else {
      // Employees can only download their own payslips
      rows = await sql`
        SELECT *
        FROM payslips
        WHERE id = ${id}::int
          AND user_id = ${requester.id}::int
      `;
    }

    const row = rows[0];
    if (!row) return res.status(403).send("Access denied");

    const filePath = path.join(__dirname, "uploads/payslips", row.filename);
    res.download(filePath, row.original_name);
  } catch (err) {
    console.error("DOWNLOAD PAYSLIP ERROR:", err);
    res.status(500).send("Download failed");
  }
});

// =========================
// EMPLOYEE – SYSTEM PAYROLL RECORDS
// =========================
app.get("/my-payrolls", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const rows = await sql`
      SELECT
        id,
        user_id,
        cutoff_from,
        cutoff_to,
        final_basic,
        final_overtime,
        final_income,
        vale_amount,
        vale_ref,
        loan_amount,
        loan_ref,
        other_amount,
        other_particulars,
        bank_ref,
        status,
        created_at,
        updated_at
      FROM payroll_cutoffs
      WHERE user_id = ${userId}::int
      ORDER BY cutoff_from DESC, cutoff_to DESC, created_at DESC
    `;
    res.json(rows);
  } catch (err) {
    console.error("MY PAYROLLS ERROR:", err);
    res.status(500).json({ error: "Failed to load payroll records" });
  }
});

/* =========================
   ADMIN – CSV SHIFT IMPORT
========================= */

app.post(
  "/admin/import-shifts",
  requireAuth,
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const adminId = req.user.id;

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const content = fs.readFileSync(req.file.path);

      const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      let inserted = 0;

      for (const r of records) {
        const date = normalizeDate(r.date);
        const start = normalizeTime(r.start_time);
        const end = normalizeTime(r.end_time);
        const slots = Number(r.slots);
        const area = (r.area || "barista").toLowerCase();

        if (!date || !start || !end || !slots) continue;

        await sql`
          INSERT INTO shifts (shift_date, start_time, end_time, slots, area, created_by)
          VALUES (${date}, ${start}, ${end}, ${slots}, ${area}, ${adminId}::int)
        `;
        inserted++;
      }

      fs.unlinkSync(req.file.path);

      res.json({ ok: true, imported: inserted });
    } catch (err) {
      console.error("CSV IMPORT ERROR:", err);
      res.status(500).json({ error: "Failed to import CSV" });
    }
  }
);

/* =========================
   TIMESHEETS
========================= */

// Save timesheets (owner only)
app.post("/timesheets", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { rows } = req.body;

  try {
    for (const r of rows || []) {
      if (!r.work_date) continue;

      let workDate = r.work_date;
      let shiftId = r.shift_id || null;

      // if shiftId given, resolve workDate from shift
      if (shiftId) {
        const [s] = await sql`SELECT shift_date FROM shifts WHERE id = ${shiftId}::int`;
        if (!s) continue;
        workDate = s.shift_date;
      }

      // block edits if locked
      const [existingTs] = await sql`
        SELECT locked
        FROM timesheets
        WHERE user_id = ${user_id}::int
          AND work_date = ${workDate}::date
        LIMIT 1
      `;

      if (existingTs?.locked) {
        return res.status(403).json({
          error: `Timesheet is locked for ${workDate}. Editing is not allowed.`
        });
      }

      // OT status
      const otStatus = (r.overtime_claimed && r.overtime_hours) ? "pending" : "none";

      await sql`
        INSERT INTO timesheets (
          user_id,
          shift_id,
          work_date,
          time_in,
          time_out,
          worked_hours,
          attendance,
          overtime_claimed,
          overtime_hours,
          overtime_status,
          overtime_rejection_reason,
          overtime_rejection_seen,
          remarks
        )
        VALUES (
          ${user_id}::int,
          ${shiftId ? Number(shiftId) : null},
          ${workDate},
          ${r.time_in || null},
          ${r.time_out || null},
          ${r.worked_hours || null},
          ${r.attendance || 'present'},
          ${r.overtime_claimed || false},
          ${r.overtime_hours || null},
          ${otStatus},
          ${null},
          ${false},
          ${r.remarks || null}
        )
        ON CONFLICT (user_id, work_date)
        DO UPDATE SET
          shift_id = EXCLUDED.shift_id,
          time_in = EXCLUDED.time_in,
          time_out = EXCLUDED.time_out,
          worked_hours = EXCLUDED.worked_hours,
          attendance = EXCLUDED.attendance,
          overtime_claimed = EXCLUDED.overtime_claimed,
          overtime_hours = EXCLUDED.overtime_hours,
          overtime_status = EXCLUDED.overtime_status,
          overtime_rejection_reason = EXCLUDED.overtime_rejection_reason,
          overtime_rejection_seen = EXCLUDED.overtime_rejection_seen,
          remarks = EXCLUDED.remarks
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("SAVE TIMESHEETS ERROR:", err);
    res.status(500).json({ error: "Failed to save timesheets" });
  }
});

// Get timesheets (owner only)
// Get timesheets (owner only)
app.get("/timesheets", requireAuth, async (req, res) => {
  const user_id = req.user.id;

  try {
    const rows = await sql`
      SELECT
        t.id,
        t.shift_id,
        TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
        s.start_time AS shift_start,
        s.end_time   AS shift_end,
        t.time_in,
        t.time_out,
        t.worked_hours,
        t.attendance,
        t.overtime_claimed,
        t.overtime_hours,
        t.locked,
        t.overtime_status,
        t.overtime_rejection_reason,
        t.overtime_rejection_seen,
        t.remarks
      FROM timesheets t
      LEFT JOIN shifts s ON s.id = t.shift_id
      WHERE t.user_id = ${user_id}::int
      ORDER BY t.work_date
    `;

    const enriched = rows.map(r => {
      const labels = buildAttendanceLabels(r);
      return {
        ...r,
        attendance_full:  labels.full,
        attendance_short: labels.short
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("LOAD TIMESHEETS ERROR:", err);
    res.status(500).json({ error: "Failed to load timesheets" });
  }
});

app.get("/timesheets/exists", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { work_date } = req.query;

  if (!work_date) return res.status(400).json({ error: "Missing work_date" });

  try {
    const rows = await sql`
      SELECT id
      FROM timesheets
      WHERE user_id = ${user_id}::int
        AND work_date = ${work_date}::date
      LIMIT 1
    `;
    res.json({ exists: rows.length > 0, id: rows[0]?.id || null });
  } catch (err) {
    console.error("TIMESHEETS EXISTS ERROR:", err);
    res.status(500).json({ error: "Failed to check" });
  }
});

// =========================
// ADMIN – TIMESHEET VIEW / EXPORT / LOCK / OT
// =========================

app.get("/admin/timesheets", requireAuth, requireAdmin, async (req, res) => {
  const { from, to, user_id } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to" });
  }

  try {
    let rows;

    if (user_id) {
      // Filter by specific employee
      rows = await sql`
        SELECT
          t.id,
          u.employee_id,
          u.name,
          TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
          s.start_time AS shift_start,
          s.end_time   AS shift_end,
          t.time_in,
          t.time_out,
          t.worked_hours,
          t.attendance,
          t.overtime_hours,
          t.locked,
          t.overtime_status,
          t.overtime_rejection_reason,
          t.remarks
        FROM timesheets t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN shifts s ON s.id = t.shift_id
        WHERE
          t.work_date::date BETWEEN ${from}::date AND ${to}::date
          AND t.user_id = ${user_id}::int
        ORDER BY u.name, t.work_date
      `;
    } else {
      // All employees
      rows = await sql`
        SELECT
          t.id,
          u.employee_id,
          u.name,
          TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
          s.start_time AS shift_start,
          s.end_time   AS shift_end,
          t.time_in,
          t.time_out,
          t.worked_hours,
          t.attendance,
          t.overtime_hours,
          t.locked,
          t.overtime_status,
          t.overtime_rejection_reason,
          t.remarks
        FROM timesheets t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN shifts s ON s.id = t.shift_id
        WHERE
          t.work_date::date BETWEEN ${from}::date AND ${to}::date
        ORDER BY u.name, t.work_date
      `;
    }

    const withPayroll = rows.map(r => {
      const labels = buildAttendanceLabels(r);

      const rounded_in  = r.time_in  ? roundTo30Minutes(r.time_in)   : null;
      const rounded_out = r.time_out ? roundTo30Minutes(r.time_out)  : null;

      return {
        ...r,
        attendance_full:  labels.full,
        attendance_short: labels.short,
        rounded_in,
        rounded_out,
        payroll_in:  rounded_in  ? timeToPayrollNumber(rounded_in)  : null,
        payroll_out: rounded_out ? timeToPayrollNumber(rounded_out) : null
      };
    });

    res.json(withPayroll);
  } catch (err) {
    console.error("ADMIN TIMESHEET VIEW ERROR:", err);
    res.status(500).json({ error: "Failed to load timesheets" });
  }
});

app.get("/timesheets.csv", requireAuth, requireAdmin, async (req, res) => {
  const { from, to, user_id } = req.query;
  if (!from || !to) {
    return res.status(400).send("Missing from/to");
  }

  try {
    let rows;

    if (user_id) {
      rows = await sql`
        SELECT
          t.id,
          u.employee_id,
          u.name,
          TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
          t.time_in,
          t.time_out,
          t.attendance,
          t.overtime_hours,
          t.locked,
          t.overtime_status,
          t.overtime_rejection_reason,
          t.remarks
        FROM timesheets t
        JOIN users u ON u.id = t.user_id
        WHERE
          t.work_date::date BETWEEN ${from}::date AND ${to}::date
          AND t.user_id = ${user_id}::int
        ORDER BY u.name, t.work_date
      `;
    } else {
      rows = await sql`
        SELECT
          t.id,
          u.employee_id,
          u.name,
          TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
          t.time_in,
          t.time_out,
          t.attendance,
          t.overtime_hours,
          t.locked,
          t.overtime_status,
          t.overtime_rejection_reason,
          t.remarks
        FROM timesheets t
        JOIN users u ON u.id = t.user_id
        WHERE
          t.work_date::date BETWEEN ${from}::date AND ${to}::date
        ORDER BY u.name, t.work_date
      `;
    }

    // ... your existing CSV building logic using rows ...
  } catch (err) {
    console.error("TIMESHEETS CSV ERROR:", err);
    res.status(500).send("Failed to generate CSV");
  }
});

// Employee FINALIZE timesheet for a cutoff (locks only this user's rows in that range)
// and REQUIRES that every day in the cutoff has a timesheet row (present or absent)
app.post("/timesheets/finalize-cutoff", requireAuth, async (req, res) => {
  const { from, to } = req.body;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to" });
  }

  try {
    // 1) Find all days in the cutoff with NO timesheet for this user
    const missing = await sql`
      WITH all_days AS (
        SELECT generate_series(${from}::date, ${to}::date, INTERVAL '1 day')::date AS d
      )
      SELECT d
      FROM all_days a
      LEFT JOIN timesheets t
        ON t.user_id = ${req.user.id}::int
       AND t.work_date::date = a.d
      WHERE t.id IS NULL
      ORDER BY d
    `;

    if (missing.length > 0) {
      return res.status(400).json({
        error: "You still have days without timesheets or ABSENT marked.",
        missing_dates: missing.map(r => r.d)   // array of dates
      });
    }

    // 2) All days covered => lock this user's rows for the cutoff
    await sql`
      UPDATE timesheets
      SET locked = TRUE
      WHERE user_id = ${req.user.id}::int
        AND work_date BETWEEN ${from}::date AND ${to}::date
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("FINALIZE CUTOFF ERROR:", err);
    res.status(500).json({ error: "Failed to finalize cutoff" });
  }
});

// Approve OT (locks timesheet)
app.post("/admin/timesheets/:id/approve-ot", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await sql`
      UPDATE timesheets
      SET
        overtime_status = 'approved',
        overtime_rejection_reason = NULL
      WHERE id = ${id}::int
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("APPROVE OT ERROR:", err);
    res.status(500).json({ error: "Failed to approve OT" });
  }
});

// Reject OT (locks timesheet + clears OT)
app.post("/admin/timesheets/:id/reject-ot", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim().length < 3) {
    return res.status(400).json({ error: "Reason is required" });
  }

  try {
    await sql`
      UPDATE timesheets
      SET
        overtime_status = 'rejected',
        overtime_rejection_reason = ${reason.trim()},
        overtime_rejection_seen = FALSE
      WHERE id = ${id}::int
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("REJECT OT ERROR:", err);
    res.status(500).json({ error: "Failed to reject OT" });
  }
});

// Employee acknowledges OT rejection popup
app.post("/timesheets/ack-ot-rejection", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Missing ids" });
  }

  try {
    await sql`
      UPDATE timesheets
      SET overtime_rejection_seen = true
      WHERE user_id = ${user_id}::int
        AND id = ANY(${ids})
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("ACK OT REJECTION ERROR:", err);
    res.status(500).json({ error: "Failed to acknowledge" });
  }
});

// Lock timesheets (admin)
app.post("/admin/lock-timesheets", requireAuth, requireAdmin, async (req, res) => {
  const { from, to, user_id } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to" });
  }

  try {
    if (user_id) {
      // lock only this employee for this cutoff
      await sql`
        UPDATE timesheets
        SET locked = true
        WHERE work_date BETWEEN ${from}::date AND ${to}::date
          AND user_id = ${user_id}::int
      `;
    } else {
      // lock ALL employees for this cutoff
      await sql`
        UPDATE timesheets
        SET locked = true
        WHERE work_date BETWEEN ${from}::date AND ${to}::date
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("LOCK TIMESHEETS ERROR:", err);
    res.status(500).json({ error: "Failed to lock timesheets" });
  }
});

app.post("/admin/unlock-timesheets", requireAuth, requireAdmin, async (req, res) => {
  const { from, to, user_id } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to" });
  }

  try {
    if (user_id) {
      // unlock only this employee for this cutoff
      await sql`
        UPDATE timesheets
        SET locked = false
        WHERE work_date BETWEEN ${from}::date AND ${to}::date
          AND user_id = ${user_id}::int
      `;
    } else {
      // unlock ALL employees for this cutoff
      await sql`
        UPDATE timesheets
        SET locked = false
        WHERE work_date BETWEEN ${from}::date AND ${to}::date
      `;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("UNLOCK TIMESHEETS ERROR:", err);
    res.status(500).json({ error: "Failed to unlock timesheets" });
  }
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: process.env.APP_VERSION || "dev",
    time: new Date().toISOString()
  });
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    const [u] = await sql`
      SELECT id, name, role, status
      FROM users
      WHERE id = ${req.user.id}::int
    `;
    if (!u) return res.status(404).json({ error: "User not found" });
    res.json(u);
  } catch (err) {
    console.error("ME ERROR:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// ==========================
// ADMIN – PAYROLL PREVIEW
// ==========================
app.get("/admin/payroll-preview", requireAuth, requireAdmin, async (req, res) => {
  const { user_id, from, to } = req.query;

  if (!user_id || !from || !to) {
    return res.status(400).json({ error: "Missing user_id/from/to" });
  }

  try {
    // 1) Employee info (daily_rate etc.)
    const users = await sql`
      SELECT id, name, COALESCE(daily_rate, 0) AS daily_rate
      FROM users
      WHERE id = ${user_id}::int
      LIMIT 1
    `;

    if (!users.length) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const emp = users[0];
    const dailyRate = Number(emp.daily_rate || 0);

    if (!dailyRate) {
      return res.status(400).json({
        error: "Daily rate is not set for this employee."
      });
    }

    const hourlyRate   = dailyRate / 8;      // 8 hours base
    const overtimeRate = hourlyRate * 1.25;  // 125%

    // -------- figure out layout (simple vs 1–20 vs 16–5) --------
    const start = new Date(from + "T00:00:00");
    const end   = new Date(to   + "T00:00:00");

    const sameMonth = start.getFullYear() === end.getFullYear() &&
                      start.getMonth()    === end.getMonth();

    const isFirstHalfCutoff =
      sameMonth &&
      start.getDate() === 1 &&
      end.getDate()   === 15;

    const isSecondHalfCutoff =
      sameMonth &&
      start.getDate() === 16 &&
      end.getDate() === new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(); // last day of month

    let displayFrom = from;
    let displayTo   = to;
    let layout      = "simple_cutoff";

    const y = start.getFullYear();
    const m = start.getMonth(); // 0-based
    const pad2 = (n) => String(n).padStart(2, "0");

    if (isFirstHalfCutoff) {
      // e.g. Jan 1–15 cutoff displayed as Jan 1–20
      displayFrom = `${y}-${pad2(m + 1)}-01`;
      displayTo   = `${y}-${pad2(m + 1)}-20`;
      layout      = "first_half_1_20";
    } else if (isSecondHalfCutoff) {
      // e.g. Jan 16–31 cutoff displayed as Jan 16–Feb 05
      const nextMonth = new Date(y, m + 1, 1);
      const ny = nextMonth.getFullYear();
      const nm = nextMonth.getMonth();

      displayFrom = `${y}-${pad2(m + 1)}-16`;
      displayTo   = `${ny}-${pad2(nm + 1)}-05`;
      layout      = "second_half_16_5";
    }

    // Timesheets to read:
    // - first_half_1_20 needs 1..15 (NOT 16..20)
    // - second_half_16_5 needs 16..end (NOT Feb 1..5)
    // - simple_cutoff reads from..to
    let tsFrom = from;
    let tsTo   = to;

    if (layout === "first_half_1_20") {
      tsFrom = from; // 1
      tsTo   = to;   // 15
    } else if (layout === "second_half_16_5") {
      tsFrom = from; // 16
      tsTo   = to;   // end-of-month

    } else if (layout === "second_half_16_5") {
      // displayFrom: 16..end + next month 1..5 (advance)
      // Real cutoff is 16..end (from..to)

      const jsDate2 = new Date(dateStr + "T00:00:00");
      const isAdvanceDay = jsDate2 > end; // beyond cutoff_to => Feb 1..5

      if (isAdvanceDay) {
        attendance      = "advance";
        basicPay        = dailyRate; // advance pay
        paidOtHours     = 0;
        undertimeHours  = 0;
      } else {
        // within 16..end (real cutoff days)
        const tsAtt = ts ? (ts.attendance || "present") : "absent";
        attendance  = tsAtt;

        if (tsAtt !== "absent") {
          undertimeHours = Math.max(0, 9 - workedHours);
        }

        const regularHours =
          tsAtt === "absent"
            ? 0
            : Math.max(0, Math.min(maxRegularHours, 8 - undertimeHours));

        const dueBasic = regularHours * hourlyRate;

        // Jan 16–20 adjustment: already advanced/assumed paid in previous payroll (1–15 displayed to 20)
        const dayNum2 = jsDate2.getDate();
        if (dayNum2 >= 16 && dayNum2 <= 20) {
          const previousBasic = dailyRate;
          basicPay = dueBasic - previousBasic; // present full => 0; absent => -dailyRate
        } else {
          basicPay = dueBasic; // normal (21..end)
        }

        // OT: only approved OT within real cutoff days
        if (otStatusRaw === "approved" && rawOtHours > 0) {
          paidOtHours = rawOtHours;
        }
      }  
    } 

    

    // Helper to iterate dates from...to inclusive
    function* dateRange(startStr, endStr) {
      const startD = new Date(startStr + "T00:00:00");
      const endD   = new Date(endStr   + "T00:00:00");
      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const y   = d.getFullYear();
        const m   = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        yield `${y}-${m}-${day}`;
      }
    }

    // Build short attendance label for payroll (EI, LI, EO, LO, -Overtime, -Undertime)
    function buildAttendanceLabelForDay({
      baseAttendance,
      ts,
      paidOtHours,
      workedHours,
      undertimeHours
    }) {
      // Handle "Advance" and pure "Absent" first
      if (!ts) {
        if (baseAttendance === "advance") return "Advance";
        if (baseAttendance === "absent")  return "ABSENT";
      }

      // If explicit absent in timesheet
      if (ts && (ts.attendance || "").toLowerCase() === "absent") {
        return "ABSENT";
      }

      const tags = [];

      const shiftStart = ts && ts.shift_start;
      const shiftEnd   = ts && ts.shift_end;
      const timeIn     = ts && ts.time_in;
      const timeOut    = ts && ts.time_out;

      // Late In / Early In
      if (shiftStart && timeIn) {
        if (timeIn > shiftStart) {
          tags.push("LI");    // Late In
        } else if (timeIn < shiftStart) {
          tags.push("EI");    // Early In
        }
      }

      // Early Out / Late Out
      if (shiftEnd && timeOut) {
        if (timeOut < shiftEnd) {
          tags.push("EO");    // Early Out
        } else if (timeOut > shiftEnd) {
          tags.push("LO");    // Late Out
        }
      }

      // Decide suffix: -Overtime or -Undertime
      let suffix = "";

      if (paidOtHours && paidOtHours > 0) {
        suffix = "-Overtime";
      } else if (undertimeHours && undertimeHours > 0.01) {
        // some real undertime (ignore tiny float noise)
        suffix = "-Undertime";
      }

      // If no flags at all → Present
      if (!tags.length && !suffix) return "Present";

      return `${tags.join("")}${suffix}`;
    }

    let totalBasic = 0;
    let totalOT    = 0;
    const days     = [];

    const maxRegularHours = 8; // 8 paid hours per day

    // 2) Load timesheets for this user in the real cutoff range
    const tsRows = await sql`
      SELECT
        TO_CHAR(t.work_date::date, 'YYYY-MM-DD') AS work_date,
        t.attendance,
        t.worked_hours,
        t.time_in,
        t.time_out,
        t.overtime_hours,
        t.overtime_status,
        s.start_time AS shift_start,
        s.end_time   AS shift_end
      FROM timesheets t
      LEFT JOIN shifts s ON s.id = t.shift_id
      WHERE t.user_id = ${user_id}::int
        AND t.work_date BETWEEN ${tsFrom}::date AND ${tsTo}::date
    `;

    // Build a map: 'YYYY-MM-DD' -> timesheet row
    const map = new Map();
    for (const r of tsRows) {
      map.set(r.work_date, r); // already "YYYY-MM-DD"
    }
    // -------- main per-day logic --------
    for (const dateStr of dateRange(displayFrom, displayTo)) {
      const jsDate  = new Date(dateStr + "T00:00:00");
      const dayNum  = jsDate.getDate();
      const ts      = map.get(dateStr) || null;

      let attendance      = "absent";
      let workedHours     = ts && ts.worked_hours != null ? Number(ts.worked_hours) : 0;
      if (!Number.isFinite(workedHours) || workedHours < 0) workedHours = 0;

      const rawOtHours  = ts && ts.overtime_hours != null ? Number(ts.overtime_hours) : 0;
      const otStatusRaw = ts && ts.overtime_status
        ? ts.overtime_status.toLowerCase()
        : "none";

      let paidOtHours    = 0;
      let basicPay       = 0;
      let overtimePay    = 0;
      let undertimeHours = 0;

      if (layout === "second_half_16_5") {
        const cutoffEnd = new Date(to + "T00:00:00"); // real cutoff end (e.g. Jan 31)

        if (jsDate <= cutoffEnd) {
          // ---- Jan 16 .. end-of-month (REAL CUTOFF DAYS) ----
          const tsAtt = ts ? (ts.attendance || "present") : "absent";
          attendance = tsAtt;

          if (tsAtt !== "absent") {
            undertimeHours = Math.max(0, 9 - workedHours);
          }

          const regularHours =
            tsAtt === "absent"
              ? 0
              : Math.max(0, Math.min(8, 8 - undertimeHours));

          const dueBasic = regularHours * hourlyRate;

          // Adjustment days: 16–20
          if (jsDate.getDate() >= 16 && jsDate.getDate() <= 20) {
            const previousBasic = dailyRate; // already advanced last cutoff
            basicPay = dueBasic - previousBasic; // present full => 0, absent => -dailyRate
          } else {
            // 21–end: normal actual pay
            basicPay = dueBasic;
          }

          // OT only within real cutoff and only if approved
          if (otStatusRaw === "approved" && rawOtHours > 0) {
            paidOtHours = rawOtHours;
          }
        } else {
          // ---- Feb 1–5 (ADVANCE PAY DAYS) ----
          attendance     = "advance";
          basicPay       = dailyRate;
          paidOtHours    = 0;
          undertimeHours = 0;
        }
      } else if (layout === "first_half_1_20") {
        const cutoffEnd = new Date(to + "T00:00:00"); // real cutoff end (e.g. Feb 15)

        if (jsDate <= cutoffEnd) {
          // ---- Days 1 .. 15 (REAL CUTOFF DAYS) ----
          const tsAtt = ts ? (ts.attendance || "present") : "absent";
          attendance = tsAtt;

          if (tsAtt !== "absent") {
            undertimeHours = Math.max(0, 9 - workedHours);
          }

          const regularHours =
            tsAtt === "absent"
              ? 0
              : Math.max(0, Math.min(8, 8 - undertimeHours));

          const dueBasic = regularHours * hourlyRate;

          // ---- Adjustment days: 1–5 (already advanced last cutoff) ----
          if (jsDate.getDate() >= 1 && jsDate.getDate() <= 5) {
            const previousBasic = dailyRate; // already paid last cutoff
            basicPay = dueBasic - previousBasic; // present full => 0, absent => -dailyRate
          } else {
            // ---- Days 6–15: normal actual pay ----
            basicPay = dueBasic;
          }

          // OT only within real cutoff (6–15) and only if approved
          if (
            jsDate.getDate() >= 6 &&
            otStatusRaw === "approved" &&
            rawOtHours > 0
          ) {
            paidOtHours = rawOtHours;
          }
        } else {
          // ---- Days 16 .. 20 (ADVANCE PAY DAYS) ----
          attendance     = "advance";
          basicPay       = dailyRate;
          paidOtHours    = 0;
          undertimeHours = 0;
        }
      } else {
        // ---- Simple cutoff ----
        const tsAtt = ts ? (ts.attendance || "present") : "absent";
        attendance = tsAtt;

        if (tsAtt !== "absent") {
          undertimeHours = Math.max(0, 9 - workedHours);
        }

        const regularHours =
          tsAtt === "absent"
            ? 0
            : Math.max(0, Math.min(8, 8 - undertimeHours));

        basicPay = regularHours * hourlyRate;

        if (otStatusRaw === "approved" && rawOtHours > 0) {
          paidOtHours = rawOtHours;
        }
      }

      overtimePay = paidOtHours * overtimeRate;

      totalBasic += basicPay;
      totalOT    += overtimePay;

      const attendanceLabel = buildAttendanceLabelForDay({
        baseAttendance: attendance,
        ts,
        paidOtHours,
        workedHours,
        undertimeHours
      });

      days.push({
        date: dateStr,
        attendance,
        attendance_label: attendanceLabel,
        worked_hours: workedHours,
        overtime_hours: paidOtHours,
        undertime_hours: undertimeHours,
        overtime_status: otStatusRaw,
        basic_pay: basicPay,
        overtime_pay: overtimePay,
        total_pay: basicPay + overtimePay
      });
    }

    // 3) Existing payroll_cutoffs record (if any)
    const existing = await sql`
      SELECT
        id,
        user_id,
        cutoff_from,
        cutoff_to,
        final_basic,
        final_overtime,
        final_income,
        vale_amount,
        vale_ref,
        loan_amount,
        loan_ref,
        other_amount,
        other_particulars,
        bank_ref,
        status,
        created_at,
        updated_at
      FROM payroll_cutoffs
      WHERE user_id = ${user_id}::int
        AND cutoff_from = ${from}::date
        AND cutoff_to   = ${to}::date
      LIMIT 1
    `;

    const payrollRecord = existing.length ? existing[0] : null;

    res.json({
      layout,  // "first_half_1_20" or "simple_cutoff"
      employee: {
        id: emp.id,
        name: emp.name,
        daily_rate: dailyRate,
        overtime_rate: overtimeRate,
        cutoff_from: from,
        cutoff_to: to
      },
      days,
      summary: {
        total_basic:    totalBasic,
        total_overtime: totalOT,
        total_income:   totalBasic + totalOT
      },
      payroll_record: payrollRecord
    });
  } catch (err) {
    console.error("PAYROLL PREVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to generate payroll" });
  }
});

// ==========================
// ADMIN – PAYROLL FINALIZE / UNLOCK
// ==========================

app.post("/admin/payroll-finalize", requireAuth, requireAdmin, async (req, res) => {
  const {
    user_id,
    from,
    to,
    final_basic,
    final_overtime,
    final_income,       // NET pay
    vale_amount,
    vale_ref,
    loan_amount,
    loan_ref,
    other_amount,
    other_particulars,
    bank_ref
  } = req.body;

  if (!user_id || !from || !to) {
    return res.status(400).json({ error: "Missing user_id/from/to" });
  }

  const fb = Number(final_basic || 0);
  const fo = Number(final_overtime || 0);
  const fi = Number(final_income || 0);

  const va = Number(vale_amount || 0);
  const la = Number(loan_amount || 0);
  const oa = Number(other_amount || 0);

  try {
    await sql`
      INSERT INTO payroll_cutoffs (
        user_id,
        cutoff_from,
        cutoff_to,
        final_basic,
        final_overtime,
        final_income,
        vale_amount,
        vale_ref,
        loan_amount,
        loan_ref,
        other_amount,
        other_particulars,
        bank_ref,
        status,
        created_at,
        updated_at
      )
      VALUES (
        ${user_id}::int,
        ${from}::date,
        ${to}::date,
        ${fb},
        ${fo},
        ${fi},
        ${va},
        ${vale_ref || null},
        ${la},
        ${loan_ref || null},
        ${oa},
        ${other_particulars || null},
        ${bank_ref || null},
        'finalized',
        NOW(),
        NOW()
      )
      ON CONFLICT (user_id, cutoff_from, cutoff_to)
      DO UPDATE SET
        final_basic       = EXCLUDED.final_basic,
        final_overtime    = EXCLUDED.final_overtime,
        final_income      = EXCLUDED.final_income,
        vale_amount       = EXCLUDED.vale_amount,
        vale_ref          = EXCLUDED.vale_ref,
        loan_amount       = EXCLUDED.loan_amount,
        loan_ref          = EXCLUDED.loan_ref,
        other_amount      = EXCLUDED.other_amount,
        other_particulars = EXCLUDED.other_particulars,
        bank_ref          = EXCLUDED.bank_ref,
        status            = 'finalized',
        updated_at        = NOW()
    `;

    res.json({ ok: true });
  } catch (err) {
    console.error("PAYROLL FINALIZE ERROR:", err);
    res.status(500).json({ error: "Failed to finalize payroll" });
  }
});

app.post("/admin/payroll-unlock", requireAuth, requireAdmin, async (req, res) => {
  const { user_id, from, to } = req.body;

  if (!user_id || !from || !to) {
    return res.status(400).json({ error: "Missing user_id/from/to" });
  }

  try {
    const result = await sql`
      UPDATE payroll_cutoffs
      SET status = 'draft', updated_at = NOW()
      WHERE user_id = ${user_id}::int
        AND cutoff_from = ${from}::date
        AND cutoff_to   = ${to}::date
      RETURNING id
    `;

    if (!result.length) {
      return res.status(404).json({ error: "No payroll record found to unlock." });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("PAYROLL UNLOCK ERROR:", err);
    res.status(500).json({ error: "Failed to unlock payroll" });
  }
});

// ==========================
// PAYROLL PDF (Employee + Admin)
// ==========================
app.get("/my-payrolls/:id/pdf", requireAuth, async (req, res) => {
  const { id } = req.params;
  const requester = req.user;

  try {
    // Admin can see any, employee can see only their own
    const rows = requester.role === "admin"
      ? await sql`
          SELECT
            p.*,
            u.name AS employee_name,
            u.employee_id,
            u.daily_rate
          FROM payroll_cutoffs p
          JOIN users u ON u.id = p.user_id
          WHERE p.id = ${id}::int
          LIMIT 1
        `
      : await sql`
          SELECT
            p.*,
            u.name AS employee_name,
            u.employee_id,
            u.daily_rate
          FROM payroll_cutoffs p
          JOIN users u ON u.id = p.user_id
          WHERE p.id = ${id}::int
            AND p.user_id = ${requester.id}::int
          LIMIT 1
        `;

    if (!rows.length) {
      return res.status(404).json({ error: "Payroll record not found" });
    }

    const p = rows[0];

    // optional: get latest bank account
    const bankRows = await sql`
      SELECT bank_name, account_name, account_number
      FROM user_bank_accounts
      WHERE user_id = ${p.user_id}::int
      ORDER BY id DESC
      LIMIT 1
    `;
    const bank = bankRows[0] || {};

    const finalBasic   = Number(p.final_basic   || 0);
    const finalOT      = Number(p.final_overtime|| 0);
    const finalIncome  = Number(p.final_income  || 0);
    const valeAmount   = Number(p.vale_amount   || 0);
    const loanAmount   = Number(p.loan_amount   || 0);
    const otherAmount  = Number(p.other_amount  || 0);

    // Set PDF headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payslip-${p.cutoff_from}-${p.cutoff_to}.pdf"`
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Header
    doc
      .fontSize(18)
      .text("PAYSLIP", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(10)
      .text(`Cutoff: ${p.cutoff_from} to ${p.cutoff_to}`, { align: "center" })
      .moveDown(1);

    // Employee info
    doc
      .fontSize(11)
      .text(`Employee Name: ${p.employee_name}`, { align: "left" })
      .text(`Employee ID: ${p.employee_id || "-"}`)
      .text(`Status: ${p.status ? p.status.toUpperCase() : "DRAFT"}`)
      .moveDown(1);

    // Bank info
    if (bank.bank_name || p.bank_ref) {
      doc
        .fontSize(11)
        .text("Bank Details:", { underline: true })
        .moveDown(0.3);

      if (bank.bank_name) {
        doc.text(`Bank: ${bank.bank_name}`);
      }
      if (bank.account_name) {
        doc.text(`Account Name: ${bank.account_name}`);
      }
      if (bank.account_number) {
        doc.text(`Account Number: ${bank.account_number}`);
      }
      if (p.bank_ref) {
        doc.text(`Transfer Ref#: ${p.bank_ref}`);
      }

      doc.moveDown(1);
    }

    // Earnings
    doc
      .fontSize(12)
      .text("EARNINGS", { underline: true })
      .moveDown(0.3);

    doc
      .fontSize(11)
      .text(`Basic Pay:    ₱${finalBasic.toFixed(2)}`)
      .text(`Overtime Pay: ₱${finalOT.toFixed(2)}`)
      .moveDown(0.5);

    const gross = finalBasic + finalOT;

    doc
      .fontSize(11)
      .text(`GROSS INCOME: ₱${gross.toFixed(2)}`)
      .moveDown(1);

    // Deductions
    doc
      .fontSize(12)
      .text("DEDUCTIONS / ADJUSTMENTS", { underline: true })
      .moveDown(0.3);

    if (valeAmount || loanAmount || otherAmount) {
      if (valeAmount) {
        doc.text(
          `Vale Amortization: ₱${valeAmount.toFixed(2)}${
            p.vale_ref ? ` (Ref#: ${p.vale_ref})` : ""
          }`
        );
      }
      if (loanAmount) {
        doc.text(
          `Loan Amortization: ₱${loanAmount.toFixed(2)}${
            p.loan_ref ? ` (Ref#: ${p.loan_ref})` : ""
          }`
        );
      }
      if (otherAmount) {
        doc.text(
          `Other Adjustment: ₱${otherAmount.toFixed(2)}${
            p.other_particulars ? ` (${p.other_particulars})` : ""
          }`
        );
      }
    } else {
      doc.text("None");
    }

    doc.moveDown(1);

    // NET PAY
    doc
      .fontSize(12)
      .text(`NET PAY: ₱${finalIncome.toFixed(2)}`, { align: "right" })
      .moveDown(2);

    doc
      .fontSize(8)
      .fillColor("gray")
      .text(
        "System-generated payslip based on finalized timesheets and approved overtime.",
        { align: "center" }
      );

    doc.end();
  } catch (err) {
    console.error("PAYROLL PDF ERROR:", err);
    res.status(500).json({ error: "Failed to generate payslip PDF" });
  }
});


/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));