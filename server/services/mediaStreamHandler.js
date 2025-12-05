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
            
            // ✅ NEW: Real-time conversation state
            isAISpeaking: false,           // Track if AI is currently playing audio
            currentAudioChunks: [],        // Store chunks being played
            userSpeechDetected: false,     // Flag for user interruption
            interimTranscript: "",         // Partial speech recognition
            silenceTimer: null,            // Timer for detecting end of speech
            conversationBuffer: [],        // Buffer for streaming responses
        };
        sessions.set(callId, session);
        console.log(`✅ Created session for call ${callId}`);
        return session;
    }

    async handleConnection(ws, req) {
        let callId = null;
        let session = null;
        
        try {
            console.log(`📞 WebSocket connection initiated`);
            
            ws.on("error", (error) => {
                if (error.code === 'WS_ERR_INVALID_UTF8' || 
                    error.message?.includes('invalid UTF-8')) {
                    return;
                }
                console.error("❌ WebSocket error:", error);
            });

            ws.on("message", async (message) => {
                try {
                    let data;
                    
                    if (Buffer.isBuffer(message)) {
                        try {
                            const messageStr = message.toString('utf8');
                            data = JSON.parse(messageStr);
                        } catch (e) {
                            return;
                        }
                    } else if (typeof message === 'string') {
                        data = JSON.parse(message);
                    } else {
                        return;
                    }

                    if (data.event === "start") {
                        console.log("▶️  Media Stream START event");
                        
                        const streamParams = data.start?.customParameters || {};
                        callId = streamParams.callId || data.start?.callSid;
                        const agentId = streamParams.agentId;
                        const userId = streamParams.userId;
                        
                        if (!callId) {
                            console.error("❌ No callId in start event");
                            ws.close();
                            return;
                        }

                        // Load agent configuration
                        let agentPrompt = "You are a helpful AI assistant.";
                        let agentVoiceId = "21m00Tcm4TlvDq8ikWAM";
                        let greetingMessage = "Hello! How can I help you today?";

                        if (agentId) {
                            try {
                                const AgentService = require('./agentService.js');
                                const agentService = new AgentService(require('../config/database.js').default);
                                
                                const agent = await agentService.getAgentById(userId, agentId);
                                if (agent) {
                                    agentPrompt = agent.identity || agentPrompt;
                                    if (agent.voiceId) {
                                        agentVoiceId = agent.voiceId;
                                    }
                                    if (agent.settings?.greetingLine) {
                                        greetingMessage = agent.settings.greetingLine;
                                    }
                                }
                            } catch (err) {
                                console.error("⚠️  Error loading agent:", err.message);
                            }
                        }

                        session = this.createSession(callId, agentPrompt, agentVoiceId, ws);
                        session.greetingMessage = greetingMessage;
                        session.streamSid = data.start.streamSid;
                        session.isReady = true;

                        // ✅ Initialize Deepgram with INTERIM results
                        const deepgramLive = this.deepgramClient.listen.live({
                            encoding: "mulaw",
                            sample_rate: 8000,
                            model: "nova-2-phonecall",
                            smart_format: true,
                            interim_results: true,      // ✅ Enable interim results
                            utterance_end_ms: 800,      // ✅ Faster utterance detection
                            punctuate: true,
                            vad_events: true,           // ✅ Voice Activity Detection
                        });

                        session.sttStream = deepgramLive;

                        // ✅ NEW: Handle INTERIM transcripts for interruption detection
                        deepgramLive.on("Transcript", async (transcriptData) => {
                            try {
                                const transcript = transcriptData.channel?.alternatives?.[0]?.transcript;
                                if (!transcript?.trim()) return;

                                // ✅ INTERIM: Detect user speech while AI is talking
                                if (!transcriptData.is_final) {
                                    session.interimTranscript = transcript;
                                    
                                    // If AI is speaking and user starts talking, INTERRUPT
                                    if (session.isAISpeaking && transcript.length > 3) {
                                        console.log(`🛑 USER INTERRUPTED: "${transcript}"`);
                                        this.handleInterruption(session);
                                    }
                                    return;
                                }

                                // ✅ FINAL: Process complete user utterance
                                console.log(`🎤 FINAL: "${transcript}"`);
                                
                                // Clear any pending silence timer
                                if (session.silenceTimer) {
                                    clearTimeout(session.silenceTimer);
                                    session.silenceTimer = null;
                                }

                                this.appendToContext(session, transcript, "user");

                                // ✅ Generate response with streaming
                                await this.handleUserMessage(session, transcript);

                            } catch (err) {
                                console.error("❌ Transcript error:", err);
                            }
                        });

                        // ✅ NEW: Handle Voice Activity Detection events
                        deepgramLive.on("VoiceActivity", (vadEvent) => {
                            if (vadEvent.speech_final) {
                                // User stopped speaking - start silence timer
                                if (session.silenceTimer) clearTimeout(session.silenceTimer);
                                
                                session.silenceTimer = setTimeout(() => {
                                    // If no new speech detected, trigger response
                                    if (session.interimTranscript && !session.isAISpeaking) {
                                        console.log(`⏱️  Silence detected, processing: "${session.interimTranscript}"`);
                                    }
                                }, 1500);
                            }
                        });

                        deepgramLive.on("Error", (error) => {
                            console.error("❌ Deepgram error:", error.message);
                        });

                        deepgramLive.on("Open", () => {
                            console.log("✅ Deepgram opened");
                        });

                        deepgramLive.on("Close", () => {
                            console.log("⚠️ Deepgram closed");
                        });

                        // Send greeting
                        setTimeout(async () => {
                            try {
                                console.log(`👋 Greeting: "${session.greetingMessage}"`);
                                await this.speakWithInterruption(session, session.greetingMessage);
                            } catch (err) {
                                console.error("❌ Greeting error:", err);
                            }
                        }, 500);

                    } else if (data.event === "media") {
                        // Send audio to Deepgram
                        if (session?.sttStream && data.media?.payload) {
                            const audioBuffer = Buffer.from(data.media.payload, "base64");
                            if (audioBuffer.length > 0) {
                                session.sttStream.send(audioBuffer);
                                
                                // ✅ Mark that user is potentially speaking
                                session.userSpeechDetected = true;
                            }
                        }
                        
                    } else if (data.event === "stop") {
                        console.log("⏹️  Stream stopped");
                        if (callId) this.endSession(callId);
                        
                    } else if (data.event === "mark") {
                        console.log("📍 Mark:", data.mark?.name);
                        
                        // ✅ Detect when AI audio finishes playing
                        if (data.mark?.name === "audio_complete") {
                            session.isAISpeaking = false;
                            session.currentAudioChunks = [];
                            console.log("✅ AI finished speaking");
                        }
                    }
                    
                } catch (err) {
                    if (!err.message?.includes('JSON') && !err.message?.includes('Unexpected')) {
                        console.error("❌ Message error:", err);
                    }
                }
            });

            ws.on("close", () => {
                console.log("🔌 WebSocket closed");
                if (callId) this.endSession(callId);
            });

        } catch (err) {
            console.error("❌ Connection error:", err);
            try { ws.close(); } catch (e) {}
        }
    }

    // ✅ NEW: Handle user interruption
    handleInterruption(session) {
        console.log("🛑 INTERRUPTING AI...");
        
        // Stop current audio playback
        session.isAISpeaking = false;
        session.currentAudioChunks = [];
        
        // Send "clear" command to stop Twilio audio
        try {
            session.ws.send(JSON.stringify({
                event: "clear",
                streamSid: session.streamSid
            }));
        } catch (err) {
            console.error("Error clearing audio:", err);
        }
        
        // Mark as interrupted
        session.userSpeechDetected = true;
    }

    // ✅ NEW: Generate response with streaming capability
    async handleUserMessage(session, userMessage) {
        try {
            // Generate LLM response
            const llmResponse = await this.callLLM(session);
            this.appendToContext(session, llmResponse, "model");

            // Speak response with interruption handling
            await this.speakWithInterruption(session, llmResponse);

        } catch (err) {
            console.error("❌ Error handling message:", err);
        }
    }

    // ✅ NEW: Speak with interruption support
    async speakWithInterruption(session, text) {
        console.log(`🔊 Speaking: "${text.substring(0, 50)}..."`);
        
        // Mark that AI is speaking
        session.isAISpeaking = true;
        session.userSpeechDetected = false;

        // Generate TTS audio
        const ttsAudio = await this.synthesizeTTS(text, session.agentVoiceId);
        
        if (!ttsAudio) {
            session.isAISpeaking = false;
            return;
        }

        // Store current audio chunks
        session.currentAudioChunks.push(ttsAudio);

        // Check if interrupted before sending
        if (session.userSpeechDetected) {
            console.log("⚠️  Interrupted before sending audio");
            session.isAISpeaking = false;
            return;
        }

        // Send audio to Twilio
        this.sendAudioToTwilio(session, ttsAudio);
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
            return "I apologize, I'm having trouble processing that.";
        }
    }

    async synthesizeTTS(text, voiceId) {
        try {
            const apiKey = this.getElevenLabsApiKey();
            
            if (!apiKey) {
                console.error("❌ Missing ElevenLabs API key");
                return null;
            }

            const response = await nodeFetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
                    method: 'POST',
                    headers: {
                        'Accept': 'audio/basic',
                        'Content-Type': 'application/json',
                        'xi-api-key': apiKey,
                    },
                    body: JSON.stringify({
                        text: text,
                        model_id: 'eleven_turbo_v2_5',
                        voice_settings: {
                            stability: 0.5,
                            similarity_boost: 0.75,
                            style: 0.0,
                            use_speaker_boost: true
                        },
                        output_format: 'ulaw_8000'
                    })
                }
            );
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ ElevenLabs error: ${response.status} - ${errorText}`);
                return null;
            }
            
            const audioBuffer = await response.buffer();
            return audioBuffer;
        } catch (err) {
            console.error("❌ TTS error:", err);
            return null;
        }
    }

    sendAudioToTwilio(session, audioBuffer) {
        try {
            if (!session.isReady || !session.streamSid) {
                session.audioQueue.push(audioBuffer);
                return;
            }

            const base64Audio = audioBuffer.toString("base64");
            const chunkSize = 214;
            let chunksSent = 0;

            for (let i = 0; i < base64Audio.length; i += chunkSize) {
                // ✅ Check for interruption before each chunk
                if (session.userSpeechDetected) {
                    console.log("⚠️  Stopped sending audio - user speaking");
                    session.isAISpeaking = false;
                    return;
                }

                const chunk = base64Audio.slice(i, i + chunkSize);
                session.ws.send(
                    JSON.stringify({
                        event: "media",
                        streamSid: session.streamSid,
                        media: { payload: chunk },
                    })
                );
                chunksSent++;
            }

            // Send completion mark
            session.ws.send(
                JSON.stringify({
                    event: "mark",
                    streamSid: session.streamSid,
                    mark: { name: "audio_complete" },
                })
            );

            console.log(`✅ Sent ${chunksSent} audio chunks`);
        } catch (err) {
            console.error("❌ Error sending audio:", err);
            session.isAISpeaking = false;
        }
    }

    appendToContext(session, text, role) {
        session.context.push({ role, parts: [{ text }] });
        console.log(`💬 ${role.toUpperCase()}: ${text}`);
    }

    endSession(callId) {
        const session = sessions.get(callId);
        if (session) {
            if (session.sttStream) {
                session.sttStream.finish();
                session.sttStream.removeAllListeners();
            }
            if (session.silenceTimer) {
                clearTimeout(session.silenceTimer);
            }
            sessions.delete(callId);
            console.log(`❌ Ended session ${callId}`);
        }
    }
}

module.exports = { MediaStreamHandler };
