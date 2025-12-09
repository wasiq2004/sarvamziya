const nodeFetch = require("node-fetch");

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

        // Convert to ulaw_8000 format for Twilio compatibility
        // If skipConversion is true, return the original buffer (e.g. for web frontend)
        if (options.skipConversion) {
            console.log(`[TTS] Skipping conversion, returning ${format}`);
            return audioBuffer;
        }

        const ulawBuffer = await convertToUlaw(audioBuffer, format);

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

async function convertToUlaw(audioBuffer, sourceFormat) {
    try {
        return audioBuffer;
        const { spawn } = require('child_process');

        console.log(`[TTS] Converting ${sourceFormat} to ulaw_8000...`);

        return new Promise((resolve, reject) => {
            // Use ffmpeg to convert to µ-law 8kHz
            const ffmpeg = spawn('ffmpeg', [
                '-i', 'pipe:0',           // Input from stdin
                '-f', sourceFormat,        // Input format
                '-ar', '8000',            // Sample rate: 8kHz
                '-ac', '1',               // Channels: mono
                '-acodec', 'pcm_mulaw',   // Codec: µ-law
                '-f', 'mulaw',            // Output format
                'pipe:1'                  // Output to stdout
            ]);

            const chunks = [];

            ffmpeg.stdout.on('data', (chunk) => {
                chunks.push(chunk);
            });

            ffmpeg.stderr.on('data', (data) => {
              
                const message = data.toString();
                if (message.includes('Error') || message.includes('error')) {
                    console.error(`[TTS] ffmpeg stderr: ${message}`);
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    const ulawBuffer = Buffer.concat(chunks);
                    console.log(`[TTS] Conversion successful: ${ulawBuffer.length} bytes`);
                    resolve(ulawBuffer);
                } else {
                    reject(new Error(`ffmpeg exited with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                console.error(`[TTS] ffmpeg error:`, error);
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
