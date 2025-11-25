const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { randomUUID, createHash, randomBytes, scryptSync, timingSafeEqual } = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const { OAuth2Client } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 4000;
const DB_PATH = path.join(__dirname, "data", "budget.db");
const SETTINGS_KEYS = {
  ADMIN_PASSWORD_HASH: "admin_password_hash",
  GOOGLE_MAPS_KEY: "google_maps_key",
  GOOGLE_OAUTH_CLIENT_ID: "google_oauth_client_id",
};

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
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
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
      const hasGoogleSub = (columns || []).some((col) => col.name === "google_sub");
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
      if (!hasGoogleSub) {
        db.run(`ALTER TABLE users ADD COLUMN google_sub TEXT`, () => {
          db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`,
          );
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
      `CREATE TABLE IF NOT EXISTS provider_catalog (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(type, name)
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

const getSetting = (key) =>
  new Promise((resolve, reject) => {
    db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : null);
    });
  });

const setSetting = (key, value) =>
  new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
      function (err) {
        if (err) return reject(err);
        resolve(value);
      },
    );
  });

const seedSettingsFromEnv = () => {
  const envAdminKey = process.env.ADMIN_KEY;
  const envGoogleKey = process.env.GOOGLE_MAPS_KEY;
  const envGoogleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (envAdminKey) {
    getSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH)
      .then((existing) => {
        if (!existing) {
          return setSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH, hashPassword(envAdminKey));
        }
        return null;
      })
      .catch((err) => console.warn("Failed to seed admin key from env", err));
  }
  if (envGoogleKey) {
    getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY)
      .then((existing) => {
        if (!existing) {
          return setSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY, envGoogleKey);
        }
        return null;
      })
      .catch((err) => console.warn("Failed to seed Google key from env", err));
  }
  if (envGoogleClientId) {
    getSetting(SETTINGS_KEYS.GOOGLE_OAUTH_CLIENT_ID)
      .then((existing) => {
        if (!existing) {
          return setSetting(SETTINGS_KEYS.GOOGLE_OAUTH_CLIENT_ID, envGoogleClientId);
        }
        return null;
      })
      .catch((err) => console.warn("Failed to seed Google OAuth client id from env", err));
  }
};

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

seedSettingsFromEnv();

const GOOGLE_LOGIN_ERRORS = {
  NOT_CONFIGURED: "GOOGLE_LOGIN_NOT_CONFIGURED",
};

const getGoogleClientId = async () => {
  const stored = await getSetting(SETTINGS_KEYS.GOOGLE_OAUTH_CLIENT_ID);
  return stored || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
};

const summarizeProfilePayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const incomePersons = Array.isArray(payload.incomePersons) ? payload.incomePersons : [];
  const loans = Array.isArray(payload.loans) ? payload.loans : [];
  const costItems = Array.isArray(payload.costItems) ? payload.costItems : [];
  const savingsItems = Array.isArray(payload.savingsItems) ? payload.savingsItems : [];
  const propertyInfo = payload.propertyInfo || {};
  const electricity = payload.electricity || {};
  const hasIncome = incomePersons.some(
    (person) =>
      (person.name && person.name.trim()) ||
      Number(person.incomeGross) > 0 ||
      Number(person.netIncome) > 0,
  );
  const hasLoans = loans.some(
    (loan) =>
      Number(loan.loanAmount) > 0 ||
      Number(loan.amountNumber) > 0 ||
      Number(loan.annualInterestRate) > 0,
  );
  const hasProperty =
    (propertyInfo.name && propertyInfo.name.trim()) ||
    Number(propertyInfo.value) > 0 ||
    Number(propertyInfo.areaSqm) > 0;
  const hasElectricity =
    Boolean(electricity.provider) ||
    Number(electricity.consumption) > 0 ||
    Number(electricity.averagePrice) > 0;
  const hasCosts = costItems.length > 0;
  const hasSavings = savingsItems.length > 0;
  return {
    income: Boolean(hasIncome),
    loans: Boolean(hasLoans),
    property: Boolean(hasProperty),
    electricity: Boolean(hasElectricity),
    costs: Boolean(hasCosts),
    savings: Boolean(hasSavings),
  };
};

const getLatestProfileSummary = (userId) =>
  new Promise((resolve) => {
    db.get(
      `SELECT payload FROM profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [userId],
      (err, row) => {
        if (err || !row) {
          if (err) {
            console.warn("Failed to load profile summary", err);
          }
          return resolve(null);
        }
        try {
          const payload = JSON.parse(row.payload);
          resolve(summarizeProfilePayload(payload));
        } catch (parseErr) {
          console.warn("Failed to parse profile summary", parseErr);
          resolve(null);
        }
      },
    );
  });

const mapDbUser = (row) => {
  if (!row) return null;
  return {
    ...row,
    username: row.username || row.email,
    onboarding_done: row.onboarding_done ?? row.onboardingDone ?? 0,
    contribute_metrics: row.contribute_metrics ?? row.contributeMetrics ?? 0,
  };
};

const formatUserResponse = (user) => ({
  username: user.username || user.email,
  onboardingDone: user.onboarding_done ?? user.onboardingDone ?? 0,
  contributeMetrics: user.contribute_metrics ?? user.contributeMetrics ?? 0,
});

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
      resolve(mapDbUser(row));
    });
  });

const findUserByGoogleSub = (googleSub) =>
  new Promise((resolve, reject) => {
    if (!googleSub) return resolve(null);
    db.get(`SELECT * FROM users WHERE google_sub = ?`, [googleSub], (err, row) => {
      if (err) return reject(err);
      resolve(mapDbUser(row));
    });
  });

const linkGoogleAccount = (userId, googleSub) =>
  new Promise((resolve, reject) => {
    if (!userId) return reject(new Error("Missing user id"));
    db.run(
      `UPDATE users SET google_sub = ? WHERE id = ?`,
      [googleSub, userId],
      function (err) {
        if (err) return reject(err);
        resolve(true);
      },
    );
  });

const createGoogleUser = ({ email, googleSub }) =>
  new Promise((resolve, reject) => {
    if (!email || !googleSub) return reject(new Error("Invalid Google user"));
    const now = new Date().toISOString();
    const id = randomUUID();
    const passwordHash = hashPassword(randomBytes(24).toString("hex"));
    db.run(
      `INSERT INTO users (id, email, password_hash, created_at, onboarding_done, contribute_metrics, google_sub) VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [id, email, passwordHash, now, googleSub],
      function (err) {
        if (err) {
          return reject(err);
        }
        resolve({
          id,
          email,
          username: email,
          onboarding_done: 0,
          contribute_metrics: 0,
          google_sub: googleSub,
        });
      }
    );
  });

const verifyGoogleCredential = async (credential) => {
  if (!credential) {
    const err = new Error("Missing credential");
    err.code = "MISSING_CREDENTIAL";
    throw err;
  }
  const clientId = await getGoogleClientId();
  if (!clientId) {
    const err = new Error("Google login not configured");
    err.code = GOOGLE_LOGIN_ERRORS.NOT_CONFIGURED;
    throw err;
  }
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  return { payload, clientId };
};

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
    const publicUser = formatUserResponse(user);
    res.json({
      token: session.token,
      username: publicUser.username,
      onboardingDone: publicUser.onboardingDone,
      contributeMetrics: publicUser.contributeMetrics,
    });
  } catch (err) {
    console.error("Login failed", err);
    res.status(500).json({ error: "Kunde inte logga in." });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const credential = req.body?.credential;
    const { payload } = await verifyGoogleCredential(credential);
    const googleSub = payload?.sub;
    const email = (payload?.email || "").trim().toLowerCase();
    if (!googleSub || !email) {
      return res.status(400).json({ error: "Ogiltig Google-användare." });
    }
    let user = await findUserByGoogleSub(googleSub);
    if (!user) {
      const existingEmailUser = await findUserByUsername(email);
      if (existingEmailUser) {
        await linkGoogleAccount(existingEmailUser.id, googleSub);
        user = existingEmailUser;
      } else {
        user = await createGoogleUser({ email, googleSub });
      }
    }
    const session = await createSession(user.id);
    const publicUser = formatUserResponse(user);
    res.json({
      token: session.token,
      username: publicUser.username,
      onboardingDone: publicUser.onboardingDone,
      contributeMetrics: publicUser.contributeMetrics,
    });
  } catch (err) {
    if (err.code === GOOGLE_LOGIN_ERRORS.NOT_CONFIGURED) {
      return res.status(503).json({ error: "Google-inloggning är inte konfigurerad." });
    }
    if (err.code === "MISSING_CREDENTIAL") {
      return res.status(400).json({ error: "Google-token saknas." });
    }
    console.error("Google login failed", err);
    res.status(500).json({ error: "Kunde inte logga in med Google." });
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

const PROVIDER_TYPES = ["broadband", "insurance", "bank"];

app.get("/api/providers/:type", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const type = req.params.type;
  if (!PROVIDER_TYPES.includes(type)) {
    return res.status(400).json({ error: "Ogiltig typ." });
  }
  db.all(
    `SELECT name FROM provider_catalog WHERE type = ? ORDER BY LOWER(name) ASC`,
    [type],
    (err, rows) => {
      if (err) {
        console.error("Failed to list providers", err);
        return res.status(500).json({ error: "Kunde inte hämta leverantörer." });
      }
      res.json({ providers: rows.map((row) => row.name) });
    },
  );
});

app.post("/api/providers", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const type = req.body?.type;
  const rawName = req.body?.name;
  if (!PROVIDER_TYPES.includes(type)) {
    return res.status(400).json({ error: "Ogiltig typ." });
  }
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "Ange ett namn." });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO provider_catalog (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, type, name, req.user.id, now],
    function (err) {
      if (err) {
        console.error("Failed to save provider", err);
        return res.status(500).json({ error: "Kunde inte spara leverantör." });
      }
      res.status(201).json({ success: true, name });
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
  const hasNonAscii = /[^\x00-\x7F]/.test(token);
  if (hasNonAscii) {
    return res.status(400).json({
      error: "Tibber-token innehåller otillåtna tecken. Kopiera den exakt från Tibber utan specialtecken.",
    });
  }
  const query = `
    {
      viewer {
        homes {
          currentSubscription {
            priceInfo { current { total } }
          }
          monthly: consumption(resolution: MONTHLY, first: 12) {
            nodes { consumption from }
          }
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
    const monthlyNodes = Array.isArray(home?.monthly?.nodes) ? home.monthly.nodes : [];
    const monthlyConsumption = monthlyNodes[0]?.consumption ?? null;
    const previousMonthlyConsumption = monthlyNodes[1]?.consumption ?? null;
    const monthlyCost =
      monthlyConsumption != null && price != null ? monthlyConsumption * price : null;
    const previousMonthlyCost =
      previousMonthlyConsumption != null && price != null
        ? previousMonthlyConsumption * price
        : null;
    const annualConsumption = monthlyNodes.reduce((sum, node) => {
      const value = Number(node?.consumption);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    res.json({
      price,
      monthlyConsumption,
      previousMonthlyConsumption,
      monthlyCost,
      previousMonthlyCost,
      monthlyPeriods: monthlyNodes.map((node) => ({
        from: node?.from,
        consumption: node?.consumption ?? null,
      })),
      annualConsumption: annualConsumption || null,
    });
  } catch (err) {
    console.error("Tibber fetch failed", err);
    res.status(500).json({ error: `Kunde inte hämta Tibber-data: ${err.message || "okänt fel"}` });
  }
});

app.post("/api/tibber/login", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Inte inloggad." });
  }
  const email = req.body?.email;
  const password = req.body?.password;
  if (!email || !password) {
    return res.status(400).json({ error: "E-post och lösenord krävs för Tibber." });
  }
  // Tibber har inte ett öppet GraphQL-fält för e-post/lösen-inloggning längre.
  // Återkoppla direkt så klienten kan visa ett tydligt meddelande.
  return res.status(501).json({
    error:
      "Tibber stödjer inte inloggning via e-post/lösenord i API:et. Använd en Personal Access Token från Tibber-appen.",
  });
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

app.get("/api/settings/status", async (_req, res) => {
  try {
    const [adminHash, googleKey, googleClientId] = await Promise.all([
      getSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH),
      getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY),
      getGoogleClientId(),
    ]);
    res.json({
      adminConfigured: Boolean(adminHash),
      googleKeyConfigured: Boolean(googleKey),
      googleLoginConfigured: Boolean(googleClientId),
      googleClientId: googleClientId || "",
    });
  } catch (err) {
    console.error("Failed to fetch settings status", err);
    res.status(500).json({ error: "Kunde inte läsa serverinställningar." });
  }
});

app.post("/api/settings/initialize", async (req, res) => {
  try {
    const existingHash = await getSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH);
    const requiresAdmin = Boolean(existingHash);
    if (requiresAdmin) {
      const header = req.headers["x-admin-key"];
      if (!header || !verifyPassword(header, existingHash)) {
        return res.status(401).json({ error: "Fel adminlösen." });
      }
    }
    const adminPassword = (req.body?.adminPassword || "").trim();
    const googleMapsKey = (req.body?.googleMapsKey || "").trim();
    const googleClientId = (req.body?.googleClientId || "").trim();
    if (!existingHash && (!adminPassword || !googleMapsKey)) {
      return res.status(400).json({
        error: "Ange både adminlösen och Google Maps-nyckel vid första konfigurationen.",
      });
    }
    const updates = [];
    if (adminPassword) {
      updates.push(setSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH, hashPassword(adminPassword)));
    }
    if (googleMapsKey) {
      updates.push(setSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY, googleMapsKey));
    }
    if (googleClientId) {
      updates.push(setSetting(SETTINGS_KEYS.GOOGLE_OAUTH_CLIENT_ID, googleClientId));
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: "Inga ändringar att spara." });
    }
    await Promise.all(updates);
    const [adminHash, googleKey, oauthClientId] = await Promise.all([
      getSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH),
      getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY),
      getGoogleClientId(),
    ]);
    res.json({
      adminConfigured: Boolean(adminHash),
      googleKeyConfigured: Boolean(googleKey),
      googleLoginConfigured: Boolean(oauthClientId),
      googleClientId: oauthClientId || "",
    });
  } catch (err) {
    console.error("Failed to initialize settings", err);
    res.status(500).json({ error: "Kunde inte spara inställningarna." });
  }
});

const requireAdmin = (req, res, next) => {
  getSetting(SETTINGS_KEYS.ADMIN_PASSWORD_HASH)
    .then((storedHash) => {
      if (!storedHash) {
        return res
          .status(403)
          .json({ error: "Adminlösen saknas. Kör initial konfiguration." });
      }
      const provided = req.headers["x-admin-key"];
      if (!provided) {
        return res.status(401).json({ error: "Ange adminlösen via X-Admin-Key." });
      }
      try {
        if (!verifyPassword(provided, storedHash)) {
          return res.status(401).json({ error: "Fel adminlösen." });
        }
      } catch (err) {
        console.error("Admin verification failed", err);
        return res.status(500).json({ error: "Kunde inte verifiera admin." });
      }
      next();
    })
    .catch((err) => {
      console.error("Admin lookup failed", err);
      res.status(500).json({ error: "Kunde inte verifiera admin." });
    });
};

app.post("/api/settings/verify-admin", requireAdmin, (_req, res) => {
  res.json({ success: true });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  db.all(
    `SELECT id, email AS username, created_at AS createdAt, onboarding_done AS onboardingDone FROM users ORDER BY created_at DESC`,
    async (err, rows) => {
      if (err) {
        console.error("Admin list users failed", err);
        return res.status(500).json({ error: "Kunde inte hämta användare." });
      }
      try {
        const summaries = await Promise.all(
          (rows || []).map(async (row) => {
            const progress = await getLatestProfileSummary(row.id);
            return { ...row, progress };
          }),
        );
        res.json(summaries);
      } catch (summaryErr) {
        console.error("Failed to build user summaries", summaryErr);
        res.json(rows || []);
      }
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
  let googleMapsKey = "";
  try {
    googleMapsKey = await getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY);
  } catch (err) {
    console.error("Failed to read Google Maps key", err);
    return res.status(500).json({ error: "Kunde inte läsa Google Maps-nyckeln." });
  }
  if (!googleMapsKey) {
    return res.status(500).json({ error: "Google Maps-nyckel saknas på servern." });
  }
  const input = (req.query.input || "").toString();
  const sessiontoken = (req.query.sessiontoken || "").toString();
  if (!input || input.length < 3) {
    return res.json({ predictions: [] });
  }
  try {
    const params = new URLSearchParams({
      input,
      key: googleMapsKey,
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

app.get("/api/place-preview", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att hämta kartförhandsgranskning." });
  }
  const address = (req.query.address || "").toString().trim();
  if (!address) {
    return res.status(400).json({ error: "Ange en adress." });
  }
  let googleMapsKey = "";
  try {
    googleMapsKey = await getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY);
  } catch (err) {
    console.error("Failed to read Google Maps key", err);
    return res.status(500).json({ error: "Kunde inte läsa Google Maps-nyckeln." });
  }
  if (!googleMapsKey) {
    return res.status(500).json({ error: "Google Maps-nyckel saknas på servern." });
  }
  try {
    const geocodeParams = new URLSearchParams({
      address,
      key: googleMapsKey,
      language: "sv",
    });
    const geocodeResp = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${geocodeParams.toString()}`,
    );
    if (!geocodeResp.ok) {
      throw new Error("Geocode misslyckades");
    }
    const geocodeData = await geocodeResp.json();
    const result = geocodeData?.results?.[0];
    if (!result) {
      return res.status(404).json({ error: "Hittade ingen matchande adress." });
    }
    const location = result.geometry?.location;
    if (!location?.lat || !location?.lng) {
      return res.status(404).json({ error: "Kunde inte hitta koordinater för adressen." });
    }
    const lat = location.lat;
    const lng = location.lng;
    const fetchImage = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error("Kunde inte hämta bild");
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    };
    const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=16&size=640x360&maptype=roadmap&markers=color:red|${lat},${lng}&key=${googleMapsKey}`;
    const streetViewUrl = `https://maps.googleapis.com/maps/api/streetview?location=${lat},${lng}&size=640x360&key=${googleMapsKey}`;
    const [mapImage, streetImage] = await Promise.all([
      fetchImage(staticMapUrl),
      fetchImage(streetViewUrl).catch(() => null),
    ]);
    res.json({
      address: result.formatted_address || address,
      lat,
      lng,
      mapImage,
      streetImage,
    });
  } catch (err) {
    console.error("Place preview failed", err);
    res.status(500).json({ error: "Kunde inte hämta kartförhandsgranskningen." });
  }
});

app.get("/api/place-preview/batch", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Logga in för att hämta förhandsgranskningar." });
  }
  const qs = req.query.q;
  const query = Array.isArray(qs) ? qs[0] : qs;
  if (!query || query.length < 3) {
    return res.json({ predictions: [] });
  }
  let googleMapsKey = "";
  try {
    googleMapsKey = await getSetting(SETTINGS_KEYS.GOOGLE_MAPS_KEY);
  } catch (err) {
    console.error("Failed to read Google Maps key", err);
    return res.status(500).json({ error: "Kunde inte läsa Google Maps-nyckeln." });
  }
  if (!googleMapsKey) {
    return res.status(500).json({ error: "Google Maps-nyckel saknas på servern." });
  }
  try {
    const autoParams = new URLSearchParams({
      input: query,
      sessiontoken: (req.query.sessiontoken || "").toString(),
      language: "sv",
      key: googleMapsKey,
    });
    const autoResp = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?${autoParams.toString()}`,
    );
    if (!autoResp.ok) {
      throw new Error("Autocomplete misslyckades");
    }
    const autoData = await autoResp.json();
    const predictions = Array.isArray(autoData?.predictions)
      ? autoData.predictions
      : [];
    const results = await Promise.all(
      predictions.map(async (prediction) => {
        try {
          const geocodeParams = new URLSearchParams({
            place_id: prediction.place_id,
            key: googleMapsKey,
            language: "sv",
          });
          const geoResp = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?${geocodeParams.toString()}`,
          );
          if (!geoResp.ok) {
            throw new Error("Geocode misslyckades");
          }
          const geoData = await geoResp.json();
          const geoResult = geoData?.results?.[0];
          if (!geoResult?.geometry?.location) {
            return null;
          }
          const { lat, lng } = geoResult.geometry.location;
          const streetUrl = `https://maps.googleapis.com/maps/api/streetview?location=${lat},${lng}&size=200x120&key=${googleMapsKey}`;
          const resp = await fetch(streetUrl);
          if (!resp.ok) {
            return {
              description: prediction.description,
              place_id: prediction.place_id,
              streetImage: null,
            };
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          return {
            description: prediction.description,
            place_id: prediction.place_id,
            streetImage: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          };
        } catch (err) {
          console.error("Batch preview failed", err);
          return {
            description: prediction.description,
            place_id: prediction.place_id,
            streetImage: null,
          };
        }
      }),
    );
    res.json({ predictions: results.filter(Boolean) });
  } catch (err) {
    console.error("Batch preview autocomplete failed", err);
    res.status(500).json({ error: "Kunde inte hämta adressförhandsgranskningar." });
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
