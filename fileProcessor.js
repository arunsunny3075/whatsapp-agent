// ============================================================
//  fileProcessor.js  –  Parse uploaded files from WhatsApp
//  Handles: Excel, Word, PDF, CSV, text/code files
//  Returns: { type, summary, content, previewMessage }
// ============================================================

const path = require('path');

const MAX_CONTENT_CHARS = 30000;

// Safe text preview — avoids quote issues in template literals
function clip(text, len) {
  if (!text) return '';
  return text.length <= len ? text : text.slice(0, len) + '...';
}

// ── Main entry point ─────────────────────────────────────────
async function processFile(buffer, filename, mimeType) {
  const ext  = path.extname(filename || '').toLowerCase();
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();

  try {
    if (mime.includes('spreadsheetml') || mime.includes('ms-excel') || ext === '.xlsx' || ext === '.xls') {
      return processExcel(buffer, filename);
    }
    if (mime.includes('wordprocessingml') || mime.includes('msword') || ext === '.docx' || ext === '.doc') {
      return await processWord(buffer, filename);
    }
    if (mime === 'application/pdf' || ext === '.pdf') {
      return await processPDF(buffer, filename);
    }
    if (mime === 'text/csv' || ext === '.csv') {
      return processCSV(buffer, filename);
    }
    // Text / code files
    return processText(buffer, filename, ext);
  } catch (err) {
    console.error(`[fileProcessor] ${filename}: ${err.message}`);
    return {
      type: 'unknown',
      summary: `File: ${filename}`,
      content: '',
      previewMessage:
        `❓ Received *${filename}* but couldn't read it: ${err.message}\n\n` +
        `Please paste the content as text instead.`,
      error: err.message
    };
  }
}

// ── Excel ────────────────────────────────────────────────────
function processExcel(buffer, filename) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sheetSummaries = [];
  const allData = {};

  workbook.SheetNames.forEach(name => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
    const headers  = (rows[0] || []).map(String);
    const dataRows = rows.slice(1);
    allData[name] = rows.slice(0, 50); // cap per sheet

    sheetSummaries.push(
      `  *${name}*: ${headers.length} columns, ${dataRows.length} rows\n` +
      `  Columns: ${headers.slice(0, 10).join(', ')}${headers.length > 10 ? '...' : ''}`
    );
  });

  const content = JSON.stringify(allData).slice(0, MAX_CONTENT_CHARS);
  const firstHeaders = (XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]], { header: 1 }
  )[0] || []).map(String);

  const previewMessage =
    `📊 *Excel file received!*\n\n` +
    `📁 ${filename}\n` +
    `📋 ${workbook.SheetNames.length} sheet(s):\n` +
    sheetSummaries.join('\n') + '\n\n' +
    `What would you like to build from this data?`;

  return {
    type: 'excel',
    summary: `Excel: ${filename} — sheets: ${workbook.SheetNames.join(', ')}, first sheet columns: ${firstHeaders.join(', ')}`,
    content,
    previewMessage
  };
}

// ── Word ─────────────────────────────────────────────────────
async function processWord(buffer, filename) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ buffer });
  const text     = (result.value || '').trim();
  const lines    = text.split('\n').filter(l => l.trim()).length;

  const previewMessage =
    `📄 *Word document received!*\n\n` +
    `📁 ${filename}\n` +
    `📝 ${lines} lines of content\n\n` +
    `Preview: "${clip(text, 150)}"\n\n` +
    `What would you like to build or do with this content?`;

  return {
    type: 'word',
    summary: `Word doc: ${filename} — ${lines} lines of text`,
    content: text.slice(0, MAX_CONTENT_CHARS),
    previewMessage
  };
}

// ── PDF ──────────────────────────────────────────────────────
async function processPDF(buffer, filename) {
  const pdfParse = require('pdf-parse');
  const data     = await pdfParse(buffer);
  const text     = (data.text || '').trim();

  const previewMessage =
    `📑 *PDF received!*\n\n` +
    `📁 ${filename}\n` +
    `📄 ${data.numpages} page(s)\n\n` +
    `Preview: "${clip(text, 150)}"\n\n` +
    `What would you like me to do with this?`;

  return {
    type: 'pdf',
    summary: `PDF: ${filename} — ${data.numpages} pages`,
    content: text.slice(0, MAX_CONTENT_CHARS),
    previewMessage
  };
}

// ── CSV ──────────────────────────────────────────────────────
function processCSV(buffer, filename) {
  const text    = buffer.toString('utf8');
  const lines   = text.split('\n').filter(l => l.trim());
  const headers = (lines[0] || '').split(',').map(h => h.trim().replace(/"/g, ''));
  const rowCount = Math.max(0, lines.length - 1);

  const previewMessage =
    `📋 *CSV file received!*\n\n` +
    `📁 ${filename}\n` +
    `📊 ${headers.length} columns, ${rowCount} rows\n` +
    `Columns: ${headers.slice(0, 8).join(', ')}${headers.length > 8 ? '...' : ''}\n\n` +
    `What would you like to build from this data?`;

  return {
    type: 'csv',
    summary: `CSV: ${filename} — ${headers.length} columns, ${rowCount} rows, headers: ${headers.join(', ')}`,
    content: text.slice(0, MAX_CONTENT_CHARS),
    previewMessage
  };
}

// ── Text / Code ──────────────────────────────────────────────
function processText(buffer, filename, ext) {
  const text  = buffer.toString('utf8');
  const lines = text.split('\n').length;

  const langMap = {
    '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript',
    '.sql': 'SQL', '.bas': 'VBA', '.sh': 'Shell', '.ps1': 'PowerShell',
    '.html': 'HTML', '.css': 'CSS', '.json': 'JSON', '.xml': 'XML',
    '.txt': 'Text', '.md': 'Markdown', '.rb': 'Ruby', '.php': 'PHP'
  };
  const lang = langMap[ext] || 'Text';

  const previewMessage =
    `📝 *${lang} file received!*\n\n` +
    `📁 ${filename}\n` +
    `📄 ${lines} lines\n\n` +
    `Preview: "${clip(text, 120)}"\n\n` +
    `What would you like to do? (review, improve, add features, convert, debug, etc.)`;

  return {
    type: 'code',
    summary: `${lang} file: ${filename} — ${lines} lines`,
    content: text.slice(0, MAX_CONTENT_CHARS),
    previewMessage
  };
}

module.exports = { processFile };
