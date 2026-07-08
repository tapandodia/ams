-- ============================================================================
--  POLICE APPLICATION MANAGEMENT SYSTEM (PAMS) — VIRAMGAM DIVISION
--  Full PostgreSQL database — schema, workflow, views, users & seed data
--  Tested on PostgreSQL 16/18. Run the whole file once in pgAdmin Query Tool.
-- ============================================================================

-- 0. EXTENSIONS ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- for password hashing

-- Clean re-run support (safe on first run too)
DROP SCHEMA IF EXISTS pams CASCADE;
CREATE SCHEMA pams;
SET search_path TO pams, public;

-- 1. MASTER TABLES ------------------------------------------------------------

CREATE TABLE police_stations (
    station_id   SERIAL PRIMARY KEY,
    station_name TEXT NOT NULL UNIQUE
);

INSERT INTO police_stations (station_name) VALUES
 ('Viramgam Division'), ('Viramgam Rural'), ('Detroj'), ('Mandal'),
 ('Vithalapur'), ('Hansalpur'), ('Nalsarovar');

CREATE TABLE users (
    user_id       SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('station','admin')),
    station_id    INT REFERENCES police_stations(station_id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT station_user_needs_station
        CHECK ( (role = 'admin' AND station_id IS NULL)
             OR (role = 'station' AND station_id IS NOT NULL) )
);

-- 8 logins: 7 police stations + 1 SDPO division office
INSERT INTO users (username, password_hash, display_name, role, station_id) VALUES
 ('viramgam-town',  crypt('vt@123',  gen_salt('bf')), 'Viramgam Town PS',              'station', 1),
 ('viramgam-rural', crypt('vr@123',  gen_salt('bf')), 'Viramgam Rural PS',             'station', 2),
 ('detroj',         crypt('dt@123',  gen_salt('bf')), 'Detroj PS',                     'station', 3),
 ('mandal',         crypt('md@123',  gen_salt('bf')), 'Mandal PS',                     'station', 4),
 ('vithalapur',     crypt('vp@123',  gen_salt('bf')), 'Vithalapur PS',                 'station', 5),
 ('hansalpur',      crypt('hp@123',  gen_salt('bf')), 'Hansalpur PS',                  'station', 6),
 ('nalsarovar',     crypt('nl@123',  gen_salt('bf')), 'Nalsarovar PS',                 'station', 7),
 ('sdpo',           crypt('sdpo@123',gen_salt('bf')), 'SDPO Office, Viramgam Division','admin',  NULL);

-- 2. APPLICATIONS -------------------------------------------------------------

CREATE SEQUENCE app_no_seq START 1;

-- Human-friendly unique ID, e.g. VGM-2026-000001 (this is what goes in the QR)
CREATE OR REPLACE FUNCTION generate_app_id() RETURNS TEXT AS $$
    SELECT 'VGM-' || to_char(now(),'YYYY') || '-' ||
           lpad(nextval('pams.app_no_seq')::TEXT, 6, '0');
$$ LANGUAGE sql;

CREATE TABLE applications (
    app_id            TEXT PRIMARY KEY DEFAULT generate_app_id(),
    station_id        INT  NOT NULL REFERENCES police_stations(station_id),
    transfer_to_station_id INT REFERENCES police_stations(station_id),
    applicant_name_address TEXT NOT NULL,             -- અરજદાર નામ અને સરનામું
    letter_no_date    TEXT,                           -- પત્ર ક્રમાંક અને તારીખ
    subject           TEXT NOT NULL,                  -- વિષય
    io                TEXT,                           -- Investigating Officer / transfer target for station apps
    pendency_reason   TEXT,                           -- Pendency Reason
    head              TEXT NOT NULL CHECK (head IN ('ઉપરી','સ્થાનિક')),  -- હેડ
    application_date  DATE NOT NULL,                  -- તારીખ
    app_year          INT  NOT NULL,                  -- વર્ષ
    status            TEXT NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending','Complete','Transferred')),
    created_by        INT REFERENCES users(user_id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_station ON applications(station_id);
CREATE INDEX idx_app_transfer_to ON applications(transfer_to_station_id);
CREATE INDEX idx_app_status  ON applications(status);
CREATE INDEX idx_app_year    ON applications(app_year);
CREATE INDEX idx_app_head    ON applications(head);

-- 3. HISTORY / AUDIT LOG --------------------------------------------------------

CREATE TABLE application_history (
    hist_id      BIGSERIAL PRIMARY KEY,
    app_id       TEXT NOT NULL REFERENCES applications(app_id) ON DELETE CASCADE,
    action       TEXT NOT NULL,
    performed_by TEXT NOT NULL DEFAULT current_user,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- keep updated_at fresh on every edit
CREATE OR REPLACE FUNCTION trg_app_touch() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_touch
BEFORE UPDATE ON applications
FOR EACH ROW EXECUTE FUNCTION trg_app_touch();

-- auto-log every new entry and every status change (runs AFTER the row exists)
CREATE OR REPLACE FUNCTION trg_app_audit() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO pams.application_history(app_id, action)
        VALUES (NEW.app_id, 'Application entered');
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO pams.application_history(app_id, action)
        VALUES (NEW.app_id, 'Status changed: ' || OLD.status || ' → ' || NEW.status);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_audit
AFTER INSERT OR UPDATE ON applications
FOR EACH ROW EXECUTE FUNCTION trg_app_audit();

-- 4. WORKFLOW FUNCTIONS ---------------------------------------------------------

-- Station finishes investigation and sends the application to SDPO for review
CREATE OR REPLACE FUNCTION transfer_to_sdpo(p_app_id TEXT) RETURNS applications AS $$
    UPDATE pams.applications
       SET status = 'Transferred'
     WHERE app_id = p_app_id AND status = 'Pending'
    RETURNING *;
$$ LANGUAGE sql;

-- SDPO finalizes a transferred application (return-for-reinvestigation is a plain
-- Transferred -> Pending update, not a function — see server.js)
CREATE OR REPLACE FUNCTION mark_complete(p_app_id TEXT) RETURNS applications AS $$
    UPDATE pams.applications
       SET status = 'Complete'
     WHERE app_id = p_app_id AND status = 'Transferred'
    RETURNING *;
$$ LANGUAGE sql;

-- Login check for the web app:  SELECT * FROM pams.verify_login('detroj','dt@123');
CREATE OR REPLACE FUNCTION verify_login(p_user TEXT, p_pass TEXT)
RETURNS TABLE(user_id INT, display_name TEXT, role TEXT, station_name TEXT) AS $$
    SELECT u.user_id, u.display_name, u.role, s.station_name
      FROM pams.users u
      LEFT JOIN pams.police_stations s USING (station_id)
     WHERE u.username = p_user
       AND u.is_active
       AND u.password_hash = crypt(p_pass, u.password_hash);
$$ LANGUAGE sql;

-- QR scan lookup:  SELECT * FROM pams.find_by_qr('VGM-2026-000001');
CREATE OR REPLACE FUNCTION find_by_qr(p_code TEXT)
RETURNS SETOF applications AS $$
    SELECT * FROM pams.applications WHERE upper(app_id) = upper(trim(p_code));
$$ LANGUAGE sql;

-- 5. VIEWS (for lists & dashboard charts) ---------------------------------------

-- Full readable list — filter station-wise or view all stations
CREATE OR REPLACE VIEW v_applications AS
SELECT a.app_id,
       s.station_name                     AS "Police Station",
       COALESCE(t.station_name, '')      AS "Forwarded To",
       a.applicant_name_address           AS "અરજદાર નામ અને સરનામું",
       a.letter_no_date                   AS "પત્ર ક્રમાંક અને તારીખ",
       a.subject                          AS "વિષય",
       a.io                               AS "IO",
       a.pendency_reason                  AS "Pendency Reason",
       a.head                             AS "હેડ",
       a.application_date                 AS "તારીખ",
       a.app_year                         AS "વર્ષ",
       a.status,
       u.display_name                     AS entered_by,
       a.created_at
FROM applications a
JOIN police_stations s USING (station_id)
LEFT JOIN police_stations t ON t.station_id = a.transfer_to_station_id
LEFT JOIN users u ON u.user_id = a.created_by
ORDER BY a.created_at DESC;

-- Dashboard: station-wise counts by status (feeds the bar chart)
CREATE OR REPLACE VIEW v_dashboard_station AS
SELECT s.station_name,
       count(*) FILTER (WHERE a.status = 'Pending')     AS pending,
       count(*) FILTER (WHERE a.status = 'Complete')    AS complete,
       count(*) FILTER (WHERE a.status = 'Transferred') AS transferred,
       count(a.app_id)                                  AS total
FROM police_stations s
LEFT JOIN applications a USING (station_id)
GROUP BY s.station_name
ORDER BY s.station_name;

-- Dashboard: overall status totals (feeds the doughnut chart)
CREATE OR REPLACE VIEW v_dashboard_status AS
SELECT status, count(*) AS total
FROM applications GROUP BY status;

-- Year-wise summary
CREATE OR REPLACE VIEW v_dashboard_year AS
SELECT app_year, count(*) AS total
FROM applications GROUP BY app_year ORDER BY app_year;

-- 6. EXCEL IMPORT (via staging table) --------------------------------------------
-- In pgAdmin: right-click pams.excel_staging → Import/Export Data → import your
-- CSV (save your Excel as CSV first), then run:  SELECT pams.process_excel_staging();

CREATE TABLE excel_staging (
    police_station          TEXT,
    applicant_name_address  TEXT,
    letter_no_date          TEXT,
    subject                 TEXT,
    io                      TEXT,
    pendency_reason         TEXT,
    head                    TEXT,
    application_date        TEXT,   -- accepts DD/MM/YYYY or YYYY-MM-DD
    app_year                TEXT
);

CREATE OR REPLACE FUNCTION process_excel_staging() RETURNS TEXT AS $$
DECLARE
    r RECORD; n_ok INT := 0; n_bad INT := 0; d DATE; sid INT;
BEGIN
    FOR r IN SELECT * FROM pams.excel_staging LOOP
        SELECT station_id INTO sid FROM pams.police_stations
         WHERE lower(station_name) = lower(trim(r.police_station));
        IF sid IS NULL THEN n_bad := n_bad + 1; CONTINUE; END IF;
        BEGIN
            d := CASE WHEN r.application_date ~ '^\d{1,2}/\d{1,2}/\d{4}$'
                      THEN to_date(r.application_date,'DD/MM/YYYY')
                      ELSE r.application_date::DATE END;
            INSERT INTO pams.applications
                (station_id, applicant_name_address, letter_no_date, subject, io,
                 pendency_reason, head, application_date, app_year)
            VALUES (sid, trim(r.applicant_name_address), trim(r.letter_no_date),
                    trim(r.subject), trim(r.io), nullif(trim(r.pendency_reason),''),
                    trim(r.head), d,
                    COALESCE(nullif(trim(r.app_year),'')::INT, extract(year FROM d)::INT));
            n_ok := n_ok + 1;
        EXCEPTION WHEN OTHERS THEN n_bad := n_bad + 1;
        END;
    END LOOP;
    DELETE FROM pams.excel_staging;
    RETURN n_ok || ' rows imported, ' || n_bad || ' rows skipped';
END $$ LANGUAGE plpgsql;

-- 7. SAMPLE DATA (3 demo applications — delete anytime) ---------------------------

INSERT INTO applications (station_id, applicant_name_address, letter_no_date, subject,
                          io, pendency_reason, head, application_date, app_year, created_by)
VALUES
 (1, 'રમેશભાઈ પટેલ, સ્ટેશન રોડ, વિરમગામ', 'જ/વશી/101/2026, તા. 01/07/2026',
     'જમીન બાબત ફરિયાદ', 'PSI A. B. Patel', 'નિવેદન બાકી', 'સ્થાનિક', '2026-07-01', 2026, 1),
 (3, 'સુરેશભાઈ ઠાકોર, દેત્રોજ ગામ', 'જ/દેત્રોજ/58/2026, તા. 28/06/2026',
     'મારામારી બાબત', 'PSI C. D. Rathod', NULL, 'ઉપરી', '2026-06-28', 2026, 3),
 (5, 'મીનાબેન રાવળ, વિઠ્ઠલાપુર', 'જ/વિઠ્ઠ/12/2026, તા. 20/06/2026',
     'ઘરેલુ તકરાર', 'ASI E. F. Chauhan', 'સાક્ષી તપાસ બાકી', 'સ્થાનિક', '2026-06-20', 2026, 5);

-- demo: complete + transfer one application
SELECT mark_complete(app_id)    FROM applications WHERE station_id = 5;
SELECT transfer_to_sdpo(app_id) FROM applications WHERE station_id = 5;

-- ============================================================================
--  QUICK REFERENCE — run these in pgAdmin Query Tool
-- ============================================================================
-- All applications (all stations):        SELECT * FROM pams.v_applications;
-- One station only:                       SELECT * FROM pams.v_applications WHERE "Police Station" = 'Detroj';
-- Dashboard (bar chart data):             SELECT * FROM pams.v_dashboard_station;
-- Dashboard (status totals):              SELECT * FROM pams.v_dashboard_status;
-- New application:
--   INSERT INTO pams.applications (station_id, applicant_name_address, letter_no_date,
--     subject, io, head, application_date, app_year)
--   VALUES (2, 'નામ, સરનામું', 'પત્ર ક્રમાંક, તારીખ', 'વિષય', 'PSI X', 'સ્થાનિક', '2026-07-07', 2026);
-- IO completes investigation:             SELECT pams.mark_complete('VGM-2026-000001');
-- Transfer to SDPO office:                SELECT pams.transfer_to_sdpo('VGM-2026-000001');
-- QR scan lookup:                         SELECT * FROM pams.find_by_qr('VGM-2026-000001');
-- Login check:                            SELECT * FROM pams.verify_login('sdpo','sdpo@123');
-- Full history of one application:        SELECT * FROM pams.application_history WHERE app_id = 'VGM-2026-000001';
-- ============================================================================
