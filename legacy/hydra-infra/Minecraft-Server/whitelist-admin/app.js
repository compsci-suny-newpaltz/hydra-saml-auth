require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { Rcon } = require("rcon-client");
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("/minecraft-data/whitelist.db");

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, minecraft_username TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY)");
});

const app = express();
app.set("trust proxy", 1);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

// Hydra config
const HYDRA_BASE_URL = process.env.HYDRA_BASE_URL || "https://hydra.newpaltz.edu";
const DEFAULT_RETURN_TO = process.env.RETURN_TO || "https://hydra.newpaltz.edu/minecraftdashboard/";

// Build absolute URL for returnTo
function fullUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

// Verify np_access with Hydra /check
async function verifyWithHydra(token) {
  if (!token) return { ok: false, status: 401 };
  const r = await fetch(`${HYDRA_BASE_URL}/check`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return { ok: false, status: r.status };
  const data = await r.json(); // { active, email, roles, groups, ... }
  return { ok: true, status: 200, data };
}

// Require Hydra login (no role checks)
async function requireHydraLogin(req, res, next) {
  try {
    const token = req.cookies?.np_access;
    const result = await verifyWithHydra(token);
    if (result.ok && result.data?.active) {
      req.user = result.data;
      return next();
    }
    // API callers get JSON 401 with a login URL hint
    const wantsJson = req.xhr || req.path.startsWith("/api/") || (req.headers.accept || "").includes("application/json");
    const loginUrl = `${HYDRA_BASE_URL}/login?returnTo=${encodeURIComponent(DEFAULT_RETURN_TO)}`;
    if (wantsJson) return res.status(401).json({ ok: false, error: "Login required", login: loginUrl });
    return res.redirect(loginUrl);
  } catch (e) {
    console.error("Auth error:", e);
    return res.status(500).send("Verification failed.");
  }
}

function isAdmin(email) {
  return new Promise((resolve, reject) => {
    db.get("SELECT email FROM admins WHERE email = ?", [email], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

async function requireFaculty(req, res, next) {
  const roles = (req.user && Array.isArray(req.user.roles)) ? req.user.roles.map(r => r.toLowerCase()) : [];
  if (roles.includes('faculty') || await isAdmin(req.user.email)) {
    return next();
  }
  res.status(403).send("Faculty/admin only.");
}

// Apply auth to everything (static + APIs)
app.use(requireHydraLogin);

app.get('/', async (req, res) => {
  const roles = (req.user && Array.isArray(req.user.roles)) ? req.user.roles.map(r => r.toLowerCase()) : [];
  if (roles.includes('faculty') || await isAdmin(req.user.email)) {
    res.sendFile(__dirname + '/public/faculty.html');
  } else {
    res.sendFile(__dirname + '/public/student.html');
  }
});

app.use(express.static("public"));

const RCON_HOST = process.env.RCON_HOST || "mc";
const RCON_PORT = parseInt(process.env.RCON_PORT || "25575", 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);

async function withRcon(fn) {
  const rcon = new Rcon({
    host: RCON_HOST,
    port: RCON_PORT,
    password: RCON_PASSWORD
  });
  await rcon.connect();
  try {
    return await fn(rcon);
  } finally {
    rcon.end();
  }
}

app.get("/api/me", (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get("/api/my-username", (req, res) => {
  db.get("SELECT minecraft_username FROM users WHERE email = ?", [req.user.email], (err, row) => {
    if (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.json({ ok: true, minecraft_username: row ? row.minecraft_username : null });
  });
});

app.post("/api/my-username", async (req, res) => {
  const minecraft_username = (req.body.minecraft_username || "").trim();
  if (!minecraft_username) {
    return res.status(400).json({ ok: false, error: "Minecraft username required" });
  }

  // First, find the old username if it exists
  db.get("SELECT minecraft_username FROM users WHERE email = ?", [req.user.email], async (err, row) => {
    if (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    const old_username = row ? row.minecraft_username : null;

    // Now, update the database with the new username
    db.run("REPLACE INTO users (email, minecraft_username) VALUES (?, ?)", [req.user.email, minecraft_username], async function(err) {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      try {
        // If there was an old username, remove it from the whitelist
        if (old_username && old_username !== minecraft_username) {
          await withRcon(rcon => rcon.send(`whitelist remove ${old_username}`));
        }
        // Add the new username to the whitelist and ensure it's on
        await withRcon(rcon => rcon.send(`whitelist add ${minecraft_username}`));
        await withRcon(rcon => rcon.send("whitelist on"));
        res.json({ ok: true, message: "Saved!" });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  });
});

app.get("/api/all-users", requireFaculty, (req, res) => {
  db.all("SELECT email, minecraft_username FROM users", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.json({ ok: true, users: rows });
  });
});


app.get("/api/status", requireFaculty, async (_req, res) => {
  try {
    const reply = await withRcon((r) => r.send("list"));
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Ensure whitelist is on
app.post("/api/enable", requireFaculty, async (_req, res) => {
  try {
    const reply = await withRcon((r) => r.send("whitelist on"));
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/add", requireFaculty, async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Name required" });

  try {
    // Add & ensure enabled
    const reply1 = await withRcon((r) => r.send(`whitelist add ${name}`));
    const reply2 = await withRcon((r) => r.send("whitelist on"));
    res.json({ ok: true, added: name, replies: [reply1, reply2] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/remove", requireFaculty, async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Name required" });

  try {
    const reply = await withRcon((r) => r.send(`whitelist remove ${name}`));
    res.json({ ok: true, removed: name, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Run arbitrary RCON command (faculty/admin only)
app.post("/api/rcon", requireFaculty, async (req, res) => {
  const cmd = (req.body && typeof req.body.cmd === "string") ? req.body.cmd.trim() : "";
  if (!cmd) return res.status(400).json({ ok: false, error: "Command required" });
  try {
    const reply = await withRcon((r) => r.send(cmd));
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/list", requireFaculty, async (_req, res) => {
  try {
    const reply = await withRcon((r) => r.send("whitelist list"));
    // Reply looks like: "There are N whitelisted players: name1, name2"
    const names = reply.includes(":")
      ? reply.split(":")[1].split(",").map(s => s.trim()).filter(Boolean)
      : [];
    res.json({ ok: true, raw: reply, names });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(APP_PORT, () => {
  console.log(`Whitelist Admin listening on 0.0.0.0:${APP_PORT}`);
  console.log(`HYDRA_BASE_URL: ${HYDRA_BASE_URL}`);
});
