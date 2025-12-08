const nodeFetch = require("node-fetch");

/**
 * TTS Controller
 * Unified interface for multiple TTS providers (ElevenLabs, Sarvam)
 * Handles provider selection and routing based on environment configuration
 */

// Import TTS providers
const { sarvamTTS } = require("./tts_sarvam.js");

/**
 * Generate speech audio using the configured TTS provider
 * @param {string} text - The text to convert to speech
 * @param {Object} options - TTS options
 * @param {string} options.voiceId - Voice ID (for ElevenLabs)
 * @param {string} options.language - Target language code (for Sarvam)
 * @param {string} options.speaker - Speaker/voice name (for Sarvam)
 * @param {string} options.format - Audio format
 * @returns {Promise<Buffer>} - Audio buffer in ulaw_8000 format
 */
async function generateTTS(text, options = {}) {
    const provider = options.provider || process.env.TTS_PROVIDER || "elevenlabs";

    console.log(`[TTS Controller] Selected provider: ${provider}`);

    try {
        if (provider === "sarvam") {
            return await generateSarvamTTS(text, options);
        } else {
            // Default to ElevenLabs
            return await generateElevenLabsTTS(text, options);
        }
    } catch (error) {
        console.error(`[TTS Controller] Error with ${provider} provider:`, error.message);

        // Optional: Implement fallback mechanism
        // if (provider === "sarvam") {
        //     console.log("[TTS Controller] Falling back to ElevenLabs...");
        //     return await generateElevenLabsTTS(text, options);
        // }

        throw error;
    }
}

/**
 * Generate TTS using Sarvam provider
 * @param {string} text - Text to synthesize
 * @param {Object} options - TTS options
 * @returns {Promise<Buffer>} - Audio buffer
 */
async function generateSarvamTTS(text, options) {
    console.log("[TTS Controller] Routing to Sarvam TTS");
    return await sarvamTTS(text, {
        language: options.language,
        speaker: options.speaker,
        format: options.format,
        skipConversion: options.skipConversion,
    });
}

/**
 * Generate TTS using ElevenLabs provider
 * @param {string} text - Text to synthesize
 * @param {Object} options - TTS options
 * @param {string} options.voiceId - ElevenLabs voice ID
 * @returns {Promise<Buffer>} - Audio buffer
 */
async function generateElevenLabsTTS(text, options) {
    console.log("[TTS Controller] Routing to ElevenLabs TTS");

    const apiKey = getElevenLabsApiKey();

    if (!apiKey) {
        throw new Error("ElevenLabs API key not configured");
    }

    const voiceId = options.voiceId || "21m00Tcm4TlvDq8ikWAM"; // Default voice

    console.log(`[TTS] Using provider: ElevenLabs`);
    console.log(`[TTS] Sending request...`);
    console.log(`   Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`   Voice ID: ${voiceId}`);

    try {
        const response = await nodeFetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: "POST",
                headers: {
                    "Accept": "audio/basic",
                    "Content-Type": "application/json",
                    "xi-api-key": apiKey,
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_turbo_v2_5",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true,
                    },
                    output_format: options.output_format || options.format || "ulaw_8000",
                }),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[TTS] ElevenLabs API error: ${response.status} - ${errorText}`);
            throw new Error(`ElevenLabs API error: ${response.status} - ${response.statusText}`);
        }

        const audioBuffer = await response.buffer();
        console.log(`[TTS] Audio received: ${audioBuffer.length} bytes (µ-law 8kHz)`);
        return audioBuffer;
    } catch (error) {
        console.error("[TTS] Error in ElevenLabs TTS:", error.message);
        throw error;
    }
}

/**
 * Get ElevenLabs API key from environment
 * @returns {string|undefined} - API key
 */
function getElevenLabsApiKey() {
    return process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
}

module.exports = {
    generateTTS,
};
