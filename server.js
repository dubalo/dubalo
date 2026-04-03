const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your existing domains
app.use(cors({
  origin: ['https://neurotrack.cc', 'https://dubalo.pages.dev', 'http://localhost:3000']
}));

app.use(express.json());
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
`);

// API endpoint to save a symptom record
app.post('/api/symptoms', (req, res) => {
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
        notes
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      values.recordDate,
      values.tremor,
      values.rigidity,
      values.bradykinesia,
      values.instability,
      values.notes
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

// API endpoint to fetch all symptom records
app.get('/api/symptoms', (req, res) => {
  try {
    const rows = db
      .prepare(`
        SELECT id, record_date AS recordDate, tremor, rigidity, bradykinesia, instability, notes, created_at AS createdAt
        FROM symptom_logs
        ORDER BY record_date ASC, id ASC
      `)
      .all();

    res.json(rows);
  } catch (error) {
    console.error('Error fetching symptoms:', error);
    res.status(500).json({ error: 'Internal server error while fetching records.' });
  }
});

// API endpoints for medications
app.post('/api/medications', (req, res) => {
  try {
    const { name, dosage, frequency, schedule, notes } = req.body;
    if (!name || !dosage) {
      return res.status(400).json({ error: 'Name and dosage are required.' });
    }

    const insert = db.prepare(`
      INSERT INTO medications (name, dosage, frequency, schedule, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = insert.run(name, dosage, frequency, schedule || '', notes || '');
    res.status(201).json({ id: result.lastInsertRowid, message: 'Medication added.' });
  } catch (error) {
    console.error('Error saving medication:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/medications', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM medications ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (error) {
    console.error('Error fetching medications:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.delete('/api/medications/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM medications WHERE id = ?').run(id);
    res.json({ message: 'Medication deleted.' });
  } catch (error) {
    console.error('Error deleting medication:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
