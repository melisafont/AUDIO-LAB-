/* ═══════════════════════════════════════════════════════════════
   AudioLab — Core JS
   ════════════════════════════════════════════════════════════ */

/* ── State ─────────────────────────────────────────────────── */
let audioCtx      = null;
let stream        = null;
let mediaRecorder = null;
let recordChunks  = [];
let recordInterval= null;
let recordSecs    = 0;
let isRecording   = false;

let rawAudioBuffer  = null;   // AudioBuffer from mic (original)
let procAudioBuffer = null;   // AudioBuffer after DSP
let processedBlob   = null;

let analyserOrig  = null;
let analyserConv  = null;
let waveAnalyser  = null;
let gainNode      = null;

let currentSR   = 44100;
let currentBits = 16;
let currentGain = 1.0;

let audioPlayer = null;
let playerSrc   = null;
let isPlaying   = false;
let playInterval= null;

/* ── Logging ────────────────────────────────────────────────── */
function log(msg, type='') {
  const box = document.getElementById('logBox');
  const ts  = new Date().toLocaleTimeString('es-AR',{hour12:false});
  const p   = document.createElement('p');
  p.className = type ? `log-${type}` : '';
  p.textContent = `[${ts}] ${msg}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

/* ── Toast ──────────────────────────────────────────────────── */
let toastTimeout;
function toast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `show ${type}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(()=>{ t.className = ''; }, 3200);
}

/* ── AudioContext lazy init ─────────────────────────────────── */
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/* ── Chip selectors ─────────────────────────────────────────── */
function setSR(val, el) {
  currentSR = val;
  document.querySelectorAll('#srChips .chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  const labels = {8000:'8 kHz',16000:'16 kHz',44100:'44.1 kHz',96000:'96 kHz'};
  document.getElementById('srBadge').textContent = labels[val];
  updateStats();
  document.getElementById('specLabel').textContent = `${labels[val]} / ${currentBits} bits`;
  log(`Tasa de muestreo → ${labels[val]}`, 'ok');
  if (procAudioBuffer) redrawSpectrums();
}
function setBits(val, el) {
  currentBits = val;
  document.querySelectorAll('#bitChips .chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('bitBadge').textContent = `${val} bits`;
  updateStats();
  const srLabel = document.getElementById('srBadge').textContent;
  document.getElementById('specLabel').textContent = `${srLabel} / ${val} bits`;
  log(`Profundidad de bits → ${val} bits`, 'ok');
  if (procAudioBuffer) redrawSpectrums();
}
function setGain(val) {
  currentGain = parseFloat(val);
  document.getElementById('gainBadge').textContent = `${currentGain.toFixed(2)}×`;
  if (gainNode) gainNode.gain.value = currentGain;
}
function updateStats() {
  const nyq = (currentSR/2/1000).toFixed(3);
  const dyn = (currentBits * 6.0206).toFixed(1);
  const lev = Math.pow(2, currentBits).toLocaleString();
  document.getElementById('nyquistVal').textContent = nyq;
  document.getElementById('dynamicVal').textContent = dyn;
  document.getElementById('levelsVal').textContent  = lev;
}
updateStats();

/* ── Wave visualizer during recording ──────────────────────── */
let waveAnimId = null;
function startWaveViz() {
  const canvas = document.getElementById('waveCanvas');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width  = canvas.offsetWidth;
  const H = canvas.height = canvas.offsetHeight;

  function draw() {
    if (!waveAnalyser) return;
    const buf = new Uint8Array(waveAnalyser.fftSize);
    waveAnalyser.getByteTimeDomainData(buf);

    ctx.clearRect(0,0,W,H);
    const grad = ctx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0, '#3b82f6');
    grad.addColorStop(0.5, '#8b5cf6');
    grad.addColorStop(1, '#06b6d4');

    ctx.beginPath();
    ctx.strokeStyle = grad;
    ctx.lineWidth   = 2;
    const step = W / buf.length;
    for (let i=0; i<buf.length; i++) {
      const x = i * step;
      const y = (buf[i]/255)*H;
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.stroke();
    waveAnimId = requestAnimationFrame(draw);
  }
  draw();
}
function stopWaveViz() {
  if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId=null; }
}

/* ── RECORD ─────────────────────────────────────────────────── */
async function toggleRecord() {
  if (!isRecording) await startRecording();
  else stopRecording();
}

async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
    const ctx = getAudioCtx();

    // build graph: source → gain → analyser → destination (monitoring off)
    const source = ctx.createMediaStreamSource(stream);
    gainNode = ctx.createGain();
    gainNode.gain.value = currentGain;

    waveAnalyser = ctx.createAnalyser();
    waveAnalyser.fftSize = 1024;

    source.connect(gainNode);
    gainNode.connect(waveAnalyser);

    mediaRecorder = new MediaRecorder(stream);
    recordChunks  = [];
    mediaRecorder.ondataavailable = e => { if(e.data.size>0) recordChunks.push(e.data); };
    mediaRecorder.start(100);

    isRecording = true;
    recordSecs  = 0;
    document.getElementById('recordBtn').classList.add('recording');
    document.getElementById('recordIcon').textContent = '⏹️';
    document.getElementById('recordStatusTxt').textContent = 'Grabando…';
    document.getElementById('micDot').classList.add('active');
    document.getElementById('micStatus').textContent = 'Micrófono activo';

    recordInterval = setInterval(()=>{
      recordSecs++;
      const m = String(Math.floor(recordSecs/60)).padStart(2,'0');
      const s = String(recordSecs%60).padStart(2,'0');
      document.getElementById('recordTimer').textContent = `${m}:${s}`;
    }, 1000);

    startWaveViz();
    log('Grabación iniciada', 'ok');
    toast('🎙️ Grabando…', 'info');
  } catch(e) {
    log(`Error de micrófono: ${e.message}`, 'err');
    toast('❌ No se pudo acceder al micrófono', 'err');
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  stream.getTracks().forEach(t=>t.stop());
  clearInterval(recordInterval);
  stopWaveViz();

  isRecording = false;
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('recordIcon').textContent = '🎙️';
  document.getElementById('recordStatusTxt').textContent = 'Grabación lista';
  document.getElementById('micDot').classList.remove('active');
  document.getElementById('micStatus').textContent = 'Micrófono no activo';

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordChunks, { type:'audio/webm' });
    const arr  = await blob.arrayBuffer();
    const ctx  = getAudioCtx();
    rawAudioBuffer = await ctx.decodeAudioData(arr);
    document.getElementById('processBtn').disabled = false;
    log(`Audio capturado: ${recordSecs}s, ${rawAudioBuffer.sampleRate} Hz, ${rawAudioBuffer.numberOfChannels}ch`, 'ok');
    toast('✅ Grabación completada', 'ok');
    drawOriginalSpectrum();
  };
}

/* ── SPECTRUM helpers ───────────────────────────────────────── */
function fftFromBuffer(buffer, channelIdx=0) {
  const data = buffer.getChannelData(channelIdx);
  const SIZE = 2048;
  const slice = data.slice(0, Math.min(SIZE, data.length));
  // Hann window
  const windowed = new Float32Array(slice.length);
  for (let i=0;i<slice.length;i++) {
    const w = 0.5*(1-Math.cos(2*Math.PI*i/(slice.length-1)));
    windowed[i] = slice[i]*w;
  }
  // DFT (half bands for display — use 512 bins max)
  const BINS = 512;
  const mag  = new Float32Array(BINS);
  const N    = windowed.length;
  for (let k=0;k<BINS;k++) {
    let re=0, im=0;
    for (let n=0;n<N;n++) {
      const ang = 2*Math.PI*k*n/N;
      re += windowed[n]*Math.cos(ang);
      im -= windowed[n]*Math.sin(ang);
    }
    mag[k] = Math.sqrt(re*re+im*im)/N;
  }
  return mag;
}

function drawSpectrum(canvasId, mag, sampleRate, color1='#3b82f6', color2='#8b5cf6', nyquistHz=null) {
  const canvas = document.getElementById(canvasId);
  const ctx    = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth || 400;
  canvas.height = canvas.offsetHeight || 160;
  const W=canvas.width, H=canvas.height;

  ctx.clearRect(0,0,W,H);

  // BG
  ctx.fillStyle = '#0d1220';
  ctx.fillRect(0,0,W,H);

  // Grid lines
  ctx.strokeStyle = 'rgba(30,45,69,0.8)';
  ctx.lineWidth = 1;
  for (let i=1;i<5;i++) {
    ctx.beginPath(); ctx.moveTo(0,H*i/5); ctx.lineTo(W,H*i/5); ctx.stroke();
  }
  for (let i=1;i<8;i++) {
    ctx.beginPath(); ctx.moveTo(W*i/8,0); ctx.lineTo(W*i/8,H); ctx.stroke();
  }

  // Spectrum bars
  const maxV = Math.max(...mag)*1.05 || 1;
  const grad = ctx.createLinearGradient(0,H,0,0);
  grad.addColorStop(0,  color1+'99');
  grad.addColorStop(0.6, color1);
  grad.addColorStop(1,  color2);

  const barW = W / mag.length;
  for (let i=0;i<mag.length;i++) {
    const h = (mag[i]/maxV)*H*0.9;
    ctx.fillStyle = grad;
    ctx.fillRect(i*barW, H-h, barW*0.85, h);
  }

  // Nyquist line
  if (nyquistHz && sampleRate) {
    const nBin = Math.min(Math.floor(nyquistHz/(sampleRate/2)*mag.length), mag.length-1);
    const x    = (nBin/mag.length)*W;
    ctx.strokeStyle = '#ef4444aa';
    ctx.lineWidth   = 2;
    ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ef444499';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`Nyquist ${(nyquistHz/1000).toFixed(1)}kHz`, x+4, 14);
  }

  // Axis labels
  ctx.fillStyle = '#475569';
  ctx.font = '10px Inter, sans-serif';
  const half = sampleRate/2;
  for (let i=0;i<=4;i++) {
    const fkHz = (half/4*i/1000).toFixed(0);
    ctx.fillText(`${fkHz}k`, (i/4)*W - (i>0?12:0), H-4);
  }
}

function drawOriginalSpectrum() {
  if (!rawAudioBuffer) return;
  const mag = fftFromBuffer(rawAudioBuffer);
  drawSpectrum('spectrumOrig', mag, rawAudioBuffer.sampleRate, '#06b6d4','#3b82f6');
}

function drawConvertedSpectrum() {
  if (!procAudioBuffer) return;
  const nyq = currentSR/2;
  const mag  = fftFromBuffer(procAudioBuffer);
  drawSpectrum('spectrumConv', mag, currentSR, '#8b5cf6','#ec4899', nyq);
}

function redrawSpectrums() {
  drawOriginalSpectrum();
  drawConvertedSpectrum();
}

/* ── DSP: resample + quantize ───────────────────────────────── */
function resampleBuffer(inputBuffer, targetSR) {
  // Use OfflineAudioContext to resample
  return new Promise(resolve=>{
    const nCh  = inputBuffer.numberOfChannels;
    const dur  = inputBuffer.duration;
    const len  = Math.ceil(dur * targetSR);
    const oCtx = new OfflineAudioContext(nCh, len, targetSR);
    const src  = oCtx.createBufferSource();
    src.buffer = inputBuffer;
    src.connect(oCtx.destination);
    src.start(0);
    oCtx.startRendering().then(resolve);
  });
}

function quantizeBuffer(audioBuffer, bits) {
  const levels = Math.pow(2, bits) - 1;
  const nCh    = audioBuffer.numberOfChannels;
  const ctx    = getAudioCtx();
  const out    = ctx.createBuffer(nCh, audioBuffer.length, audioBuffer.sampleRate);
  for (let c=0;c<nCh;c++) {
    const input  = audioBuffer.getChannelData(c);
    const output = out.getChannelData(c);
    for (let i=0;i<input.length;i++) {
      // map [-1,1] → [0,levels] → quantize → back to [-1,1]
      const mapped = (input[i]+1)/2 * levels;
      const quant  = Math.round(mapped);
      output[i]    = (quant/levels)*2 - 1;
    }
  }
  return out;
}

/* ── PROCESS ────────────────────────────────────────────────── */
async function processAudio() {
  if (!rawAudioBuffer) { toast('⚠️ Primero grabá audio', 'err'); return; }
  log(`Procesando: ${currentSR} Hz / ${currentBits} bits…`, 'warn');

  const btn = document.getElementById('processBtn');
  btn.disabled = true; btn.textContent = '⏳ Procesando…';

  try {
    const resampled   = await resampleBuffer(rawAudioBuffer, currentSR);
    procAudioBuffer   = quantizeBuffer(resampled, currentBits);

    // build WAV blob
    processedBlob = audioBufferToWav(procAudioBuffer, currentBits);

    // update player
    const url = URL.createObjectURL(processedBlob);
    if (playerSrc) URL.revokeObjectURL(playerSrc);
    playerSrc = url;
    if (audioPlayer) audioPlayer.src = url;
    else {
      audioPlayer = new Audio(url);
      audioPlayer.addEventListener('timeupdate', updateProgress);
      audioPlayer.addEventListener('ended', ()=>{
        isPlaying = false;
        document.getElementById('playBtn').textContent = '▶';
        clearInterval(playInterval);
      });
      audioPlayer.addEventListener('loadedmetadata', ()=>{
        document.getElementById('totalTime').textContent = formatTime(audioPlayer.duration);
        document.getElementById('durationBadge').textContent = formatTime(audioPlayer.duration);
      });
    }
    audioPlayer.src = url;

    document.getElementById('playerSection').style.display='block';
    document.getElementById('exportWavBtn').disabled = false;
    document.getElementById('exportMp3Btn').disabled = false;
    document.getElementById('fileStats').style.display = 'flex';

    const sizeKB = (processedBlob.size/1024).toFixed(1);
    const dur    = procAudioBuffer.duration.toFixed(2);
    document.getElementById('fileSizeVal').textContent = sizeKB+'KB';
    document.getElementById('fileDurVal').textContent  = dur+'s';
    document.getElementById('fileSrVal').textContent   = (currentSR/1000).toFixed(1)+'kHz';
    document.getElementById('fileBitVal').textContent  = currentBits+'bit';

    drawConvertedSpectrum();

    log(`✓ Procesado: ${(resampled.length/1000).toFixed(1)}k muestras, ${sizeKB}KB, ${dur}s`, 'ok');
    toast('✅ Audio procesado', 'ok');
  } catch(e) {
    log(`Error en procesamiento: ${e.message}`, 'err');
    toast('❌ Error al procesar', 'err');
  }

  btn.disabled = false; btn.textContent = '⚙️ Procesar Audio';
}

/* ── WAV ENCODER ────────────────────────────────────────────── */
function audioBufferToWav(buffer, bits) {
  const numCh   = buffer.numberOfChannels;
  const sr      = buffer.sampleRate;
  const numSamples = buffer.length * numCh;
  const bytesPerSample = bits === 8 ? 1 : bits === 16 ? 2 : 3;
  const dataSize = numSamples * bytesPerSample;
  const bufSize  = 44 + dataSize;
  const ab       = new ArrayBuffer(bufSize);
  const view     = new DataView(ab);

  function write(offset, str) {
    for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i));
  }
  write(0,'RIFF');
  view.setUint32(4, 36+dataSize, true);
  write(8,'WAVE');
  write(12,'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bits===24?1:1, true);   // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr*numCh*bytesPerSample, true);
  view.setUint16(32, numCh*bytesPerSample, true);
  view.setUint16(34, bits, true);
  write(36,'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  // interleave channels
  const channels = [];
  for (let c=0;c<numCh;c++) channels.push(buffer.getChannelData(c));

  for (let i=0;i<buffer.length;i++) {
    for (let c=0;c<numCh;c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      if (bits===8) {
        view.setUint8(offset, (sample+1)/2*255);
        offset += 1;
      } else if (bits===16) {
        view.setInt16(offset, sample<0?sample*32768:sample*32767, true);
        offset += 2;
      } else { // 24
        const s = Math.round(sample * 8388607);
        view.setUint8(offset,   s & 0xFF);
        view.setUint8(offset+1, (s>>8) & 0xFF);
        view.setUint8(offset+2, (s>>16) & 0xFF);
        offset += 3;
      }
    }
  }
  return new Blob([ab], { type:'audio/wav' });
}

/* ── EXPORT ─────────────────────────────────────────────────── */
function exportWAV() {
  if (!processedBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(processedBlob);
  a.download = `audiolab_${currentSR}hz_${currentBits}bit.wav`;
  a.click();
  log(`WAV exportado: ${currentSR} Hz, ${currentBits} bits`, 'ok');
  toast('💾 WAV descargado', 'ok');
}

// MP3 simulation: since native MP3 encoding in JS requires external libs,
// we export a WAV but named .mp3 — or use a reduced-quality WAV to simulate compression.
function exportMP3Like() {
  if (!processedBlob) return;
  // simulate MP3: downsample to 44.1kHz 16bit and reduce file size note
  const a = document.createElement('a');
  a.href = URL.createObjectURL(processedBlob);
  a.download = `audiolab_export.wav`;
  a.click();
  log('MP3: exportado como WAV (MP3 nativo requiere librerías externas como lamejs)', 'warn');
  toast('🎵 Archivo exportado (WAV compatible)', 'info');
}

/* ── PLAYER ─────────────────────────────────────────────────── */
function togglePlay() {
  if (!audioPlayer) return;
  if (isPlaying) {
    audioPlayer.pause();
    document.getElementById('playBtn').textContent = '▶';
    isPlaying = false;
  } else {
    audioPlayer.play();
    document.getElementById('playBtn').textContent = '⏸';
    isPlaying = true;
  }
}
function updateProgress() {
  if (!audioPlayer || !audioPlayer.duration) return;
  const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  document.getElementById('progressFill').style.width = pct+'%';
  document.getElementById('currentTime').textContent = formatTime(audioPlayer.currentTime);
}
function seekAudio(e) {
  if (!audioPlayer || !audioPlayer.duration) return;
  const bar  = document.getElementById('progressBar');
  const rect = bar.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  audioPlayer.currentTime = pct * audioPlayer.duration;
}
function formatTime(s) {
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60).toString().padStart(2,'0');
  return `${m}:${sec}`;
}

/* ── CLEAR ──────────────────────────────────────────────────── */
function clearAll() {
  rawAudioBuffer  = null;
  procAudioBuffer = null;
  processedBlob   = null;
  if (audioPlayer) { audioPlayer.pause(); audioPlayer=null; }
  if (playerSrc)   { URL.revokeObjectURL(playerSrc); playerSrc=null; }
  isPlaying = false;

  document.getElementById('processBtn').disabled = true;
  document.getElementById('exportWavBtn').disabled = true;
  document.getElementById('exportMp3Btn').disabled = true;
  document.getElementById('playerSection').style.display='none';
  document.getElementById('fileStats').style.display='none';
  document.getElementById('recordTimer').textContent = '00:00';
  document.getElementById('recordStatusTxt').textContent = 'Presioná para grabar';

  // clear canvases
  ['spectrumOrig','spectrumConv','waveCanvas'].forEach(id=>{
    const c = document.getElementById(id);
    const ctx = c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
  });

  document.getElementById('logBox').innerHTML = '<p class="log-ok">▶ AudioLab reiniciado.</p>';
  toast('🗑️ Todo limpiado', 'info');
}

/* ── Resize observer for canvases ───────────────────────────── */
window.addEventListener('resize', ()=>{
  if (rawAudioBuffer)  drawOriginalSpectrum();
  if (procAudioBuffer) drawConvertedSpectrum();
});

/* ── Init log ────────────────────────────────────────────────── */
log(`WebAudio API disponible: ${!!(window.AudioContext||window.webkitAudioContext)}`, 'ok');
log(`MediaRecorder disponible: ${!!window.MediaRecorder}`, 'ok');