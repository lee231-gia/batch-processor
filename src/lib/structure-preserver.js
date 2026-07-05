const LINE_TOLERANCE = 8;
const COLUMN_GAP_THRESHOLD = 0.15;
const COLUMN_GAP_MIN = 0.08;
const PARA_LINE_HEIGHT_FACTOR = 1.5;
const FORMAT_CHAR_WIDTH_DIV = 80;
const FORMAT_MAX_INDENT = 8;
const MARKDOWN_INDENT_THRESHOLD = 0.15;

class StructurePreserver {
  reconstructLayout(words, mode = 'formatted') {
    if (!words || words.length === 0) return '';

    const lines = this._groupIntoLines(words);
    const columns = this._detectColumns(lines);
    const paragraphs = this._groupIntoParagraphs(lines);

    switch (mode) {
      case 'formatted': return this._formatFormatted(lines, columns, paragraphs);
      case 'markdown': return this._formatMarkdown(lines, columns, paragraphs);
      case 'raw': return this._formatRaw(lines);
      default: return this._formatFormatted(lines, columns, paragraphs);
    }
  }

  _groupIntoLines(words) {
    if (words.length === 0) return [];

    const sorted = [...words].sort((a, b) => {
      const yDiff = a.bbox.y0 - b.bbox.y0;
      return yDiff !== 0 ? yDiff : a.bbox.x0 - b.bbox.x0;
    });

    const lines = [];
    let currentLine = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const word = sorted[i];
      const prev = currentLine[currentLine.length - 1];
      const yDiff = Math.abs(word.bbox.y0 - prev.bbox.y0);

      if (yDiff <= LINE_TOLERANCE) {
        currentLine.push(word);
      } else {
        lines.push(currentLine);
        currentLine = [word];
      }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    for (const line of lines) {
      line.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    }

    return lines;
  }

  _detectColumns(lines) {
    if (lines.length === 0) return { count: 1, boundaries: [0] };

    const allXGaps = [];
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const gap = line[i].bbox.x0 - line[i - 1].bbox.x1;
        if (gap > 0) allXGaps.push(gap);
      }
    }

    if (allXGaps.length === 0) return { count: 1, boundaries: [0] };

    allXGaps.sort((a, b) => b - a);
    const maxGap = allXGaps[0];

    const pageWidth = lines.reduce((max, line) => {
      const last = line[line.length - 1];
      return Math.max(max, last.bbox.x1);
    }, 0);

    if (maxGap < pageWidth * COLUMN_GAP_THRESHOLD) {
      return { count: 1, boundaries: [0] };
    }

    const significantGaps = allXGaps.filter(g => g > pageWidth * COLUMN_GAP_MIN);
    significantGaps.sort((a, b) => a - b);

    const colEdges = new Set();
    colEdges.add(0);

    for (const line of lines) {
      const first = line[0];
      const last = line[line.length - 1];
      for (let i = 1; i < line.length; i++) {
        const gap = line[i].bbox.x0 - line[i - 1].bbox.x1;
        if (gap > pageWidth * COLUMN_GAP_MIN) {
          colEdges.add(line[i].bbox.x0 - gap / 2);
        }
      }
    }

    const sortedEdges = [...colEdges].sort((a, b) => a - b);
    return { count: sortedEdges.length, boundaries: sortedEdges };
  }

  _groupIntoParagraphs(lines) {
    if (lines.length === 0) return [];

    const paragraphs = [];
    let currentPara = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
      const prevLine = lines[i - 1];
      const currLine = lines[i];
      const prevLast = prevLine[prevLine.length - 1];
      const currFirst = currLine[0];
      const gap = currFirst.bbox.y0 - prevLast.bbox.y1;

      const avgLineHeight = (prevLast.bbox.y1 - prevLast.bbox.y0 + currFirst.bbox.y1 - currFirst.bbox.y0) / 2;
      const yThreshold = avgLineHeight * PARA_LINE_HEIGHT_FACTOR;

      if (gap > yThreshold) {
        paragraphs.push(currentPara);
        currentPara = [currLine];
      } else {
        currentPara.push(currLine);
      }
    }
    if (currentPara.length > 0) paragraphs.push(currentPara);

    return paragraphs;
  }

  _getIndent(line) {
    if (line.length === 0) return 0;
    return line[0].bbox.x0;
  }

  _findPageWidth(lines) {
    let maxX = 0;
    for (const line of lines) {
      for (const word of line) {
        maxX = Math.max(maxX, word.bbox.x1);
      }
    }
    return maxX || 1;
  }

  _formatFormatted(lines, columns, paragraphs) {
    const pageWidth = this._findPageWidth(lines);
    if (pageWidth === 0) return '';

    const charWidth = pageWidth / FORMAT_CHAR_WIDTH_DIV;
    const output = [];

    for (const paragraph of paragraphs) {
      const paraLines = [];
      for (const line of paragraph) {
        const textLine = line.map(w => w.text).join(' ');
        const indent = this._getIndent(line);
        const indentSpaces = indent > 0 ? Math.round(indent / charWidth) : 0;
        const indentStr = ' '.repeat(Math.min(indentSpaces, FORMAT_MAX_INDENT));
        paraLines.push(indentStr + textLine);
      }
      output.push(paraLines.join('\n'));
    }
    return output.join('\n\n');
  }

  _formatMarkdown(lines, columns, paragraphs) {
    const pageWidth = this._findPageWidth(lines);
    if (pageWidth === 0) return '';

    if (columns.count > 1) {
      return this._formatMarkdownTable(lines, columns);
    }

    const output = [];
    for (const paragraph of paragraphs) {
      const paraLines = [];
      for (const line of paragraph) {
        const text = line.map(w => w.text).join(' ');
        const indent = this._getIndent(line);
        if (indent > pageWidth * MARKDOWN_INDENT_THRESHOLD) {
          paraLines.push('  ' + text);
        } else {
          if (paraLines.length === 0 && line.length > 0) {
            const prevLines = output.flatMap(p => p.split('\n'));
            if (prevLines.length <= 2 && text.length < 60) {
            }
          }
          paraLines.push(text);
        }
      }
      output.push(paraLines.join('\n'));
    }
    return output.join('\n\n');
  }

  _formatMarkdownTable(lines, columns) {
    const colLines = {};
    for (let c = 0; c < Math.max(columns.count, 2); c++) colLines[c] = [];
    for (const line of lines) {
      for (const word of line) {
        let col = 0;
        for (let c = 1; c < (columns.boundaries || []).length; c++) {
          if (word.bbox.x0 >= columns.boundaries[c]) col = c;
        }
        if (!colLines[col]) colLines[col] = [];
        colLines[col].push(word.text);
      }
    }
    if (colLines[0].length === 0) return lines.map(l => l.map(w => w.text).join(' ')).join('\n');

    for (let c = 0; c < Math.max(columns.count, 2); c++) {
      if (!colLines[c] || colLines[c].length === 0) colLines[c] = [''];
    }

    const maxRows = Math.max(...Object.values(colLines).map(cc => cc.length));
    const rows = [];
    for (let r = 0; r < maxRows; r++) {
      const cells = [];
      for (let c = 0; c < Math.max(columns.count, 2); c++) {
        cells.push((colLines[c] || [])[r] || '');
      }
      rows.push('| ' + cells.join(' | ') + ' |');
    }

    if (rows.length >= 2) {
      const sep = '| ' + rows[0].split('|').slice(1, -1).map(() => '---').join(' | ') + ' |';
      rows.splice(1, 0, sep);
    }
    return rows.join('\n');
  }

  _formatRaw(lines) {
    const output = [];
    for (const line of lines) {
      output.push(line.map(w => w.text).join(' '));
    }
    return output.join('\n');
  }
}

window.StructurePreserver = StructurePreserver;
