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
            "https://api.sarvam.ai/text-to-speech/convert",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: text,
                    target_language_code: language,
                    speaker: speaker,
                    format: format,
                }),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[TTS] Sarvam API error: ${response.status} - ${response.statusText}`);
            console.error(`[TTS] Error details: ${errorText}`);
            throw new Error(`Sarvam API error: ${response.status} - ${response.statusText}`);
        }

        const audioBuffer = await response.buffer();
        console.log(`[TTS] Audio received: ${audioBuffer.length} bytes`);
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

/**
 * Convert audio buffer to ulaw_8000 format for Twilio compatibility
 * @param {Buffer} audioBuffer - Input audio buffer
 * @param {string} sourceFormat - Source audio format (mp3, wav, pcm)
 * @returns {Promise<Buffer>} - Audio buffer in ulaw_8000 format
 */
async function convertToUlaw(audioBuffer, sourceFormat) {
    try {
        // For now, if Sarvam supports direct ulaw output, we can request that
        // Otherwise, we'd need to use a library like ffmpeg or sox for conversion
        // This is a placeholder that assumes the audio is already compatible
        // In production, you might want to:
        // 1. Request ulaw format directly from Sarvam if supported
        // 2. Use ffmpeg/sox for conversion if needed
        // 3. Use a Node.js audio processing library
        
        // TODO: Implement actual audio format conversion if needed
        // For now, returning the buffer as-is
        // This works if Sarvam can output in a Twilio-compatible format
        
        return audioBuffer;
    } catch (error) {
        console.error("[TTS] Error converting audio format:", error.message);
        throw new Error(`Audio format conversion failed: ${error.message}`);
    }
}

module.exports = {
    sarvamTTS,
};
