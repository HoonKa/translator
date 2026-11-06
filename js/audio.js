// Microphone capture. Calls onChunk({ b64, rms }) every 100 ms.
export async function listMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function startMic({ deviceId, onChunk, onEnded }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let ctx;
  let src;
  try {
    // Let the browser resample to 16 kHz (best quality).
    ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    src = ctx.createMediaStreamSource(stream);
  } catch {
    if (ctx) ctx.close();
    ctx = new AudioContext({ latencyHint: 'interactive' });
    src = ctx.createMediaStreamSource(stream);
  }
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e) => onChunk({ b64: toBase64(e.data.pcm), rms: e.data.rms });
  src.connect(node);
  // The node must reach the destination to keep running; a muted gain keeps the speakers silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();

  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', () => onEnded && onEnded());

  return {
    label: track.label,
    sampleRate: ctx.sampleRate,
    stop() {
      try { node.port.onmessage = null; src.disconnect(); node.disconnect(); } catch {}
      stream.getTracks().forEach(t => t.stop());
      ctx.close();
    },
  };
}
