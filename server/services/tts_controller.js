const nodeFetch = require("node-fetch");

const { sarvamTTS } = require("./tts_sarvam.js");

async function generateTTS(text, options = {}) {
    // Known Sarvam speakers
    const sarvamSpeakers = ['anushka', 'abhilash', 'chitra', 'meera', 'arvind', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'];

    // Auto-detect provider based on voice ID or speaker
    let provider = options.provider || process.env.TTS_PROVIDER;

    // If no provider specified, try to detect from voice ID/speaker
    if (!provider) {
        const voiceId = (options.voiceId || options.speaker || '').toLowerCase();
        if (sarvamSpeakers.includes(voiceId)) {
            provider = 'sarvam';
            // Set speaker if not already set
            if (!options.speaker) {
                options.speaker = voiceId;
            }
        } else {
            provider = 'elevenlabs';
        }
    }

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

        // Implement fallback mechanism
        if (provider === "sarvam") {
            console.log("[TTS Controller] ⚠️  Sarvam failed, falling back to ElevenLabs...");
            try {
                // Use default ElevenLabs voice as fallback
                return await generateElevenLabsTTS(text, { voiceId: "21m00Tcm4TlvDq8ikWAM" });
            } catch (fallbackError) {
                console.error("[TTS Controller] Fallback to ElevenLabs also failed:", fallbackError.message);
                throw error; // Throw original error
            }
        }

        throw error;
    }
}

async function generateSarvamTTS(text, options) {
    console.log("[TTS Controller] Routing to Sarvam TTS");
    return await sarvamTTS(text, {
        language: options.language,
        speaker: options.speaker,
        format: options.format,
        skipConversion: options.skipConversion,
    });
}

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

function getElevenLabsApiKey() {
    return process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
}

module.exports = {
    generateTTS,
};
