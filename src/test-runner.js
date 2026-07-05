(function() {
  'use strict';

  const EXPECTED_TEXTS = [
    'The quick brown fox jumps over the lazy dog.',
    'To be or not to be that is the question.',
    'A thing of beauty is a joy forever.',
  ];

  const GET_TEST_CASES = (quick) => quick ? [
    { name: 'Clean Arial 24pt', font: '24px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Low contrast', font: '22px Arial', noise: 0, blur: 0, rotate: 0, contrast: 0.4 },
    { name: 'Noisy', font: '22px Arial', noise: 30, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Blurry (2px)', font: '22px Arial', noise: 0, blur: 2, rotate: 0, contrast: 1 },
    { name: 'Blurry (3px)', font: '22px Arial', noise: 0, blur: 3, rotate: 0, contrast: 1 },
    { name: 'Rotated 180deg', font: '22px Arial', noise: 0, blur: 0, rotate: 180, contrast: 1 },
    { name: 'Bright background', font: '22px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1, bgBright: true },
  ] : [
    { name: 'Clean Arial 24pt', font: '24px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Clean Serif 18pt', font: '18px "Times New Roman"', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Bold sans 20pt', font: 'bold 20px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Small text 12pt', font: '12px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Low contrast', font: '22px Arial', noise: 0, blur: 0, rotate: 0, contrast: 0.4 },
    { name: 'Noisy', font: '22px Arial', noise: 30, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Blurry (2px)', font: '22px Arial', noise: 0, blur: 2, rotate: 0, contrast: 1 },
    { name: 'Blurry (3px)', font: '22px Arial', noise: 0, blur: 3, rotate: 0, contrast: 1 },
    { name: 'Rotated 180deg', font: '22px Arial', noise: 0, blur: 0, rotate: 180, contrast: 1 },
    { name: 'Mixed case small', font: '14px "Courier New"', noise: 0, blur: 0, rotate: 0, contrast: 1 },
    { name: 'Bright background', font: '22px Arial', noise: 0, blur: 0, rotate: 0, contrast: 1, bgBright: true },
  ];

  async function createTestImage(text, params) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = 800;
    canvas.height = 100;

    // Background
    if (params.bgBright) {
      ctx.fillStyle = '#f0f0f0';
    } else {
      ctx.fillStyle = '#ffffff';
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Text
    ctx.font = params.font || '22px Arial';
    ctx.fillStyle = params.contrast < 0.6 ? '#888888' : '#000000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Wrap text
    const maxWidth = 700;
    const words = text.split(' ');
    let lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    canvas.height = Math.max(80, lines.length * 36 + 20);

    ctx.fillStyle = params.bgBright ? '#f0f0f0' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = params.font || '22px Arial';
    ctx.fillStyle = params.contrast < 0.6 ? '#888888' : '#000000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const lineHeight = 36;
    const startY = canvas.height / 2 - (lines.length - 1) * lineHeight / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], canvas.width / 2, startY + i * lineHeight);
    }

    // Apply noise
    if (params.noise > 0) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const p = imageData.data;
      for (let i = 0; i < p.length; i += 4) {
        const noise = (Math.random() - 0.5) * params.noise;
        p[i] = Math.max(0, Math.min(255, p[i] + noise));
        p[i+1] = Math.max(0, Math.min(255, p[i+1] + noise));
        p[i+2] = Math.max(0, Math.min(255, p[i+2] + noise));
      }
      ctx.putImageData(imageData, 0, 0);
    }

    // Apply blur
    if (params.blur > 0) {
      ctx.filter = `blur(${params.blur}px)`;
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = 'none';
    }

    // Apply rotation (180° keeps same dimensions; only 90/270 swap)
    if (params.rotate !== 0) {
      const rotated = document.createElement('canvas');
      if (params.rotate === 90 || params.rotate === 270) {
        rotated.width = canvas.height;
        rotated.height = canvas.width;
      } else {
        rotated.width = canvas.width;
        rotated.height = canvas.height;
      }
      const rctx = rotated.getContext('2d');
      rctx.translate(rotated.width / 2, rotated.height / 2);
      rctx.rotate(params.rotate * Math.PI / 180);
      rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      return rotated.toDataURL('image/png');
    }

    return canvas.toDataURL('image/png');
  }

  function normalizeText(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function computeCER(hyp, ref) {
    const h = normalizeText(hyp);
    const r = normalizeText(ref);
    if (r.length === 0) return h.length === 0 ? 0 : 1;
    // Levenshtein distance at character level
    const dp = Array.from({ length: h.length + 1 }, () => Array(r.length + 1).fill(0));
    for (let i = 0; i <= h.length; i++) dp[i][0] = i;
    for (let j = 0; j <= r.length; j++) dp[0][j] = j;
    for (let i = 1; i <= h.length; i++) {
      for (let j = 1; j <= r.length; j++) {
        const cost = h[i-1] === r[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
      }
    }
    return dp[h.length][r.length] / r.length;
  }

  function computeWER(hyp, ref) {
    const h = normalizeText(hyp).split(/\s+/).filter(w => w);
    const r = normalizeText(ref).split(/\s+/).filter(w => w);
    if (r.length === 0) return h.length === 0 ? 0 : 1;
    const dp = Array.from({ length: h.length + 1 }, () => Array(r.length + 1).fill(0));
    for (let i = 0; i <= h.length; i++) dp[i][0] = i;
    for (let j = 0; j <= r.length; j++) dp[0][j] = j;
    for (let i = 1; i <= h.length; i++) {
      for (let j = 1; j <= r.length; j++) {
        const cost = h[i-1] === r[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
      }
    }
    return dp[h.length][r.length] / r.length;
  }

  function computeAccuracy(cer, wer) {
    const charAcc = Math.max(0, 1 - cer) * 100;
    const wordAcc = Math.max(0, 1 - wer) * 100;
    return { charAccuracy: charAcc, wordAccuracy: wordAcc };
  }

  async function runSingleTest(ocr, testCase, text, index) {
    const imageData = await createTestImage(text, testCase);

    const startTime = Date.now();
    let result;
    try {
      result = await ocr.processImage(imageData, `test_${index}`);
    } catch (e) {
      result = { text: `[ERROR: ${e.message}]`, words: [], confidence: 0, wordCount: 0 };
    }
    const duration = Date.now() - startTime;

    const cer = computeCER(result.text, text);
    const wer = computeWER(result.text, text);
    const acc = computeAccuracy(cer, wer);

    return {
      index,
      testName: testCase.name,
      params: { ...testCase },
      expectedPreview: text.substring(0, 60),
      actualPreview: result.text.substring(0, 60),
      charErrorRate: cer,
      wordErrorRate: wer,
      charAccuracy: acc.charAccuracy,
      wordAccuracy: acc.wordAccuracy,
      confidence: result.confidence,
      wordCount: result.wordCount,
      duration,
      pipelineReport: result.pipelineReport ? {
        difficulty: result.pipelineReport.quality?.difficulty,
        iterations: result.pipelineReport.iterations?.length,
        strategies: (result.pipelineReport.iterations || []).flatMap(i => i.strategies || []).map(s => s.name),
        consensusAgreement: result.pipelineReport.consensusAgreement,
      } : null,
    };
  }

  async function runAllTests(quick = true) {
    const testCases = GET_TEST_CASES(quick);
    const results = [];
    let totalCharAcc = 0;
    let totalWordAcc = 0;
    let totalDuration = 0;
    let passed = 0;

    console.log('%c═══════════════════════════════════════════════════════════', 'font-weight:bold');
    console.log('%c  OCR ACCURACY TEST SUITE', 'font-size:16px;font-weight:bold');
    console.log('%c═══════════════════════════════════════════════════════════', 'font-weight:bold');
    console.log(`  Test cases: ${testCases.length}`);
    console.log(`  Reference texts: ${EXPECTED_TEXTS.length}`);
    console.log(`  Total runs: ${testCases.length * EXPECTED_TEXTS.length}`);
    console.log('');

    const ocr = new OcrProcessor();
    await ocr.init();

    for (let t = 0; t < testCases.length; t++) {
      const testCase = testCases[t];

      for (let e = 0; e < EXPECTED_TEXTS.length; e++) {
        const text = EXPECTED_TEXTS[e];
        const result = await runSingleTest(ocr, testCase, text, t * EXPECTED_TEXTS.length + e);
        results.push(result);
        totalCharAcc += result.charAccuracy;
        totalWordAcc += result.wordAccuracy;
        totalDuration += result.duration;
        if (result.wordAccuracy >= 80) passed++;

        const status = result.wordAccuracy >= 90 ? '✅' : result.wordAccuracy >= 70 ? '⚠️' : '❌';
        console.log(
          `  ${status} [${testCase.name}] #${e + 1}: ` +
          `CER=${(result.charErrorRate * 100).toFixed(1)}% ` +
          `WER=${(result.wordErrorRate * 100).toFixed(1)}% ` +
          `WordAcc=${result.wordAccuracy.toFixed(1)}% ` +
          `Conf=${result.confidence.toFixed(0)} ` +
          `(${(result.duration / 1000).toFixed(1)}s)`
        );

        if (result.wordAccuracy < 80) {
          console.log(`    Expected: "${text.substring(0, 80)}..."`);
          console.log(`    Got:      "${result.actualPreview.substring(0, 80)}..."`);
        }
      }
    }

    const total = results.length;
    const avgCharAcc = totalCharAcc / total;
    const avgWordAcc = totalWordAcc / total;
    const avgDuration = totalDuration / total;

    console.log('');
    console.log('%c═══════════════════════════════════════════════════════════', 'font-weight:bold');
    console.log('%c  RESULTS', 'font-size:14px;font-weight:bold');
    console.log(`  Total runs: ${total}`);
    console.log(`  Passed (WER<20%): ${passed}/${total}`);
    console.log(`  Average character accuracy: ${avgCharAcc.toFixed(1)}%`);
    console.log(`  Average word accuracy: ${avgWordAcc.toFixed(1)}%`);
    console.log(`  Average duration: ${(avgDuration / 1000).toFixed(1)}s`);
    console.log('%c═══════════════════════════════════════════════════════════', 'font-weight:bold');

    // Detailed breakdown by test case
    console.log('');
    console.log('%c  ── BY TEST CASE ──', 'font-weight:bold');
    for (let t = 0; t < testCases.length; t++) {
      const caseResults = results.filter(r => r.testName === testCases[t].name);
      const caseCA = caseResults.reduce((s, r) => s + r.charAccuracy, 0) / caseResults.length;
      const caseWA = caseResults.reduce((s, r) => s + r.wordAccuracy, 0) / caseResults.length;
      const caseDur = caseResults.reduce((s, r) => s + r.duration, 0) / caseResults.length;
      const icon = caseWA >= 90 ? '✅' : caseWA >= 70 ? '⚠️' : '❌';
      console.log(`  ${icon} ${testCases[t].name}: CharAcc=${caseCA.toFixed(1)}% WordAcc=${caseWA.toFixed(1)}% (${(caseDur/1000).toFixed(1)}s)`);
    }

    return {
      results, avgCharAcc, avgWordAcc, avgDuration, passed, total,
    };
  }

  window.runOcrAccuracyTest = () => runAllTests(true);
  window.runFullOcrAccuracyTest = () => runAllTests(false);
  console.log('%cOCR Accuracy Test Runner loaded. Call window.runOcrAccuracyTest() (quick) or window.runFullOcrAccuracyTest() (full).', 'color:#6c8cff;font-weight:bold');
})();
