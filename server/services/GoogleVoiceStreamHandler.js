const WebSocket = require('ws');
const nodeFetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

/**
 * Google Voice Stream Handler
 * Pipeline: User Audio -> Google STT -> Gemini -> ElevenLabs -> User Audio
 */
class GoogleVoiceStreamHandler {
    constructor(voiceSyncService, walletService) {
        this.voiceSyncService = voiceSyncService;
        this.walletService = walletService;
        this.clients = new Set();
    }

    handleConnection(ws, req) {
        console.log('[GoogleVoice] New connection');

        let audioBuffer = [];
        let isProcessing = false;

        // Configuration
        const googleApiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;

        // Query params
        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('agentId');
        const voiceId = url.searchParams.get('voiceId') || '21m00Tcm4TlvDq8ikWAM';
        const identity = decodeURIComponent(url.searchParams.get('identity') || 'You are a helpful AI assistant.');
        const userId = url.searchParams.get('userId');

        if (!googleApiKey) {
            console.error('[GoogleVoice] Missing Google API Key');
            ws.send(JSON.stringify({ event: 'error', message: 'Server missing Google API Key' }));
            return;
        }

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());

                if (data.event === 'audio') {
                    // Buffer audio
                    audioBuffer.push(data.data); // base64 string

                    // Process every ~1 second of audio (assuming approx 30-50 chunks/sec depending on frontend)
                    // For better latency, we might process more aggressively, but let's stick to batching 
                    // to match the previous logic and ensure we have enough context.
                    // If we have > 20 chunks and aren't processing, go.
                    if (audioBuffer.length >= 20 && !isProcessing) {
                        isProcessing = true;
                        const chunksToProcess = [...audioBuffer];
                        audioBuffer = []; // Clear buffer immediately

                        await this.processPipeline(
                            ws,
                            chunksToProcess,
                            googleApiKey,
                            elevenLabsApiKey,
                            agentId,
                            voiceId,
                            identity,
                            userId
                        );

                        isProcessing = false;
                    }
                }
            } catch (error) {
                console.error('[GoogleVoice] Error processing message:', error);
                isProcessing = false;
            }
        });

        ws.on('close', () => {
            console.log('[GoogleVoice] Client disconnected');
        });
    }

    async processPipeline(ws, audioChunks, googleApiKey, elevenLabsApiKey, agentId, voiceId, identity, userId) {
        try {
            // 1. Google Speech-to-Text
            const transcript = await this.transcribeAudio(audioChunks, googleApiKey);

            if (!transcript) return; // No speech detected

            console.log(`[GoogleVoice] Transcript: "${transcript}"`);

            // Send transcript to client
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ event: 'transcript', text: transcript }));
            }

            // 2. Gemini
            const llmResponse = await this.generateResponse(transcript, identity, googleApiKey);
            console.log(`[GoogleVoice] Gemini Response: "${llmResponse}"`);

            // Track Gemini Usage
            if (userId && this.walletService) {
                // Rough estimation
                const estimatedTokens = (transcript.length + llmResponse.length) / 4;
                this.walletService.recordUsageAndCharge(userId, agentId || 'direct', 'gemini', estimatedTokens, {
                    prompt_length: transcript.length,
                    response_length: llmResponse.length
                }).catch(e => console.error('Wallet error:', e)); // Don't block processing
            }

            // 3. ElevenLabs TTS
            if (elevenLabsApiKey) {
                const audioBase64 = await this.generateAudio(llmResponse, voiceId, elevenLabsApiKey);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'audio', audio: audioBase64 }));
                }

                // Track ElevenLabs Usage
                if (userId && this.walletService) {
                    this.walletService.recordUsageAndCharge(userId, agentId || 'direct', 'elevenlabs', llmResponse.length, {
                        voice_id: voiceId
                    }).catch(e => console.error('Wallet error:', e));
                }
            } else {
                // Fallback if no TTS
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'agent-response', text: llmResponse }));
                }
            }

        } catch (error) {
            console.error('[GoogleVoice] Pipeline Error:', error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    event: 'error',
                    message: error.message || 'Error processing audio'
                }));
            }
        }
    }

    async transcribeAudio(audioChunks, ApiKey) {
        try {
            // Combine chunks - these are base64 strings from the frontend
            const combinedBase64 = audioChunks.join('');

            console.log(`[GoogleVoice] Transcribing ${audioChunks.length} chunks, total base64 length: ${combinedBase64.length}`);

            // Google STT REST API
            const response = await nodeFetch(`https://speech.googleapis.com/v1/speech:recognize?key=${ApiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    config: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 16000,
                        languageCode: 'en-US',
                        enableAutomaticPunctuation: true
                    },
                    audio: {
                        content: combinedBase64
                    }
                })
            });

            const data = await response.json();

            console.log('[GoogleVoice] STT Response:', JSON.stringify(data).substring(0, 200));

            if (data.error) {
                console.error('[GoogleVoice] STT Error:', data.error);
                throw new Error(`Google STT Error: ${data.error.message}`);
            }

            if (!data.results || data.results.length === 0) {
                console.log('[GoogleVoice] No speech detected in audio');
                return null;
            }

            const transcript = data.results
                .map(result => result.alternatives[0].transcript)
                .join(' ')
                .trim();

            return transcript;
        } catch (error) {
            console.error('[GoogleVoice] Transcription error:', error);
            throw error;
        }
    }

    async generateResponse(transcript, systemPrompt, ApiKey) {
        // Using Gemini 1.5 Flash via Generative Language API
        const response = await nodeFetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${ApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `${systemPrompt}\n\nUser: ${transcript}` }]
                }]
            })
        });

        const data = await response.json();

        if (data.error) {
            // Fallback to gemini-pro if 1.5-flash fails or doesn't exist
            throw new Error(`Gemini Error: ${data.error.message}`);
        }

        return data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't understand that.";
    }

    async generateAudio(text, voiceId, apiKey) {
        // CHECK FOR SARVAM VOICE
        // The frontend sends just the speaker name for Sarvam (e.g. "anushka"), 
        // OR it might send a prefixed ID if we changed that logic.
        // Based on previous context, user was adding "sarvam" provider.
        // Let's assume if the ID doesn't look like an ElevenLabs ID (usually 20 chars), it might be Sarvam, 
        // OR we specifically check against known Sarvam names.

        const sarvamSpeakers = [
            'anushka', 'abhilash', 'chitra', 'meera', 'arvind',
            'manisha', 'vidya', 'arya', 'karun', 'hitesh'
        ];

        // If voiceId matches a Sarvam speaker or starts with 'sarvam:'
        const isSarvam = sarvamSpeakers.includes(voiceId) || voiceId.startsWith('sarvam:');

        if (isSarvam) {
            const speaker = voiceId.replace('sarvam:', '');
            console.log(`[GoogleVoice] Generating Sarvam audio for speaker: ${speaker}`);

            try {
                // Import dynamically to avoid top-level issues if file missing
                const { sarvamTTS } = require('./tts_sarvam');

                const audioBuffer = await sarvamTTS(text, {
                    speaker: speaker,
                    language: 'en-IN', // You might want to make this dynamic later
                    format: 'wav',     // WAV works well with decodeAudioData
                    skipConversion: true // Use our new flag to get standard WAV
                });

                return audioBuffer.toString('base64');
            } catch (err) {
                console.error('[GoogleVoice] Sarvam TTS Failed:', err);
                // Fallback or re-throw?
                throw new Error(`Sarvam TTS Failed: ${err.message}`);
            }
        }

        // DEFAULT: ELEVEN LABS
        // Use mp3_44100_128 which is standard and plays everywhere
        console.log(`[GoogleVoice] Generating ElevenLabs audio for voice: ${voiceId}`);
        const response = await nodeFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_turbo_v2_5"
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`ElevenLabs Error: ${err}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    }
}

module.exports = GoogleVoiceStreamHandler;
