// Capture worklet: forwards raw mic frames to the main thread, tagged with the
// AudioContext frame index of the first sample in each block.
//
// `currentFrame` is the AudioContext's own frame counter, so the indices line up
// with ctx.currentTime * sampleRate. The worklet's local counter is only used to
// bridge the gap before the first block arrives.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.local = 0;
    this.offset = null; // currentFrame - local, fixed at the first block
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) {
      this.local += 128;
      return true;
    }

    if (this.offset === null) this.offset = currentFrame - this.local;
    const frame = this.local + this.offset;

    // Copy: the input buffer is reused by the engine after process() returns.
    this.port.postMessage({ frame, data: new Float32Array(ch) });
    this.local += ch.length;
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
