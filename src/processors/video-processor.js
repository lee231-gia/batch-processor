class VideoProcessor {
  constructor(ocrProcessor) {
    this.ocrProcessor = ocrProcessor;
    this.videoMode = 'sync-separate';
  }

  setVideoMode(mode) {
    this.videoMode = mode;
  }

  async processVideo(videoBlob, fileName, onProgress) {
    const videoUrl = URL.createObjectURL(videoBlob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = videoUrl;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video load timeout')), 15000);
      video.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error('Failed to load video')); };
    });

    const duration = video.duration;
    if (!duration || duration <= 0 || !isFinite(duration)) {
      URL.revokeObjectURL(videoUrl);
      video.remove();
      return { text: '', structuredText: '', confidence: 0, wordCount: 0 };
    }

    const frameInterval = Math.max(5, Math.ceil(duration / 20));
    const totalFrames = Math.min(Math.ceil(duration / frameInterval), 20);
    const frameResults = [];

    for (let i = 0; i < totalFrames; i++) {
      const time = Math.min(i * frameInterval, duration - 0.1);
      if (onProgress) onProgress((i / totalFrames) * 0.9);

      try {
        video.currentTime = time;
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('seek timeout')), 5000);
          video.onseeked = () => { clearTimeout(to); resolve(); };
        });

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);

        const imageData = canvas.toDataURL('image/jpeg', 0.85);
        const result = await this.ocrProcessor.processImage(
          imageData, `frame_${Math.round(time)}s`
        );

        if (result.text && result.text.trim()) {
          frameResults.push({
            timestamp: time,
            text: result.text.trim(),
            confidence: result.confidence,
          });
        }
      } catch (_) {}
    }

    URL.revokeObjectURL(videoUrl);
    video.remove();

    return this._mergeResults(frameResults, duration);
  }

  _mergeResults(frameResults, duration) {
    const text = frameResults
      .filter(f => f.text)
      .map(f => {
        const m = Math.floor(f.timestamp / 60);
        const s = Math.floor(f.timestamp % 60);
        return `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}] ${f.text}`;
      })
      .join('\n');

    const wordCount = text.split(/\s+/).filter(w => w).length;
    const avgConf = frameResults.length > 0
      ? frameResults.reduce((s, f) => s + f.confidence, 0) / frameResults.length
      : 0;

    return {
      text,
      structuredText: text,
      confidence: avgConf || 0.5,
      wordCount,
    };
  }
}

window.VideoProcessor = VideoProcessor;
