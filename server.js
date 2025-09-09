// backend/server.js

// Import required modules
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken'); // For securing admin endpoints

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow CORS for frontend access
app.use(bodyParser.json());

// Google Sheets Authentication
const SERVICE_ACCOUNT_KEY = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY); // Store as environment variable for security
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // Your Google Sheet ID
const jwtClient = new google.auth.JWT(
  SERVICE_ACCOUNT_KEY.client_email,
  null,
  SERVICE_ACCOUNT_KEY.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);

// Sheets API instance
const sheets = google.sheets({ version: 'v4', auth: jwtClient });

// In-memory data (for simplicity; in production, use Redis or database)
let attendanceData = {};
let leaveData = {};
let employees = {}; // Load from Google Sheets initially

// Your JWT secret (store securely in env variables)
const JWT_SECRET = process.env.JWT_SECRET;

// Helper function to load employees from Google Sheets
async function loadEmployeesFromSheets() {
  try {
    const ranges = ['Employees!A:D']; // Adjust column ranges as needed
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: ranges,
    });
    const employeesSheet = response.data.valueRanges[0].values || [];
    employeesSheet.forEach(row => {
      if (row[0] && row[1]) {
        employees[row[0]] = { name: row[1], password: row[2], isAdmin: row[3] === 'true' };
      }
    });
    console.log('Employees loaded from Google Sheets');
  } catch (error) {
    console.error('Error loading employees:', error);
  }
}

// Load initial data on startup
loadEmployeesFromSheets();

// Load attendance data from Google Sheets (adjust range)
async function loadAttendanceFromSheets() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:G', // Adjust columns
    });
    const rows = response.data.values || [];
    rows.forEach(row => {
      const empId = row[0];
      const date = row[1];
      const checkIn = row[2];
      const checkOut = row[3];
      const location = JSON.parse(row[4] || '{}'); // Assuming location is JSON string
      const isLate = row[5] === 'true';
      const isHalfDay = row[6] === 'true';

      if (!attendanceData[empId]) attendanceData[empId] = {};
      attendanceData[empId][date] = {
        checkIn,
        checkOut,
        checkInLocation: location.checkIn || {},
        checkOutLocation: location.checkOut || {},
        isLate,
        isHalfDay,
        date
      };
    });
    console.log('Attendance loaded from Google Sheets');
  } catch (error) {
    console.error('Error loading attendance:', error);
  }
}

// Load leave data (similarly)
async function loadLeaveFromSheets() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Leave!A:H', // Adjust columns (A to H covers 8 columns)
    });
    const rows = response.data.values || [];
    rows.forEach(row => {
      const empId = row[0];
      const leave = {
        id: parseInt(row[1]),
        type: row[2],
        fromDate: row[3],
        toDate: row[4],
        reason: row[5],
        status: row[6],
        appliedOn: row[7],
        employeeId: empId // Added for consistency
      };
      if (!leaveData[empId]) leaveData[empId] = [];
      leaveData[empId].push(leave);
    });
    console.log('Leave loaded from Google Sheets');
  } catch (error) {
    console.error('Error loading leave:', error);
  }
}

// Routes

// Employee Login (returns JWT if admin)
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  if (employees[id] && employees[id].password === password) {
    const token = jwt.sign({ userId: id, isAdmin: employees[id].isAdmin }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, name: employees[id].name, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Middleware to verify admin JWT
function verifyAdmin(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Access denied' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ message: 'Admin access required' });
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Get attendance data
app.get('/api/attendance/:empId', async (req, res) => {
  const { empId } = req.params;
  res.json(attendanceData[empId] || {});
});

// Post attendance
app.post('/api/attendance', async (req, res) => {
  const { empId, date, checkIn, checkOut, location, isLate, isHalfDay } = req.body;
  if (!attendanceData[empId]) attendanceData[empId] = {};
  attendanceData[empId][date] = {
    checkIn,
    checkOut,
    location,
    isLate,
    isHalfDay,
    date
  };

  // Save to Google Sheets
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:G',
      valueInputOption: 'RAW',
      resource: {
        values: [[empId, date, checkIn, checkOut, JSON.stringify(location), isLate, isHalfDay]]
      }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving attendance:', error);
    res.status(500).json({ success: false, message: 'Failed to save attendance' });
  }
});

// Get leave data
app.get('/api/leave/:empId', async (req, res) => {
  const { empId } = req.params;
  res.json(leaveData[empId] || []);
});

// Post leave
app.post('/api/leave', async (req, res) => {
  const { empId, type, fromDate, toDate, reason } = req.body;
  const leave = {
    id: Date.now(),
    type,
    fromDate,
    toDate,
    reason,
    status: 'Pending',
    appliedOn: new Date().toLocaleDateString(),
    employeeId: empId
  };
  if (!leaveData[empId]) leaveData[empId] = [];
  leaveData[empId].push(leave);

  // Save to Google Sheets
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Leave!A:H',
      valueInputOption: 'RAW',
      resource: {
        values: [[empId, leave.id, leave.type, leave.fromDate, leave.toDate, leave.reason, leave.status, leave.appliedOn]]
      }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving leave:', error);
    res.status(500).json({ success: false, message: 'Failed to save leave' });
  }
});

// Admin-only: Get all attendance
app.get('/api/admin/attendance', verifyAdmin, async (req, res) => {
  res.json(attendanceData);
});

// Admin-only: Update leave status
app.put('/api/leave/:empId/:leaveId', verifyAdmin, async (req, res) => {
  const { empId, leaveId } = req.params;
  const { status } = req.body;
  const leaveList = leaveData[empId];
  if (!leaveList) return res.status(404).json({ message: 'Leave not found' });
  const leave = leaveList.find(l => l.id.toString() === leaveId);
  if (!leave) return res.status(404).json({ message: 'Leave not found' });
  leave.status = status;

  // Update in Google Sheets
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Leave!A:H',
    });
    const rows = response.data.values;
    const rowIndex = rows.findIndex(row => row[0] === empId && row[1] === leaveId);
    if (rowIndex > -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Leave!F${rowIndex + 2}`, // Column F is status, +2 for header row
        valueInputOption: 'RAW',
        resource: { values: [[status]] }
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating leave status:', error);
    res.status(500).json({ success: false, message: 'Failed to update leave status' });
  }
});

// Admin-only: Add/Update employee
app.post('/api/admin/employee', verifyAdmin, async (req, res) => {
  const { id, name, password, isAdmin } = req.body;
  employees[id] = { name, password, isAdmin: isAdmin || false };

  // Save to Google Sheets
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Employees!A:D',
      valueInputOption: 'RAW',
      resource: {
        values: [[id, name, password, isAdmin ? 'true' : 'false']]
      }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving employee:', error);
    res.status(500).json({ success: false, message: 'Failed to save employee' });
  }
});

// Admin-only: Delete employee
app.delete('/api/admin/employee/:id', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  delete employees[id];
  delete attendanceData[id];
  delete leaveData[id];
  res.json({ success: true });
});

// Admin-only: Get all leave requests
app.get('/api/admin/leave', verifyAdmin, async (req, res) => {
  res.json(leaveData);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Load data on startup
  loadAttendanceFromSheets();
  loadLeaveFromSheets();

});
