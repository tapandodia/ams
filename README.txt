============================================================
 PAMS — POLICE APPLICATION MANAGEMENT SYSTEM (Viramgam)
 How to run the database-connected system on your Mac
============================================================

WHAT'S IN THIS FOLDER
  pams_database.sql   -> the PostgreSQL database (run once in pgAdmin)
  server.js           -> the API server (connects app <-> database)
  package.json        -> server dependencies list
  public/index.html   -> the web application

ONE-TIME SETUP
  1. DATABASE
     - Open pgAdmin -> right-click Databases -> Create -> Database -> name: pams_db
     - Right-click pams_db -> Query Tool -> open pams_database.sql -> press F5

  2. INSTALL NODE.JS
     - Download the macOS installer from https://nodejs.org (LTS version)
     - Install it (double-click, next, next)

  3. SET YOUR DATABASE PASSWORD
     - Open server.js in TextEdit
     - Near the top, change   password: "CHANGE_ME"
       to your postgres password (the one you use in pgAdmin)

  4. INSTALL SERVER DEPENDENCIES (first time only)
     - Open Terminal, go to this folder:   cd path/to/pams-server
     - Run:   npm install

START THE SYSTEM (every time)
     - In Terminal, inside this folder:   npm start
     - Open Safari/Chrome:   http://localhost:3000
     - Keep the Terminal window open while using the system.

LOGINS (8 users)
     viramgam-town / vt@123        viramgam-rural / vr@123
     detroj / dt@123               mandal / md@123
     vithalapur / vp@123           hansalpur / hp@123
     nalsarovar / nl@123           sdpo / sdpo@123
  To change a password, run in pgAdmin Query Tool, e.g.:
     UPDATE pams.users SET password_hash = crypt('NewPass', gen_salt('bf'))
     WHERE username = 'detroj';

OTHER COMPUTERS ON THE SAME NETWORK
     They can open:  http://<this-computer's-IP>:3000
     (Find your IP: System Settings -> Wi-Fi/Network. Keep this computer on.)
     For stations in other towns to connect over the internet, the server
     needs to be hosted on an always-on machine / cloud server with a fixed
     address - ask Claude when you are ready for that step.
