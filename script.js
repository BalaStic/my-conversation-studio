const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

let availableVoices = [];
let lastLoadedKey = '';
let voiceLoadTimer = null;

const REQUEST_DELAY_MS = 2500;
const MAX_RETRIES = 4;

let lastRequestTime = 0;

const PRESETS = {
  podcast: `Alice: Welcome to The AI Soundstage! I'm your host, Alice.\nBob: And I'm Bob. Today we're exploring how conversational text transforms into realistic multi-speaker audio.\nAlice: What excites me most is how each character can have their own distinct pitch, tempo, and personality.\nBob: Exactly! You can create podcasts, audio dramas, and educational dialogues right from your browser.\nAlice: And with one click, you can download the entire combined master audio file. Let's hear it!`,
  interview: `Interviewer: Welcome, Dr. Watson. Could you explain what makes multi-speaker audio synthesis so powerful?\nDr. Watson: Certainly! When we listen to a conversation, natural turn-taking, distinct vocal timbres, and subtle pauses make the content come alive.\nInterviewer: How does the pacing between speakers affect comprehension?\nDr. Watson: Even a half-second pause gives the listener's brain time to absorb the point before the next speaker responds.`,
  story: `Narrator: Deep in the misty forest, two travelers stumbled upon a glowing ancient archway.\nElena: Marcus, look! The runes are beginning to resonate with the crystal.\nMarcus: Be cautious, Elena. We don't know what kind of guardian this magic might summon.\nNarrator: A soft chime echoed through the trees, and the stones parted into a staircase of pure light.`,
  language: `Teacher: Bonjour Sophie! Comment vas-tu aujourd'hui?\nSophie: Bonjour Madame! Je vais très bien, merci. J'étudie mon dialogue en français.\nTeacher: Excellent! N'oublie pas de bien prononcer chaque phrase avec confiance.\nSophie: D'accord! Merci beaucoup pour votre aide.`
};

let speakerMap = {};
let isPlayingPreview = false;
let currentPreviewIndex = 0;
let renderedAudioBlob = null;
let renderedAudioUrl = null;
let renderedAudioMp3Blob = null;
let renderedAudioMp3Url = null;
let activeSource = null;
let decodeCtx = null;

const SPEAKER_COLORS = ['#38BDF8', '#F472B6', '#FBBF24', '#A78BFA', '#34D399', '#FB923C', '#E879F9'];

function loadApiKey() {
  const saved = localStorage.getItem('elevenLabsApiKey') || '';
  const input = document.getElementById('apiKeyInput');
  if (input) input.value = saved;
}

function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  if (input) localStorage.setItem('elevenLabsApiKey', input.value.trim());
  scheduleVoiceLoad();
}

function getApiKey() {
  const input = document.getElementById('apiKeyInput');
  return (input && input.value.trim()) || localStorage.getItem('elevenLabsApiKey') || '';
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('apiKeyInput');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

function scheduleVoiceLoad() {
  clearTimeout(voiceLoadTimer);
  voiceLoadTimer = setTimeout(loadAvailableVoices, 600);
}

function assignVoiceIds() {
  const speakers = Object.keys(speakerMap);
  speakers.forEach((spk, idx) => {
    if (!speakerMap[spk].voiceId && availableVoices.length) {
      speakerMap[spk].voiceId = availableVoices[idx % availableVoices.length].id;
    }
  });
}

async function loadAvailableVoices() {
  const apiKey = getApiKey();
  if (!apiKey) return;

  if (apiKey === lastLoadedKey && availableVoices.length > 0) return;
  lastLoadedKey = apiKey;

  setStatus('loading', 'Loading your ElevenLabs voices...');
  try {
    const res = await fetchWithRetry(`${ELEVENLABS_API_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey }
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to load voices (HTTP ${res.status}): ${errText.slice(0, 160)}`);
    }
    const data = await res.json();
    availableVoices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name }));
    if (availableVoices.length === 0) {
      setStatus('error', 'No voices found on your ElevenLabs account.');
      refreshSpeakerPersonas();
      return;
    }
    assignVoiceIds();
    populateSingleVoiceSelect();
    const badge = document.getElementById('voiceCountBadge');
    if (badge) badge.innerText = `${availableVoices.length} voices`;
    setStatus('success', `Loaded ${availableVoices.length} ElevenLabs voices.`);
    refreshSpeakerPersonas();
  } catch (err) {
    availableVoices = [];
    lastLoadedKey = '';
    setStatus('error', err.message);
    refreshSpeakerPersonas();
  }
}

function setStatus(type, msg) {
  const el = document.getElementById('statusMessage');
  const colors = { loading: '#6366F1', success: '#10B981', error: '#EF4444', muted: '#9CA3AF' };
  const color = colors[type] || '#9CA3AF';
  el.innerHTML = `<span style="color:${color}">●</span> ${escapeHtml(msg)}`;
}

function getDecodeContext() {
  if (!decodeCtx) decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  return decodeCtx;
}



function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function awaitRequestSlot() {
  const wait = REQUEST_DELAY_MS - (Date.now() - lastRequestTime);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url, options) {
  let lastStatus = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    if (res.status === 429 || res.status === 503) {
      lastStatus = res.status;
      const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1500 * Math.pow(2, attempt), 12000);
      setStatus('loading', `Rate limit hit (HTTP ${res.status}), retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }

    return res;
  }
  throw new Error(`Rate limit exceeded (HTTP ${lastStatus}) after retries. Try again in a minute.`);
}

async function synthesizeSpeech(text, voiceId) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Enter your ElevenLabs API key in the API Key field first.');
  if (!voiceId) throw new Error('Select an ElevenLabs voice for this speaker.');

  const endpoint = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`;
  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0
    }
  };

  await awaitRequestSlot();
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const ctx = getDecodeContext();
  return await ctx.decodeAudioData(arrayBuf);
}

function loadPreset(key) {
  if (PRESETS[key]) {
    document.getElementById('conversationInput').value = PRESETS[key];
    parseAndRenderSpeakers();
  }
}

function parseScript(text) {
  if (isSingleVoiceMode()) {
    const trimmed = text.trim();
    return trimmed ? [{ speaker: 'Narrator', direction: '', text: trimmed }] : [];
  }
  const lines = text.split('\n');
  const turns = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^\[?([\p{L}0-9_.'\s]+?)(?:\s*\((.*?)\))?\]?[:-]\s*(.*)$/u);
    if (match) {
      turns.push({ speaker: match[1].trim(), direction: match[2] || '', text: match[3].trim() });
    } else {
      if (turns.length > 0) turns[turns.length - 1].text += ' ' + line;
      else turns.push({ speaker: 'Narrator', direction: '', text: line });
    }
  }
  return turns;
}

function parseAndRenderSpeakers() {
  const text = document.getElementById('conversationInput').value;
  const turns = parseScript(text);
  const uniqueSpeakers = [...new Set(turns.map(t => t.speaker))];

  const chipsContainer = document.getElementById('speakerChips');
  chipsContainer.innerHTML = '';
  uniqueSpeakers.forEach((spk, idx) => {
    const color = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
    const chip = document.createElement('div');
    chip.className = 'speaker-badge';
    chip.innerHTML = `<span class="speaker-dot" style="background:${color}"></span> ${escapeHtml(spk)}`;
    chipsContainer.appendChild(chip);
  });

  uniqueSpeakers.forEach((spk, idx) => {
    if (!speakerMap[spk]) {
      speakerMap[spk] = {
        voiceId: availableVoices.length ? availableVoices[idx % availableVoices.length].id : '',
        pitch: 1.0,
        rate: 1.0,
        color: SPEAKER_COLORS[idx % SPEAKER_COLORS.length]
      };
    }
  });
  refreshSpeakerPersonas(uniqueSpeakers);
}

function refreshSpeakerPersonas(speakerList) {
  if (!speakerList) {
    const turns = parseScript(document.getElementById('conversationInput').value);
    speakerList = [...new Set(turns.map(t => t.speaker))];
  }
  const container = document.getElementById('speakersContainer');
  container.innerHTML = '';
  if (speakerList.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim); font-size:0.85rem;">Type dialogue above to assign voices (e.g. Alice: Hello).</div>';
    return;
  }
  if (availableVoices.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim); font-size:0.85rem;">Enter your ElevenLabs API key to load voices.</div>';
    return;
  }
  speakerList.forEach((spk, idx) => {
    const defaultVoiceId = availableVoices[idx % availableVoices.length].id;
    const config = speakerMap[spk] || { voiceId: defaultVoiceId, pitch: 1.0, rate: 1.0, color: SPEAKER_COLORS[idx % SPEAKER_COLORS.length] };
    const card = document.createElement('div');
    card.className = 'speaker-card';

    const voiceOptionsHtml = availableVoices.map((v) => {
      const selected = v.id === (config.voiceId || '') ? 'selected' : '';
      return `<option value="${escapeHtml(v.id)}" ${selected}>${escapeHtml(v.name)}</option>`;
    }).join('');

    card.innerHTML = `
      <div class="speaker-top-row">
        <div class="speaker-name"><span class="speaker-dot" style="background:${config.color}"></span>${escapeHtml(spk)}</div>
        <button class="btn btn-outline btn-sm" onclick="testSpeakerVoice('${escapeHtml(spk)}')">🔊 Test Voice</button>
      </div>
      <div class="controls-grid">
        <div><select onchange="updateSpeakerVoice('${escapeHtml(spk)}', this.value)">${voiceOptionsHtml}</select></div>
        <div class="slider-group">
          <div class="slider-label"><span>Pitch</span><span id="pitchVal_${idx}">${config.pitch.toFixed(1)}x</span></div>
          <input type="range" min="0.5" max="1.8" step="0.1" value="${config.pitch}" oninput="updateSpeakerPitch('${escapeHtml(spk)}', this.value, ${idx})">
        </div>
        <div class="slider-group">
          <div class="slider-label"><span>Speed</span><span id="rateVal_${idx}">${config.rate.toFixed(1)}x</span></div>
          <input type="range" min="0.6" max="1.6" step="0.1" value="${config.rate}" oninput="updateSpeakerRate('${escapeHtml(spk)}', this.value, ${idx})">
        </div>
      </div>`;
    container.appendChild(card);
  });
}

function updateSpeakerVoice(spk, voiceId) { if (speakerMap[spk]) speakerMap[spk].voiceId = voiceId; }
function updateSpeakerPitch(spk, val, idx) {
  const num = parseFloat(val);
  if (speakerMap[spk]) speakerMap[spk].pitch = num;
  const el = document.getElementById(`pitchVal_${idx}`);
  if (el) el.innerText = num.toFixed(1) + 'x';
}
function updateSpeakerRate(spk, val, idx) {
  const num = parseFloat(val);
  if (speakerMap[spk]) speakerMap[spk].rate = num;
  const el = document.getElementById(`rateVal_${idx}`);
  if (el) el.innerText = num.toFixed(1) + 'x';
}

function populateSingleVoiceSelect() {
  const select = document.getElementById('singleVoiceSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = availableVoices.map(v =>
    `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`
  ).join('');
  if (current && availableVoices.some(v => v.id === current)) {
    select.value = current;
  } else if (availableVoices.length) {
    select.value = availableVoices[0].id;
  }
}

function isSingleVoiceMode() {
  const cb = document.getElementById('singleVoiceMode');
  return !!(cb && cb.checked);
}

function toggleSingleVoiceMode() {
  const cb = document.getElementById('singleVoiceMode');
  const select = document.getElementById('singleVoiceSelect');
  if (select) select.disabled = !(cb && cb.checked);
  parseAndRenderSpeakers();
}

function resolveVoiceId(turn) {
  if (isSingleVoiceMode()) {
    const select = document.getElementById('singleVoiceSelect');
    const single = select && select.value;
    if (single) return single;
  }
  const defaultVoiceId = availableVoices[0] && availableVoices[0].id;
  const config = speakerMap[turn.speaker] || { voiceId: defaultVoiceId, pitch: 1.0, rate: 1.0 };
  return config.voiceId || defaultVoiceId;
}

async function testSpeakerVoice(spk) {
  const defaultVoiceId = availableVoices[0] && availableVoices[0].id;
  const config = speakerMap[spk] || { voiceId: defaultVoiceId, pitch: 1.0, rate: 1.0 };
  const voiceId = config.voiceId || defaultVoiceId;
  setStatus('loading', `Testing ${spk}'s voice...`);
  try {
    const buffer = await synthesizeSpeech(`Hi there! This is ${spk}'s configured voice.`, voiceId);
    await playBuffer(buffer, config.rate);
    setStatus('success', 'Voice test finished.');
  } catch (err) {
    setStatus('error', err.message);
  }
}

function setupVisualizer() {
  const canvas = document.getElementById('visualizer');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio || 600;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio || 140;

  function renderFrame() {
    requestAnimationFrame(renderFrame);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const width = canvas.width;
    const height = canvas.height;
    const barCount = 48;
    const barWidth = (width / barCount) - 3;

    for (let i = 0; i < barCount; i++) {
      const barHeight = isPlayingPreview
        ? (Math.sin(Date.now() / 150 + i * 0.3) * 0.5 + 0.5) * (height * 0.8) + 4
        : 4;
      const x = i * (barWidth + 3);
      const y = (height - barHeight) / 2;
      const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
      grad.addColorStop(0, '#6366F1');
      grad.addColorStop(1, '#10B981');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 3);
      ctx.fill();
    }
  }
  renderFrame();
}

function toggleLivePreview() {
  if (isPlayingPreview) stopLivePreview();
  else startLivePreview();
}

function stopLivePreview() {
  isPlayingPreview = false;
  if (activeSource) {
    try { activeSource.stop(); } catch (e) {}
    activeSource = null;
  }
  document.getElementById('playIcon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
  document.getElementById('playBtnText').innerText = 'Preview Live Conversation';
  setStatus('muted', 'Playback stopped.');
  document.querySelectorAll('.line-item').forEach(el => el.classList.remove('active'));
}

async function startLivePreview() {
  const ctx = getDecodeContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const text = document.getElementById('conversationInput').value;
  const turns = parseScript(text);
  if (turns.length === 0) return alert('Please write conversation text first.');

  isPlayingPreview = true;
  currentPreviewIndex = 0;
  document.getElementById('playIcon').innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
  document.getElementById('playBtnText').innerText = 'Pause Preview';
  setStatus('loading', 'Playing dialogue preview with ElevenLabs voices...');

  const box = document.getElementById('dialogueDisplay');
  box.innerHTML = '';
  turns.forEach((turn, idx) => {
    const line = document.createElement('div');
    line.id = `line_${idx}`;
    line.className = 'line-item';
    const color = (speakerMap[turn.speaker] && speakerMap[turn.speaker].color) || '#38BDF8';
    line.innerHTML = `<span class="line-speaker" style="color:${color}">${escapeHtml(turn.speaker)}:</span><span>${escapeHtml(turn.text)}</span>`;
    box.appendChild(line);
  });
  playNextPreviewTurn(turns);
}

async function playNextPreviewTurn(turns) {
  if (!isPlayingPreview || currentPreviewIndex >= turns.length) {
    stopLivePreview();
    setStatus('success', 'Preview completed!');
    return;
  }
  const turn = turns[currentPreviewIndex];
  const lineEl = document.getElementById(`line_${currentPreviewIndex}`);
  document.querySelectorAll('.line-item').forEach(el => el.classList.remove('active'));
  if (lineEl) {
    lineEl.classList.add('active');
    lineEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const defaultVoiceId = availableVoices[0] && availableVoices[0].id;
  const config = speakerMap[turn.speaker] || { voiceId: defaultVoiceId, pitch: 1.0, rate: 1.0 };
  const voiceId = resolveVoiceId(turn);

  try {
    const buffer = await synthesizeSpeech(turn.text, voiceId);
    if (!isPlayingPreview) return;
    await playBuffer(buffer, config.rate);
    currentPreviewIndex++;
    const pauseMs = parseFloat(document.getElementById('pauseDuration').value) * 1000;
    await new Promise(r => setTimeout(r, pauseMs));
    if (isPlayingPreview) playNextPreviewTurn(turns);
  } catch (err) {
    if (!isPlayingPreview) return;
    stopLivePreview();
    setStatus('error', err.message);
  }
}

function playBuffer(buffer, rate) {
  return new Promise((resolve, reject) => {
    const ctx = getDecodeContext();
    const start = () => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate || 1.0;
      src.connect(ctx.destination);
      activeSource = src;
      src.onended = () => {
        if (activeSource === src) activeSource = null;
        resolve();
      };
      src.start();
    };
    if (ctx.state === 'suspended') ctx.resume().then(start).catch(reject);
    else start();
  });
}

async function renderAndDownloadAudio() {
  const text = document.getElementById('conversationInput').value;
  const turns = parseScript(text);
  if (turns.length === 0) return alert('Please enter a conversation script to export.');

  const progressContainer = document.getElementById('progressBarContainer');
  const progressBar = document.getElementById('progressBarFill');

  try {
    if (!getApiKey()) throw new Error('Enter your ElevenLabs API key in the API Key field first.');

    progressContainer.style.display = 'block';
    progressBar.style.width = '10%';
    setStatus('loading', 'Synthesizing speech with ElevenLabs TTS...');

    const pauseSec = parseFloat(document.getElementById('pauseDuration').value) || 0.5;
    const bgmType = document.getElementById('bgmSelect').value;
    const bgmVol = parseFloat(document.getElementById('bgmVolume').value) || 0.1;
    const hasIntro = document.getElementById('introChime').checked;

    const rendered = [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const defaultVoiceId = availableVoices[0] && availableVoices[0].id;
      const config = speakerMap[turn.speaker] || { voiceId: defaultVoiceId, pitch: 1.0, rate: 1.0 };
      const voiceId = resolveVoiceId(turn);
      setStatus('loading', `Synthesizing line ${i + 1}/${turns.length} (${turn.speaker})...`);
      const buffer = await synthesizeSpeech(turn.text, voiceId);
      rendered.push({ buffer, config });
      progressBar.style.width = Math.round(10 + (i / turns.length) * 60) + '%';
    }

    let totalDuration = hasIntro ? 2.0 : 0.5;
    rendered.forEach(({ buffer, config }) => {
      totalDuration += buffer.duration / (config.rate || 1.0) + pauseSec;
    });
    totalDuration += 3.0;

    const sampleRate = 44100;
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      2, Math.ceil(sampleRate * totalDuration), sampleRate
    );

    let currentTime = hasIntro ? 1.5 : 0.5;
    if (hasIntro) {
      renderChime(offlineCtx, 0.2, 523.25);
      renderChime(offlineCtx, 0.5, 659.25);
      renderChime(offlineCtx, 0.8, 783.99);
      renderChime(offlineCtx, 1.1, 1046.50);
    }

    rendered.forEach(({ buffer, config }) => {
      const src = offlineCtx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = config.rate || 1.0;
      src.connect(offlineCtx.destination);
      src.start(currentTime);
      currentTime += buffer.duration / (config.rate || 1.0) + pauseSec;
    });

    if (bgmType !== 'none') {
      renderBackgroundMusic(offlineCtx, bgmType, 0, currentTime + 1.0, bgmVol);
    }

    if (document.getElementById('outroChime').checked) {
      renderChime(offlineCtx, currentTime + 0.2, 783.99);
      renderChime(offlineCtx, currentTime + 0.6, 523.25);
    }

    progressBar.style.width = '90%';
    setStatus('loading', 'Mixing and mastering audio...');
    const renderedBuffer = await offlineCtx.startRendering();

    const wavBlob = audioBufferToWav(renderedBuffer);
    renderedAudioBlob = wavBlob;
    renderedAudioUrl = URL.createObjectURL(wavBlob);

    const mp3Blob = audioBufferToMp3(renderedBuffer, 128);
    renderedAudioMp3Blob = mp3Blob;
    renderedAudioMp3Url = URL.createObjectURL(mp3Blob);

    progressBar.style.width = '100%';
    setStatus('success', 'Conversation audio generated successfully!');

    const audioSection = document.getElementById('renderedAudioSection');
    const finalAudioPlayer = document.getElementById('finalAudioPlayer');
    finalAudioPlayer.src = renderedAudioMp3Url;
    audioSection.style.display = 'flex';

    downloadMasterMp3();
  } catch (err) {
    setStatus('error', `Generation error: ${err.message}`);
    progressContainer.style.display = 'none';
  }
}

function renderChime(ctx, startTime, freq) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.2);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + 1.2);
}

function renderBackgroundMusic(ctx, type, startTime, totalDuration, volume) {
  const chords = [ [261.63, 329.63, 392.00, 493.88], [220.00, 261.63, 329.63, 392.00] ];
  const chordDuration = 4.0;
  let cur = startTime;
  let cIdx = 0;

  while (cur < totalDuration) {
    chords[cIdx % chords.length].forEach(noteFreq => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(noteFreq, cur);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, cur);

      gain.gain.setValueAtTime(0.0001, cur);
      gain.gain.linearRampToValueAtTime(volume * 0.35, cur + 0.8);
      gain.gain.linearRampToValueAtTime(volume * 0.35, cur + chordDuration - 0.8);
      gain.gain.linearRampToValueAtTime(0.0001, cur + chordDuration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(cur);
      osc.stop(cur + chordDuration);
    });
    cur += chordDuration;
    cIdx++;
  }
}

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const dataByteCount = buffer.length * numChannels * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataByteCount);
  const view = new DataView(arrayBuffer);

  function writeString(v, o, s) { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteCount, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataByteCount, true);

  const channels = [];
  for (let i = 0; i < numChannels; i++) channels.push(buffer.getChannelData(i));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function downloadMasterMp3() {
  if (!renderedAudioMp3Blob) return;
  const url = URL.createObjectURL(renderedAudioMp3Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation_audio_${Date.now()}.mp3`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 100);
}

function audioBufferToMp3(buffer, bitRate) {
  const sampleRate = buffer.sampleRate;
  const encoder = new lamejs.Mp3Encoder(2, sampleRate, bitRate || 128);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const blockSize = 1152;
  const chunks = [];

  for (let i = 0; i < left.length; i += blockSize) {
    const l = new Int16Array(blockSize);
    const r = new Int16Array(blockSize);
    for (let j = 0; j < blockSize; j++) {
      const idx = i + j;
      if (idx < left.length) {
        l[j] = floatTo16Bit(left[idx]);
        r[j] = floatTo16Bit(right[idx]);
      }
    }
    const mp3buf = encoder.encodeBuffer(l, r);
    if (mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
  }
  const end = encoder.flush();
  if (end.length > 0) chunks.push(new Uint8Array(end));

  return new Blob(chunks, { type: 'audio/mpeg' });
}

function floatTo16Bit(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
}

function downloadMasterWav() {
  if (!renderedAudioBlob) return;
  const url = URL.createObjectURL(renderedAudioBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation_audio_${Date.now()}.wav`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 100);
}

function downloadSubtitlesSRT() {
  const text = document.getElementById('conversationInput').value;
  const turns = parseScript(text);
  const pauseSec = parseFloat(document.getElementById('pauseDuration').value) || 0.5;
  let curSec = 1.5;
  let srtContent = '';

  turns.forEach((turn, idx) => {
    const wordCount = turn.text.split(/\s+/).length;
    const rate = (speakerMap[turn.speaker] && speakerMap[turn.speaker].rate) || 1.0;
    const dur = Math.max(1.5, (wordCount / 2.6) / rate);
    srtContent += `${idx + 1}\n${formatSrtTime(curSec)} --> ${formatSrtTime(curSec + dur)}\n${turn.speaker}: ${turn.text}\n\n`;
    curSec += dur + pauseSec;
  });

  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation_subtitles_${Date.now()}.srt`;
  a.click();
}

function formatSrtTime(totalSec) {
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = Math.floor(totalSec % 60);
  const ms = Math.floor((totalSec % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeHtml(str) {
  const amp = String.fromCharCode(38);
  return String(str)
    .replace(/&/g, amp + 'amp;')
    .replace(/</g, amp + 'lt;')
    .replace(/>/g, amp + 'gt;')
    .replace(/"/g, amp + 'quot;')
    .replace(/'/g, amp + '#039;');
}

document.getElementById('conversationInput').addEventListener('input', () => { parseAndRenderSpeakers(); });
window.addEventListener('DOMContentLoaded', () => {
  loadApiKey();
  loadPreset('interview');
  setupVisualizer();
  toggleSingleVoiceMode();
  loadAvailableVoices();
});
