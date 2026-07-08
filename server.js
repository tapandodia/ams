/* ============================================================================
   PAMS API SERVER — connects the web app to the PostgreSQL 'pams' database
   ----------------------------------------------------------------------------
   1) Edit the DB settings below (especially password)
   2) Run:  npm install   (first time only)
   3) Run:  npm start
   4) Open: http://localhost:3000
   ============================================================================ */
require('dotenv').config();
// ======================= EDIT THESE DATABASE SETTINGS =======================
const DB = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
       ? { rejectUnauthorized: false }
       : false
};
const SERVER_PORT = 3000;
// ============================================================================

const express = require("express");
const crypto  = require("crypto");
const path    = require("path");
const session = require("express-session");
const { Pool } = require("pg");

const pool = new Pool(DB);
const app  = express();
app.use(express.json({ limit: "10mb" }));

// session middleware (simple memory store — fine for local use)
app.use(session({
  secret: 'pams_secret_change_this',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, "public")));
app.set('trust proxy', 1);   // add this line — Render sits behind a proxy

app.use(session({
  secret: process.env.SESSION_SECRET || 'pams_secret_change_this',  // read from env
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));
async function ensureSchema() {
  try {
    const insertStation = await pool.query(
      `INSERT INTO pams.police_stations (station_name)
       VALUES ('Viramgam Division')
       ON CONFLICT (station_name) DO NOTHING
       RETURNING station_id`
    );
    if (insertStation.rows.length) {
      console.log('DB migration: inserted missing station Viramgam Division (station_id=' + insertStation.rows[0].station_id + ')');
    } else {
      console.log('DB migration: station Viramgam Division already exists');
    }
    const col = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='pams' AND table_name='applications' AND column_name='transfer_to_station_id'"
    );
    if (!col.rows.length) {
      console.log('DB migration: adding pams.applications.transfer_to_station_id');
      await pool.query(
        `ALTER TABLE pams.applications
         ADD COLUMN IF NOT EXISTS transfer_to_station_id INT REFERENCES pams.police_stations(station_id)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_app_transfer_to ON pams.applications(transfer_to_station_id)`
      );
    }
    // Split applicant details: name / address / optional 10-digit contact.
    // applicant_name_address stays maintained (combined) so old rows, list search
    // and Excel import keep working.
    await pool.query(`
      ALTER TABLE pams.applications
        ADD COLUMN IF NOT EXISTS applicant_name TEXT,
        ADD COLUMN IF NOT EXISTS applicant_address TEXT,
        ADD COLUMN IF NOT EXISTS applicant_contact TEXT
    `);
    // IO officers per police station (managed by SDPO; used by the form's IO dropdown)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pams.io_officers (
        io_id      SERIAL PRIMARY KEY,
        station_id INT NOT NULL REFERENCES pams.police_stations(station_id),
        io_name    TEXT NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        UNIQUE(station_id, io_name)
      )`);
    // Workflow: station investigates (Pending) -> sends to SDPO (Transferred) ->
    // SDPO finalizes (Complete) or returns for re-investigation (back to Pending).
    await pool.query(`
      CREATE OR REPLACE FUNCTION pams.transfer_to_sdpo(p_app_id TEXT) RETURNS pams.applications AS $$
          UPDATE pams.applications
             SET status = 'Transferred'
           WHERE app_id = p_app_id AND status = 'Pending'
          RETURNING *;
      $$ LANGUAGE sql;
    `);
    await pool.query(`
      CREATE OR REPLACE FUNCTION pams.mark_complete(p_app_id TEXT) RETURNS pams.applications AS $$
          UPDATE pams.applications
             SET status = 'Complete'
           WHERE app_id = p_app_id AND status = 'Transferred'
          RETURNING *;
      $$ LANGUAGE sql;
    `);
    // One-time repair: rows SDPO created/imported under the old logic were INSERTed
    // directly as 'Transferred'. Under the new workflow they should be 'Pending' at
    // the station they were forwarded to. Only touch rows whose history shows no
    // real status change — i.e. never actually sent back to SDPO by a station.
    const fixed = await pool.query(`
      UPDATE pams.applications a
         SET status = 'Pending'
       WHERE a.status = 'Transferred'
         AND a.station_id = (SELECT station_id FROM pams.police_stations WHERE station_name = 'Viramgam Division')
         AND a.transfer_to_station_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pams.application_history h
            WHERE h.app_id = a.app_id AND h.action LIKE 'Status changed:%'
         )
      RETURNING a.app_id`);
    if (fixed.rows.length) {
      console.log('DB migration: reset ' + fixed.rows.length + ' SDPO-forwarded application(s) from Transferred to Pending');
    }
  } catch (e) {
    console.error('Schema check failed:', e.message);
    throw e;
  }
}

// ---- auth middleware ------------------------------------------------------
// token fallback store (short-lived tokens for API use when cookies fail)
const tokens = new Map(); // token -> { user, exp }
const TOKEN_TTL = 15 * 60 * 1000; // 15 minutes

function genToken(user){
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { user, exp: Date.now() + TOKEN_TTL });
  return t;
}

function auth(req, res, next) {
  const sid = req.sessionID;
  // check bearer token first
  const authh = (req.headers.authorization || "").replace("Bearer ", "");
  if(authh){
    const rec = tokens.get(authh);
    if(rec && rec.exp > Date.now()){
      req.user = rec.user;
      console.log('AUTH token ok sessionID=', sid, 'token=', authh.slice(0,6)+'..', 'user=', req.user.label);
      return next();
    }
    if(rec) tokens.delete(authh);
    console.log('AUTH token invalid/expired, falling back to session', authh.slice(0,6)+'..');
  }
  const hasUser = !!(req.session && req.session.user);
  console.log('AUTH check, sessionID=', sid, 'hasUser=', hasUser, 'path=', req.path);
  const u = req.session && req.session.user;
  if (!u) {
    return res.status(401).json({ error: "Not logged in" });
  }
  req.user = u;
  next();
}

// map a DB row to the shape the web app uses
const mapRow = r => ({
  id: r.app_id, station: r.station_name,
  transferTo: r.transfer_to_station || "",
  applicant: r.applicant_name_address,
  applicantName: r.applicant_name || r.applicant_name_address || "",
  applicantAddress: r.applicant_address || "",
  contact: r.applicant_contact || "",
  letter: r.letter_no_date,
  subject: r.subject, io: r.io, pend: r.pendency_reason || "",
  head: r.head, date: r.application_date ? r.application_date.toISOString().slice(0,10) : "",
  year: String(r.app_year), status: r.status,
  createdBy: r.entered_by || "", createdAt: r.created_at
});

const BASE_SELECT = `
  SELECT a.*, s.station_name, t.station_name AS transfer_to_station, u.display_name AS entered_by
    FROM pams.applications a
    JOIN pams.police_stations s USING (station_id)
    LEFT JOIN pams.police_stations t ON t.station_id = a.transfer_to_station_id
    LEFT JOIN pams.users u ON u.user_id = a.created_by`;

// ---- LOGIN ------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const q = await pool.query("SELECT * FROM pams.verify_login($1,$2)", [username, password]);
    if (!q.rows.length) return res.status(401).json({ error: "Incorrect username or password" });
    const row = q.rows[0];
    const user = { userId: row.user_id, label: row.display_name,
                   role: row.role, station: row.role === 'admin' ? 'Viramgam Division' : row.station_name };
    req.session.user = user;
    // ensure session saved and cookie sent before responding
    req.session.save(err => {
      if (err) console.error('Session save error:', err);
      const token = genToken(user);
      console.log('LOGIN:', user.label, 'sessionID=', req.sessionID, 'token=', token.slice(0,6)+'..');
      res.json({ user, token });
    });
  } catch (e) { res.status(500).json({ error: "Database error: " + e.message }); }
});

// return current session user
app.get('/api/me', (req, res) => {
  console.log('ME endpoint, sessionID=', req.sessionID, 'hasUser=', !!(req.session && req.session.user));
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  // fallback: accept bearer token for session restore
  const authh = (req.headers.authorization || "").replace("Bearer ", "");
  if (authh) {
    const rec = tokens.get(authh);
    if (rec && rec.exp > Date.now()){
      return res.json({ user: rec.user });
    }
    if(rec) tokens.delete(authh);
  }
  return res.status(401).json({ error: 'Not logged in' });
});

// logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- LIST (station users automatically see only their own station) -----------
app.get("/api/applications", auth, async (req, res) => {
  try {
    // Station logins see their own applications only while these are in their hands:
    // once transferred to SDPO office the record leaves their list (it comes back if
    // SDPO returns it for re-investigation).
    const q = req.user.role === "admin"
      ? await pool.query(`${BASE_SELECT} ORDER BY a.created_at DESC`)
      : await pool.query(`${BASE_SELECT} WHERE (s.station_name = $1 OR t.station_name = $1) AND a.status <> 'Transferred' ORDER BY a.created_at DESC`, [req.user.station]);
    res.json(q.rows.map(mapRow));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ONE RECORD + HISTORY (also used for QR scan lookup) ----------------------
app.get("/api/applications/:id", auth, async (req, res) => {
  try {
    const q = await pool.query(`${BASE_SELECT} WHERE upper(a.app_id) = upper(trim($1))`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: "Record not found" });
    const rec = mapRow(q.rows[0]);
    if (req.user.role !== "admin" && rec.station !== req.user.station && rec.transferTo !== req.user.station)
      return res.status(403).json({ error: "This application belongs to " + rec.station + " police station" });
    const h = await pool.query(
      "SELECT action, performed_at FROM pams.application_history WHERE app_id=$1 ORDER BY hist_id", [rec.id]);
    rec.history = h.rows.map(x => ({ act: x.action, t: x.performed_at }));
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- CREATE -------------------------------------------------------------------
app.post("/api/applications", auth, async (req, res) => {
  try {
    const b = req.body;
    const station = req.user.role === "admin" ? 'Viramgam Division' : req.user.station;
    const transferTo = req.user.role === "admin" ? b.transferTo : null;
    const head = req.user.role === "admin" ? 'ઉપરી' : (b.head || 'સ્થાનિક');
    // Every application starts life "Pending" at whichever station now holds it —
    // including one SDPO just created and forwarded — since that station still has
    // to investigate it.
    const status = 'Pending';
    const contact = (b.contact || '').trim();
    if (contact && !/^\d{10}$/.test(contact))
      return res.status(400).json({ error: "Contact number must be exactly 10 digits" });
    const applicantCombined = [b.applicantName, b.applicantAddress].filter(Boolean).join(', ') || b.applicant || '';
    const q = await pool.query(`
      INSERT INTO pams.applications
        (station_id, transfer_to_station_id, applicant_name_address, applicant_name, applicant_address,
         applicant_contact, letter_no_date, subject, io,
         pendency_reason, head, application_date, app_year, status, created_by)
      VALUES ((SELECT station_id FROM pams.police_stations WHERE station_name=$1),
              (SELECT station_id FROM pams.police_stations WHERE station_name=$2),
              $3,$4,$5,NULLIF($6,''),$7,$8,$9,NULLIF($10,''),$11,$12,$13,$14,$15)
      RETURNING app_id`,
      [station, transferTo, applicantCombined, b.applicantName, b.applicantAddress, contact,
       b.letter, b.subject, b.io, b.pend, head, b.date, b.year, status, req.user.userId]);
    res.json({ id: q.rows[0].app_id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- EDIT ----------------------------------------------------------------------
app.put("/api/applications/:id", auth, async (req, res) => {
  try {
    const b = req.body;
    const station = req.user.role === "admin" ? 'Viramgam Division' : req.user.station;
    const transferTo = req.user.role === "admin" ? b.transferTo : null;
    const head = req.user.role === "admin" ? 'ઉપરી' : (b.head || 'સ્થાનિક');
    const contact = (b.contact || '').trim();
    if (contact && !/^\d{10}$/.test(contact))
      return res.status(400).json({ error: "Contact number must be exactly 10 digits" });
    const applicantCombined = [b.applicantName, b.applicantAddress].filter(Boolean).join(', ') || b.applicant || '';
    // Non-admin edits keep ownership fields (station / forward-to / head) untouched,
    // and a station may edit both its own applications and ones forwarded to it.
    const q = await pool.query(`
      UPDATE pams.applications SET
        station_id = CASE WHEN $15 THEN (SELECT station_id FROM pams.police_stations WHERE station_name=$1) ELSE station_id END,
        transfer_to_station_id = CASE WHEN $15 THEN (SELECT station_id FROM pams.police_stations WHERE station_name=$2) ELSE transfer_to_station_id END,
        applicant_name_address=$3, applicant_name=$4, applicant_address=$5, applicant_contact=NULLIF($6,''),
        letter_no_date=$7, subject=$8, io=$9,
        pendency_reason=NULLIF($10,''), head = CASE WHEN $15 THEN $11 ELSE head END,
        application_date=$12, app_year=$13
      WHERE app_id=$14
        AND ($15 OR station_id=(SELECT station_id FROM pams.police_stations WHERE station_name=$16)
                 OR transfer_to_station_id=(SELECT station_id FROM pams.police_stations WHERE station_name=$16))
      RETURNING app_id`,
      [station, transferTo, applicantCombined, b.applicantName, b.applicantAddress, contact,
       b.letter, b.subject, b.io || '', b.pend, head, b.date, b.year,
       req.params.id, req.user.role === "admin", req.user.station || ""]);
    if (!q.rows.length) return res.status(403).json({ error: "Not allowed or record not found" });
    await pool.query("INSERT INTO pams.application_history(app_id,action) VALUES ($1,$2)",
      [req.params.id, "Details edited by " + req.user.label]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- USER MANAGEMENT (SDPO only) ---------------------------------------------------
// list of active logins for the login-page dropdown (no auth — shown before login)
app.get("/api/logins", async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT username, display_name FROM pams.users WHERE is_active
        ORDER BY CASE WHEN role='admin' THEN 1 ELSE 0 END, display_name`);
    res.json(q.rows.map(r => ({ username: r.username, name: r.display_name })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function adminOnly(req, res) {
  if (req.user.role !== "admin") { res.status(403).json({ error: "Only SDPO office can manage users" }); return false; }
  return true;
}

app.get("/api/users", auth, async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const q = await pool.query(
      `SELECT u.user_id, u.username, u.display_name, u.role, u.is_active, s.station_name
         FROM pams.users u LEFT JOIN pams.police_stations s USING (station_id)
        ORDER BY u.user_id`);
    res.json(q.rows.map(r => ({ id: r.user_id, username: r.username, name: r.display_name,
      role: r.role, station: r.station_name || "", active: r.is_active })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users", auth, async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const { username, name, role, station, password } = req.body;
    if (!/^[a-z0-9._-]{3,30}$/i.test(username || ""))
      return res.status(400).json({ error: "Username: 3-30 letters/digits/._- only" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Display name is required" });
    if (!["station", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role" });
    if (!password || password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
    if (role === "station" && !station) return res.status(400).json({ error: "Station is required for station users" });
    const q = await pool.query(
      `INSERT INTO pams.users (username, password_hash, display_name, role, station_id)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4,
               CASE WHEN $4='station' THEN (SELECT station_id FROM pams.police_stations WHERE station_name=$5) END)
       RETURNING user_id`,
      [username.toLowerCase(), password, String(name).trim(), role, station || null]);
    res.json({ id: q.rows[0].user_id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: "Username already exists" });
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/users/:id/password", auth, async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
    const q = await pool.query(
      "UPDATE pams.users SET password_hash = crypt($1, gen_salt('bf')) WHERE user_id=$2 RETURNING username",
      [password, req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, username: q.rows[0].username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- IO OFFICERS (managed by SDPO, station-wise) -----------------------------------
// stations get their own active IOs (for the form dropdown); SDPO gets all
app.get("/api/ios", auth, async (req, res) => {
  try {
    const q = req.user.role === "admin"
      ? await pool.query(`SELECT i.io_id, i.io_name, i.is_active, s.station_name
          FROM pams.io_officers i JOIN pams.police_stations s USING (station_id)
          ORDER BY s.station_name, i.io_name`)
      : await pool.query(`SELECT i.io_id, i.io_name, i.is_active, s.station_name
          FROM pams.io_officers i JOIN pams.police_stations s USING (station_id)
          WHERE s.station_name = $1 AND i.is_active ORDER BY i.io_name`, [req.user.station]);
    res.json(q.rows.map(r => ({ id: r.io_id, name: r.io_name, station: r.station_name, active: r.is_active })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ios", auth, async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const { station, name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: "IO name is required" });
    const q = await pool.query(
      `INSERT INTO pams.io_officers (station_id, io_name)
       VALUES ((SELECT station_id FROM pams.police_stations WHERE station_name=$1), $2)
       RETURNING io_id`, [station, String(name).trim()]);
    res.json({ id: q.rows[0].io_id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: "This IO already exists for that station" });
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/ios/:id", auth, async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const { name, active } = req.body;
    const q = await pool.query(
      `UPDATE pams.io_officers SET
         io_name  = COALESCE(NULLIF($1,''), io_name),
         is_active = COALESCE($2, is_active)
       WHERE io_id=$3 RETURNING io_id`,
      [name !== undefined ? String(name).trim() : '', active === undefined ? null : !!active, req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: "IO not found" });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: "This IO already exists for that station" });
    res.status(400).json({ error: e.message });
  }
});

// ---- STATUS WORKFLOW -------------------------------------------------------------
app.post("/api/applications/:id/status", auth, async (req, res) => {
  try {
    const { status } = req.body;
    let q;
    if (status === "Transferred" && req.user.role !== "admin")    // station: SDPO-forwarded app investigated, send back for review
      q = await pool.query(
        `UPDATE pams.applications SET status='Transferred'
          WHERE app_id=$1 AND status='Pending'
            AND transfer_to_station_id=(SELECT station_id FROM pams.police_stations WHERE station_name=$2)
          RETURNING app_id`,
        [req.params.id, req.user.station || ""]);
    else if (status === "Complete" && req.user.role !== "admin")  // station closes its own (સ્થાનિક) application
      q = await pool.query(
        `UPDATE pams.applications SET status='Complete'
          WHERE app_id=$1 AND status='Pending'
            AND station_id=(SELECT station_id FROM pams.police_stations WHERE station_name=$2)
          RETURNING app_id`,
        [req.params.id, req.user.station || ""]);
    else if (status === "Pending" && req.user.role !== "admin")   // station reopens its own completed application
      q = await pool.query(
        `UPDATE pams.applications SET status='Pending'
          WHERE app_id=$1 AND status='Complete'
            AND station_id=(SELECT station_id FROM pams.police_stations WHERE station_name=$2)
          RETURNING app_id`,
        [req.params.id, req.user.station || ""]);
    else if (status === "Complete" && req.user.role === "admin")  // SDPO finalizes: a reviewed (Transferred) app, or one it is investigating itself
      q = await pool.query(
        `UPDATE pams.applications SET status='Complete'
          WHERE app_id=$1
            AND (status='Transferred'
              OR (status='Pending' AND transfer_to_station_id =
                    (SELECT station_id FROM pams.police_stations WHERE station_name='Viramgam Division')))
          RETURNING app_id`,
        [req.params.id]);
    else if (status === "Pending" && req.user.role === "admin")   // SDPO returns for re-investigation
      q = await pool.query(
        "UPDATE pams.applications SET status='Pending' WHERE app_id=$1 AND status='Transferred' RETURNING app_id",
        [req.params.id]);
    else return res.status(400).json({ error: "Invalid status change" });
    if (!q.rows.length || !q.rows[0].app_id)
      return res.status(400).json({ error: "Status change not allowed from current state" });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- DELETE (SDPO only) -------------------------------------------------------------
app.delete("/api/applications/:id", auth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only SDPO office can delete" });
  try {
    await pool.query("DELETE FROM pams.applications WHERE app_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- EXCEL IMPORT (rows parsed in the browser, saved here) ----------------------------
app.post("/api/import", auth, async (req, res) => {
  const rows = req.body.rows || [];
  let ok = 0; const errs = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [i, b] of rows.entries()) {
      const isAdmin = req.user.role === "admin";
      // SDPO/admin uploads: the "station" column in the sheet is the station the
      // application is being forwarded to, same as the "Forward to" dropdown used
      // for a manual entry — so mirror POST /api/applications exactly.
      const station = isAdmin ? 'Viramgam Division' : req.user.station;
      const transferTo = isAdmin ? b.transferTo : null;
      const head = isAdmin ? 'ઉપરી' : (b.head || 'સ્થાનિક');
      // Same rule as POST /api/applications: newly created/imported rows are always
      // Pending — the holding station (even one SDPO just forwarded to) still has to
      // investigate them.
      const status = 'Pending';
      await client.query("SAVEPOINT row_sp");
      try {
        await client.query(`
          INSERT INTO pams.applications
            (station_id, transfer_to_station_id, applicant_name_address, letter_no_date, subject, io,
             pendency_reason, head, application_date, app_year, status, created_by)
          VALUES ((SELECT station_id FROM pams.police_stations WHERE station_name=$1),
                  (SELECT station_id FROM pams.police_stations WHERE station_name=$2),
                  $3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,$11,$12)`,
          [station, transferTo, b.applicant, b.letter, b.subject, b.io || '', b.pend, head, b.date, b.year, status, req.user.userId]);
        ok++;
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT row_sp");   // undo only this row, keep the rest
        errs.push("Row " + (i + 2) + ": " + e.message.split("\n")[0]);
      }
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); return res.status(500).json({ error: e.message }); }
  finally { client.release(); }
  res.json({ imported: ok, errors: errs });
});

// ---- start ------------------------------------------------------------------------------
(async function startServer(){
  try {
    await ensureSchema();
    app.listen(SERVER_PORT, () => {
      console.log("======================================================");
      console.log("  PAMS server running");
      console.log("  Listening on port " + SERVER_PORT);
      console.log("  Database:         " + (process.env.DATABASE_URL ? "remote (DATABASE_URL)" : "local"));
      console.log("======================================================");
    });
    const r = await pool.query("SELECT count(*) FROM pams.applications");
    console.log("  Database connected ✔  (" + r.rows[0].count + " applications)");
  } catch (e) {
    console.error("  ⚠ FAILED TO START:", e.message);
    process.exit(1);
  }
})();
