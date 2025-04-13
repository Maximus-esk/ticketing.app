const path = require('path');
const { Pool } = require('pg'); // Use PostgreSQL
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');
const PDFDocument = require('pdfkit'); // Add PDF generation library
const QRCode = require('qrcode'); // Add QR code generation library
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

// Update database schema to allow NULL for bestellnummer in ticket_numbers
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
        bestellnummer TEXT UNIQUE NOT NULL,
        gesamtpreis REAL NOT NULL,
        gezahlt BOOLEAN DEFAULT FALSE,
        email_sent BOOLEAN DEFAULT FALSE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_numbers (
        id SERIAL PRIMARY KEY,
        ticketnummer TEXT UNIQUE NOT NULL,
        token TEXT UNIQUE NOT NULL,
        bestellnummer TEXT REFERENCES tickets(bestellnummer) DEFAULT NULL,
        scanned BOOLEAN DEFAULT FALSE
      );
    `);
  } finally {
    client.release();
  }
}

// Simplify ticket number generation logic
async function generiereTicketnummer(email) {
  const client = await pool.connect();
  try {
    // Find the next available ticket number
    const { rows } = await client.query('SELECT MAX(ticketnummer::INTEGER) AS max_nummer FROM ticket_numbers');
    const maxNummer = rows[0].max_nummer || 0;

    const neueNummer = maxNummer + 1;
    if (neueNummer > 999) {
      throw new Error('Keine verfügbaren Ticketnummern mehr.');
    }

    const nummer = String(neueNummer).padStart(3, '0');
    const token = crypto.createHash('sha256').update(`${nummer}${email}`).digest('hex');

    // Insert the new ticket number
    await client.query(
      'INSERT INTO ticket_numbers (ticketnummer, token) VALUES ($1, $2)',
      [nummer, token]
    );

    return { nummer, token };
  } catch (error) {
    console.error('Fehler beim Generieren der Ticketnummer:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Remove unnecessary initialization logic for ticket numbers
async function initializeTicketNumbers() {
  console.log('Ticketnummern werden dynamisch generiert. Keine Vorinitialisierung erforderlich.');
}

// Initialisierung der Datenbank und Ticketnummern
initializeDatabase()
  .then(() => bereinigeTicketNumbers())
  .then(() => initializeTicketNumbers())
  .catch(console.error);

// Helper functions
async function ladeBisherigeTickets() {
  const { rows } = await pool.query('SELECT * FROM tickets');
  return rows;
}

async function speichereTicket(ticket) {
  const query = `
    INSERT INTO tickets (vorname, name, email, anzahl_tickets, zeitpunkt, bestellnummer, gesamtpreis)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *;
  `;
  const values = [
    ticket.vorname, ticket.name, ticket.email, ticket.anzahl_tickets,
    ticket.zeitpunkt, ticket.letzte_ticketnummer, ticket.bestellnummer,
    ticket.gesamtpreis, ticket.token  ];
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
  const token = req.query.token || req.headers['authorization'];

  if (!token) {
    console.error('Fehler: Kein Token bereitgestellt.');
    return res.status(403).json({ message: 'Zugriff verweigert: Kein Token bereitgestellt.' });
  }

  const benutzer = validiereToken(token);

  if (!benutzer) {
    console.error('Fehler: Ungültiger Token.');
    return res.status(403).json({ message: 'Zugriff verweigert: Ungültiger Token.' });
  }

  console.log(`Benutzer authentifiziert: ${benutzer.username}`);
  req.benutzer = benutzer;
  next();
}

// Freigabe der öffentlichen Dateien
app.use(express.static(path.join(__dirname, '../public')));

// Kombinierte Route: Ticketing und Bestellwesen
app.get('/ticketing', authentifiziere, async (req, res) => {
  console.log('Route /ticketing aufgerufen.');
  if (req.benutzer.recht !== 'Admin' && req.benutzer.recht !== 'Purchase') {
    console.error('Fehler: Keine Berechtigung für Ticketing.');
    return res.redirect(`${process.env.CORS_ORIGIN}/unauthorized.html`);
  }

  // Redirect to the frontend ticketing page
  res.redirect(`${process.env.CORS_ORIGIN}/ticketing.html`);
});

// Kombinierte Route: Inlet und Ticketscanner
app.get('/inlet', authentifiziere, (req, res) => {
  console.log('Route /inlet aufgerufen.');
  if (req.benutzer.recht !== 'Admin' && req.benutzer.recht !== 'Scanner') {
    console.error('Fehler: Keine Berechtigung für Inlet.');
    return res.redirect(`${process.env.CORS_ORIGIN}/unauthorized.html`);
  }

  // Redirect to the frontend inlet page
  res.redirect(`${process.env.CORS_ORIGIN}/inlet.html`);
});

// API-Routen ohne Token-Authentifizierung
// GET: Verfügbare Tickets
app.get('/api/verbleibend', async (req, res) => {
  console.log('Route /api/verbleibend aufgerufen.'); // Debug log
  try {
    const configPath = path.join(__dirname, 'config.json');
    console.log(`Lese Konfigurationsdatei von: ${configPath}`); // Debug log
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Config geladen:', config); // Debug log
    const verbleibend = await berechneVerbleibend(config.maxTickets);
    console.log(`Verbleibende Tickets: ${verbleibend}`); // Debug log
    res.json({ verbleibend });
  } catch (error) {
    console.error('Fehler beim Berechnen der verbleibenden Tickets:', error); // Debug log
    res.status(500).json({ message: 'Fehler beim Berechnen der verbleibenden Tickets.', error: error.message });
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

// GET: Fetch unpaid orders
app.get('/api/unpaid-orders', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM tickets 
      WHERE gezahlt = FALSE AND zeitpunkt <= NOW() - INTERVAL '7 days'
    `);
    res.json(rows);
  } catch (error) {
    console.error('Fehler beim Abrufen der unbezahlten Bestellungen:', error);
    res.status(500).json({ message: 'Fehler beim Abrufen der unbezahlten Bestellungen.' });
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
      from: process.env.EMAIL_USER, // Verwenden Sie die Umgebungsvariable
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
        reject(new Error('E-Mail konnte nicht gesendet werden.'));
      } else {
        console.log('E-Mail gesendet:', info.response);
        resolve(true);
      }
    });
  });
}

// Function to generate a styled PDF for a single ticket
async function generateStyledTicketPDF(ticket, order) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {
    console.log('PDF-Generierung abgeschlossen.');
  });

  try {
    // Header
    doc.rect(0, 0, doc.page.width, 100).fill('#121212');
    doc.fillColor('#f0e68c').fontSize(24).text('Abschlussparty 2025', { align: 'center', valign: 'center' });
    doc.moveDown();

    // Ticket details
    doc.fillColor('#000').fontSize(16).text(`Ticketnummer: ${ticket.nummer}`, { align: 'left' });
    doc.text(`Name: ${order.vorname} ${order.name}`, { align: 'left' });
    doc.text(`E-Mail: ${order.email}`, { align: 'left' });
    doc.text(`Bestellnummer: ${order.bestellnummer}`, { align: 'left' });
    doc.text(`Preis: ${ticket.preis.toFixed(2)} €`, { align: 'left' });
    doc.moveDown();

    // QR Code
    const qrCodeData = await QRCode.toDataURL(ticket.token);
    doc.image(qrCodeData, { fit: [150, 150], align: 'center' });
    doc.moveDown();

    // Footer
    doc.rect(0, doc.page.height - 50, doc.page.width, 50).fill('#121212');
    doc.fillColor('#f0e68c').fontSize(12).text('Vielen Dank für deine Unterstützung! Wir freuen uns auf dich.', {
      align: 'center',
      valign: 'bottom',
    });

    doc.end();
    return Buffer.concat(buffers);
  } catch (error) {
    console.error('Fehler bei der PDF-Generierung:', error);
    throw new Error('PDF konnte nicht generiert werden.');
  }
}

// Function to send ticket emails with individual PDFs
async function sendTicketEmails() {
  try {
    const { rows: paidOrders } = await pool.query(
      'SELECT * FROM tickets WHERE gezahlt = TRUE AND email_sent = FALSE'
    );

    for (const order of paidOrders) {
      const tickets = Array.from({ length: order.anzahl_tickets }, (_, i) => ({
        nummer: order.letzte_ticketnummer - order.anzahl_tickets + i + 1,
        token: order.token,
        preis: i === 0 ? 49.99 : 12.49, // First ticket is full price, others are discounted
      }));

      const attachments = [];
      for (const ticket of tickets) {
        const pdfBuffer = await generateStyledTicketPDF(ticket, order);
        attachments.push({
          filename: `Ticket_${ticket.nummer}.pdf`,
          content: pdfBuffer,
        });
      }

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: order.email,
        subject: 'Deine Tickets für die Abschlussparty 2025',
        text: `Hallo ${order.vorname} ${order.name},

anbei findest du deine Tickets für die Abschlussparty 2025. Bitte bringe die Tickets in digitaler oder ausgedruckter Form mit.

Wir freuen uns auf dich!

Herzliche Grüße,
Dein Orga-Team der Abschlussparty 2025`,
        attachments,
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log(`Tickets für ${order.email} gesendet.`);

        // Mark the order as email_sent
        await pool.query('UPDATE tickets SET email_sent = TRUE WHERE id = $1', [order.id]);
      } catch (error) {
        console.error(`Fehler beim Senden der E-Mail an ${order.email}:`, error);
      }
    }
  } catch (error) {
    console.error('Fehler beim Senden der Ticket-E-Mails:', error);
  }
}

// Schedule the function to run every 30 minutes
setInterval(sendTicketEmails, 30 * 60 * 1000);

// POST: Ticketkauf (ohne Token-Authentifizierung)
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

    const neue_bestellnummer = `GFS2025-${String(Date.now()).slice(-4)}`;
    const gesamtpreis = 49.99 + (anzahl_tickets - 1) * 12.49;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO tickets (vorname, name, email, anzahl_tickets, zeitpunkt, bestellnummer, gesamtpreis)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
      `;
      const values = [
        vorname, name, email, anzahl_tickets,
        new Date().toISOString(), neue_bestellnummer, gesamtpreis
      ];
      await client.query(query, values);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.status(201).json({
      message: 'Bestellung erfolgreich gespeichert.',
      bestellnummer: neue_bestellnummer,
      gesamtpreis
    });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).json({ message: 'Fehler beim Speichern der Bestellung.' });
  }
});

// POST: Resend confirmation email (ohne Token-Authentifizierung)
app.post('/api/tickets/:bestellnummer/resend-email', async (req, res) => {
  const { bestellnummer } = req.params;

  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE bestellnummer = $1', [bestellnummer]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
    }

    const order = rows[0];
    const tickets = Array.from({ length: order.anzahl_tickets }, (_, i) => ({
      nummer: order.letzte_ticketnummer - order.anzahl_tickets + i + 1,
      token: order.token,
      preis: i === 0 ? 49.99 : 12.49, // First ticket is full price, others are discounted
    }));

    const attachments = [];
    for (const ticket of tickets) {
      const pdfBuffer = await generateStyledTicketPDF(ticket, order);
      attachments.push({
        filename: `Ticket_${ticket.nummer}.pdf`,
        content: pdfBuffer,
      });
    }

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: order.email,
      subject: 'Deine Tickets für die Abschlussparty 2025',
      text: `Hallo ${order.vorname} ${order.name},

anbei findest du deine Tickets für die Abschlussparty 2025. Bitte bringe die Tickets in digitaler oder ausgedruckter Form mit.

Wir freuen uns auf dich!

Herzliche Grüße,
Dein Orga-Team der Abschlussparty 2025`,
      attachments,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Tickets für ${order.email} erneut gesendet.`);
    res.json({ message: 'Die Ticket-E-Mail wurde erfolgreich erneut gesendet.' });
  } catch (error) {
    console.error('Fehler beim erneuten Senden der Ticket-E-Mail:', error);
    res.status(500).json({ message: 'Fehler beim erneuten Senden der Ticket-E-Mail.' });
  }
});

// POST: Send reminder email for unpaid orders
app.post('/api/tickets/:bestellnummer/send-reminder', async (req, res) => {
  const { bestellnummer } = req.params;

  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE bestellnummer = $1', [bestellnummer]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
    }

    const ticket = rows[0];
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: ticket.email,
      subject: 'Erinnerung: Ihre Ticketreservierung läuft bald ab',
      text: `Hallo ${ticket.vorname} ${ticket.name},

Ihre Ticketreservierung für die Abschlussparty 2025 läuft in einer Woche ab. Bitte überweisen Sie den Betrag von ${ticket.gesamtpreis.toFixed(2)} € an:

Empfänger: Frida Stein
IBAN: DE37370502990045079818
Verwendungszweck: ${ticket.bestellnummer}

Falls keine Zahlung eingeht, wird Ihre Reservierung automatisch gelöscht.

Vielen Dank,
Ihr Orga-Team der Abschlussparty 2025`
    });

    await pool.query('UPDATE tickets SET reminder_sent = TRUE WHERE bestellnummer = $1', [bestellnummer]);
    res.json({ message: 'Erinnerungs-E-Mail erfolgreich gesendet.' });
  } catch (error) {
    console.error('Fehler beim Senden der Erinnerungs-E-Mail:', error);
    res.status(500).json({ message: 'Fehler beim Senden der Erinnerungs-E-Mail.' });
  }
});

// PATCH: Update payment status and generate tickets
app.patch('/api/tickets/:bestellnummer/gezahlt', authentifiziere, async (req, res) => {
  const { bestellnummer } = req.params;

  if (!req.benutzer || req.benutzer.recht !== 'Admin') {
    return res.status(403).json({ message: 'Zugriff verweigert: Keine Berechtigung.' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'UPDATE tickets SET gezahlt = TRUE WHERE bestellnummer = $1 RETURNING *',
        [bestellnummer]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
      }

      const order = rows[0];
      const ticketnummern = [];
      for (let i = 0; i < order.anzahl_tickets; i++) {
        const { nummer, token } = await generiereTicketnummer(order.email);
        ticketnummern.push({ nummer, token });
      }

      for (const { nummer } of ticketnummern) {
        await client.query(
          'UPDATE ticket_numbers SET bestellnummer = $1 WHERE ticketnummer = $2',
          [bestellnummer, nummer]
        );
      }

      await client.query('COMMIT');
      res.json({ message: 'Zahlungsstatus aktualisiert und Tickets generiert.', tickets: ticketnummern });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Fehler beim Aktualisieren des Zahlungsstatus:', error);
      res.status(500).json({ message: 'Fehler beim Aktualisieren des Zahlungsstatus.' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Fehler beim Verarbeiten der Anfrage:', error);
    res.status(500).json({ message: 'Interner Serverfehler.' });
  }
});

// POST: Validate ticket via QR code
app.post('/api/validate-ticket', authentifiziere, async (req, res) => {
  const { token } = req.body;

  if (!req.benutzer || req.benutzer.recht !== 'Scanner') {
    return res.status(403).json({ message: 'Zugriff verweigert: Keine Berechtigung.' });
  }

  if (!token) {
    return res.status(400).json({ message: 'Kein Token bereitgestellt.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM ticket_numbers WHERE token = $1', [token]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Ungültiger QR-Code.' });
    }

    const ticket = rows[0];
    if (!ticket.bestellnummer) {
      return res.status(400).json({ message: 'Ticket ist nicht mit einer Bestellung verknüpft.' });
    }

    const { rows: orderRows } = await pool.query('SELECT * FROM tickets WHERE bestellnummer = $1', [ticket.bestellnummer]);
    if (orderRows.length === 0 || !orderRows[0].gezahlt) {
      return res.status(400).json({ message: 'Ticket ist nicht bezahlt.' });
    }

    if (ticket.scanned) {
      return res.status(400).json({ message: 'Ticket wurde bereits gescannt.' });
    }

    await pool.query('UPDATE ticket_numbers SET scanned = TRUE WHERE id = $1', [ticket.id]);
    res.json({ message: `Ticket akzeptiert: ${orderRows[0].vorname} ${orderRows[0].name}` });
  } catch (error) {
    console.error('Fehler bei der Token-Validierung:', error);
    res.status(500).json({ message: 'Fehler bei der Token-Validierung.' });
  }
});

// DELETE: Remove a ticket by ID
app.delete('/api/tickets/:id', authentifiziere, async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM tickets WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ message: 'Ticket nicht gefunden.' });
    }
    res.json({ message: 'Ticket erfolgreich gelöscht.' });
  } catch (error) {
    console.error('Fehler beim Löschen des Tickets:', error);
    res.status(500).json({ message: 'Fehler beim Löschen des Tickets.' });
  }
});

// DELETE: Remove unpaid orders after 2 weeks
app.delete('/api/tickets/:bestellnummer', async (req, res) => {
  const { bestellnummer } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Freigeben der Ticketnummern
    await client.query(
      'UPDATE ticket_numbers SET bestellnummer = NULL WHERE bestellnummer = $1',
      [bestellnummer]
    );

    // Löschen der Bestellung
    const { rowCount } = await client.query(
      'DELETE FROM tickets WHERE bestellnummer = $1',
      [bestellnummer]
    );

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Bestellung nicht gefunden.' });
    }

    await client.query('COMMIT');
    res.json({ message: 'Bestellung erfolgreich gelöscht und Ticketnummern freigegeben.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Fehler beim Löschen der Bestellung:', error);
    res.status(500).json({ message: 'Fehler beim Löschen der Bestellung.' });
  } finally {
    client.release();
  }
});

// DELETE: Remove an order by bestellnummer
app.delete('/api/tickets/:bestellnummer', async (req, res) => {
  const { bestellnummer } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Entferne alle Ticketnummern, die mit der Bestellung verknüpft sind
    await client.query(
      'DELETE FROM ticket_numbers WHERE bestellnummer = $1',
      [bestellnummer]
    );

    // Lösche die Bestellung
    const { rowCount } = await client.query(
      'DELETE FROM tickets WHERE bestellnummer = $1',
      [bestellnummer]
    );

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Bestellung nicht gefunden.' });
    }

    await client.query('COMMIT');
    res.json({ message: 'Bestellung und zugehörige Daten erfolgreich gelöscht.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Fehler beim Löschen der Bestellung:', error);
    res.status(500).json({ message: 'Fehler beim Löschen der Bestellung.' });
  } finally {
    client.release();
  }
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

async function bereinigeTicketNumbers() {
  const client = await pool.connect();
  try {
    console.log('Bereinige ungültige Einträge in der Tabelle ticket_numbers...');

    // Setze `bestellnummer` auf NULL, wenn die zugehörige Bestellung nicht existiert
    const { rowCount } = await client.query(`
      UPDATE ticket_numbers
      SET bestellnummer = NULL
      WHERE bestellnummer IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tickets WHERE tickets.bestellnummer = ticket_numbers.bestellnummer
      );
    `);

    console.log(`${rowCount} ungültige Einträge wurden bereinigt.`);
  } catch (error) {
    console.error('Fehler bei der Bereinigung der Tabelle ticket_numbers:', error);
  } finally {
    client.release();
  }
}

// Initialisierung der Datenbank und Bereinigung
initializeDatabase()
  .then(() => bereinigeTicketNumbers())
  .then(() => initializeTicketNumbers())
  .catch(console.error);