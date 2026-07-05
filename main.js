const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    title: 'Batch Processor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (process.argv.includes('--run-tests')) {
      runTestsFromMain();
    }
    if (process.argv.includes('--run-full-tests')) {
      runTestsFromMain(true);
    }
    const dirArg = process.argv.find(a => a.startsWith('--process-dir='));
    if (dirArg) {
      const targetDir = dirArg.split('=')[1];
      processDirImages(targetDir);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('crashed', () => { console.error('Renderer crashed'); });
  mainWindow.webContents.on('render-process-gone', (event, details) => { console.error('Render process gone:', details.reason); });
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function runTestsFromMain(full) {
  await new Promise(r => setTimeout(r, 4000));
  try {
    const fn = full ? 'window.runFullOcrAccuracyTest()' : 'window.runOcrAccuracyTest()';
    const result = await mainWindow.webContents.executeJavaScript(fn);
    const reportPath = path.join(__dirname, 'accuracy-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    console.log('=== ACCURACY TEST COMPLETE ===');
    console.log(`Average Word Accuracy: ${result.avgWordAcc.toFixed(1)}%`);
    console.log(`Average Char Accuracy: ${result.avgCharAcc.toFixed(1)}%`);
    console.log(`Passed: ${result.passed}/${result.total}`);
    console.log(`Report saved to: ${reportPath}`);
    app.quit();
  } catch (e) {
    console.error('Test failed:', e);
    app.quit();
  }
}

ipcMain.handle('run-ocr-tests', async () => {
  if (!mainWindow) return { error: 'No window' };
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.runOcrAccuracyTest()');
    const reportPath = path.join(__dirname, 'accuracy-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

async function processDirImages(dirPath) {
  const fs = require('fs');
  const path = require('path');
  try {
    const files = fs.readdirSync(dirPath).filter(f => /\.(jpg|jpeg|png|bmp|gif|tiff?)$/i.test(f));
    console.log(`Processing ${files.length} images from ${dirPath}`);

    // Read each file as base64 data URL
    const images = files.map(f => {
      const fullPath = path.join(dirPath, f);
      const ext = path.extname(f).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      const data = fs.readFileSync(fullPath);
      return { name: f, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    });

    // Inject into renderer and run OCR on each
    const code = `
(async () => {
  const images = ${JSON.stringify(images)};
  const results = [];
  const ocr = new OcrProcessor();
  await ocr.init();

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    console.log('Processing', img.name);
    try {
      const r = await ocr.processImage(img.dataUrl, img.name);
      const orientation = r.orientationCorrected ? 'ROTATED' : r.mirroredCorrected ? 'MIRRORED' : 'normal';
      const textPreview = (r.text || '').trim().substring(0, 120).replace(/\\n/g, ' ');
      results.push({
        name: img.name,
        status: 'done',
        orientation,
        textPreview,
        wordCount: r.wordCount,
        confidence: Math.round(r.confidence),
        pipelineReport: {
          difficulty: r.pipelineReport?.quality?.difficulty,
          iterations: r.pipelineReport?.iterations?.length,
          strategies: (r.pipelineReport?.iterations || []).flatMap(it => it.strategies || []).map(s => s.name),
        }
      });
    } catch (e) {
      results.push({ name: img.name, status: 'error', error: e.message });
    }
  }
  return results;
})()
`;

    const results = await mainWindow.webContents.executeJavaScript(code);
    const reportPath = path.join(__dirname, 'dir-process-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

    console.log('\n=== DIRECTORY PROCESSING RESULTS ===');
    console.log(`Total: ${results.length} images`);
    const rotated = results.filter(r => r.orientation === 'ROTATED');
    const mirrored = results.filter(r => r.orientation === 'MIRRORED');
    const errors = results.filter(r => r.status === 'error');
    console.log(`Rotated: ${rotated.length}, Mirrored: ${mirrored.length}, Normal: ${results.length - rotated.length - mirrored.length - errors.length}, Errors: ${errors.length}`);

    if (rotated.length > 0) {
      console.log('\n--- Rotation Detected ---');
      rotated.forEach(r => console.log(`  ${r.name}: ${r.textPreview.substring(0, 80)}`));
    }
    if (errors.length > 0) {
      console.log('\n--- Errors ---');
      errors.forEach(r => console.log(`  ${r.name}: ${r.error}`));
    }
    console.log(`\nFull report saved to: ${reportPath}`);
    app.quit();
  } catch (e) {
    console.error('Directory processing failed:', e);
    app.quit();
  }
}

ipcMain.handle('fetch-url', async (event, url) => {
  try {
    const content = await fetchUrlContent(url);
    return { success: true, data: content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function fetchUrlContent(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          url: url,
          html: data,
          statusCode: res.statusCode,
        });
      });
    }).on('error', (e) => reject(new Error('Failed to fetch ' + url + ': ' + e.message))).on('timeout', function() {
      this.destroy();
      reject(new Error('Request to ' + url + ' timed out after 15s. The server may be unreachable or too slow.'));
    });
  });
}
