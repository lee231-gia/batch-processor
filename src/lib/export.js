class ExportManager {
  constructor() {
    this.results = [];
    this.layoutMode = 'formatted';
  }

  setResults(results) {
    this.results = results;
  }

  setLayoutMode(mode) {
    this.layoutMode = mode;
  }

  async exportTxtIndividual() {
    for (const result of this.results) {
      const text = result.structuredText || result.text || '';
      const name = this._safeName(result.name) + '.txt';
      this._download(text, name, 'text/plain');
    }
  }

  async exportTxtMerged() {
    const parts = [];
    for (const result of this.results) {
      const text = result.structuredText || result.text || '';
      parts.push(`=== ${result.name} ===\n${text}`);
    }
    this._download(parts.join('\n\n'), 'merged-output.txt', 'text/plain');
  }

  async exportMdMerged() {
    const parts = [];
    for (const result of this.results) {
      const text = result.structuredText || result.text || '';
      parts.push(`## ${result.name}\n\n${text}`);
    }
    this._download(parts.join('\n\n'), 'merged-output.md', 'text/markdown');
  }

  async exportCsv() {
    const escape = (s) => '"' + (s || '').replace(/"/g, '""') + '"';
    let csv = 'filename,type,confidence,word_count,text\n';
    for (const r of this.results) {
      const text = (r.structuredText || r.text || '').replace(/\n/g, '\\n');
      csv += `${escape(r.name)},${escape(r.type)},${r.confidence || 0},${r.wordCount || 0},${escape(text)}\n`;
    }
    this._download(csv, 'output.csv', 'text/csv');
  }

  async exportZip() {
    try {
      if (!window.JSZip) {
        await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      }
      if (!window.JSZip) { alert('Failed to load JSZip'); return; }
      const zip = new JSZip();
      for (const result of this.results) {
        const text = result.structuredText || result.text || '';
        const name = this._safeName(result.name) + '.txt';
        zip.file(name, text);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      this._downloadBlob(blob, 'output.zip');
    } catch (e) { console.error('ZIP export failed:', e); alert('Export failed: ' + e.message); }
  }

  async exportPdf() {
    try {
      if (!window.PDFLib) {
        await this._loadScript('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js');
      }
      if (!window.PDFLib || !PDFLib.PDFDocument) { alert('Failed to load PDF library'); return; }
      const pdfDoc = await PDFLib.PDFDocument.create();
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);

      for (const result of this.results) {
        const text = result.structuredText || result.text || '';
        const lines = this._wrapText(text, 80);
        const linesPerPage = 55;
        let lineIdx = 0;

        while (lineIdx < lines.length) {
          const page = pdfDoc.addPage([612, 792]);
          let y = 750;

          if (lineIdx === 0) {
            page.drawText(result.name, { x: 50, y, size: 12, font });
            y -= 20;
            lineIdx = 0;
          }

          for (let i = 0; i < linesPerPage && lineIdx < lines.length; i++, lineIdx++) {
            page.drawText(lines[lineIdx], { x: 50, y, size: 10, font });
            y -= 14;
          }
        }
      }

      const pdfBytes = await pdfDoc.save();
      this._downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), 'output.pdf');
    } catch (e) { console.error('PDF export failed:', e); alert('Export failed: ' + e.message); }
  }

  _wrapText(text, maxChars) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && current.length + word.length + 1 > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  async exportDocx() {
    try {
      if (!window.docx) {
        await this._loadScript('https://unpkg.com/docx@8.5.0/build/index.umd.min.js');
      }
      if (!window.docx) { alert('Failed to load DOCX library'); return; }
      const doc = new docx.Document({
        sections: this.results.map(result => ({
          properties: {},
          children: [
            new docx.Paragraph({
              text: result.name,
              heading: docx.HeadingLevel ? docx.HeadingLevel.HEADING_2 : undefined,
            }),
            new docx.Paragraph({
              children: [new docx.TextRun((result.structuredText || result.text || ''))],
              spacing: { after: 200 },
            }),
          ],
        })),
      });
      const blob = await docx.Packer.toBlob(doc);
      this._downloadBlob(blob, 'output.docx');
    } catch (e) { console.error('DOCX export failed:', e); alert('Export failed: ' + e.message); }
  }

  async copyAll() {
    const parts = [];
    for (const result of this.results) {
      const text = result.structuredText || result.text || '';
      parts.push(`=== ${result.name} ===\n${text}`);
    }
    await navigator.clipboard.writeText(parts.join('\n\n'));
  }

  _download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    this._downloadBlob(blob, filename);
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  _safeName(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\.[^.]+$/, '');
  }

  _loadScript(src) {
    return new Promise((resolve) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
  }
}

window.ExportManager = ExportManager;
