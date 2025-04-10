const path = require('path');
const { Pool } = require('pg'); // Use PostgreSQL
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, process.env.NODE_ENV === 'production' ? '.env.production' : '.env') });

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN, // Dynamische CORS-Origin
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database schema
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        vorname TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        anzahl_tickets INTEGER NOT NULL,
        zeitpunkt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        letzte_ticketnummer INTEGER,
        bestellnummer TEXT UNIQUE NOT NULL,
        gesamtpreis REAL NOT NULL,
        gezahlt BOOLEAN DEFAULT FALSE,
        token TEXT UNIQUE NOT NULL,
        scanned BOOLEAN DEFAULT FALSE
      );
    `);
  } finally {
    client.release();
  }
}
initializeDatabase().catch(console.error);

// Helper functions
async function ladeBisherigeTickets() {
  const { rows } = await pool.query('SELECT * FROM tickets');
  return rows;
}

async function speichereTicket(ticket) {
  const query = `
    INSERT INTO tickets (vorname, name, email, anzahl_tickets, zeitpunkt, letzte_ticketnummer, bestellnummer, gesamtpreis, token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *;
  `;
  const values = [
    ticket.vorname, ticket.name, ticket.email, ticket.anzahl_tickets,
    ticket.zeitpunkt, ticket.letzte_ticketnummer, ticket.bestellnummer,
    ticket.gesamtpreis, ticket.token
  ];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

async function berechneVerbleibend(maxTickets) {
  const { rows } = await pool.query('SELECT COALESCE(SUM(anzahl_tickets), 0) AS verkauft FROM tickets');
  return maxTickets - rows[0].verkauft;
}

// Hilfsfunktion: Benutzer aus administration.json laden
function ladeBenutzer() {
  try {
    const raw = fs.readFileSync(ADMIN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Fehler beim Laden der Benutzerdatei:', err);
    return [];
  }
}

// Hilfsfunktion: Token validieren
function validiereToken(token) {
  const benutzerListe = ladeBenutzer();

  const benutzer = benutzerListe.find(
    (user) => user.token === token // Vergleiche den übergebenen Token mit dem hinterlegten Token
  );

  return benutzer || null; // Gibt den Benutzer zurück, wenn gefunden, sonst null
}

// Middleware: Token-Authentifizierung
function authentifiziere(req, res, next) {
  const token = req.query.token;

  if (!token) {
    console.error('Fehler: Kein Token bereitgestellt.');
    return res.status(401).sendFile(path.join(__dirname, '../public/unauthorized.html'));
  }

  const benutzer = validiereToken(token);

  if (!benutzer) {
    console.error('Fehler: Ungültiger Token.');
    return res.status(403).sendFile(path.join(__dirname, '../public/unauthorized.html'));
  }

  console.log(`Benutzer authentifiziert: ${benutzer.username}`);
  req.benutzer = benutzer;
  next();
}

// Kombinierte Route: Ticketing und Bestellwesen
app.get('/ticketing', authentifiziere, async (req, res) => {
  console.log('Route /ticketing aufgerufen.');
  if (req.benutzer.recht !== 'Admin' && req.benutzer.recht !== 'Purchase') {
    console.error('Fehler: Keine Berechtigung für Ticketing.');
    return res.status(403).json({ error: 'Keine Berechtigung für Ticketing' });
  }

  // Prüfe, ob JSON-Daten oder HTML-Datei angefordert wird
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    try {
      const tickets = await ladeBisherigeTickets();
      console.log('Tickets erfolgreich geladen:', tickets.length);
      res.json({ tickets });
    } catch (error) {
      console.error('Fehler beim Laden der Tickets:', error);
      res.status(500).json({ error: 'Fehler beim Laden der Tickets.' });
    }
  } else {
    console.log('HTML-Datei für Ticketing wird gesendet.');
    res.sendFile(path.join(__dirname, '../public/ticketing.html'));
  }
});

// Kombinierte Route: Inlet und Ticketscanner
app.get('/inlet', authentifiziere, (req, res) => {
  console.log('Route /inlet aufgerufen.');
  if (req.benutzer.recht !== 'Admin' && req.benutzer.recht !== 'Scanner') {
    console.error('Fehler: Keine Berechtigung für Inlet.');
    return res.status(403).json({ error: 'Keine Berechtigung für Inlet' });
  }

  // Prüfe, ob JSON-Daten oder HTML-Datei angefordert wird
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    console.log('JSON-Daten für Inlet werden gesendet.');
    res.json({ message: 'Zugriff auf Ticketscanner erlaubt' });
  } else {
    console.log('HTML-Datei für Inlet wird gesendet.');
    res.sendFile(path.join(__dirname, '../public/inlet.html'));
  }
});

// GET: Verfügbare Tickets
app.get('/api/verbleibend', async (req, res) => {
  console.log('Route /api/verbleibend aufgerufen.');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const verbleibend = await berechneVerbleibend(config.maxTickets);
    console.log(`Verbleibende Tickets: ${verbleibend}`);
    res.json({ verbleibend });
  } catch (error) {
    console.error('Fehler beim Berechnen der verbleibenden Tickets:', error);
    res.status(500).json({ message: 'Fehler beim Berechnen der verbleibenden Tickets.' });
  }
});

// GET: Fetch all tickets
app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await ladeBisherigeTickets();
    res.json(tickets);
  } catch (error) {
    console.error('Fehler beim Abrufen der Tickets:', error);
    res.status(500).json({ message: 'Fehler beim Abrufen der Tickets.' });
  }
});

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use your email provider
  auth: {
    user: process.env.EMAIL_USER, // Use environment variable for email user
    pass: process.env.EMAIL_PASS  // Use environment variable for email password
  }
});

// Function to send email
function sendeBestellEmail(email, bestellnummer, gesamtpreis, anzahlTickets) {
  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: 'abschlusstickets@gmail.com', // Replace with your email
      to: email,
      subject: 'Deine Ticketbestellung für die Abschlussparty 2025',
      text: `Hallo,

vielen Dank, dass du Tickets für unsere Abschlussparty 2025 bestellt hast! Wir freuen uns sehr, dass du dabei sein möchtest.

Hier sind die Zahlungsinformationen, um deine Bestellung abzuschließen:
Empfänger: Frida Stein
IBAN: DE37370502990045079818
Verwendungszweck: ${bestellnummer}

Anzahl der bestellten Tickets: ${anzahlTickets}
Gesamtbetrag: ${gesamtpreis.toFixed(2)} €

Bitte überweise den Gesamtbetrag auf das oben genannte Konto. Sobald die Zahlung bei uns eingegangen ist, senden wir dir die Tickets per E-Mail zu. Bitte beachte, dass der Überweisungsprozess bis zu 3 Werktage dauern und die Bearbeitung deiner Bestellung bis zu einer Woche in Anspruch nehmen kann.

Falls du Fragen hast oder Unterstützung benötigst, zögere nicht, uns in der Schule anzusprechen. Wir sind gerne für dich da.

Vielen Dank für dein Vertrauen und deine Unterstützung. Wir freuen uns schon darauf, mit dir zu feiern!

Herzliche Grüße,  
Dein Orga-Team der Abschlussparty 2025`
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Fehler beim Senden der E-Mail:', error);
        reject(error);
      } else {
        console.log('E-Mail gesendet:', info.response);
        resolve(true);
      }
    });
  });
}

// POST: Ticketkauf
app.post('/api/tickets', async (req, res) => {
  const { vorname, name, email, anzahl_tickets } = req.body;
  if (!vorname || !name || !email || !anzahl_tickets) {
    return res.status(400).json({ message: 'Alle Felder müssen ausgefüllt sein.' });
  }
  if (anzahl_tickets < 1 || anzahl_tickets > 10) {
    return res.status(400).json({ message: 'Maximal 10 Tickets pro Person erlaubt.' });
  }

  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const verbleibend = await berechneVerbleibend(config.maxTickets);
    if (anzahl_tickets > verbleibend) {
      return res.status(400).json({ message: 'Nicht genügend Tickets verfügbar.' });
    }

    const { rows } = await pool.query('SELECT * FROM tickets WHERE name = $1 AND email = $2', [name, email]);
    if (rows.length > 0) {
      return res.status(400).json({ message: 'Sie haben bereits Tickets gekauft.' });
    }

    const { rows: lastTicketRows } = await pool.query('SELECT MAX(letzte_ticketnummer) AS letzte_ticketnummer FROM tickets');
    const letzte_ticketnummer = lastTicketRows[0].letzte_ticketnummer || 25000;
    const neue_ticketnummern = Array.from({ length: anzahl_tickets }, (_, i) => letzte_ticketnummer + i + 1);
    const bestellnummer = `GFS2025-${String(Date.now()).slice(-4)}`;
    const token = crypto.createHash('sha256').update(`${bestellnummer}${email}`).digest('hex');
    const gesamtpreis = 49.99 + (anzahl_tickets - 1) * 12.49;

    const neuer_eintrag = {
      vorname, name, email, anzahl_tickets,
      zeitpunkt: new Date().toISOString(),
      letzte_ticketnummer: neue_ticketnummern[neue_ticketnummern.length - 1],
      bestellnummer, gesamtpreis, token
    };

    const ticket = await speichereTicket(neuer_eintrag);
    res.status(201).json({
      message: 'Tickets erfolgreich gekauft.',
      bestellnummer,
      gesamtpreis,
      tickets: neue_ticketnummern.map(nr => ({ nummer: nr })),
      token
    });
  } catch (error) {
    console.error('Error saving ticket:', error);
    res.status(500).json({ message: 'Fehler beim Speichern des Tickets.' });
  }
});

// Entferne SQLite-bezogene Funktionen und ersetze sie durch PostgreSQL-Abfragen
app.post('/api/tickets/:bestellnummer/resend-email', async (req, res) => {
  const { bestellnummer } = req.params;

  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE bestellnummer = $1', [bestellnummer]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
    }

    const ticket = rows[0];
    console.log(`Resending email to ${ticket.email} for order ${bestellnummer}`);
    res.json({ message: 'Die Bestätigungs-E-Mail wurde erfolgreich erneut gesendet.' });
  } catch (error) {
    console.error('Error fetching ticket for email resend:', error);
    res.status(500).json({ message: 'Fehler beim Abrufen des Tickets.' });
  }
});

// PATCH: Update payment status
app.patch('/api/tickets/:bestellnummer/gezahlt', async (req, res) => {
  const { bestellnummer } = req.params;
  try {
    const { rowCount } = await pool.query('UPDATE tickets SET gezahlt = TRUE WHERE bestellnummer = $1', [bestellnummer]);
    if (rowCount === 0) {
      return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
    }
    res.json({ message: 'Zahlungsstatus aktualisiert.' });
  } catch (error) {
    console.error('Error updating payment status:', error);
    res.status(500).json({ message: 'Fehler beim Aktualisieren des Zahlungsstatus.' });
  }
});

// Ändere die QR-Code-Validierungsroute, um PostgreSQL zu verwenden
app.post('/api/validate-ticket', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: 'Kein Token bereitgestellt.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE token = $1', [token]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Ungültiger QR-Code.' });
    }

    const ticket = rows[0];
    if (!ticket.gezahlt) {
      return res.status(400).json({ message: 'Ticket ist nicht bezahlt.' });
    }

    if (ticket.scanned) {
      return res.status(400).json({ message: 'Ticket wurde bereits gescannt.' });
    }

    await pool.query('UPDATE tickets SET scanned = TRUE WHERE id = $1', [ticket.id]);
    res.json({ message: `Ticket für ${ticket.name} akzeptiert.` });
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).json({ message: 'Fehler bei der Token-Validierung.' });
  }
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});