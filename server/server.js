const express = require('express');
const cors = require('cors');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Angular Ionic web app (running on localhost:8100 or mobile origins)
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize persistent SQLite database file
const dbPath = path.join(__dirname, 'fieldbi_invoices.db');
const db = new DatabaseSync(dbPath);

console.log(`[FieldBi Database] Connected to SQLite database at: ${dbPath}`);

// Create database tables if they do not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS ap_invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    vendor_name TEXT NOT NULL,
    invoice_date TEXT,
    due_date TEXT,
    billed_to TEXT,
    currency TEXT DEFAULT 'USD',
    subtotal REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    grand_total REAL NOT NULL,
    raw_ocr_text TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ap_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL,
    item_no INTEGER NOT NULL,
    description TEXT,
    quantity REAL DEFAULT 1,
    unit_price REAL DEFAULT 0,
    total REAL DEFAULT 0,
    FOREIGN KEY (invoice_id) REFERENCES ap_invoices(id) ON DELETE CASCADE
  );
`);

/**
 * POST /api/ap-invoices
 * Insert a verified AP Invoice into the database
 */
app.post('/api/ap-invoices', (req, res) => {
  try {
    const inv = req.body;

    if (!inv || !inv.vendorName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: vendorName',
      });
    }

    const id = 'inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const invoiceNumber = (inv.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`).trim();
    const vendorName = (inv.vendorName || 'Unknown Vendor').trim();
    const invoiceDate = inv.invoiceDate || new Date().toISOString().split('T')[0];
    const dueDate = inv.dueDate || '';
    const billedTo = inv.billedTo || '';
    const currency = inv.currency || 'USD';
    const subtotal = Number(inv.subtotal) || 0;
    const taxRate = Number(inv.taxRate) || 0;
    const taxAmount = Number(inv.taxAmount) || 0;
    const grandTotal = Number(inv.grandTotal) || 0;
    const rawOcrText = inv.rawOcrText || '';
    const createdAt = Date.now();

    // Insert or replace header
    const insertInvoice = db.prepare(`
      INSERT INTO ap_invoices (
        id, invoice_number, vendor_name, invoice_date, due_date, billed_to,
        currency, subtotal, tax_rate, tax_amount, grand_total, raw_ocr_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invoice_number) DO UPDATE SET
        vendor_name = excluded.vendor_name,
        invoice_date = excluded.invoice_date,
        due_date = excluded.due_date,
        billed_to = excluded.billed_to,
        currency = excluded.currency,
        subtotal = excluded.subtotal,
        tax_rate = excluded.tax_rate,
        tax_amount = excluded.tax_amount,
        grand_total = excluded.grand_total,
        raw_ocr_text = excluded.raw_ocr_text,
        created_at = excluded.created_at
    `);

    insertInvoice.run(
      id,
      invoiceNumber,
      vendorName,
      invoiceDate,
      dueDate,
      billedTo,
      currency,
      subtotal,
      taxRate,
      taxAmount,
      grandTotal,
      rawOcrText,
      createdAt
    );

    // Clean any prior items for this invoice
    db.prepare('DELETE FROM ap_invoice_items WHERE invoice_id = ?').run(id);

    // Insert line items
    const items = Array.isArray(inv.items) ? inv.items : [];
    if (items.length > 0) {
      const insertItem = db.prepare(`
        INSERT INTO ap_invoice_items (invoice_id, item_no, description, quantity, unit_price, total)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        insertItem.run(
          id,
          item.itemNo || i + 1,
          item.description || `Item ${i + 1}`,
          Number(item.quantity) || 1,
          Number(item.unitPrice) || 0,
          Number(item.total) || 0
        );
      }
    }

    console.log(`[FieldBi Database] Stored AP Invoice #${invoiceNumber} for ${currency} ${grandTotal} from "${vendorName}"`);

    return res.status(201).json({
      success: true,
      id,
      invoiceNumber,
      vendorName,
      grandTotal,
      currency,
      itemCount: items.length,
      message: `AP Invoice #${invoiceNumber} successfully saved to FieldBi database!`,
    });
  } catch (error) {
    console.error('[FieldBi Database Error]:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Database insertion error',
    });
  }
});

/**
 * GET /api/ap-invoices
 * Retrieve all saved AP Invoices with their line items
 */
app.get('/api/ap-invoices', (req, res) => {
  try {
    const invoices = db.prepare('SELECT * FROM ap_invoices ORDER BY created_at DESC').all();

    const getItems = db.prepare('SELECT * FROM ap_invoice_items WHERE invoice_id = ? ORDER BY item_no ASC');

    const result = invoices.map((inv) => {
      const items = getItems.all(inv.id).map((it) => ({
        itemNo: it.item_no,
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        total: it.total,
      }));

      return {
        id: inv.id,
        documentType: 'AP_INVOICE',
        invoiceNumber: inv.invoice_number,
        vendorName: inv.vendor_name,
        invoiceDate: inv.invoice_date,
        dueDate: inv.due_date,
        billedTo: inv.billed_to,
        currency: inv.currency,
        subtotal: inv.subtotal,
        taxRate: inv.tax_rate,
        taxAmount: inv.tax_amount,
        grandTotal: inv.grand_total,
        items,
        createdAt: inv.created_at,
        createdFormatted: new Date(inv.created_at).toLocaleString(),
      };
    });

    res.json({
      success: true,
      count: result.length,
      invoices: result,
    });
  } catch (error) {
    console.error('[FieldBi Database Error]:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ap-invoices/:id
 * Retrieve a single AP Invoice
 */
app.get('/api/ap-invoices/:id', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ? OR invoice_number = ?').get(req.params.id, req.params.id);
    if (!inv) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    const items = db.prepare('SELECT * FROM ap_invoice_items WHERE invoice_id = ? ORDER BY item_no ASC').all(inv.id);

    res.json({
      success: true,
      invoice: {
        ...inv,
        items,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/ap-invoices/:id
 * Delete an AP Invoice
 */
app.delete('/api/ap-invoices/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM ap_invoices WHERE id = ? OR invoice_number = ?').run(req.params.id, req.params.id);
    db.prepare('DELETE FROM ap_invoice_items WHERE invoice_id = ?').run(req.params.id);

    res.json({
      success: true,
      deleted: info.changes > 0,
      message: 'AP Invoice deleted successfully',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /
 * Beautiful FieldBi Live Invoices Dashboard
 */
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FieldBi AP Invoice Database Explorer</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0b0f17;
      color: #e2e8f0;
      padding: 32px 24px;
      min-height: 100vh;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      flex-wrap: wrap;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .badge {
      background: #ec1f28;
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      padding: 4px 8px;
      border-radius: 6px;
      letter-spacing: 0.5px;
    }
    .title { font-size: 22px; font-weight: 700; color: #fff; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 18px 20px;
    }
    .stat-label { font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .stat-value { font-size: 24px; font-weight: 800; color: #fff; }
    .stat-val-red { color: #ec1f28; }
    .card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    }
    .card-header {
      padding: 18px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .card-title { font-size: 16px; font-weight: 700; color: #fff; }
    .btn-refresh {
      background: #1e293b;
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.15s ease;
    }
    .btn-refresh:hover { background: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; text-align: left; }
    th {
      background: rgba(255, 255, 255, 0.02);
      padding: 14px 20px;
      color: #94a3b8;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    td { padding: 16px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); vertical-align: middle; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .inv-number { font-weight: 700; color: #38bdf8; font-family: monospace; font-size: 13.5px; }
    .inv-vendor { font-weight: 600; color: #fff; }
    .inv-amount { font-weight: 800; color: #4ade80; font-size: 14px; }
    .items-pill {
      display: inline-block;
      background: rgba(255, 255, 255, 0.06);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      color: #94a3b8;
    }
    .empty-state { text-align: center; padding: 48px 24px; color: #64748b; font-size: 14px; }
    .endpoint-pill {
      font-family: monospace;
      font-size: 12px;
      background: rgba(236, 31, 40, 0.12);
      color: #f87171;
      padding: 6px 12px;
      border-radius: 6px;
      display: inline-block;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">
        <span class="badge">FIELDBI</span>
        <h1 class="title">AP Invoice Database Explorer</h1>
      </div>
      <div class="status-pill">
        <span class="status-dot"></span>
        <span>SQLite Database Active (Port ${PORT})</span>
      </div>
    </div>

    <div class="stats-grid" id="statsGrid">
      <div class="stat-card">
        <div class="stat-label">Total Invoices</div>
        <div class="stat-value" id="totalCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Amount Recorded</div>
        <div class="stat-value stat-val-red" id="totalAmount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">API Endpoint (Ready)</div>
        <div style="font-size: 13px; font-family: monospace; color: #38bdf8; word-break: break-all;">
          POST http://localhost:${PORT}/api/ap-invoices
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Stored AP Invoices</h3>
        <button class="btn-refresh" onclick="loadInvoices()">⟳ Refresh Data</button>
      </div>
      <div id="tableContainer">
        <div class="empty-state">Loading invoices from SQLite database...</div>
      </div>
    </div>
  </div>

  <script>
    async function loadInvoices() {
      try {
        const res = await fetch('/api/ap-invoices');
        const data = await res.json();
        const invoices = data.invoices || [];

        document.getElementById('totalCount').innerText = invoices.length;
        const total = invoices.reduce((sum, inv) => sum + (Number(inv.grandTotal) || 0), 0);
        document.getElementById('totalAmount').innerText = '$' + total.toFixed(2);

        if (invoices.length === 0) {
          document.getElementById('tableContainer').innerHTML = \`
            <div class="empty-state">
              <p style="font-size: 16px; font-weight: 600; color: #94a3b8; margin-bottom: 8px;">No AP Invoices Recorded Yet</p>
              <p>Upload an invoice in your DocumentScannerApp and click <b>"Insert to AP Invoice"</b>!</p>
              <div class="endpoint-pill">Target API: POST http://localhost:${PORT}/api/ap-invoices</div>
            </div>
          \`;
          return;
        }

        let html = \`
          <table>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Vendor Name</th>
                <th>Invoice Date</th>
                <th>Line Items</th>
                <th>Grand Total</th>
                <th>Saved At</th>
              </tr>
            </thead>
            <tbody>
        \`;

        for (const inv of invoices) {
          const itemCount = inv.items ? inv.items.length : 0;
          html += \`
            <tr>
              <td><span class="inv-number">\${inv.invoiceNumber}</span></td>
              <td><span class="inv-vendor">\${inv.vendorName}</span></td>
              <td>\${inv.invoiceDate || '-'}</td>
              <td><span class="items-pill">\${itemCount} item\${itemCount === 1 ? '' : 's'}</span></td>
              <td><span class="inv-amount">\${inv.currency} \${Number(inv.grandTotal).toFixed(2)}</span></td>
              <td style="color: #64748b; font-size: 12.5px;">\${inv.createdFormatted}</td>
            </tr>
          \`;
        }

        html += '</tbody></table>';
        document.getElementById('tableContainer').innerHTML = html;
      } catch (err) {
        document.getElementById('tableContainer').innerHTML = \`
          <div class="empty-state" style="color: #f87171;">
            Failed to connect to backend: \${err.message}
          </div>
        \`;
      }
    }

    loadInvoices();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` FieldBi AP Invoice Backend Server is LIVE!`);
  console.log(` Dashboard: http://localhost:${PORT}`);
  console.log(` API Route: POST http://localhost:${PORT}/api/ap-invoices`);
  console.log(`=======================================================`);
});
