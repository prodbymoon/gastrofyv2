const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: false
    },
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Test Connection Handler
ipcMain.handle('test-connection', async () => {
  console.log('Test connection called');
  return { success: true, message: 'Electron IPC funktioniert!' };
});

// Windows Drucker finden
async function findWindowsPrinters() {
  return new Promise((resolve) => {
    exec('wmic printer get name,portname,status /format:csv', (error, stdout, stderr) => {
      if (error) {
        console.error('Drucker-Suche Fehler:', error);
        resolve([]);
        return;
      }

      const lines = stdout.split('\n').filter(line => line.trim() && !line.startsWith('Node'));
      const printers = lines.map(line => {
        const parts = line.split(',');
        if (parts.length >= 3) {
          return {
            name: parts[1] ? parts[1].trim() : '',
            port: parts[2] ? parts[2].trim() : '',
            status: parts[3] ? parts[3].trim() : ''
          };
        }
        return null;
      }).filter(printer => printer && printer.name);

      console.log('Gefundene Drucker:', printers);
      resolve(printers);
    });
  });
}

// Drucker-Info Handler
ipcMain.handle('get-printer-info', async () => {
  try {
    const printers = await findWindowsPrinters();
    
    // Suche nach Label-Druckern
    const labelPrinters = printers.filter(printer => {
      const name = printer.name.toLowerCase();
      return name.includes('brother') || 
             name.includes('dymo') || 
             name.includes('zebra') || 
             name.includes('label') ||
             name.includes('thermal') ||
             name.includes('ql');
    });
    
    return {
      allPrinters: printers,
      labelPrinters: labelPrinters,
      found: printers.length > 0
    };
  } catch (error) {
    return { error: error.message };
  }
});

// Print Label Handler
ipcMain.handle('print-label', async (event, labelData) => {
  console.log('Print request:', labelData);
  
  try {
    // 1. Prüfe verfügbare Drucker
    const printers = await findWindowsPrinters();
    console.log('Available printers:', printers);
    
    if (printers.length === 0) {
      return { 
        success: false, 
        error: 'Keine Drucker gefunden. Bitte Drucker anschließen und Windows neu starten.' 
      };
    }
    
    // 2. Suche Label-Drucker
    let targetPrinter = printers.find(p => {
      const name = p.name.toLowerCase();
      return name.includes('brother') || name.includes('ql') || 
             name.includes('dymo') || name.includes('label');
    });
    
    // 3. Fallback: Ersten verfügbaren Drucker nehmen
    if (!targetPrinter) {
      targetPrinter = printers[0];
      console.log('No label printer found, using first available:', targetPrinter.name);
    }
    
    console.log('Using printer:', targetPrinter);
    
    // 4. Bestimme Druckmethode basierend auf Drucker-Name
    const printerName = targetPrinter.name.toLowerCase();
    
    if (printerName.includes('2120tf') || 
        printerName.includes('gp-2120') || 
        printerName.includes('gprinter') || 
        printerName.includes('gl-2120') ||
        printerName.includes('label')) {
      return await printBrotherGL2120TF(labelData, targetPrinter);
    } else if (printerName.includes('brother') && printerName.includes('ql')) {
      return await printBrother(labelData, targetPrinter);
    } else if (printerName.includes('dymo')) {
      return await printDymo(labelData, targetPrinter);
    } else if (printerName.includes('zebra')) {
      return await printZebra(labelData, targetPrinter);
    } else {
      return await printGeneric(labelData, targetPrinter);
    }
    
  } catch (error) {
    console.error('Print error:', error);
    return { success: false, error: error.message };
  }
});

// Brother GL-2120TF spezifische Behandlung
async function printBrother(labelData, printer) {
  console.log('Printing to Brother GL-2120TF:', printer.name);
  
  // Der GL-2120TF verwendet ESC/P Befehle, nicht P-touch
  if (printer.name.includes('2120TF') || printer.name.includes('GL-2120')) {
    return await printBrotherGL2120TF(labelData, printer);
  }
  
  // Fallback für andere Brother Drucker
  return await printGenericHTML(labelData, printer);
}

// GP-2120TF Grafik-Modus: Erstelle Label als Bild und drucke über Windows
async function printBrotherGL2120TF(labelData, printer) {
  console.log('Using GP-2120TF Graphics Mode (Windows Driver)');
  
  try {
    // Methode 1: Label als HTML generieren und über Browser drucken
    return await printViaHTML(labelData, printer);
  } catch (error) {
    console.log('HTML print failed, trying image method:', error);
    // Methode 2: Label als Bild generieren
    return await printViaImage(labelData, printer);
  }
}

// Label als HTML/CSS generieren und automatisch drucken
async function printViaHTML(labelData, printer) {
  const tempFile = path.join(os.tmpdir(), `label_${Date.now()}.html`);
  
  // HTML Label für 58mm Thermodrucker generieren (2 Labels pro Papier)
  const htmlContent = generateLabelHTML(labelData);
  
  try {
    fs.writeFileSync(tempFile, htmlContent, 'utf8');
    
    // Direkter Print über Chrome/Edge (falls installiert)
    const browsers = [
      'chrome.exe --headless --disable-gpu --print-to-pdf-no-header --disable-extensions',
      'msedge.exe --headless --disable-gpu --print-to-pdf-no-header --disable-extensions',
      'start ""' // Fallback: normaler Browser
    ];
    
    let printCmd = `start "" "${tempFile}"`;
    
    // Versuche headless printing
    for (const browser of browsers.slice(0, 2)) {
      try {
        if (await checkBrowserAvailable(browser.split(' ')[0])) {
          printCmd = `${browser} --print-to-printer="${printer.name}" "${tempFile}"`;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    return new Promise((resolve) => {
      exec(printCmd, (error, stdout, stderr) => {
        setTimeout(() => {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        }, 8000);
        
        if (error) {
          resolve({ 
            success: true, // Trotzdem success, da Browser öffnet
            method: 'html_graphics_manual',
            printer: printer.name,
            note: 'Browser öffnet sich - bitte STRG+P drücken und GP-2120TF wählen'
          });
        } else {
          resolve({ 
            success: true, 
            method: 'html_graphics_auto',
            printer: printer.name,
            note: 'Label wurde automatisch gedruckt'
          });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Prüfe ob Browser verfügbar ist
async function checkBrowserAvailable(browserExe) {
  return new Promise((resolve) => {
    exec(`where ${browserExe}`, (error) => {
      resolve(!error);
    });
  });
}

// HTML Label generieren (2 Labels pro 58mm Papier)
function generateLabelHTML(labelData) {
  let htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Label Druck</title>
    <style>
        @page {
            size: 58mm 50mm; /* Doppelte Höhe für 2 Labels */
            margin: 0;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            width: 58mm;
            height: 50mm;
        }
        .label {
            width: 56mm;
            height: 23mm;
            padding: 1mm;
            border-bottom: 1px dashed #000;
            page-break-inside: avoid;
            position: relative;
        }
        .label:last-child {
            border-bottom: none;
        }
        .product-name {
            font-size: 16pt;
            font-weight: bold;
            text-align: center;
            margin-bottom: 2mm;
            line-height: 1.1;
        }
        .info-line {
            font-size: 10pt;
            margin-bottom: 1mm;
            line-height: 1.1;
        }
        .user-info {
            font-size: 9pt;
            text-align: center;
            margin-top: 1mm;
            font-weight: bold;
        }
    </style>
    <script>
        window.onload = function() {
            setTimeout(function() {
                // Auto-print nach 1 Sekunde
                window.print();
                // Fenster nach 3 Sekunden schließen
                setTimeout(function() {
                    window.close();
                }, 3000);
            }, 1000);
        }
    </script>
</head>
<body>`;

  // Berechne wie viele Doppel-Labels wir brauchen
  const totalLabels = labelData.quantity;
  const pairs = Math.ceil(totalLabels / 2);
  
  for (let pair = 0; pair < pairs; pair++) {
    if (pair > 0) {
      htmlContent += '<div style="page-break-before: always;"></div>';
    }
    
    // Erstes Label des Paares
    const firstLabelIndex = pair * 2;
    if (firstLabelIndex < totalLabels) {
      htmlContent += `
      <div class="label">
        <div class="product-name">${labelData.productName}</div>
        <div class="info-line">Zubereitet: ${labelData.preparationDate}</div>
        <div class="info-line">Haltbar bis: ${labelData.expiryDate}</div>
        <div class="user-info">${labelData.preparationTime} - ${labelData.userShortcode}</div>
      </div>`;
    }
    
    // Zweites Label des Paares (falls vorhanden)
    const secondLabelIndex = pair * 2 + 1;
    if (secondLabelIndex < totalLabels) {
      htmlContent += `
      <div class="label">
        <div class="product-name">${labelData.productName}</div>
        <div class="info-line">Zubereitet: ${labelData.preparationDate}</div>
        <div class="info-line">Haltbar bis: ${labelData.expiryDate}</div>
        <div class="user-info">${labelData.preparationTime} - ${labelData.userShortcode}</div>
      </div>`;
    } else {
      // Falls ungerade Anzahl: leeres zweites Label
      htmlContent += `
      <div class="label">
        <div style="height: 23mm;"></div>
      </div>`;
    }
  }
  
  htmlContent += '</body></html>';
  return htmlContent;
}

// Label als Canvas-Bild generieren (Fallback)
async function printViaImage(labelData, printer) {
  // Diese Methode würde Canvas verwenden um ein Bild zu erstellen
  // Für jetzt verwenden wir HTML als primäre Methode
  return { 
    success: false, 
    error: 'Image generation not implemented yet - use HTML method' 
  };
}

// Hilfsfunktion: Text zu lesbarem Format konvertieren
function convertToText(binaryData) {
  // Konvertiere für Fallback-Zwecke
  return binaryData.toString().replace(/[\x00-\x1F\x7F]/g, '');
}

// Konvertiere ESC/P zu Text (für Fallback)
function convertToText(escpData) {
  // Entferne Steuerzeichen und behalte nur Text
  return escpData
    .replace(/\x1B./g, '') // ESC sequences entfernen
    .replace(/\x0C/g, '\n--- CUT ---\n') // Form feed als Cut-Marker
    .replace(/\x0A/g, '\n') // Line feeds
    .replace(/\x0D/g, '') // Carriage returns entfernen
    .trim();
}

// DYMO Drucker
async function printDymo(labelData, printer) {
  console.log('Printing to DYMO:', printer.name);
  
  // Versuche DYMO Connect
  const dymoConnectPath = 'C:\\Program Files (x86)\\DYMO\\DYMO Connect\\DYMO.Connect.exe';
  if (fs.existsSync(dymoConnectPath)) {
    return await printWithDymoConnect(labelData, printer);
  }
  
  // Fallback: Generic print
  return await printGenericHTML(labelData, printer);
}

// Zebra Drucker
async function printZebra(labelData, printer) {
  console.log('Printing to Zebra:', printer.name);
  
  // ZPL-Befehle generieren und senden
  const zplCode = generateZPLCode(labelData);
  return await printRawData(zplCode, printer);
}

// Generic Drucker (Text oder HTML)
async function printGeneric(labelData, printer) {
  console.log('Printing to generic printer:', printer.name);
  
  // Versuche HTML-Print
  return await printGenericHTML(labelData, printer);
}

// HTML-Print für alle Drucker
async function printGenericHTML(labelData, printer) {
  const tempDir = os.tmpdir();
  const htmlFile = path.join(tempDir, `label_${Date.now()}.html`);
  
  const labelHtml = generateLabelHTML(labelData);
  
  try {
    fs.writeFileSync(htmlFile, labelHtml);
    console.log('HTML file created:', htmlFile);
    
    // Windows Print Command
    const printCmd = `powershell -Command "Start-Process -FilePath '${htmlFile}' -Verb Print -WindowStyle Hidden"`;
    
    return new Promise((resolve) => {
      exec(printCmd, (error, stdout, stderr) => {
        // Cleanup nach 10 Sekunden
        setTimeout(() => {
          if (fs.existsSync(htmlFile)) {
            fs.unlinkSync(htmlFile);
          }
        }, 10000);
        
        if (error) {
          console.error('Print command error:', error);
          // Fallback: Öffne Datei zum manuellen Drucken
          exec(`start "${htmlFile}"`);
          resolve({ 
            success: true, 
            method: 'manual',
            message: `Datei geöffnet zum manuellen Drucken: ${htmlFile}`,
            printer: printer.name 
          });
        } else {
          resolve({ 
            success: true, 
            method: 'windows_print',
            printer: printer.name 
          });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Raw Data Print (für ESC/POS, ZPL etc.)
async function printRawData(data, printer) {
  const tempFile = path.join(os.tmpdir(), `raw_${Date.now()}.txt`);
  
  try {
    fs.writeFileSync(tempFile, data);
    
    const printCmd = `copy /b "${tempFile}" "${printer.name}"`;
    
    return new Promise((resolve) => {
      exec(printCmd, (error, stdout, stderr) => {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        
        if (error) {
          resolve({ success: false, error: error.message });
        } else {
          resolve({ 
            success: true, 
            method: 'raw_data',
            printer: printer.name 
          });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// HTML Template für Labels
function generateLabelHTML(labelData) {
  let labelsHtml = '';
  
  for (let i = 0; i < labelData.quantity; i++) {
    labelsHtml += `
      <div class="label">
        <div class="product-name">${labelData.productName}</div>
        <div class="date-line">Zubereitet: ${labelData.preparationDate}</div>
        <div class="date-line">Haltbar bis: ${labelData.expiryDate}</div>
        <div class="date-line">${labelData.preparationTime} - ${labelData.userShortcode}</div>
      </div>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>CAS Labels</title>
      <style>
        @page { 
          size: 58mm auto; 
          margin: 1mm; 
        }
        body { 
          font-family: Arial, sans-serif; 
          font-size: 10px; 
          margin: 0; 
          padding: 1mm;
        }
        .label { 
          width: 56mm; 
          text-align: center;
          margin-bottom: 3mm;
          page-break-after: always;
          border: 1px solid #000;
          padding: 2mm;
        }
        .product-name { 
          font-size: 14px; 
          font-weight: bold; 
          margin-bottom: 2mm;
          text-transform: uppercase;
        }
        .date-line { 
          font-size: 10px; 
          margin: 1mm 0;
          font-weight: bold;
        }
        @media print { 
          .label { 
            margin: 0; 
            page-break-after: always; 
          } 
        }
      </style>
    </head>
    <body>
      ${labelsHtml}
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.print();
          }, 1000);
        };
      </script>
    </body>
    </html>
  `;
}

// ZPL Code für Zebra
function generateZPLCode(labelData) {
  let zpl = '^XA'; // Start
  
  for (let i = 0; i < labelData.quantity; i++) {
    zpl += '^CF0,30'; // Font
    zpl += `^FO30,30^FD${labelData.productName}^FS`;
    zpl += '^CF0,20';
    zpl += `^FO30,70^FD${labelData.preparationDate}^FS`;
    zpl += `^FO30,100^FD${labelData.expiryDate}^FS`;
    zpl += `^FO30,130^FD${labelData.preparationTime} - ${labelData.userShortcode}^FS`;
    
    if (i < labelData.quantity - 1) {
      zpl += '^XZ^XA'; // End current, start new
    }
  }
  
  zpl += '^XZ'; // End
  return zpl;
}

console.log('CAS Label Generator main process loaded');
