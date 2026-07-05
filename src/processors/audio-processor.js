class AudioProcessor {
  constructor() {
    this.initialized = false;
  }

  async init() {
    this.initialized = true;
  }

  async processAudio(audioBlob, fileName, onProgress) {
    await this.init();
    if (onProgress) onProgress(0.5);
    return {
      text: '',
      words: [],
      confidence: 0,
      wordCount: 0,
    };
  }
}

window.AudioProcessor = AudioProcessor;
