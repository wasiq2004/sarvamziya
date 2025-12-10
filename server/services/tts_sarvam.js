const nodeFetch = require("node-fetch");

/**
 * Sarvam TTS Service
 * Provides text-to-speech functionality using Sarvam.ai API
 */

/**
 * Generate speech audio using Sarvam TTS API
 * @param {string} text - The text to convert to speech
 * @param {Object} options - TTS options
 * @param {string} options.language - Target language code (default: en-IN)
 * @param {string} options.speaker - Speaker/voice name (default: anushka)
 * @param {string} options.format - Audio format: mp3, wav, pcm (default: mp3)
 * @returns {Promise<Buffer>} - Audio buffer in ulaw_8000 format for Twilio compatibility
 */
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

/**
 * Detect audio format by inspecting magic numbers (file signatures)
 * @param {Buffer} buffer - Audio buffer to inspect
 * @returns {string} - Detected format: 'mp3', 'wav', 's16le', or 'unknown'
 */
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

/**
 * Convert audio buffer to ulaw_8000 format for Twilio compatibility
 * @param {Buffer} audioBuffer - Input audio buffer
 * @param {string} sourceFormat - Source audio format (mp3, wav, pcm)
 * @returns {Promise<Buffer>} - Audio buffer in ulaw_8000 format
 */
async function convertToUlaw(audioBuffer, sourceFormat) {
    try {
        const { spawn } = require('child_process');

        console.log(`[TTS] Converting ${sourceFormat} (${audioBuffer.length} bytes) to ulaw_8000...`);

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
                    '-f', 'au',            // AU format (has 24-byte header we can strip)
                    'pipe:1'               // Output to stdout
                ];
            } else {
                // MP3 or WAV format
                ffmpegArgs = [
                    '-f', sourceFormat,     // Input format
                    '-i', 'pipe:0',        // Input from stdin
                    '-af', 'volume=1.5',   // Increase volume for better audibility
                    '-ar', '8000',         // Sample rate: 8kHz
                    '-ac', '1',            // Channels: mono
                    '-acodec', 'pcm_mulaw', // Codec: µ-law
                    '-f', 'au',            // AU format (has 24-byte header we can strip)
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
                    const fullBuffer = Buffer.concat(chunks);

                    // AU format header parsing
                    // AU header: magic(4) + data_offset(4) + data_size(4) + encoding(4) + sample_rate(4) + channels(4)
                    // The data_offset field (bytes 4-7) tells us where audio data starts

                    if (fullBuffer.length < 24) {
                        console.error(`[TTS] Buffer too small: ${fullBuffer.length} bytes`);
                        reject(new Error('Audio buffer too small'));
                        return;
                    }

                    // Read the data offset (big-endian uint32 at position 4)
                    const dataOffset = fullBuffer.readUInt32BE(4);
                    console.log(`[TTS] AU header data offset: ${dataOffset} bytes`);

                    // Strip the header based on actual offset
                    const ulawBuffer = fullBuffer.slice(dataOffset);

                    console.log(`[TTS] Conversion successful: ${ulawBuffer.length} bytes (stripped ${dataOffset}-byte AU header)`);
                    console.log(`[TTS] Full buffer size: ${fullBuffer.length} bytes`);
                    console.log(`[TTS] First 20 bytes (hex): ${ulawBuffer.slice(0, 20).toString('hex')}`);
                    console.log(`[TTS] First 20 bytes (decimal): [${Array.from(ulawBuffer.slice(0, 20)).join(', ')}]`);
                    console.log(`[TTS] Duration: ${(ulawBuffer.length / 8000).toFixed(2)} seconds @ 8kHz`);
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

module.exports = {
    sarvamTTS,
};

