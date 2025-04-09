const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // Add crypto module for token generation
const nodemailer = require('nodemailer'); // Add nodemailer for email sending
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'))); // Serve static files from the public folder

const DATA_FILE = path.join(__dirname, 'tickets.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ADMIN_FILE = path.join(__dirname, 'administration.json');

const ORDER_NUMBER_FORMAT = "GFS2025"; // Format für Bestellnummer

const cors = require("cors");

app.get('/api/tickets', (req, res) => {
  const tickets = ladeBisherigeTickets();
  res.json(tickets);
});

app.use(cors({
  origin: "https://abschlusstickets.de", // deine echte Netlify-Domain
  credentials: true
}));


// Hilfsfunktionen
function ladeKonfiguration() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(raw);
}

function ladeBisherigeTickets() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return data ? JSON.parse(data) : [];
  } catch (err) {
    return [];
  }
}

function speichereTickets(tickets) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(tickets, null, 2));
}

function berechneVerbleibend(tickets, maxTickets) {
  const verkauft = tickets.reduce((sum, t) => sum + t.anzahl_tickets, 0);
  return maxTickets - verkauft;
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
  const entschlüsselt = Buffer.from(token, 'base64').toString('utf8'); // Token entschlüsseln
  const [username, recht] = entschlüsselt.split(':');

  const benutzer = benutzerListe.find(
    (user) => user.username === username && user.recht === recht
  );

  return benutzer || null; // Gibt den Benutzer zurück, wenn gefunden, sonst null
}

// Middleware: Token-Authentifizierung
function authentifiziere(req, res, next) {
  // Token aus Header oder Query-Parameter lesen
  const token = req.headers['authorization'] || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Kein Token bereitgestellt' });
  }

  const benutzer = validiereToken(token);

  if (!benutzer) {
    return res.status(403).json({ error: 'Ungültiger Token oder keine Berechtigung' });
  }

  req.benutzer = benutzer; // Benutzerinformationen für nachfolgende Routen speichern
  next();
}

// Beispiel: Geschützte Route für Bestellwesen
app.get('/ticketing', authentifiziere, (req, res) => {
  if (req.benutzer.recht !== 'Purchase' || req.benutzer.recht !== 'Admin') {
    return res.status(403).json({ error: 'Keine Berechtigung für Bestellwesen' });
  }

  const tickets = ladeBisherigeTickets();
  res.json({ tickets });
});

// Beispiel: Geschützte Route für Ticketscanner
app.get('/inlet', authentifiziere, (req, res) => {
  if (req.benutzer.recht !== 'Scanner' || req.benutzer.recht !== 'Admin') {
    return res.status(403).json({ error: 'Keine Berechtigung für Ticketscanner' });
  }

  res.json({ message: 'Zugriff auf Ticketscanner erlaubt' });
});

// GET: Verfügbare Tickets
app.get('/api/verbleibend', (req, res) => {
  const config = ladeKonfiguration();
  const tickets = ladeBisherigeTickets();
  const verbleibend = berechneVerbleibend(tickets, config.maxTickets);
  res.json({ verbleibend });
});

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use your email provider
  auth: {
    user: 'abschlusstickets@gmail.com', // Replace with your email
    pass: 'Abschluss25!'  // Replace with your email password or app-specific password
  }
});

// Function to send email
function sendeBestellEmail(email, bestellnummer, gesamtpreis) {
  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: 'abschlusstickets@gmail.com', // Replace with your email
      to: email,
      subject: 'Ticketbestellung - Abschlussparty 2025',
      text: `Vielen Dank für die Bestellung!

Hier sind die Zahlungsinformationen um den Bestellvorgang abzuschließen:
Empfänger: Frida Stein
IBAN: DE37370502990045079818
Verwendungszweck: ${bestellnummer}

Bitte prüfe und überweise den Gesamtbetrag von ${gesamtpreis.toFixed(2)} € auf das oben genannte Konto.

Nach Eingang der Zahlung werden die Tickets per E-Mail zugeschickt.
Dieser Vorgang kann bis zu einer Woche dauern.

Vielen Dank und wir freuen uns aufs Feiern mit Euch!

Beste Grüße,
Euer Organisationsteam`
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

  // Lese Konfiguration und aktuelle Ticketdaten
  const config = ladeKonfiguration();
  const maxTickets = config.maxTickets;
  const tickets = ladeBisherigeTickets();
  const verbleibend = berechneVerbleibend(tickets, maxTickets);

  // Prüfe, ob noch genug Tickets verfügbar sind
  if (anzahl_tickets > verbleibend) {
    return res.status(400).json({ message: 'Nicht genügend Tickets verfügbar.' });
  }

  // Prüfe, ob der Käufer bereits Tickets gekauft hat
  const existingBuyer = tickets.find(t => t.name === name && t.email === email);
  if (existingBuyer) {
    return res.status(400).json({ message: 'Sie haben bereits Tickets gekauft.' });
  }

  const letzte_ticketnummer = tickets.length
    ? tickets[tickets.length - 1].letzte_ticketnummer
    : 25000;

  const neue_ticketnummern = Array.from({ length: anzahl_tickets }, (_, i) => letzte_ticketnummer + i + 1);

  const bestellnummer = `${ORDER_NUMBER_FORMAT}-${String(tickets.length + 1).padStart(4, '0')}`;
  const token = crypto.createHash('sha256').update(`${bestellnummer}${email}`).digest('hex'); // Generate full token

  const neue_tickets = neue_ticketnummern.map(nr => ({
    nummer: nr,
    qr_code: crypto.createHash('sha256').update(`${bestellnummer}-${email}-${nr}`).digest('hex') // Generate unique QR code
  }));

  const preis_pro_ticket = 55 + (anzahl_tickets - 1) * 7.5;
  const gesamtpreis = preis_pro_ticket; // Gesamtpreis nur für die aktuelle Bestellung berechnen

  const neuer_eintrag = {
    vorname,
    name,
    email,
    anzahl_tickets,
    zeitpunkt: new Date().toISOString(),
    letzte_ticketnummer: neue_ticketnummern[neue_ticketnummern.length - 1],
    bestellnummer,
    gesamtpreis, // Gesamtpreis speichern
    tickets: neue_tickets,
    gezahlt: false, // Initial payment status
    token // Store the full token
  };

  // Speichern
  tickets.push(neuer_eintrag);
  speichereTickets(tickets);

  // Send confirmation email
  try {
    await sendeBestellEmail(email, bestellnummer, gesamtpreis);
    res.status(201).json({
      message: 'Tickets erfolgreich gekauft. Eine Bestätigungs-E-Mail wurde an Ihre Adresse gesendet.',
      emailSent: true,
      bestellnummer,
      email,
      name,
      vorname,
      gesamtpreis, // Include total price for payment
      tickets: neue_tickets,
      token // Include full token in the response
    });
  } catch (error) {
    console.error('Fehler beim Senden der E-Mail:', error);
    res.status(201).json({
      message: 'Tickets erfolgreich reserviert. Die Bestätigungs-E-Mail konnte jedoch nicht gesendet werden. Sie können die E-Mail erneut senden.',
      emailSent: false,
      bestellnummer,
      email,
      name,
      vorname,
      gesamtpreis, // Include total price for payment
      tickets: neue_tickets,
      token // Include full token in the response
    });
  }
});

// POST: E-Mail erneut senden
app.post('/api/tickets/:bestellnummer/resend-email', async (req, res) => {
  const { bestellnummer } = req.params;
  const tickets = ladeBisherigeTickets();
  const ticket = tickets.find(t => t.bestellnummer === bestellnummer);

  if (!ticket) {
    return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
  }

  try {
    await sendeBestellEmail(ticket.email, ticket.bestellnummer, ticket.gesamtpreis);
    res.json({ message: 'Die Bestätigungs-E-Mail wurde erfolgreich erneut gesendet.' });
  } catch (error) {
    console.error('Fehler beim erneuten Senden der E-Mail:', error);
    res.status(500).json({ message: 'Die Bestätigungs-E-Mail konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.' });
  }
});

// PATCH: Update payment status
app.patch('/api/tickets/:bestellnummer/gezahlt', (req, res) => {
  const { bestellnummer } = req.params;
  const tickets = ladeBisherigeTickets();
  const ticketIndex = tickets.findIndex(t => t.bestellnummer === bestellnummer);

  if (ticketIndex === -1) {
    return res.status(404).json({ message: 'Bestellnummer nicht gefunden.' });
  }

  tickets[ticketIndex].gezahlt = true;
  speichereTickets(tickets);
  res.json({ message: 'Zahlungsstatus aktualisiert.', ticket: tickets[ticketIndex] });
});


// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});