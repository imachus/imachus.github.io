// Global Variables
let audioContext;
let mediaRecorder;
let audioChunks = [];
let source;
let analyser;
let requestAnimationId;
let recordingTimeout;
let modelBuffer = null;
let userBuffer = null;
let currentStream = null;

// Playback State
let modelPlayState = {
    source: null,
    startTime: 0,
    pauseTime: 0,
    isPlaying: false
};
let userPlayState = {
    source: null,
    startTime: 0,
    pauseTime: 0,
    isPlaying: false
};

// DOM Elements
const btnRecordModel = document.getElementById('btn-record-model');
const btnStopModel = document.getElementById('btn-stop-model');
const btnPlayModel = document.getElementById('btn-play-model');
const btnPauseModel = document.getElementById('btn-pause-model');
const btnSaveModel = document.getElementById('btn-save-model');
const btnRecordUser = document.getElementById('btn-record-user');
const btnStopUser = document.getElementById('btn-stop-user');
const btnPlayUser = document.getElementById('btn-play-user');
const btnPauseUser = document.getElementById('btn-pause-user');
const fileUploadModel = document.getElementById('file-upload-model');
const canvasModel = document.getElementById('canvas-model');
const canvasUser = document.getElementById('canvas-user');
const canvasResult = document.getElementById('canvas-result');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Canvas sizing
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Event Listeners
    btnRecordModel.addEventListener('click', () => startRecording('model'));
    btnStopModel.addEventListener('click', () => stopRecording('model'));
    btnPlayModel.addEventListener('click', () => playRecording('model'));
    btnPauseModel.addEventListener('click', () => pausePlayback('model'));
    btnSaveModel.addEventListener('click', () => saveModelMp3());
    fileUploadModel.addEventListener('change', handleFileUpload);

    btnRecordUser.addEventListener('click', () => startRecording('user'));
    btnStopUser.addEventListener('click', () => stopRecording('user'));
    btnPlayUser.addEventListener('click', () => playRecording('user'));
    btnPauseUser.addEventListener('click', () => pausePlayback('user'));
});

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        await initAudioContext();
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        modelBuffer = audioBuffer;
        console.log("Model loaded from file:", modelBuffer);

        btnPlayModel.disabled = false;
        btnPauseModel.disabled = true;
        btnSaveModel.disabled = true; // Disable save for uploaded files (optional, but logical since it's already a file)

        document.getElementById('status-model').textContent = `ファイル読み込み完了: ${file.name}`;

        // Visualize the loaded audio (static visualization)
        drawStaticVisualizer('canvas-model', modelBuffer);

    } catch (err) {
        console.error("Error loading file:", err);
        alert("ファイルの読み込みまたはデコードに失敗しました。");
    }
}

function drawStaticVisualizer(canvasId, buffer) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.beginPath();
    ctx.strokeStyle = '#c5a059';
    ctx.lineWidth = 1;

    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[i * step + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        ctx.moveTo(i, (1 + min) * amp);
        ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();
}

function resizeCanvas() {
    canvasModel.width = canvasModel.parentElement.clientWidth;
    canvasModel.height = canvasModel.parentElement.clientHeight;
    canvasUser.width = canvasUser.parentElement.clientWidth;
    canvasUser.height = canvasUser.parentElement.clientHeight;
    if (canvasResult) {
        canvasResult.width = canvasResult.parentElement.clientWidth;
        canvasResult.height = canvasResult.parentElement.clientHeight;
    }
}

async function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
}

// Playback Functions
async function playRecording(type) {
    const buffer = type === 'model' ? modelBuffer : userBuffer;
    const state = type === 'model' ? modelPlayState : userPlayState;
    const btnPlay = type === 'model' ? btnPlayModel : btnPlayUser;
    const btnPause = type === 'model' ? btnPauseModel : btnPauseUser;

    if (!buffer) return;

    // Ensure context is ready
    await initAudioContext();

    // Prevent overlapping if already specifically playing
    if (state.isPlaying) {
        return;
    }

    // Create Source
    state.source = audioContext.createBufferSource();
    state.source.buffer = buffer;
    state.source.connect(audioContext.destination);

    // Calculate offset
    // Ensure offset doesn't exceed duration
    let offset = state.pauseTime;
    if (offset >= buffer.duration) {
        offset = 0;
        state.pauseTime = 0;
    }

    // cleanup on end
    state.source.onended = () => {
        state.isPlaying = false;
        state.pauseTime = 0; // Reset to beginning on natural end
        btnPlay.disabled = false;
        btnPause.disabled = true;
    };

    // Start
    state.source.start(0, offset);
    state.startTime = audioContext.currentTime - offset;
    state.isPlaying = true;

    // UI Update
    btnPlay.disabled = true;
    btnPause.disabled = false;
}

function pausePlayback(type) {
    const state = type === 'model' ? modelPlayState : userPlayState;
    const btnPlay = type === 'model' ? btnPlayModel : btnPlayUser;
    const btnPause = type === 'model' ? btnPauseModel : btnPauseUser;

    if (!state.isPlaying || !state.source) return;

    // Prevent onended from triggering reset logic (which clears pauseTime)
    state.source.onended = null;

    // Stop source
    try {
        state.source.stop();
    } catch (e) {
        console.warn("Stop called on invalid source", e);
    }

    state.isPlaying = false;

    // Calculate new pauseTime
    state.pauseTime = audioContext.currentTime - state.startTime;

    // UI
    btnPlay.disabled = false;
    btnPause.disabled = true;
}

function stopPlaybackFull(type) {
    // Helper to fully stop and reset (used when starting recording etc)
    const state = type === 'model' ? modelPlayState : userPlayState;
    const btnPlay = type === 'model' ? btnPlayModel : btnPlayUser;
    const btnPause = type === 'model' ? btnPauseModel : btnPauseUser;

    if (state.source) {
        // Prevent side effects
        state.source.onended = null;
        try { state.source.stop(); } catch (e) { }
    }
    state.isPlaying = false;
    state.pauseTime = 0;

    // Reset buttons if they exist (might be called before init)
    if (btnPlay) btnPlay.disabled = false;
    if (btnPause) btnPause.disabled = true;
}

async function startRecording(type) {
    try {
        await initAudioContext();

        // Get user media
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        currentStream = stream;

        // Setup Audio Node Graph for Visualization
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        // Start Visualizer
        const canvasId = type === 'model' ? 'canvas-model' : 'canvas-user';
        drawRecordingVisualizer(canvasId);

        // Setup MediaRecorder
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.addEventListener("dataavailable", event => {
            audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener("stop", async () => {
            // Clear timeout if it exists
            if (recordingTimeout) {
                clearTimeout(recordingTimeout);
                recordingTimeout = null;
            }

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            if (type === 'model') {
                modelBuffer = audioBuffer;
                console.log("Model recorded:", modelBuffer);
                btnPlayModel.disabled = false;
                btnPauseModel.disabled = true;
                btnSaveModel.disabled = false;
            } else {
                userBuffer = audioBuffer;
                console.log("User recorded:", userBuffer);
                btnPlayUser.disabled = false;
                btnPauseUser.disabled = true;
                // Trigger comparison immediately if model exists
                if (modelBuffer) {
                    calculateScore();
                }
            }

            // Clean up stream and animation
            stopStream(currentStream);
            cancelAnimationFrame(requestAnimationId);
            currentStream = null;
        });

        mediaRecorder.start();
        updateUIState(type, true);

        // Set 180s timeout (maximum recording duration)
        recordingTimeout = setTimeout(() => {
            console.log("Max recording duration reached (180s)");
            stopRecording(type);
            alert("録音時間の制限（180秒）に達したため停止しました。");
        }, 180000);

    } catch (err) {
        console.error("Error accessing microphone:", err);
        alert("マイクへのアクセスが許可されていません。設定を確認してください。");
    }
}

function stopRecording(type) {
    if (recordingTimeout) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        updateUIState(type, false);
    }
}



function stopStream(stream) {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
}

function updateUIState(type, isRecording) {
    // Stop any playback first
    stopPlaybackFull(type);

    if (type === 'model') {
        btnRecordModel.disabled = isRecording;
        btnStopModel.disabled = !isRecording;
        document.getElementById('status-model').textContent = isRecording ? "録音中..." : "待機中";

        if (isRecording) {
            btnPlayModel.disabled = true;
            btnPauseModel.disabled = true;
            btnSaveModel.disabled = true;
            fileUploadModel.disabled = true;
        }

        // Disable other section while recording
        btnRecordUser.disabled = isRecording;
    } else {
        btnRecordUser.disabled = isRecording;
        btnStopUser.disabled = !isRecording;
        document.getElementById('status-user').textContent = isRecording ? "比較録音中..." : "待機中";

        if (isRecording) {
            btnPlayUser.disabled = true;
            btnPauseUser.disabled = true;
        }

        // Disable other section while recording
        btnRecordModel.disabled = isRecording;
    }
}

function drawRecordingVisualizer(canvasId) {
    const canvas = document.getElementById(canvasId);
    const canvasCtx = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
        requestAnimationId = requestAnimationFrame(draw);

        analyser.getByteTimeDomainData(dataArray);

        canvasCtx.fillStyle = '#000';
        canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = '#c5a059'; // Gold color matching CSS
        canvasCtx.beginPath();

        const sliceWidth = canvas.width * 1.0 / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * canvas.height / 2;

            if (i === 0) {
                canvasCtx.moveTo(x, y);
            } else {
                canvasCtx.lineTo(x, y);
            }

            x += sliceWidth;
        }

        canvasCtx.lineTo(canvas.width, canvas.height / 2);
        canvasCtx.stroke();
    };

    draw();
}

// --- Audio Processing & Visualization ---

const WINDOW_SIZE = 4096;

function calculateScore() {
    console.log("Calculating score...");
    const scoreElement = document.getElementById('score-value');
    scoreElement.textContent = "計算中...";

    // Run in a slight timeout to allow UI update
    setTimeout(() => {
        if (!modelBuffer || !userBuffer) {
            scoreElement.textContent = "--";
            return;
        }

        const modelPitches = extractPitchSequence(modelBuffer);
        const userPitches = extractPitchSequence(userBuffer);

        console.log("Model Pitches:", modelPitches);
        console.log("User Pitches:", userPitches);

        const score = compareSequences(modelPitches, userPitches);

        // Visualize Results
        drawComparisonResult(modelPitches, userPitches);

        // Animate score
        let currentScore = 0;
        const animation = setInterval(() => {
            currentScore += 1;
            if (currentScore >= score) {
                currentScore = score;
                clearInterval(animation);
            }
            scoreElement.textContent = Math.floor(currentScore);
        }, 20);

    }, 100);
}

function saveModelMp3() {
    console.log("Starting MP3 conversion...");
    if (!modelBuffer) {
        console.error("No model buffer to save.");
        alert("保存する録音データがありません。");
        return;
    }

    // Check for lamejs
    const lame = window.lamejs;
    if (!lame) {
        console.error("lamejs not found in window.");
        alert("MP3エンコーダーライブラリ(lamejs)が読み込まれていません。ページを再読み込みしてください。");
        return;
    }

    try {
        const mp3Data = [];
        const sampleRate = modelBuffer.sampleRate;
        const channels = 1; // Force mono
        const kbps = 128;

        console.log(`Encoding: ${sampleRate}Hz, ${channels}ch, ${kbps}kbps`);

        const wavEncoder = new lame.Mp3Encoder(channels, sampleRate, kbps);
        const samples = modelBuffer.getChannelData(0);
        const sampleBlockSize = 1152;

        // Convert Float32 to Int16
        const int16Samples = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            // Clamp and scale
            let s = Math.max(-1, Math.min(1, samples[i]));
            int16Samples[i] = s * (s < 0 ? 0x8000 : 0x7FFF);
        }

        console.log(`Converted ${samples.length} samples to Int16.`);

        for (let i = 0; i < int16Samples.length; i += sampleBlockSize) {
            const sampleChunk = int16Samples.subarray(i, i + sampleBlockSize);
            const mp3buf = wavEncoder.encodeBuffer(sampleChunk);
            if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
            }
        }

        const mp3buf = wavEncoder.flush();
        if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
        }

        console.log("Encoding complete. Creating Blob...");

        const blob = new Blob(mp3Data, { type: 'audio/mp3' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `gagaku_model_${timestamp}.mp3`;
        document.body.appendChild(a);
        a.click();

        // Cleanup
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);

        console.log("Download triggered.");

    } catch (e) {
        console.error("MP3 Encoding failed:", e);
        alert(`MP3保存中にエラーが発生しました: ${e.message}`);
    }
}

function extractPitchSequence(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const pitches = [];
    const step = WINDOW_SIZE;

    for (let i = 0; i < channelData.length - WINDOW_SIZE; i += step) {
        const slice = channelData.slice(i, i + WINDOW_SIZE);
        const pitch = autoCorrelate(slice, sampleRate);
        pitches.push(pitch);
    }

    return pitches;
}

function autoCorrelate(buffer, sampleRate) {
    const size = buffer.length;
    let sumOfSquares = 0;
    for (let i = 0; i < size; i++) {
        const val = buffer[i];
        sumOfSquares += val * val;
    }

    const rms = Math.sqrt(sumOfSquares / size);
    if (rms < 0.01) { // Silence threshold
        return -1;
    }

    const minPeriod = Math.floor(sampleRate / 1500);
    const maxPeriod = Math.floor(sampleRate / 50);

    let bestPeriod = -1;
    let maxCorrelation = 0;

    for (let lag = minPeriod; lag <= maxPeriod; lag++) {
        let correlation = 0;
        for (let i = 0; i < size - lag; i++) {
            correlation += buffer[i] * buffer[i + lag];
        }

        if (correlation > maxCorrelation) {
            maxCorrelation = correlation;
            bestPeriod = lag;
        }
    }

    if (maxCorrelation > 0.2 * sumOfSquares) {
        return sampleRate / bestPeriod;
    }

    return -1;
}

function compareSequences(modelPitches, userPitches) {
    const mTrim = trimSilence(modelPitches);
    const uTrim = trimSilence(userPitches);

    if (mTrim.length === 0 || uTrim.length === 0) return 0;

    // Use start-aligned stretching for scoring? 
    // For now we assume the user tries to match the duration roughly.
    // The visualization will warp the user to match model for display.
    const stretchedUser = stretchArray(uTrim, mTrim.length);

    let matchCount = 0;
    let validFrames = 0;

    for (let i = 0; i < mTrim.length; i++) {
        const fRef = mTrim[i];
        const fInput = stretchedUser[i];

        if (fRef === -1 && fInput === -1) continue;

        if (fRef !== -1 && fInput !== -1) {
            validFrames++;
            const semitones = 12 * Math.log2(fInput / fRef);
            if (Math.abs(semitones) < 1.0) {
                matchCount++;
            }
        }
    }

    if (validFrames === 0) return 0;

    const percentage = (matchCount / validFrames) * 100;
    return Math.min(100, Math.max(0, percentage));
}

function drawComparisonResult(modelPitches, userPitches) {
    const canvas = document.getElementById('canvas-result');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = '#1a1a2e'; // Dark blue bg
    ctx.fillRect(0, 0, width, height);

    const mTrim = trimSilence(modelPitches);
    const uTrim = trimSilence(userPitches);

    if (mTrim.length === 0) return;

    // Stretch user to match model length for visualization overlay
    const stretchedUser = stretchArray(uTrim, mTrim.length);

    // Find min and max frequencies to scale Y axis
    let minF = Infinity;
    let maxF = 0;

    const validPitches = [...mTrim, ...stretchedUser].filter(p => p !== -1);
    if (validPitches.length === 0) return;

    minF = Math.min(...validPitches);
    maxF = Math.max(...validPitches);

    // Add padding
    minF *= 0.8;
    maxF *= 1.2;

    const getX = (i) => (i / (mTrim.length - 1)) * width;
    const getY = (freq) => height - ((freq - minF) / (maxF - minF)) * height;

    // Draw Model (Gold)
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#c5a059';
    ctx.beginPath();
    let isDrawing = false;

    for (let i = 0; i < mTrim.length; i++) {
        const freq = mTrim[i];
        if (freq === -1) {
            isDrawing = false;
        } else {
            const x = getX(i);
            const y = getY(freq);
            if (!isDrawing) {
                ctx.moveTo(x, y);
                isDrawing = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    ctx.stroke();

    // Draw User (Red)
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#b33e30';
    ctx.beginPath();
    isDrawing = false;

    for (let i = 0; i < stretchedUser.length; i++) {
        const freq = stretchedUser[i];
        if (freq === -1) {
            isDrawing = false;
        } else {
            const x = getX(i);
            const y = getY(freq);
            if (!isDrawing) {
                ctx.moveTo(x, y);
                isDrawing = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
    }
    ctx.stroke();
}

function trimSilence(pitches) {
    let start = 0;
    let end = pitches.length - 1;

    while (start < pitches.length && pitches[start] === -1) start++;
    while (end >= 0 && pitches[end] === -1) end--;

    if (start > end) return [];
    return pitches.slice(start, end + 1);
}

function stretchArray(arr, targetLength) {
    if (arr.length === 0) return [];
    if (arr.length === targetLength) return arr;

    const newArr = [];
    const factor = (arr.length - 1) / (targetLength - 1);

    for (let i = 0; i < targetLength; i++) {
        const index = i * factor;
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;

        const valLower = arr[lower];
        const valUpper = arr[upper];

        if (valLower === -1 || valUpper === -1) {
            newArr.push(weight < 0.5 ? valLower : valUpper);
        } else {
            newArr.push(valLower * (1 - weight) + valUpper * weight);
        }
    }
    return newArr;
}
