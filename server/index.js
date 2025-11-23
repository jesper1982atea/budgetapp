const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, "data", "budget.db");
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

app.use(cors());
app.use(express.json());

const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const calculateLoanRow = ({
  id,
  name,
  loanAmount,
  annualInterestRate,
  amortizationPercent,
  rateType = "variable",
}) => {
  const monthlyRate = annualInterestRate / 100 / 12;
  const monthlyInterest = loanAmount * monthlyRate;
  const monthlyAmortization =
    (loanAmount * (amortizationPercent / 100)) / 12;
  const totalMonthlyCost = monthlyInterest + monthlyAmortization;

  return {
    id,
    name,
    loanAmount,
    annualInterestRate,
    amortizationPercent,
    monthlyInterest,
    monthlyAmortization,
    totalMonthlyCost,
    rateType,
  };
};

const ensureDb = () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        onboarding_done INTEGER DEFAULT 0,
        contribute_metrics INTEGER DEFAULT 0
      )`,
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`,
    );
    db.all(`PRAGMA table_info(profiles)`, (err, columns) => {
      if (err) return;
      const hasUserId = (columns || []).some((col) => col.name === "user_id");
      if (!hasUserId) {
        db.run(`ALTER TABLE profiles ADD COLUMN user_id TEXT`, () => {});
      }
    });
    db.all(`PRAGMA table_info(users)`, (err, columns) => {
      if (err) return;
      const hasOnboarding = (columns || []).some((col) => col.name === "onboarding_done");
      const hasContribute = (columns || []).some((col) => col.name === "contribute_metrics");
      if (!hasOnboarding) {
        db.run(`ALTER TABLE users ADD COLUMN onboarding_done INTEGER DEFAULT 0`, () => {
          db.run(`UPDATE users SET onboarding_done = 0 WHERE onboarding_done IS NULL`);
        });
      }
      if (!hasContribute) {
        db.run(`ALTER TABLE users ADD COLUMN contribute_metrics INTEGER DEFAULT 0`, () => {
          db.run(`UPDATE users SET contribute_metrics = 0 WHERE contribute_metrics IS NULL`);
        });
      }
    });
    db.run(
      `CREATE TABLE IF NOT EXISTS insurance_policies (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        provider TEXT,
        annual_premium REAL,
        deductible REAL,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`,
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS public_shares (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`,
    );
  });
  return db;
};

const db = ensureDb();

const hashPassword = (password) => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
};

const verifyPassword = (password, stored) => {
  const [saltHex, hashHex] = stored.split(":");
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const storedHash = Buffer.from(hashHex, "hex");
  return timingSafeEqual(hash, storedHash);
};

const createUser = (username, password) =>
  new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const passwordHash = hashPassword(password);
    db.run(
      `INSERT INTO users (id, email, password_hash, created_at, onboarding_done, contribute_metrics) VALUES (?, ?, ?, ?, 0, 0)`,
      [id, username, passwordHash, now],
      function (err) {
        if (err) {
          return reject(err);
        }
        resolve({ id, username, createdAt: now });
      },
    );
  });

const findUserByUsername = (username) =>
  new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE email = ?`, [username], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });

const createSession = (userId) =>
  new Promise((resolve, reject) => {
    const token = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
      [token, userId, now],
      function (err) {
        if (err) return reject(err);
        resolve({ token, createdAt: now });
      },
    );
  });

const getUserFromToken = (token) =>
  new Promise((resolve, reject) => {
    if (!token) return resolve(null);
    db.get(
      `SELECT users.id, users.email AS username, users.onboarding_done AS onboardingDone, users.contribute_metrics AS contributeMetrics FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token = ?`,
      [token],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      },
    );
  });

const authMiddleware = async (req, _res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  try {
    const user = await getUserFromToken(token);
    req.user = user;
  } catch (err) {
    console.error("Auth middleware error", err);
    req.user = null;
  }
  next();
};

app.use(authMiddleware);

const saveProfile = (id, name, payload, userId) =>
  new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const data = JSON.stringify(payload);
    const isUpdate = Boolean(id);
    const profileId = id || randomUUID();
    const sql = isUpdate
      ? `UPDATE profiles SET name = ?, payload = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      : `INSERT INTO profiles (id, name, payload, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = isUpdate
      ? [name, data, now, profileId, userId]
      : [profileId, name, data, now, now, userId];

    db.run(sql, params, function (err) {
      if (err) {
        return reject(err);
      }
      resolve({ id: profileId, updatedAt: now });
    });
  });

const getProfileList = (userId) =>
  new Promise((resolve, reject) => {
    db.all(
      `SELECT id, name, updated_at AS updatedAt FROM profiles WHERE user_id = ? ORDER BY updated_at DESC`,
      [userId],
      (err, rows) => {
        if (err) {
          return reject(err);
        }
        resolve(rows || []);
      },
    );
  });

const getProfileById = (id, userId) =>
  new Promise((resolve, reject) => {
    db.get(
      `SELECT id, name, payload, updated_at AS updatedAt FROM profiles WHERE id = ? AND user_id = ?`,
      [id, userId],
      (err, row) => {
        if (err) {
          return reject(err);
        }
        if (!row) {
          return resolve(null);
        }
        try {
          const payload = JSON.parse(row.payload);
          resolve({ ...row, payload });
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });

app.post("/api/calculate", (req, res) => {
  const income = parseNumber(req.body?.income);
  const loansInput = Array.isArray(req.body?.loans)
    ? req.body.loans
    : [];

  if (loansInput.length === 0) {
    return res.status(400).json({
      error: "Minst ett lån måste anges för att göra en kalkyl.",
    });
  }

  const parsedLoans = loansInput
    .map((loan, index) => {
      const loanAmount = parseNumber(loan?.loanAmount);
      const annualInterestRate = parseNumber(loan?.annualInterestRate);
      const amortizationPercent =
        parseNumber(loan?.amortizationPercent) ?? 2;

      if (
        loanAmount === undefined ||
        annualInterestRate === undefined ||
        amortizationPercent === undefined ||
        loanAmount <= 0 ||
        annualInterestRate < 0 ||
        amortizationPercent < 0
      ) {
        return null;
      }

      return {
        id: loan?.id ?? `loan-${index + 1}`,
        name: loan?.name ?? `Lån ${index + 1}`,
        loanAmount,
        annualInterestRate,
        amortizationPercent,
        rateType: loan?.rateType === "fixed" ? "fixed" : "variable",
      };
    })
    .filter(Boolean);

  if (parsedLoans.length === 0) {
    const fallbackLoanAmount = parseNumber(req.body?.loanAmount);
    const fallbackInterest = parseNumber(req.body?.annualInterestRate);
    const fallbackAmortization =
      parseNumber(req.body?.amortizationPercent) ?? 2;

    if (
      fallbackLoanAmount !== undefined &&
      fallbackInterest !== undefined &&
      fallbackLoanAmount > 0 &&
      fallbackInterest >= 0 &&
      fallbackAmortization >= 0
    ) {
      parsedLoans.push({
        id: "loan-1",
        name: req.body?.loanName ?? "Lån 1",
        loanAmount: fallbackLoanAmount,
        annualInterestRate: fallbackInterest,
        amortizationPercent: fallbackAmortization,
        rateType: "variable",
      });
    }
  }

  if (parsedLoans.length === 0) {
    return res.status(400).json({
      error:
        "Minst ett lån måste anges med belopp, ränta och amortering för att göra en kalkyl.",
    });
  }

  const loanResults = parsedLoans.map((loan) => calculateLoanRow(loan));
  const totals = loanResults.reduce(
    (acc, loan) => {
      acc.loanAmount += loan.loanAmount;
      acc.monthlyInterest += loan.monthlyInterest;
      acc.monthlyAmortization += loan.monthlyAmortization;
      acc.totalMonthlyCost += loan.totalMonthlyCost;
      return acc;
    },
    {
      loanAmount: 0,
      monthlyInterest: 0,
      monthlyAmortization: 0,
      totalMonthlyCost: 0,
    },
  );

  const payload = {
    income,
    loans: loanResults,
    totals,
  };

  if (income !== undefined && income > 0) {
    payload.incomeShare = totals.totalMonthlyCost / income;
  }

  return res.json(payload);
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const username = (req.body?.username || "").trim().toLowerCase();
    const password = req.body?.password || "";
    if (!username || !password) {
      return res.status(400).json({ error: "Användarnamn och lösenord krävs." });
    }
    const existing = await findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: "Användarnamnet är redan upptaget." });
    }
    const user = await createUser(username, password);
    const session = await createSession(user.id);
    res.json({ token: session.token, username: user.username, onboardingDone: 0, contributeMetrics: 0 });
  } catch (err) {
    console.error("Signup failed", err);
    res.status(500).json({ error: "Kunde inte skapa användare." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = (req.body?.username || "").trim().toLowerCase();
    const password = req.body?.password || "";
    const user = await findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Fel användarnamn eller lösenord." });
    }
    const session = await createSession(user.id);
    res.json({
      token: session.token,
      username: user.username,
      onboardingDone: user.onboarding_done,
      contributeMetrics: user.contribute_metrics,
    });
  } catch (err) {
    console.error("Login failed", err);
    res.status(500).json({ error: "Kunde inte logga in." });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  res.json({
    username: req.user.username,
    id: req.user.id,
    onboardingDone: req.user.onboardingDone,
    contributeMetrics: req.user.contributeMetrics,
  });
});

app.post("/api/users/onboarding/done", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  db.run(
    `UPDATE users SET onboarding_done = 1 WHERE id = ?`,
    [req.user.id],
    function (err) {
      if (err) {
        console.error("Failed to set onboarding done", err);
        return res.status(500).json({ error: "Kunde inte uppdatera onboarding." });
      }
      res.json({ success: true });
    },
  );
});

app.post("/api/users/contribute", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const value = req.body?.contribute ? 1 : 0;
  db.run(
    `UPDATE users SET contribute_metrics = ? WHERE id = ?`,
    [value, req.user.id],
    function (err) {
      if (err) {
        console.error("Failed to set contribute flag", err);
        return res.status(500).json({ error: "Kunde inte uppdatera inställning." });
      }
      res.json({ success: true, contribute: value });
    },
  );
});

app.get("/api/insurance", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  db.all(
    `SELECT id, type, provider, annual_premium AS annualPremium, deductible, notes FROM insurance_policies WHERE user_id = ? ORDER BY created_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) {
        console.error("Failed to list insurance", err);
        return res.status(500).json({ error: "Kunde inte hämta försäkringar." });
      }
      res.json(rows || []);
    },
  );
});

app.post("/api/insurance", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const payload = req.body || {};
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO insurance_policies (id, user_id, type, provider, annual_premium, deductible, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.user.id,
      payload.type || "hem",
      payload.provider || "",
      Number(payload.annualPremium) || 0,
      Number(payload.deductible) || 0,
      payload.notes || "",
      now,
    ],
    function (err) {
      if (err) {
        console.error("Failed to save insurance", err);
        return res.status(500).json({ error: "Kunde inte spara försäkring." });
      }
      res.status(201).json({ id });
    },
  );
});

app.delete("/api/insurance/:id", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  db.run(
    `DELETE FROM insurance_policies WHERE id = ? AND user_id = ?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) {
        console.error("Failed to delete insurance", err);
        return res.status(500).json({ error: "Kunde inte ta bort försäkring." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Hittade ingen försäkring." });
      }
      res.json({ success: true });
    },
  );
});

app.get("/api/metrics/insurance", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  db.all(
    `SELECT type, AVG(annual_premium) as avgPremium FROM insurance_policies WHERE user_id IN (SELECT id FROM users WHERE contribute_metrics = 1) GROUP BY type`,
    (err, rows) => {
      if (err) {
        console.error("Failed to load metrics insurance", err);
        return res.status(500).json({ error: "Kunde inte hämta jämförelser." });
      }
      res.json(rows || []);
    },
  );
});

app.post("/api/tibber/price", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const token = req.body?.token;
  if (!token) {
    return res.status(400).json({ error: "Tibber-token saknas." });
  }
  const query = `
    {
      viewer {
        homes {
          currentSubscription {
            priceInfo { current { total } }
          }
          consumption(resolution: MONTHLY, first: 1) { nodes { consumption } }
        }
      }
    }
  `;
  try {
    const response = await fetch("https://api.tibber.com/v1-beta/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = data?.errors?.[0]?.message || data?.message || response.statusText;
      throw new Error(upstream || "Tibber-svar misslyckades");
    }
    const home = data?.data?.viewer?.homes?.[0];
    const price = home?.currentSubscription?.priceInfo?.current?.total ?? null;
    const monthlyConsumption = home?.consumption?.nodes?.[0]?.consumption ?? null;
    res.json({ price, monthlyConsumption });
  } catch (err) {
    console.error("Tibber fetch failed", err);
    res.status(500).json({ error: `Kunde inte hämta Tibber-data: ${err.message || "okänt fel"}` });
  }
});

app.get("/api/profiles", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att se profiler." });
  }
  try {
    const rows = await getProfileList(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error("Failed to list profiles", err);
    res.status(500).json({ error: "Kunde inte hämta profiler." });
  }
});

app.get("/api/profiles/:id", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att läsa profiler." });
  }
  try {
    const profile = await getProfileById(req.params.id, req.user.id);
    if (!profile) {
      return res.status(404).json({ error: "Profilen finns inte." });
    }
    res.json(profile);
  } catch (err) {
    console.error("Failed to load profile", err);
    res.status(500).json({ error: "Kunde inte läsa profilen." });
  }
});

app.post("/api/profiles", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att spara profiler." });
  }
  try {
    const name = (req.body?.name || "").trim();
    const payload = req.body?.payload;
    if (!name) {
      return res.status(400).json({ error: "Ange ett profilenamn." });
    }
    if (typeof payload !== "object" || payload === null) {
      return res.status(400).json({ error: "Ogiltigt profilinnehåll." });
    }
    const { id, updatedAt } = await saveProfile(null, name, payload, req.user.id);
    res.status(201).json({ id, name, updatedAt });
  } catch (err) {
    console.error("Failed to save profile", err);
    res.status(500).json({ error: "Kunde inte spara profilen." });
  }
});

app.put("/api/profiles/:id", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att spara profiler." });
  }
  try {
    const name = (req.body?.name || "").trim();
    const payload = req.body?.payload;
    const id = req.params.id;
    if (!name) {
      return res.status(400).json({ error: "Ange ett profilenamn." });
    }
    if (typeof payload !== "object" || payload === null) {
      return res.status(400).json({ error: "Ogiltigt profilinnehåll." });
    }
    const existing = await getProfileById(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "Profilen finns inte." });
    }
    const { updatedAt } = await saveProfile(id, name, payload, req.user.id);
    res.json({ id, name, updatedAt });
  } catch (err) {
    console.error("Failed to update profile", err);
    res.status(500).json({ error: "Kunde inte uppdatera profilen." });
  }
});

app.delete("/api/profiles/:id", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att ta bort profiler." });
  }
  db.run(`DELETE FROM profiles WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id], function (err) {
    if (err) {
      console.error("Failed to delete profile", err);
      return res.status(500).json({ error: "Kunde inte ta bort profilen." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Profilen finns inte." });
    }
    res.json({ success: true });
  });
});

const adminKey = process.env.ADMIN_KEY || "";

const requireAdmin = (req, res, next) => {
  if (!adminKey) {
    return res.status(403).json({ error: "Admin-nyckel saknas i servern." });
  }
  const key = req.headers["x-admin-key"];
  if (key !== adminKey) {
    return res.status(401).json({ error: "Fel admin-nyckel." });
  }
  next();
};

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  db.all(
    `SELECT id, email AS username, created_at AS createdAt, onboarding_done AS onboardingDone FROM users ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error("Admin list users failed", err);
        return res.status(500).json({ error: "Kunde inte hämta användare." });
      }
      res.json(rows || []);
    },
  );
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const userId = req.params.id;
  db.serialize(() => {
    db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    db.run(`DELETE FROM profiles WHERE user_id = ?`, [userId]);
    db.run(`DELETE FROM users WHERE id = ?`, [userId], function (err) {
      if (err) {
        console.error("Admin delete user failed", err);
        return res.status(500).json({ error: "Kunde inte ta bort användaren." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Hittade ingen användare." });
      }
      res.json({ success: true });
    });
  });
});

app.post("/api/admin/users/:id/reset-onboarding", requireAdmin, (req, res) => {
  const userId = req.params.id;
  db.run(`UPDATE users SET onboarding_done = 0 WHERE id = ?`, [userId], function (err) {
    if (err) {
      console.error("Admin reset onboarding failed", err);
      return res.status(500).json({ error: "Kunde inte återställa onboarding." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Hittade ingen användare." });
    }
    res.json({ success: true });
  });
});

app.get("/api/place-autocomplete", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att söka adress." });
  }
  if (!GOOGLE_MAPS_KEY) {
    return res.status(500).json({ error: "GOOGLE_MAPS_KEY saknas på servern." });
  }
  const input = (req.query.input || "").toString();
  const sessiontoken = (req.query.sessiontoken || "").toString();
  if (!input || input.length < 3) {
    return res.json({ predictions: [] });
  }
  try {
    const params = new URLSearchParams({
      input,
      key: GOOGLE_MAPS_KEY,
      sessiontoken,
      language: "sv",
    });
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error("Upstream error");
    }
    const data = await response.json();
    res.json({ predictions: data.predictions || [] });
  } catch (err) {
    console.error("Place autocomplete failed", err);
    res.status(500).json({ error: "Kunde inte hämta adresser." });
  }
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

if (process.env.NODE_ENV === "production") {
  const clientBuildPath = path.join(__dirname, "../client/dist");
  app.use(express.static(clientBuildPath));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
