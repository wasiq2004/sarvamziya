const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { LLMService } = require("../llmService.js");
const nodeFetch = require("node-fetch");

const sessions = new Map();

class MediaStreamHandler {
    constructor(deepgramApiKey, geminiApiKey, campaignService) {
        if (!deepgramApiKey) throw new Error("Missing Deepgram API Key");
        if (!geminiApiKey) throw new Error("Missing Gemini API Key");

        this.deepgramClient = createClient(deepgramApiKey);
        this.llmService = new LLMService(geminiApiKey);
        this.campaignService = campaignService;
    }

    // ✅ FIX: Method to get fresh API key each time
    getElevenLabsApiKey() {
        return process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
    }

    createSession(callId, agentPrompt, agentVoiceId, ws) {
        const session = {
            callId,
            context: [],
            sttStream: null,
            agentPrompt,
            agentVoiceId: agentVoiceId || "21m00Tcm4TlvDq8ikWAM",
            ws,
            streamSid: null,
            isReady: false,
            audioQueue: [],
            isSpeaking: false, // Track if agent is currently speaking
            lastUserSpeechTime: null, // Track when user last spoke
        };
        sessions.set(callId, session);
        console.log(`✅ Created session for call ${callId}`);
        console.log(`   Agent Prompt: ${agentPrompt.substring(0, 100)}...`);
        console.log(`   Voice ID: ${session.agentVoiceId}`);
        return session;
    }

    endSession(callId) {
        const session = sessions.get(callId);
        if (session) {
            if (session.sttStream) {
                session.sttStream.finish();
                session.sttStream.removeAllListeners();
            }
            sessions.delete(callId);
            console.log(`❌ Ended session for call ${callId}`);
        }
    }

    appendToContext(session, text, role) {
        session.context.push({ role, parts: [{ text }] });
        console.log(`💬 ${role.toUpperCase()}: ${text}`);
    }

    // REPLACE the handleConnection method in mediaStreamHandler.js:

    async handleConnection(ws, req) {
        let callId = null;
        let agentId = null;
        let session = null;

        try {
            console.log(`📞 WebSocket connection initiated from handleConnection`);

            // ✅ Set up error handler FIRST before any other operations
            ws.on("error", (error) => {
                // Ignore UTF-8 errors from binary frames (Twilio sends binary audio data)
                if (error.code === 'WS_ERR_INVALID_UTF8' ||
                    error.message?.includes('invalid UTF-8') ||
                    error.message?.includes('Invalid WebSocket frame')) {
                    console.log("⚠️  Ignoring binary frame error (normal for audio data)");
                    return; // Don't crash
                }
                console.error("❌ WebSocket error:", error);
            });

            ws.on("message", async (message) => {
                try {
                    let data;

                    // ✅ CRITICAL: Handle binary messages from Twilio
                    if (Buffer.isBuffer(message)) {
                        // Binary message - try to parse as JSON first
                        try {
                            const messageStr = message.toString('utf8');
                            data = JSON.parse(messageStr);
                        } catch (e) {
                            // Not JSON - could be raw audio, ignore
                            return;
                        }
                    } else if (typeof message === 'string') {
                        // String message - parse as JSON
                        data = JSON.parse(message);
                    } else {
                        // Unknown message type
                        return;
                    }

                    // ✅ Get parameters from Twilio "start" event
                    if (data.event === "start") {
                        console.log("▶️  Media Stream START event received");

                        // Extract parameters from start event
                        const streamParams = data.start?.customParameters || {};
                        callId = streamParams.callId || data.start?.callSid;
                        agentId = streamParams.agentId;
                        const userId = streamParams.userId;

                        console.log(`📞 Call ID: ${callId}`);
                        console.log(`🤖 Agent ID: ${agentId}`);
                        console.log(`👤 User ID: ${userId}`);

                        if (!callId) {
                            console.error("❌ No callId in start event");
                            ws.close();
                            return;
                        }

                        // Load agent configuration
                        let agentPrompt = "You are a helpful AI assistant.";
                        let agentVoiceId = "21m00Tcm4TlvDq8ikWAM"; // Default voice
                        let greetingMessage = "Hello! How can I help you today?";

                        if (agentId) {
                            try {
                                const AgentService = require('./agentService.js');
                                const agentService = new AgentService(require('../config/database.js').default);

                                const agent = await agentService.getAgentById(userId, agentId);
                                if (agent) {
                                    agentPrompt = agent.identity || agentPrompt;

                                    // ✅ CRITICAL: Use the voice ID directly from database
                                    if (agent.voiceId) {
                                        agentVoiceId = agent.voiceId;
                                        console.log(`🎤 Using agent voice ID from database: ${agentVoiceId}`);
                                    } else {
                                        console.warn(`⚠️  Agent has no voiceId, using default: ${agentVoiceId}`);
                                    }

                                    if (agent.settings?.greetingLine) {
                                        greetingMessage = agent.settings.greetingLine;
                                    }
                                    console.log(`✅ Loaded agent: ${agent.name}`);
                                    console.log(`   Voice ID: ${agentVoiceId}`);
                                    console.log(`   Prompt: ${agentPrompt.substring(0, 100)}...`);
                                } else {
                                    console.warn(`⚠️  Agent ${agentId} not found, using defaults`);
                                }
                            } catch (err) {
                                console.error("⚠️  Error loading agent:", err.message);
                            }
                        } else {
                            console.log(`ℹ️  No agentId provided, using default voice: ${agentVoiceId}`);
                        }

                        // Create session with the correct voice ID
                        session = this.createSession(callId, agentPrompt, agentVoiceId, ws);
                        console.log(`✅ Session created with voice ID: ${session.agentVoiceId}`);

                        session.greetingMessage = greetingMessage;
                        session.streamSid = data.start.streamSid;
                        session.isReady = true;

                        // Initialize Deepgram with SDK v4 API
                        console.log("🔄 Initializing Deepgram connection...");
                        const deepgramLive = this.deepgramClient.listen.live({
                            encoding: "mulaw",
                            sample_rate: 8000,
                            model: "nova-2-phonecall",
                            smart_format: true,
                            interim_results: true,  // MUST be true for utterance_end_ms
                            utterance_end_ms: 1000,
                            punctuate: true,
                            language: "en-US",
                        });

                        session.sttStream = deepgramLive;

                        // Register event handlers BEFORE any audio is sent
                        deepgramLive.on(LiveTranscriptionEvents.Open, () => {
                            console.log("✅ Deepgram connection opened and ready");
                        });

                        deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
                            try {
                                const transcript = data.channel?.alternatives?.[0]?.transcript;
                                const isFinal = data.is_final;

                                // Only process final transcripts
                                if (!isFinal || !transcript?.trim()) return;

                                console.log(`🎤 User said: "${transcript}"`);

                                // ✅ INTERRUPTION HANDLING: User spoke
                                session.lastUserSpeechTime = Date.now();

                                // If agent is speaking, user is interrupting - stop agent
                                if (session.isSpeaking) {
                                    console.log(`⚠️  User interrupted agent - stopping agent speech`);
                                    session.isSpeaking = false;
                                    if (session.ws && session.streamSid) {
                                        session.ws.send(
                                            JSON.stringify({
                                                event: "clear",
                                                streamSid: session.streamSid
                                            })
                                        );
                                    }
                                }

                                this.appendToContext(session, transcript, "user");

                                const llmResponse = await this.callLLM(session);
                                this.appendToContext(session, llmResponse, "model");

                                console.log(`🔊 Synthesizing response with voice: ${session.agentVoiceId}`);
                                const ttsAudio = await this.synthesizeTTS(llmResponse, session.agentVoiceId);
                                if (ttsAudio) {
                                    this.sendAudioToTwilio(session, ttsAudio);
                                }
                            } catch (err) {
                                console.error("❌ Transcript error:", err);
                            }
                        });

                        deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                            console.log("🎤 User finished speaking (utterance end)");
                        });

                        deepgramLive.on(LiveTranscriptionEvents.Error, (error) => {
                            console.error("❌ Deepgram error:", error);
                        });

                        deepgramLive.on(LiveTranscriptionEvents.Close, () => {
                            console.log("⚠️  Deepgram connection closed");
                        });

                        // Send greeting after a short delay
                        setTimeout(async () => {
                            try {
                                console.log(`👋 Greeting: "${session.greetingMessage}"`);
                                console.log(`🔊 Using voice ID for greeting: ${session.agentVoiceId}`);
                                const audio = await this.synthesizeTTS(session.greetingMessage, session.agentVoiceId);
                                if (audio && audio.length > 0) {
                                    console.log(`✅ Greeting audio generated: ${audio.length} bytes`);
                                    this.sendAudioToTwilio(session, audio);
                                } else {
                                    console.error("❌ Greeting audio is empty or null");
                                }
                            } catch (err) {
                                console.error("❌ Greeting error:", err);
                                console.error("❌ Error stack:", err.stack);
                            }
                        }, 500);

                    } else if (data.event === "connected") {
                        console.log("✅ Twilio connected");

                    } else if (data.event === "media") {
                        // ✅ Send audio directly to Deepgram
                        if (session?.sttStream && data.media?.payload) {
                            const audioBuffer = Buffer.from(data.media.payload, "base64");
                            if (audioBuffer.length > 0) {
                                session.sttStream.send(audioBuffer);
                                // Log occasionally to verify audio is flowing
                                if (Math.random() < 0.01) { // Log ~1% of packets
                                    console.log(`🎤 Receiving audio from user (${audioBuffer.length} bytes)`);
                                }
                            }
                        }

                    } else if (data.event === "stop") {
                        console.log("⏹️  Stream stopped");
                        if (callId) this.endSession(callId);

                    } else if (data.event === "mark") {
                        console.log("📍 Mark:", data.mark?.name);
                    }

                } catch (err) {
                    // Only log real errors
                    if (!err.message?.includes('JSON') && !err.message?.includes('Unexpected')) {
                        console.error("❌ Message processing error:", err);
                    }
                }
            });

            ws.on("close", () => {
                console.log("🔌 WebSocket closed");
                if (callId) this.endSession(callId);
            });

            console.log("✅ WebSocket handlers registered and ready");

        } catch (err) {
            console.error("❌ Connection setup error:", err);
            try {
                ws.close();
            } catch (closeErr) {
                // Ignore close errors
            }
        }
    }
    async callLLM(session) {
        try {
            const response = await this.llmService.generateContent({
                model: "gemini-1.5-flash",
                contents: session.context,
                config: { systemInstruction: session.agentPrompt },
            });
            return response.text;
        } catch (err) {
            console.error("❌ LLM error:", err);
            return "I apologize, I'm having trouble processing that right now.";
        }
    }
    async synthesizeTTS(text, voiceId) {
        try {
            // Use TTS controller for provider abstraction
            const { generateTTS } = require('./tts_controller.js');

            console.log(`🔊 Synthesizing TTS with voice: ${voiceId}`);

            const audioBuffer = await generateTTS(text, { voiceId });

            if (!audioBuffer) {
                console.error("❌ TTS generation returned null");
                return null;
            }

            console.log(`✅ TTS generated: ${audioBuffer.length} bytes (µ-law 8kHz) using voice ${voiceId}`);
            return audioBuffer;
        } catch (err) {
            console.error("❌ TTS error:", err);
            return null;
        }
    }
    sendAudioToTwilio(session, audioBuffer) {
        try {
            if (!session.isReady || !session.streamSid) {
                console.log("⏸️  Queueing audio - stream not ready yet");
                session.audioQueue.push(audioBuffer);
                return;
            }

            // ✅ Set speaking flag
            session.isSpeaking = true;

            const base64Audio = audioBuffer.toString("base64");
            const chunkSize = 214; // 160 bytes µ-law = 214 chars base64
            let chunksSent = 0;

            console.log(`📤 Sending audio to Twilio:`);
            console.log(`   Total base64 length: ${base64Audio.length}`);
            console.log(`   First 50 chars: ${base64Audio.substring(0, 50)}`);

            for (let i = 0; i < base64Audio.length; i += chunkSize) {
                const chunk = base64Audio.slice(i, i + chunkSize);
                session.ws.send(
                    JSON.stringify({
                        event: "media",
                        streamSid: session.streamSid,
                        media: {
                            payload: chunk
                        },
                    })
                );
                chunksSent++;
            }
            // Send mark to indicate audio completion
            session.ws.send(
                JSON.stringify({
                    event: "mark",
                    streamSid: session.streamSid,
                    mark: { name: "audio_complete" },
                })
            );

            // ✅ Clear speaking flag after a delay (estimate based on audio length)
            // Approximate: 160 bytes µ-law @ 8kHz = 20ms per chunk
            const estimatedDurationMs = chunksSent * 20;
            setTimeout(() => {
                session.isSpeaking = false;
                console.log(`✅ Agent finished speaking`);
            }, estimatedDurationMs);

            console.log(`✅ Sent ${chunksSent} audio chunks to Twilio (streamSid: ${session.streamSid})`);
        } catch (err) {
            console.error("❌ Error sending audio to Twilio:", err);
            session.isSpeaking = false; // Clear flag on error
        }
    }
}
module.exports = { MediaStreamHandler };
