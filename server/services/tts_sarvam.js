const nodeFetch = require("node-fetch");
const { WaveFile } = require('wavefile');

async function sarvamTTS(text, options = {}) {
    try {
        const apiKey = process.env.SARVAM_API_KEY;

        if (!apiKey) {
            throw new Error("SARVAM_API_KEY not configured in environment variables");
        }

        // Default options from environment or fallback values
        const language = options.language || process.env.SARVAM_TTS_LANGUAGE || "en-IN";
        const speaker = options.speaker || process.env.SARVAM_TTS_SPEAKER || "anushka";
        const format = options.format || process.env.SARVAM_TTS_FORMAT || "mp3";

        console.log(`[TTS] Using provider: Sarvam`);
        console.log(`[TTS] Sending request...`);
        console.log(`   Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        console.log(`   Language: ${language}`);
        console.log(`   Speaker: ${speaker}`);
        console.log(`   Format: ${format}`);

        const response = await nodeFetch(
            "https://api.sarvam.ai/text-to-speech",
            {
                method: "POST",
                headers: {
                    "api-subscription-key": apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: [text],
                    target_language_code: language,
                    speaker: speaker,
                    model: "bulbul:v2",
                    enable_preprocessing: true
                }),
            }
        );


        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[TTS] Sarvam API error: ${response.status} - ${response.statusText}`);
            console.error(`[TTS] Error details: ${errorText}`);
            throw new Error(`Sarvam API error: ${response.status} - ${response.statusText}`);
        }

        // Sarvam returns JSON with base64 audio
        const jsonResponse = await response.json();
        console.log(`[TTS] Response received from Sarvam`);

        // Extract base64 audio from response
        const base64Audio = jsonResponse.audios && jsonResponse.audios[0];
        if (!base64Audio) {
            throw new Error('No audio data in Sarvam response');
        }

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        console.log(`[TTS] Audio received: ${audioBuffer.length} bytes`);

        // Check actual audio format by inspecting magic numbers
        const actualFormat = detectAudioFormat(audioBuffer);
        console.log(`[TTS] Detected audio format: ${actualFormat} (requested: ${format})`);

        // Convert to ulaw_8000 format for Twilio compatibility
        // If skipConversion is true, return the original buffer (e.g. for web frontend)
        if (options.skipConversion) {
            console.log(`[TTS] Skipping conversion, returning ${format}`);
            return audioBuffer;
        }

        const ulawBuffer = await convertToUlaw(audioBuffer, actualFormat);

        console.log(`[TTS] Converted to ulaw_8000: ${ulawBuffer.length} bytes`);
        return ulawBuffer;

    } catch (error) {
        console.error("[TTS] Error in Sarvam TTS:", error.message);

        // Provide specific error messages for common issues
        if (error.message.includes("SARVAM_API_KEY")) {
            throw new Error("Sarvam API key is missing. Please set SARVAM_API_KEY in your environment variables.");
        } else if (error.message.includes("ENOTFOUND") || error.message.includes("ETIMEDOUT")) {
            throw new Error("Network error: Unable to reach Sarvam API. Please check your internet connection.");
        } else if (error.message.includes("401")) {
            throw new Error("Authentication failed: Invalid Sarvam API key.");
        } else if (error.message.includes("429")) {
            throw new Error("Rate limit exceeded: Too many requests to Sarvam API.");
        }

        throw error;
    }
}

function detectAudioFormat(buffer) {
    if (buffer.length < 4) return 'unknown';

    // Check for MP3 (ID3 tag or MPEG frame sync)
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
        return 'mp3'; // ID3v2 tag
    }
    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
        return 'mp3'; // MPEG frame sync
    }

    // Check for WAV (RIFF header)
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        return 'wav'; // RIFF
    }

    // If no recognizable header, assume raw PCM (signed 16-bit little-endian)
    return 's16le';
}

async function convertToUlaw(audioBuffer, sourceFormat) {
    try {
        console.log(`[TTS] Converting ${sourceFormat} (${audioBuffer.length} bytes) to ulaw_8000...`);

        // OPTION 1: Use wavefile for WAV and Raw PCM (Pure JS, no ffmpeg needed)
        // explicitly excluding mp3 to force ffmpeg path for mp3 as requested
        if (sourceFormat !== 'mp3' && (sourceFormat === 'wav' || sourceFormat === 's16le' || sourceFormat === 'unknown')) {
            try {
                const wav = new WaveFile();

                if (sourceFormat === 'wav') {
                    // Load existing WAV
                    wav.fromBuffer(audioBuffer);
                } else {
                    // Assume Raw PCM: 24kHz, 1 channel, 16-bit (Sarvam default)
                    // If sourceFormat is unknown, we guess it's raw 24k PCM
                    wav.fromScratch(1, 24000, '16', audioBuffer);
                }

                // Resample to 8000Hz
                wav.toSampleRate(8000);

                // Extract samples. wav.data.samples determines the samples as bytes (Uint8Array)
                // We need to interpret them as 16-bit PCM (Little Endian)
                // Safely get samples as Int16 array
                // This handles endianness and channel separation for us
                let samples = wav.getSamples(false, Int16Array);

                // If stereo (array of arrays), mix down or take first channel
                if (Array.isArray(samples) && samples.length > 0 && samples[0].length !== undefined && typeof samples[0] !== 'number') {
                    // Stereo or multi-channel: samples is [channel1, channel2]
                    console.log(`[TTS] Multiple channels detected, using first channel`);
                    samples = samples[0];
                }

                const length = samples.length;
                const ulawBuffer = Buffer.alloc(length);

                for (let i = 0; i < length; i++) {
                    let sample = samples[i];
                    ulawBuffer[i] = encodeMuLaw(sample);
                }

                console.log(`[TTS] Conversion successful (manual encode): ${ulawBuffer.length} bytes`);
                return ulawBuffer;

            } catch (waveError) {
                console.error(`[TTS] wavefile conversion failed, falling back to ffmpeg:`, waveError);
                // Fallthrough to ffmpeg
            }
        }

        // OPTION 2: Use ffmpeg (Required for MP3, or fallback)
        const { spawn } = require('child_process');
        return new Promise((resolve, reject) => {
            let ffmpegArgs;

            // Build ffmpeg arguments based on source format
            if (sourceFormat === 's16le' || sourceFormat === 'unknown') {
                // Raw PCM format - need to specify input parameters
                ffmpegArgs = [
                    '-f', 's16le',         // Input format: signed 16-bit PCM little-endian
                    '-ar', '24000',        // Input sample rate (Sarvam typically uses 24kHz)
                    '-ac', '1',            // Input channels: mono
                    '-i', 'pipe:0',        // Input from stdin
                    '-ar', '8000',         // Output sample rate: 8kHz
                    '-ac', '1',            // Output channels: mono
                    '-acodec', 'pcm_mulaw', // Codec: µ-law
                    '-f', 'mulaw',         // Output format
                    '-loglevel', 'error',  // Only show errors
                    'pipe:1'               // Output to stdout
                ];
            } else {
                // MP3 or WAV format (if wavefile failed)
                ffmpegArgs = [
                    '-f', sourceFormat === 'wav' ? 'wav' : 'mp3',     // Input format
                    '-i', 'pipe:0',        // Input from stdin
                    '-ar', '8000',         // Sample rate: 8kHz
                    '-ac', '1',            // Channels: mono
                    '-acodec', 'pcm_mulaw', // Codec: µ-law
                    '-f', 'mulaw',         // Output format
                    '-af', 'volume=2.0',   // Increase volume by 2x for better audibility
                    '-loglevel', 'error',  // Only show errors
                    'pipe:1'               // Output to stdout
                ];
            }

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);

            const chunks = [];
            let stderrOutput = '';

            ffmpeg.stdout.on('data', (chunk) => {
                chunks.push(chunk);
            });

            ffmpeg.stderr.on('data', (data) => {
                // Collect all stderr for debugging
                stderrOutput += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    const ulawBuffer = Buffer.concat(chunks);
                    console.log(`[TTS] Conversion successful (using ffmpeg): ${ulawBuffer.length} bytes`);
                    resolve(ulawBuffer);
                } else {
                    console.error(`[TTS] ffmpeg failed with code ${code}`);
                    console.error(`[TTS] ffmpeg stderr:`, stderrOutput);
                    reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
                }
            });

            ffmpeg.on('error', (error) => {
                console.error(`[TTS] ffmpeg process error:`, error);
                reject(new Error(`ffmpeg process error: ${error.message}`));
            });

            // Write input buffer to ffmpeg stdin
            ffmpeg.stdin.write(audioBuffer);
            ffmpeg.stdin.end();
        });
    } catch (error) {
        console.error("[TTS] Error converting audio format:", error.message);
        throw new Error(`Audio format conversion failed: ${error.message}`);
    }
}

function encodeMuLaw(sample) {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign, exponent, mantissa, ulawbyte;

    // Get sign
    sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;

    // Clip magnitude
    if (sample > CLIP) sample = CLIP;

    sample += BIAS;

    // Determine exponent
    exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
        if (sample < (1 << (exp + 5))) {
            exponent = exp;
            break; // Found exponent
        }
    }
    // Correction: the loop above finds exponent such that sample < 2^(exp+5)
    // Wait, let's use the explicit check logic which is safer
    if (sample > 0x7FFF) exponent = 7;
    else if (sample > 0x3FFF) exponent = 6;
    else if (sample > 0x1FFF) exponent = 5;
    else if (sample > 0x0FFF) exponent = 4;
    else if (sample > 0x07FF) exponent = 3;
    else if (sample > 0x03FF) exponent = 2;
    else if (sample > 0x01FF) exponent = 1;
    else exponent = 0;

    // Determine mantissa
    mantissa = (sample >> (exponent + 3)) & 0x0F;

    // Assemble u-law byte
    ulawbyte = ~(sign | (exponent << 4) | mantissa);

    return ulawbyte & 0xFF;
}

module.exports = {
    sarvamTTS,
};
