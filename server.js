const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Reads ANTHROPIC_API_KEY from the environment (set as a Cloud Run secret in production)
const anthropic = new Anthropic();

// JWT_SECRET must be set as a Cloud Run secret in production. Without it, sessions
// won't survive a restart or be shared across multiple instances.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn(
    'WARNING: JWT_SECRET is not set. Using a temporary random secret for this run only — ' +
    'logins will break on restart or when Cloud Run scales to more than one instance. ' +
    'Set JWT_SECRET in your environment for production.'
  );
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || crypto.randomBytes(32).toString('hex');

const COOKIE_NAME = 'neurotrack_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
};

// Enable CORS for your existing domains (credentials required for the auth cookie)
app.use(cors({
  origin: ['https://neurotrack.cc', 'https://www.neurotrack.cc', 'https://dubalo.pages.dev', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// Initialize the database
const db = new Database(path.join(__dirname, 'symptoms.db'));

// Create the tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS symptom_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date TEXT NOT NULL,
    tremor INTEGER NOT NULL,
    rigidity INTEGER NOT NULL,
    bradykinesia INTEGER NOT NULL,
    instability INTEGER NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS medications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dosage TEXT NOT NULL,
    frequency TEXT NOT NULL,
    schedule TEXT,
    notes TEXT,
    date_added TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clinical_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_date TEXT NOT NULL,
    doctor_name TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    share_code TEXT NOT NULL UNIQUE,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patient_members (
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (patient_id, user_id)
  );
`);

// Migrate existing single-tenant tables to carry a nullable patient_id.
// Rows created before this migration keep patient_id = NULL and won't be
// visible to any account until re-entered under a patient record.
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('symptom_logs', 'patient_id', 'patient_id INTEGER REFERENCES patients(id)');
ensureColumn('medications', 'patient_id', 'patient_id INTEGER REFERENCES patients(id)');
ensureColumn('clinical_history', 'patient_id', 'patient_id INTEGER REFERENCES patients(id)');

function generateShareCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function issueToken(res, payload) {
  const token = jwt.sign(payload, EFFECTIVE_JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
}

function listPatientsForUser(userId) {
  return db.prepare(`
    SELECT p.id, p.name, p.share_code AS shareCode, pm.role
    FROM patient_members pm
    JOIN patients p ON p.id = pm.patient_id
    WHERE pm.user_id = ?
    ORDER BY (pm.role = 'owner') DESC, pm.joined_at ASC
  `).all(userId);
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.userId = payload.userId;
    req.patientId = payload.patientId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, patientName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = db
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(normalizedEmail, passwordHash, name);
    const userId = userResult.lastInsertRowid;

    const finalPatientName = patientName || `${name}'s Records`;
    const shareCode = generateShareCode();
    const patientResult = db
      .prepare('INSERT INTO patients (name, share_code, owner_user_id) VALUES (?, ?, ?)')
      .run(finalPatientName, shareCode, userId);
    const patientId = patientResult.lastInsertRowid;

    db.prepare('INSERT INTO patient_members (patient_id, user_id, role) VALUES (?, ?, ?)')
      .run(patientId, userId, 'owner');

    issueToken(res, { userId, patientId });
    res.status(201).json({
      user: { id: userId, email: normalizedEmail, name },
      activePatient: { id: patientId, name: finalPatientName, shareCode, role: 'owner' }
    });
  } catch (error) {
    console.error('Error signing up:', error);
    res.status(500).json({ error: 'Internal server error during signup.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const patients = listPatientsForUser(user.id);
    if (patients.length === 0) {
      return res.status(500).json({ error: 'Account has no associated patient record.' });
    }

    const activePatient = patients[0];
    issueToken(res, { userId: user.id, patientId: activePatient.id });

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      activePatient,
      patients
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  res.json({ message: 'Logged out.' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const patients = listPatientsForUser(req.userId);
  const activePatient = patients.find((p) => p.id === req.patientId) || patients[0];

  res.json({ user, activePatient, patients });
});

// ---------------------------------------------------------------------------
// Patient (shared record) endpoints
// ---------------------------------------------------------------------------

app.post('/api/patients/select', requireAuth, (req, res) => {
  try {
    const { patientId } = req.body;
    const membership = db
      .prepare('SELECT * FROM patient_members WHERE patient_id = ? AND user_id = ?')
      .get(patientId, req.userId);

    if (!membership) {
      return res.status(403).json({ error: 'You do not have access to that patient record.' });
    }

    issueToken(res, { userId: req.userId, patientId: Number(patientId) });
    res.json({ message: 'Switched active patient record.' });
  } catch (error) {
    console.error('Error switching patient:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/patients/join', requireAuth, (req, res) => {
  try {
    const { shareCode } = req.body;
    if (!shareCode) {
      return res.status(400).json({ error: 'Share code is required.' });
    }

    const patient = db
      .prepare('SELECT * FROM patients WHERE share_code = ?')
      .get(String(shareCode).trim().toUpperCase());

    if (!patient) {
      return res.status(404).json({ error: 'No patient record found for that share code.' });
    }

    const existingMembership = db
      .prepare('SELECT * FROM patient_members WHERE patient_id = ? AND user_id = ?')
      .get(patient.id, req.userId);

    if (!existingMembership) {
      db.prepare('INSERT INTO patient_members (patient_id, user_id, role) VALUES (?, ?, ?)')
        .run(patient.id, req.userId, 'member');
    }

    issueToken(res, { userId: req.userId, patientId: patient.id });
    res.json({
      message: 'Joined patient record.',
      activePatient: { id: patient.id, name: patient.name, shareCode: patient.share_code }
    });
  } catch (error) {
    console.error('Error joining patient record:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Clinical history (scoped to the active patient record)
// ---------------------------------------------------------------------------

app.post('/api/history', requireAuth, (req, res) => {
  try {
    const { visitDate, doctorName, notes } = req.body;
    if (!visitDate || !doctorName) {
      return res.status(400).json({ error: 'Visit date and doctor name are required.' });
    }

    const insert = db.prepare(`
      INSERT INTO clinical_history (visit_date, doctor_name, notes, patient_id)
      VALUES (?, ?, ?, ?)
    `);

    const result = insert.run(visitDate, doctorName, notes || '', req.patientId);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Record added.' });
  } catch (error) {
    console.error('Error saving history:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/history', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM clinical_history WHERE patient_id = ? ORDER BY visit_date DESC')
      .all(req.patientId);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM clinical_history WHERE id = ? AND patient_id = ?').run(id, req.patientId);
    res.json({ message: 'Record deleted.' });
  } catch (error) {
    console.error('Error deleting history:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Symptom logs (scoped to the active patient record)
// ---------------------------------------------------------------------------

app.post('/api/symptoms', requireAuth, (req, res) => {
  try {
    const { recordDate, tremor, rigidity, bradykinesia, instability, notes } = req.body;

    const values = {
      recordDate,
      tremor: Number(tremor),
      rigidity: Number(rigidity),
      bradykinesia: Number(bradykinesia),
      instability: Number(instability),
      notes: notes || ''
    };

    if (!values.recordDate) {
      return res.status(400).json({ error: 'recordDate is required.' });
    }

    const symptomKeys = ['tremor', 'rigidity', 'bradykinesia', 'instability'];
    for (const key of symptomKeys) {
      if (isNaN(values[key]) || values[key] < 0 || values[key] > 10) {
        return res.status(400).json({ error: `${key} must be a number between 0 and 10.` });
      }
    }

    const insert = db.prepare(`
      INSERT INTO symptom_logs (
        record_date,
        tremor,
        rigidity,
        bradykinesia,
        instability,
        notes,
        patient_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      values.recordDate,
      values.tremor,
      values.rigidity,
      values.bradykinesia,
      values.instability,
      values.notes,
      req.patientId
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      message: 'Symptom record saved successfully.'
    });
  } catch (error) {
    console.error('Error saving symptom:', error);
    res.status(500).json({ error: 'Internal server error while saving record.' });
  }
});

app.get('/api/symptoms', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare(`
        SELECT id, record_date AS recordDate, tremor, rigidity, bradykinesia, instability, notes, created_at AS createdAt
        FROM symptom_logs
        WHERE patient_id = ?
        ORDER BY record_date ASC, id ASC
      `)
      .all(req.patientId);

    res.json(rows);
  } catch (error) {
    console.error('Error fetching symptoms:', error);
    res.status(500).json({ error: 'Internal server error while fetching records.' });
  }
});

// ---------------------------------------------------------------------------
// Medications (scoped to the active patient record)
// ---------------------------------------------------------------------------

app.post('/api/medications', requireAuth, (req, res) => {
  try {
    const { name, dosage, frequency, schedule, notes } = req.body;
    if (!name || !dosage) {
      return res.status(400).json({ error: 'Name and dosage are required.' });
    }

    const insert = db.prepare(`
      INSERT INTO medications (name, dosage, frequency, schedule, notes, patient_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(name, dosage, frequency, schedule || '', notes || '', req.patientId);
    res.status(201).json({ id: result.lastInsertRowid, message: 'Medication added.' });
  } catch (error) {
    console.error('Error saving medication:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/medications', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM medications WHERE patient_id = ? ORDER BY created_at DESC')
      .all(req.patientId);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching medications:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.delete('/api/medications/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM medications WHERE id = ? AND patient_id = ?').run(id, req.patientId);
    res.json({ message: 'Medication deleted.' });
  } catch (error) {
    console.error('Error deleting medication:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Claude-generated doctor-visit summary (scoped to the active patient record)
// ---------------------------------------------------------------------------

app.post('/api/summary', requireAuth, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Summary feature is not configured on the server.' });
    }

    const symptoms = db.prepare(`
      SELECT record_date AS recordDate, tremor, rigidity, bradykinesia, instability, notes
      FROM symptom_logs
      WHERE patient_id = ? AND record_date >= date('now', '-30 days')
      ORDER BY record_date ASC
    `).all(req.patientId);

    const medications = db.prepare(`
      SELECT name, dosage, frequency, schedule, notes
      FROM medications
      WHERE patient_id = ?
      ORDER BY created_at DESC
    `).all(req.patientId);

    const recentVisits = db.prepare(`
      SELECT visit_date AS visitDate, doctor_name AS doctorName, notes
      FROM clinical_history
      WHERE patient_id = ?
      ORDER BY visit_date DESC
      LIMIT 5
    `).all(req.patientId);

    if (symptoms.length === 0 && medications.length === 0 && recentVisits.length === 0) {
      return res.status(400).json({ error: 'No logged data available to summarize yet.' });
    }

    const patientData = JSON.stringify({ symptoms, medications, recentVisits }, null, 2);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: "You are a clinical documentation assistant helping a Parkinson's disease patient prepare for a doctor visit. Summarize the provided symptom logs, medications, and recent visit notes into a clear, well-organized brief the patient can hand to their doctor. Use plain language, group related information, and call out any trends the data shows (e.g. worsening tremor scores over time). Only use information present in the data — do not invent details, and do not offer a diagnosis or treatment advice.",
      messages: [
        {
          role: 'user',
          content: `Here is the patient's logged data as JSON:\n\n${patientData}\n\nWrite a doctor-visit summary.`
        }
      ]
    });

    const summary = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    res.json({ summary });
  } catch (error) {
    console.error('Error generating summary:', error);
    res.status(500).json({ error: 'Internal server error while generating summary.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
