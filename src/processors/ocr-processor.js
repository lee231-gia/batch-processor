const COMMON_BIGRAMS = new Set([
  'th','he','in','er','an','re','nd','at','on','nt',
  'ha','es','st','en','ed','to','it','ou','ea','hi',
  'is','or','ti','as','te','et','ng','of','al','de',
  'se','le','sa','si','ar','ve','ra','ld','ur','me',
  'ne','ce','el','co','ta','ec','ll','ri','ro','ho',
  'be','di','ai','ch','ma','do','pr','mo','li','sh',
  'no','fo','lo','la','un','wi','so','go','pa','pe',
  'ei','ac','ad','ge','da','fe','po','tr','fi','cr',
  'ea','tu','ty','fi','fr','gr','he','im','io','ju',
]);

const COMMON_WORDS = new Set('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us'.split(' '));

const STRATEGY_LABELS = {
  standard: 'Standard (grayscale)',
  contrast: 'Enhanced contrast',
  sharpened: 'Sharpened + contrast',
  threshold: 'Adaptive threshold',
  upscaled: '2x upscaled',
  despeckle: 'Denoised',
  aggresive: 'Aggressive enhance',
  deblur: 'Deblur + threshold',
};

const OCR_OCR_ORIENT_THUMB_MAX_DIM = 800;
const OCR_OCR_MAX_STRATEGIES = 3;
const OCR_OCR_MAX_RETRY_STRATEGIES = 2;
const OCR_OCR_TARGET_CONFIDENCE = 0.7;
const OCR_OCR_MIN_IMPROVEMENT = 0.5;
const OCR_OCR_OTSU_THRESHOLD_DEFAULT = 128;

class OcrProcessor {
  constructor() {
    this.workers = [];
    this.maxWorkers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    this.initialized = false;
    this.lang = 'eng';
    this._initPromise = null;
    this.idle = [];
    this.busy = new Set();
  }

  setLang(lang) { this.lang = lang; }

  setMaxWorkers(n) { this.maxWorkers = Math.max(1, n); }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (typeof Tesseract === 'undefined') {
      try {
        await this._loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
      } catch (e) {
        try {
          await this._loadScript('https://unpkg.com/tesseract.js@5/dist/tesseract.min.js');
        } catch (e2) {
          throw new Error('Could not load Tesseract.js OCR engine. Check internet connection.');
        }
      }
    }
    if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js failed to load');
    this.initialized = true;
    const errors = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      try {
        const worker = await Tesseract.createWorker(this.lang);
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        });
        this.idle.push(worker);
      } catch (e) { errors.push(e.message); }
    }
    if (this.idle.length === 0 && errors.length > 0)
      throw new Error('Failed to create OCR workers: ' + errors.join('; '));
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN ENTRY POINT
     ══════════════════════════════════════════════════════════════ */

  async processImage(imageData, fileName, onProgress) {
    await this.init();
    let worker;
    if (this.idle.length > 0) {
      worker = this.idle.pop();
    } else {
      worker = await Tesseract.createWorker(this.lang);
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
    }
    this.busy.add(worker);
    try {
      if (onProgress) onProgress(0.01);
      const result = await this._adaptivePipeline(imageData, worker, onProgress);
      return {
        text: result.text,
        words: result.words,
        confidence: result.confidence,
        wordCount: result.wordCount,
        orientationCorrected: result.transform ? result.transform !== 'original' : false,
        mirroredCorrected: result.transform === 'mirror-h' || result.transform === '180mirror',
        pipelineReport: result.pipelineReport,
      };
    } finally {
      this.busy.delete(worker);
      this.idle.push(worker);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ADAPTIVE PIPELINE
     ══════════════════════════════════════════════════════════════ */

  async _adaptivePipeline(imageData, worker, onProgress) {
    const report = {
      iterations: [],
      strategies: [],
      totalCalls: 0,
      startTime: Date.now(),
      finalStrategy: null,
      improvement: 0,
      consensusAgreement: 0,
    };

    // Phase 1: Quality analysis
    if (onProgress) onProgress(0.02);
    const quality = await this._analyzeQuality(imageData);
    report.quality = quality;

    // Phase 2: Orientation detection — run once on raw image, try all 5 orientations
    if (onProgress) onProgress(0.03);
    const orientResult = await this._findBestOrientation(imageData, worker);
    report.bestOrientation = orientResult.transform;
    imageData = orientResult.correctedImageData;

    // Phase 3: Generate strategies based on quality
    const strategies = this._generateStrategies(quality);
    report.initialStrategies = strategies.map(s => s.name);

    let bestResult = null;
    let bestScore = -Infinity;
    let allCandidates = [];
    const maxIterations = quality.difficulty === 'hard' ? 2 : 1;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const iterReport = { iteration, strategies: [], startTime: Date.now() };

      let activeStrategies;
      if (iteration === 0) {
        activeStrategies = strategies.slice(0, strategies.length);
      } else {
        activeStrategies = this._generateRetryStrategies(quality, bestResult, iteration);
      }
      if (activeStrategies.length === 0) break;

      for (let si = 0; si < activeStrategies.length; si++) {
        const strategy = activeStrategies[si];
        const stratLabel = strategy.name;

        if (onProgress) {
          const base = 0.05 + (iteration / Math.max(maxIterations, 1)) * 0.85;
          const step = si / Math.max(activeStrategies.length, 1) * (0.85 / Math.max(maxIterations, 1));
          onProgress(base + step);
        }

        let processedData, stratResult;
        try {
          processedData = await this._applyStrategy(imageData, strategy);
          await this._setPsm(worker, strategy.psm || 6);
          stratResult = await this._doRecognize(worker, processedData);
        } catch (e) {
          console.warn(`Strategy ${stratLabel} failed:`, e);
          iterReport.strategies.push({ name: stratLabel, score: -99, wordCount: 0, error: e.message });
          continue;
        }

        report.totalCalls++;
        stratResult.transform = orientResult.transform;
        stratResult.strategy = stratLabel;
        stratResult.strategyLabel = STRATEGY_LABELS[stratLabel] || stratLabel;
        stratResult.iteration = iteration;
        allCandidates.push(stratResult);

        const score = this._score(stratResult);
        if (score > bestScore) {
          bestScore = score;
          bestResult = stratResult;
          report.finalStrategy = stratLabel;
        }

        iterReport.strategies.push({
          name: stratLabel,
          score: Math.round(score * 100) / 100,
          wordCount: stratResult.wordCount,
          transform: orientResult.transform,
        });
      }

      iterReport.duration = Date.now() - iterReport.startTime;
      report.iterations.push(iterReport);

      if (bestResult) {
        const critique = this._critique(bestResult, quality);
        report.lastCritique = critique;
        if (critique.overallConfidence >= OCR_TARGET_CONFIDENCE) {
          report.stoppingReason = `Target confidence reached (${(critique.overallConfidence * 100).toFixed(0)}%)`;
          break;
        }
        if (iteration > 0) {
          const prevScore = report.iterations[iteration - 1].strategies.reduce((m, s) => Math.max(m, s.score), 0);
          report.improvement = bestScore - prevScore;
          if (report.improvement < OCR_MIN_IMPROVEMENT) {
            report.stoppingReason = `Improvement negligible (${report.improvement.toFixed(1)} pts)`;
            break;
          }
        }
      }
    }

    if (allCandidates.length >= 2) {
      const topScores = allCandidates.map(c => this._score(c)).sort((a, b) => b - a);
      report.consensusAgreement = topScores.length > 1
        ? (topScores[1] / Math.max(topScores[0], 1))
        : 1;
    } else {
      report.consensusAgreement = 0;
    }

    report.totalDuration = Date.now() - report.startTime;

    const final = bestResult || { text: '', words: [], confidence: 0, wordCount: 0, transform: orientResult.transform };
    final.pipelineReport = report;
    return final;
  }

  async _findBestOrientation(imageData, worker) {
    const thumb = await this._downscaleForOrient(imageData);
    const candidates = [];
    const tryOcr = async (label, data) => {
      try {
        const r = await this._doRecognize(worker, data);
        candidates.push({ ...r, transform: label, _orientScore: this._scoreOrientation(r) });
      } catch (_) {}
    };
    try {
      await this._setPsm(worker, 6);
      await tryOcr('original', thumb);
      await tryOcr('180', await this._rotateImage(thumb, 180));
      await tryOcr('mirror-h', await this._flipImage(thumb, true, false));
      await tryOcr('mirror-v', await this._flipImage(thumb, false, true));
      await tryOcr('90', await this._rotateImage(thumb, 90));
    } catch (_) {}
    const best = candidates.reduce((a, b) => (!a || b._orientScore > a._orientScore) ? b : a, null);
    if (!best || best.transform === 'original') {
      return { transform: 'original', correctedImageData: imageData };
    }
    const orig = candidates.find(c => c.transform === 'original');
    if (orig && best._orientScore < orig._orientScore + 2) {
      return { transform: 'original', correctedImageData: imageData };
    }
    let corrected = imageData;
    switch (best.transform) {
      case '180': corrected = await this._rotateImage(imageData, 180); break;
      case 'mirror-h': corrected = await this._flipImage(imageData, true, false); break;
      case 'mirror-v': corrected = await this._flipImage(imageData, false, true); break;
      case '90': corrected = await this._rotateImage(imageData, 90); break;
    }
    return { transform: best.transform, correctedImageData: corrected };
  }

  _downscaleForOrient(imageData) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            let w = img.width, h = img.height;
            if (w <= OCR_ORIENT_THUMB_MAX_DIM && h <= OCR_ORIENT_THUMB_MAX_DIM) { resolve(imageData); return; }
            const scale = Math.min(OCR_ORIENT_THUMB_MAX_DIM / w, OCR_ORIENT_THUMB_MAX_DIM / h, 1);
            w = Math.round(w * scale); h = Math.round(h * scale);
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', 0.85));
          } catch (_) { resolve(imageData); }
        };
        img.onerror = () => resolve(imageData);
        img.src = imageData;
      } catch (_) { resolve(imageData); }
    });
  }

  _scoreOrientation(result) {
    const text = (result.text || '').trim();
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (words.length === 0 || letters.length === 0) return -10;
    let bigramHits = 0, bigramTotal = 0;
    const lim = Math.min(letters.length - 1, 200);
    for (let i = 0; i < lim; i++) {
      const bg = letters.substring(i, i + 2).toLowerCase();
      if (bg.length === 2) { bigramTotal++; if (COMMON_BIGRAMS.has(bg)) bigramHits++; }
    }
    const bigramScore = bigramTotal > 3 ? bigramHits / bigramTotal : 0;
    const vowelCount = (letters.match(/[aeiou]/gi) || []).length;
    const vowelRatio = letters.length > 0 ? vowelCount / letters.length : 0;
    const weirdChars = (text.match(/[\[\]{}()|\\\/@#$%^&*+=<>~`_]/g) || []).length;
    const weirdRatio = text.length > 0 ? weirdChars / text.length : 0;
    const commonCount = words.filter(w => COMMON_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ''))).length;
    const commonRatio = words.length > 0 ? commonCount / words.length : 0;
    const realWords = words.filter(w => /[aeiou]/i.test(w));
    const realWordRatio = words.length > 0 ? realWords.length / words.length : 0;
    let score = 0;
    if (bigramScore > 0.25) score += 2;
    if (bigramScore > 0.35) score += 3;
    if (vowelRatio >= 0.25 && vowelRatio <= 0.45) score += 3;
    if (realWordRatio > 0.7) score += 2;
    if (weirdRatio > 0.1) score -= 3;
    if (commonRatio > 0.1) score += 2;
    if (words.length >= 3) score += 1;
    if (words.length >= 5) score += 1;
    return score;
  }

  async _setPsm(worker, psm) {
    try { await worker.setParameters({ tessedit_pageseg_mode: String(psm) }); } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     QUALITY ANALYSIS
     ══════════════════════════════════════════════════════════════ */

  async _analyzeQuality(imageData) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, img.width, img.height);
          const p = d.data;
          const total = img.width * img.height;

          let sum = 0, sumSq = 0;
          let laplacianSum = 0;
          const gray = new Uint8Array(total);

          for (let i = 0; i < total; i++) {
            const idx = i * 4;
            const g = 0.299 * p[idx] + 0.587 * p[idx + 1] + 0.114 * p[idx + 2];
            gray[i] = Math.round(g);
            sum += g; sumSq += g * g;
          }

          const mean = sum / total;
          const variance = sumSq / total - mean * mean;
          const std = variance > 0 ? Math.sqrt(variance) : 0;

          // Blur detection via Laplacian variance (higher = sharper)
          for (let y = 1; y < img.height - 1; y++) {
            for (let x = 1; x < img.width - 1; x++) {
              const i = y * img.width + x;
              const lap = Math.abs(
                4 * gray[i]
                - gray[i - 1] - gray[i + 1]
                - gray[i - img.width] - gray[i + img.width]
              );
              laplacianSum += lap * lap;
            }
          }
          const blurScore = laplacianSum / total;

          // Normalize blur by contrast (std): sharp image has high Laplacian relative to contrast
          // This makes blur metric content-independent
          const normalizedBlur = std > 5 ? blurScore / std : blurScore;

          // Estimate noise: high-frequency energy in smooth regions
          let noiseEst = 0;
          for (let y = 2; y < img.height - 2; y++) {
            for (let x = 2; x < img.width - 2; x++) {
              const i = y * img.width + x;
              const localVar = (
                Math.abs(gray[i] - gray[i - 1]) +
                Math.abs(gray[i] - gray[i + 1]) +
                Math.abs(gray[i] - gray[i - img.width]) +
                Math.abs(gray[i] - gray[i + img.width])
              ) / 4;
              noiseEst += localVar;
            }
          }
          noiseEst = noiseEst / total;

          const resolution = img.width * img.height;
          const difficulty = this._classifyDifficulty({
            resolution, std, blurScore, normalizedBlur, mean, noiseEst,
            width: img.width, height: img.height,
          });

          resolve({
            resolution, width: img.width, height: img.height,
            contrast: std,
            brightness: mean,
            blurScore: Math.round(blurScore),
            normalizedBlur: Math.round(normalizedBlur * 100) / 100,
            noiseEstimate: Math.round(noiseEst * 100) / 100,
            difficulty,
            isBlurry: normalizedBlur < 0.5,
            isLowContrast: std < 30,
            isDark: mean < 40,
            isBright: mean > 220,
            isSmall: resolution < 300000,
            isNoisy: noiseEst > 30,
          });
        } catch (e) {
          resolve({ difficulty: 'unknown', contrast: 0, brightness: 128, blurScore: 0 });
        }
      };
      img.onerror = () => resolve({ difficulty: 'unknown', contrast: 0, brightness: 128, blurScore: 0 });
      img.src = imageData;
    });
  }

  _classifyDifficulty(q) {
    let score = 0;
    if (q.resolution < 200000) score += 2;
    else if (q.resolution < 500000) score += 1;
    const blur = q.normalizedBlur !== undefined ? q.normalizedBlur * 30 : q.blurScore;
    if (blur < 3) score += 2;
    else if (blur < 8) score += 1;
    if (q.std < 20) score += 2;
    else if (q.std < 40) score += 1;
    if (q.mean < 30 || q.mean > 225) score += 1;
    if (q.noiseEst > 50) score += 1;
    if (score >= 4) return 'hard';
    if (score >= 2) return 'medium';
    return 'easy';
  }

  /* ══════════════════════════════════════════════════════════════
     STRATEGY GENERATION
     ══════════════════════════════════════════════════════════════ */

  _generateStrategies(quality) {
    const strategies = [{ name: 'standard', psm: 6 }];
    if (quality.isBlurry || quality.isLowContrast) {
      strategies.push({ name: 'contrast', psm: 6 });
    }
    if (quality.isBlurry) {
      strategies.push({ name: 'deblur', psm: 6 });
    } else if (quality.difficulty === 'hard') {
      strategies.push({ name: 'sharpened', psm: 6 });
    } else if (quality.isLowContrast) {
      strategies.push({ name: 'threshold', psm: 6 });
    }
    if (strategies.length > OCR_MAX_STRATEGIES) strategies.length = OCR_MAX_STRATEGIES;
    return strategies;
  }

  _generateRetryStrategies(quality, previousResult, iteration) {
    const strategies = [];
    if (previousResult && previousResult.wordCount < 10) {
      if (quality.isBlurry) strategies.push({ name: 'deblur', psm: 3 });
      strategies.push({ name: 'threshold', psm: 6 });
    } else {
      strategies.push({ name: 'threshold', psm: 3 });
    }
    if (strategies.length > OCR_MAX_RETRY_STRATEGIES) strategies.length = OCR_MAX_RETRY_STRATEGIES;
    return strategies;
  }

  /* ══════════════════════════════════════════════════════════════
     STRATEGY APPLICATION (preprocessing per strategy)
     ══════════════════════════════════════════════════════════════ */

  async _applyStrategy(imageData, strategy) {
    switch (strategy.name) {
      case 'standard': return this._applyStandard(imageData);
      case 'contrast': return this._applyContrast(imageData);
      case 'sharpened': return this._applySharpened(imageData);
      case 'threshold': return this._applyThreshold(imageData);
      case 'upscaled': return this._applyUpscaled(imageData);
      case 'despeckle': return this._applyDespeckle(imageData);
      case 'aggresive': return this._applyAggressive(imageData);
      case 'deblur': return this._applyDeblur(imageData);
      default: return imageData;
    }
  }

  _pixelsFromImage(imageData) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, img.width, img.height);
        const p = d.data;
        const total = img.width * img.height;
        const gray = new Uint8Array(total);
        let sum = 0, sumSq = 0;
        for (let i = 0; i < total; i++) {
          const idx = i * 4;
          const g = Math.round(0.299 * p[idx] + 0.587 * p[idx + 1] + 0.114 * p[idx + 2]);
          gray[i] = g; sum += g; sumSq += g * g;
          p[idx] = p[idx+1] = p[idx+2] = g;
        }
        const mean = sum / total;
        const std = Math.sqrt(sumSq / total - mean * mean);
        resolve({ img, canvas, ctx, d, p, gray, total, mean, std, width: img.width, height: img.height });
      };
      img.onerror = () => resolve(null);
      img.src = imageData;
    });
  }

  _applyContrastToPixels(pixels, mean, std, maxFactor, targetStd) {
    const factor = Math.min(maxFactor, targetStd / Math.max(std, 1));
    for (let i = 0; i < pixels.length; i += 4) {
      let v = (pixels[i] - mean) * factor + 128;
      pixels[i] = pixels[i+1] = pixels[i+2] = Math.max(0, Math.min(255, v));
    }
  }

  async _applyStandard(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;
    if ((px.mean < 30 || px.mean > 225 || px.std < 25) && px.std > 1) {
      this._applyContrastToPixels(px.d.data, px.mean, px.std, 1.25, 60);
      px.ctx.putImageData(px.d, 0, 0);
    }
    return px.canvas.toDataURL('image/png');
  }

  async _applyContrast(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;
    this._applyContrastToPixels(px.d.data, px.mean, px.std, 2, 80);
    px.ctx.putImageData(px.d, 0, 0);
    return px.canvas.toDataURL('image/png');
  }

  async _applySharpened(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;

    const { width, height } = px;
    this._applyContrastToPixels(px.d.data, px.mean, px.std, 1.5, 70);

    for (let pass = 0; pass < 2; pass++) {
      const input = new Float32Array(px.d.data.length);
      for (let i = 0; i < px.d.data.length; i++) input[i] = px.d.data[i];
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = (y * width + x) * 4;
          const v = Math.round(
            9 * input[i]
            - input[i - 4] - input[i + 4]
            - input[i - width * 4] - input[i + width * 4]
          );
          px.d.data[i] = px.d.data[i+1] = px.d.data[i+2] = Math.max(0, Math.min(255, v));
        }
      }
    }
    px.ctx.putImageData(px.d, 0, 0);
    return px.canvas.toDataURL('image/png');
  }

  _otsuThreshold(pixels, total) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i += 4) {
      histogram[pixels[i]]++;
    }
    let wB = 0, sumB = 0, maxVariance = 0, threshold = OCR_OTSU_THRESHOLD_DEFAULT;
    const sumTotal = histogram.reduce((a, v, i) => a + i * v, 0);
    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sumTotal - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVariance) { maxVariance = between; threshold = t; }
    }
    return threshold;
  }

  _applyBinarize(pixels, threshold) {
    for (let i = 0; i < pixels.length; i += 4) {
      const v = pixels[i] < threshold ? 0 : 255;
      pixels[i] = pixels[i+1] = pixels[i+2] = v;
    }
  }

  async _applyThreshold(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;
    const threshold = this._otsuThreshold(px.d.data, px.total);
    this._applyBinarize(px.d.data, threshold);
    px.ctx.putImageData(px.d, 0, 0);
    return px.canvas.toDataURL('image/png');
  }

  async _applyUpscaled(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;

    const { img, width, height } = px;
    const scale = Math.min(2, 1500 / Math.min(width, height));
    if (scale <= 1) return imageData;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const upPixels = d.data;
    const upTotal = canvas.width * canvas.height;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < upPixels.length; i += 4) {
      const g = upPixels[i]; sum += g; sumSq += g * g;
    }
    const upMean = sum / upTotal;
    const upStd = Math.sqrt(sumSq / upTotal - upMean * upMean);
    if (upStd < 40 && upStd > 1) {
      this._applyContrastToPixels(upPixels, upMean, upStd, 1.3, 60);
      ctx.putImageData(d, 0, 0);
    }
    return canvas.toDataURL('image/png');
  }

  async _applyDespeckle(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;

    const { canvas, d, width, height } = px;
    // Median filter 3x3
    const src = new Uint8Array(d.data.length);
    src.set(d.data);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const neighbors = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            neighbors.push(src[((y + dy) * width + (x + dx)) * 4]);
          }
        }
        neighbors.sort((a, b) => a - b);
        const median = neighbors[4];
        const i = (y * width + x) * 4;
        d.data[i] = d.data[i+1] = d.data[i+2] = median;
      }
    }
    px.ctx.putImageData(d, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async _applyAggressive(imageData) {
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;

    let sum = 0, sumSq = 0;
    for (let i = 0; i < px.d.data.length; i += 4) {
      sum += px.d.data[i]; sumSq += px.d.data[i] * px.d.data[i];
    }
    const m = sum / px.total;
    const s = Math.sqrt(sumSq / px.total - m * m);
    this._applyContrastToPixels(px.d.data, m, s, 2.5, 100);
    const threshold = this._otsuThreshold(px.d.data, px.total);
    this._applyBinarize(px.d.data, threshold);
    px.ctx.putImageData(px.d, 0, 0);
    return px.canvas.toDataURL('image/png');
  }

  async _applyDeblur(imageData) {
    // Strategy: upscale 4x (nearest neighbor) → strong iterative sharpening → Otsu threshold
    const px = await this._pixelsFromImage(imageData);
    if (!px) return imageData;

    const { width, height } = px;

    // 4x nearest-neighbor upscale (keeps hard edges, gives Tesseract more pixels)
    const canvas = document.createElement('canvas');
    canvas.width = width * 4;
    canvas.height = height * 4;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(px.img, 0, 0, canvas.width, canvas.height);

    // 5 iterations of strong sharpening
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const upD = d.data;
    const upW = canvas.width;
    const upH = canvas.height;

    for (let pass = 0; pass < 5; pass++) {
      const input = new Float32Array(upD.length);
      for (let i = 0; i < upD.length; i++) input[i] = upD[i];
      for (let y = 1; y < upH - 1; y++) {
        for (let x = 1; x < upW - 1; x++) {
          const i = (y * upW + x) * 4;
          const v = Math.round(
            9 * input[i]
            - input[i - 4] - input[i + 4]
            - input[i - upW * 4] - input[i + upW * 4]
          );
          upD[i] = upD[i+1] = upD[i+2] = Math.max(0, Math.min(255, v));
        }
      }
    }

    const threshold = this._otsuThreshold(upD, upW * upH);
    this._applyBinarize(upD, threshold);
    ctx.putImageData(d, 0, 0);

    return canvas.toDataURL('image/png');
  }

  /* ══════════════════════════════════════════════════════════════
     ORIENTATION AUTO-FIX (handled in _findBestOrientation now)
     ══════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════
     SELF-CRITIQUE
     ══════════════════════════════════════════════════════════════ */

  _critique(result, quality) {
    const issues = [];
    const text = (result.text || '').trim();
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const letters = text.replace(/[^a-zA-Z]/g, '');

    let overallConfidence = 0.5;

    // Check 1: Very few words for a large image
    if (quality.width && quality.height && quality.width * quality.height > 500000 && wordCount < 20) {
      issues.push('Large image but few words extracted — text may be missed');
      overallConfidence -= 0.2;
    }

    // Check 2: Unusual character distribution
    if (letters.length > 0) {
      const vowelRatio = (letters.match(/[aeiou]/gi) || []).length / letters.length;
      if (vowelRatio < 0.18 || vowelRatio > 0.52) {
        issues.push('Unusual vowel distribution — possible garbage text');
        overallConfidence -= 0.2;
      }
    }

    // Check 3: Average word length
    if (wordCount > 0) {
      const avgLen = words.reduce((s, w) => s + w.length, 0) / wordCount;
      if (avgLen < 2.5 || avgLen > 14) {
        issues.push('Average word length outside normal range');
        overallConfidence -= 0.1;
      }
    }

    // Check 4: Common word ratio
    if (wordCount > 0) {
      const commonCount = words.filter(w => COMMON_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ''))).length;
      const commonRatio = commonCount / wordCount;
      if (commonRatio < 0.1 && wordCount > 3) {
        issues.push('Very few common English words — may not be English or may be garbled');
        overallConfidence -= 0.2;
      } else if (commonRatio > 0.35) {
        overallConfidence += 0.1;
      }
    }

    // Check 5: Word confidence from OCR
    const avgConf = result.confidence || 0;
    if (avgConf > 0) {
      const confScore = avgConf / 100;
      if (confScore < 0.5) {
        issues.push('Low average OCR confidence');
        overallConfidence -= 0.15;
      } else if (confScore > 0.8) {
        overallConfidence += 0.1;
      }
    }

    // Check 6: Bigram score
    if (letters.length > 5) {
      let bigramHits = 0, bigramTotal = 0;
      for (let i = 0; i < letters.length - 1; i++) {
        const bg = letters.substring(i, i + 2).toLowerCase();
        if (bg.length === 2) {
          bigramTotal++;
          if (COMMON_BIGRAMS.has(bg)) bigramHits++;
        }
      }
      const bigramScore = bigramTotal > 5 ? bigramHits / bigramTotal : 0;
      if (bigramScore < 0.28) {
        issues.push('Unusual character bigram distribution');
        overallConfidence -= 0.15;
      } else if (bigramScore > 0.45) {
        overallConfidence += 0.08;
      }
    }

    // Check 7: Weird characters
    const weirdChars = (text.match(/[\[\]{}()|\\\/@#$%^&*+=<>~`_]/g) || []).length;
    if (weirdChars > text.length * 0.02) {
      issues.push('Excessive special characters');
      overallConfidence -= 0.1;
    }

    overallConfidence = Math.max(0.05, Math.min(0.99, overallConfidence));

    return { issues, overallConfidence: Math.round(overallConfidence * 100) / 100 };
  }

  /* ══════════════════════════════════════════════════════════════
     SCORING & CONSENSUS
     ══════════════════════════════════════════════════════════════ */

  _quality(result) {
    if (!result || !result.text) return 0;
    return this._score(result);
  }

  _pickBest(candidates) {
    return candidates.reduce((a, b) => {
      if (!a) return b;
      if (!b) return a;
      return this._score(a) >= this._score(b) ? a : b;
    }, null);
  }

  _score(result) {
    const text = (result.text || '').trim();
    const wordCount = result.wordCount || 0;
    if (wordCount < 3 || text.length < 10) return -10;

    const clean = text.toLowerCase();
    const letters = clean.replace(/[^a-z]/g, '');
    if (letters.length < 5) return -5;

    let bigramHits = 0, bigramTotal = 0;
    for (let i = 0; i < letters.length - 1; i++) {
      const bg = letters.substring(i, i + 2);
      if (bg.length === 2) {
        bigramTotal++;
        if (COMMON_BIGRAMS.has(bg)) bigramHits++;
      }
    }
    const bigramScore = bigramTotal > 5 ? bigramHits / bigramTotal : 0;

    const words = text.split(/\s+/).filter(w => w.length > 0);
    const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;

    const vowelCount = (letters.match(/[aeiou]/g) || []).length;
    const vowelRatio = letters.length > 0 ? vowelCount / letters.length : 0;

    const realWords = words.filter(w => /[aeiou]/i.test(w));
    const realWordRatio = words.length > 0 ? realWords.length / words.length : 0;

    const weirdChars = (text.match(/[\[\]{}()|\\\/@#$%^&*+=<>~`_]/g) || []).length;
    const weirdPenalty = Math.max(0.1, 1 - weirdChars / Math.max(text.length, 1) * 4);

    const digitCount = (text.match(/\d/g) || []).length;
    const digitRatio = digitCount / Math.max(text.length, 1);
    const digitPenalty = digitRatio < 0.15 ? 1 : Math.max(0.1, 1 - digitRatio);

    // Consecutive consonant cluster penalty (English text rarely has 4+ consonants in a row)
    const consonantRuns = (text.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || []).length;
    const consonantClusterPenalty = Math.max(0.2, 1 - consonantRuns * 0.15);

    const lenScore = avgLen >= 3 && avgLen <= 10 ? 1 : Math.max(0.1, 1 - Math.abs(avgLen - 5) / 15);

    const mixedCase = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
    const casePenalty = mixedCase > 0.01 && mixedCase < 0.5 ? 1 : 0.5;

    const commonWords = words.filter(w => COMMON_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ''))).length;
    const commonRatio = words.length > 0 ? commonWords / words.length : 0;
    const commonBonus = 1 + commonRatio * 0.5;

    const score = wordCount *
      Math.min(1, bigramScore * 2.5) *
      realWordRatio *
      Math.min(1, vowelRatio * 3) *
      lenScore *
      weirdPenalty *
      digitPenalty *
      casePenalty *
      commonBonus *
      consonantClusterPenalty;

    return score;
  }

  /* ══════════════════════════════════════════════════════════════
     OCR EXECUTION
     ══════════════════════════════════════════════════════════════ */

  async _doRecognize(worker, imageData) {
    if (!imageData || (typeof imageData === 'string' && !imageData.startsWith('data:'))) {
      return { text: '', words: [], confidence: 0, wordCount: 0 };
    }
    let result;
    try { result = await worker.recognize(imageData); } catch (_) { return { text: '', words: [], confidence: 0, wordCount: 0 }; }
    if (!result || !result.data) return { text: '', words: [], confidence: 0, wordCount: 0 };
    const data = result.data;
    let words = [];
    if (data.words && data.words.length > 0) {
      words = data.words.map(w => ({
        text: w.text,
        bbox: { x0: w.bbox?.x0 || 0, y0: w.bbox?.y0 || 0, x1: w.bbox?.x1 || 0, y1: w.bbox?.y1 || 0 },
        confidence: w.confidence || 0,
      }));
    } else if (data.symbols) {
      words = this._extractWordsFromSymbols(data.symbols);
    }
    const avgConf = words.length > 0
      ? words.reduce((s, w) => s + w.confidence, 0) / words.length
      : 0;
    return { text: data.text || '', words, confidence: avgConf, wordCount: words.length };
  }

  _rotateImage(imageData, degrees) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            if (degrees === 90 || degrees === 270) { c.width = img.height; c.height = img.width; }
            else { c.width = img.width; c.height = img.height; }
            ctx.save();
            ctx.translate(c.width / 2, c.height / 2);
            ctx.rotate(degrees * Math.PI / 180);
            ctx.drawImage(img, -img.width / 2, -img.height / 2);
            ctx.restore();
            resolve(c.toDataURL('image/png'));
          } catch (_) { resolve(imageData); }
        };
        img.onerror = () => resolve(imageData);
        img.src = imageData;
      } catch (_) { resolve(imageData); }
    });
  }

  _flipImage(imageData, horizontal, vertical) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.save();
            ctx.translate(horizontal ? img.width : 0, vertical ? img.height : 0);
            ctx.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
            ctx.drawImage(img, 0, 0);
            ctx.restore();
            resolve(c.toDataURL('image/png'));
          } catch (_) { resolve(imageData); }
        };
        img.onerror = () => resolve(imageData);
        img.src = imageData;
      } catch (_) { resolve(imageData); }
    });
  }

  _extractWordsFromSymbols(symbols) {
    const words = [];
    let cur = null;
    for (const s of symbols) {
      if (!cur) {
        cur = { text: s.text, bbox: { ...s.bbox }, confidence: s.confidence || 0 };
      } else if (s.text === ' ') {
        if (cur) words.push(cur);
        cur = null;
      } else {
        cur.text += s.text;
        cur.bbox.x1 = s.bbox.x1; cur.bbox.y1 = s.bbox.y1;
        cur.confidence = (cur.confidence + (s.confidence || 0)) / 2;
      }
    }
    if (cur) words.push(cur);
    return words;
  }

  async terminate() {
    for (const w of this.idle) await w.terminate();
    for (const w of this.busy) await w.terminate();
    this.idle = []; this.busy.clear();
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
}

window.OcrProcessor = OcrProcessor;
