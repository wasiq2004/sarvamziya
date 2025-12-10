const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { LLMService } = require("../llmService.js");

const sessions = new Map();

class DeepgramBrowserHandler {
    constructor(deepgramApiKey, geminiApiKey, mysqlPool = null) {
        if (!deepgramApiKey) throw new Error("Missing Deepgram API Key");
        if (!geminiApiKey) throw new Error("Missing Gemini API Key");

        this.deepgramClient = createClient(deepgramApiKey);
        this.llmService = new LLMService(geminiApiKey);
        this.mysqlPool = mysqlPool; // Add database pool for call logging
    }

    createSession(connectionId, agentPrompt, agentVoiceId, ws, userId = null, agentId = null) {
        const session = {
            id: connectionId,
            context: [],
            sttStream: null,
            agentPrompt,
            agentVoiceId: agentVoiceId || "21m00Tcm4TlvDq8ikWAM",
            ws,
            isReady: false,
            isSpeaking: false,
            lastUserSpeechTime: null,
            userId: userId,
            agentId: agentId,
            callId: null, // Will be set when call is logged
            startTime: new Date(),
        };
        sessions.set(connectionId, session);
        console.log(`✅ Created browser session ${connectionId} for user ${userId}, agent ${agentId}`);
        return session;
    }

    endSession(connectionId) {
        const session = sessions.get(connectionId);
        if (session) {
            if (session.sttStream) {
                // Check if finish exists before calling
                if (typeof session.sttStream.finish === 'function') {
                    session.sttStream.finish();
                }
                session.sttStream.removeAllListeners();
            }
            sessions.delete(connectionId);
            console.log(`❌ Ended browser session ${connectionId}`);
        }
    }

    appendToContext(session, text, role) {
        session.context.push({ role, parts: [{ text }] });
    }

    async handleConnection(ws, req) {
        const connectionId = 'browser_' + Date.now();
        let session = null;
        let deepgramLive = null;
        let keepAliveInterval = null;

        try {
            console.log(`📞 Browser WebSocket connection initiated: ${connectionId}`);

            // Parse query parameters
            const url = new URL(req.url, `http://${req.headers.host}`);
            const agentId = url.searchParams.get('agentId');
            const voiceId = url.searchParams.get('voiceId');
            const userId = url.searchParams.get('userId');
            let identity = url.searchParams.get('identity'); // Can be passed directly

            // Load agent details if agentId is present
            let agentPrompt = identity || "You are a helpful AI assistant.";
            let agentVoiceId = voiceId || "21m00Tcm4TlvDq8ikWAM"; // default
            let greetingMessage = "Hello! How can I help you today?";

            if (agentId && userId) {
                try {
                    const AgentService = require('./agentService.js');
                    const agentService = new AgentService(require('../config/database.js').default);
                    const agent = await agentService.getAgentById(userId, agentId);
                    if (agent) {
                        agentPrompt = agent.identity || agentPrompt;
                        if (agent.voiceId) agentVoiceId = agent.voiceId;
                        if (agent.settings?.greetingLine) greetingMessage = agent.settings.greetingLine;
                        console.log(`✅ Loaded agent details for ${agent.name}`);
                    }
                } catch (err) {
                    console.error("⚠️ Error loading agent details:", err);
                }
            }

            session = this.createSession(connectionId, agentPrompt, agentVoiceId, ws, userId, agentId);

            // Log call start to database
            await this.logCallStart(session);

            // Send initial greeting
            setTimeout(async () => {
                try {
                    if (ws.readyState === ws.OPEN) {
                        console.log(`👋 Sending greeting: "${greetingMessage}"`);

                        // Send text update
                        ws.send(JSON.stringify({
                            event: 'agent-response',
                            text: greetingMessage
                        }));

                        // Send audio
                        const audio = await this.synthesizeTTS(greetingMessage, session.agentVoiceId);
                        if (audio) {
                            this.sendAudioToClient(session, audio);
                        }
                    }
                } catch (e) {
                    console.error("❌ Error sending greeting:", e);
                }
            }, 500);

            // Initialize Deepgram for Browser Audio (Linear16 16kHz)
            console.log("🔄 Initializing Deepgram for browser stream...");
            deepgramLive = this.deepgramClient.listen.live({
                model: "nova-2",
                language: "en-US",
                smart_format: true,
                encoding: "linear16",
                sample_rate: 16000,
                interim_results: true,
                utterance_end_ms: 500, // Reduced from 1000ms for faster response
                punctuate: true,
            });

            session.sttStream = deepgramLive;

            // Deepgram Event Handlers
            deepgramLive.on(LiveTranscriptionEvents.Open, () => {
                console.log("✅ Deepgram browser connection opened");
            });

            deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
                try {
                    const transcript = data.channel?.alternatives?.[0]?.transcript;
                    const isFinal = data.is_final;

                    if (!isFinal || !transcript?.trim()) return;

                    console.log(`🎤 User (Browser): "${transcript}"`);
                    session.lastUserSpeechTime = Date.now();

                    // Send transcript to client for UI display
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({
                            event: 'transcript',
                            text: transcript
                        }));
                    }

                    // Handle Interruption
                    if (session.isSpeaking) {
                        console.log(`⚠️ User interrupted agent`);
                        session.isSpeaking = false;
                        // Tell client to stop audio
                        ws.send(JSON.stringify({ event: 'stop-audio' }));
                    }

                    this.appendToContext(session, transcript, "user");

                    // Get LLM Response
                    const llmResponse = await this.callLLM(session);
                    this.appendToContext(session, llmResponse, "model");

                    // Send text response to client immediately
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({
                            event: 'agent-response',
                            text: llmResponse
                        }));
                    }

                    // Generate TTS in parallel (don't await - let it happen in background)
                    console.log(`🔊 Synthesizing response...`);
                    this.synthesizeTTS(llmResponse, session.agentVoiceId)
                        .then(ttsAudio => {
                            if (ttsAudio) {
                                this.sendAudioToClient(session, ttsAudio);
                            }
                        })
                        .catch(err => {
                            console.error("❌ TTS generation failed:", err);
                        });

                } catch (err) {
                    console.error("❌ Error processing transcript:", err);
                }
            });

            deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                console.log("🎤 User finished speaking (browser)");
            });

            deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
                console.error("❌ Deepgram error:", err);
            });

            deepgramLive.on(LiveTranscriptionEvents.Close, () => {
                console.log("⚠️ Deepgram connection closed");
            });

            // WebSocket Message Handling
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);

                    if (data.event === 'audio' && data.data) {
                        // Received base64 audio from browser
                        const audioBuffer = Buffer.from(data.data, 'base64');
                        if (deepgramLive.getReadyState() === 1) { // OPEN
                            deepgramLive.send(audioBuffer);
                        }
                    } else if (data.event === 'ping') {
                        ws.send(JSON.stringify({ event: 'pong' }));
                    } else if (data.event === 'stop') {
                        this.endSession(connectionId);
                    }
                } catch (err) {
                    console.error("❌ Error handling message:", err);
                }
            });

            ws.on('close', async () => {
                console.log("🔌 Browser WebSocket closed");
                // Log call end before ending session
                if (session) {
                    await this.logCallEnd(session);
                }
                this.endSession(connectionId);
                if (keepAliveInterval) clearInterval(keepAliveInterval);
            });

            // Keep-alive setup
            keepAliveInterval = setInterval(() => {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.keepAlive();
                }
            }, 10000);


        } catch (err) {
            console.error("❌ Browser connection setup error:", err);
            ws.close();
        }
    }

    async callLLM(session) {
        try {
            console.log("🧠 Calling Gemini LLM...");
            const response = await this.llmService.generateContent({
                model: "models/gemini-2.5-flash",
                contents: session.context,
                config: { systemInstruction: session.agentPrompt },
            });
            console.log("🧠 Gemini response received");
            return response.text;
        } catch (err) {
            console.error("❌ LLM error details:", err.message);
            console.error(err.stack);
            return "I'm having trouble connecting to my brain right now.";
        }
    }

    async synthesizeTTS(text, voiceId) {
        try {
            console.log(`🔊 Generating TTS for: "${text.substring(0, 20)}..."`);
            const { generateTTS } = require('./tts_controller.js');
            // Request High Quality MP3 for browser playback
            const audioBuffer = await generateTTS(text, {
                voiceId,
                output_format: 'mp3_44100_128', // ElevenLabs
                format: 'mp3',                  // Sarvam
                skipConversion: true            // Sarvam (prevent ulaw conversion)
            });
            console.log(`✅ TTS generated: ${audioBuffer ? audioBuffer.length : 0} bytes`);
            return audioBuffer;
        } catch (err) {
            console.error("❌ TTS error details:", err.message);
            console.error(err.stack);
            return null;
        }
    }

    sendAudioToClient(session, audioBuffer) {
        if (!session.ws || session.ws.readyState !== session.ws.OPEN) return;

        session.isSpeaking = true;
        const base64Audio = audioBuffer.toString('base64');

        session.ws.send(JSON.stringify({
            event: 'audio',
            audio: base64Audio
        }));

        // Estimate duration for isSpeaking flag
        // MP3 128kbps = 16KB/s approx
        const durationSeconds = audioBuffer.length / 16000;
        setTimeout(() => {
            session.isSpeaking = false;
        }, durationSeconds * 1000);
    }

    async logCallStart(session) {
        if (!this.mysqlPool || !session.userId) {
            console.log('⚠️ Skipping call logging (no database pool or user ID)');
            return null;
        }

        try {
            const { v4: uuidv4 } = require('uuid');
            const callId = uuidv4();

            await this.mysqlPool.execute(
                `INSERT INTO calls (id, user_id, agent_id, call_sid, from_number, to_number, direction, status, call_type, started_at, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    callId,
                    session.userId,
                    session.agentId || null,
                    session.id, // Use session ID as call_sid for web calls
                    'web-browser', // from_number
                    'voice-agent', // to_number
                    'inbound', // direction
                    'in-progress', // status
                    'web_call', // call_type
                    session.startTime
                ]
            );

            session.callId = callId;
            console.log(`✅ Call logged to database: ${callId}`);
            return callId;
        } catch (err) {
            console.error('❌ Error logging call start:', err);
            return null;
        }
    }

    async logCallEnd(session) {
        if (!this.mysqlPool || !session.callId) {
            console.log('⚠️ Skipping call end logging (no database pool or call ID)');
            return;
        }

        try {
            const endTime = new Date();
            const duration = Math.floor((endTime - session.startTime) / 1000); // Duration in seconds

            await this.mysqlPool.execute(
                `UPDATE calls SET status = ?, ended_at = ?, duration = ? WHERE id = ?`,
                ['completed', endTime, duration, session.callId]
            );

            console.log(`✅ Call ended and logged: ${session.callId}, duration: ${duration}s`);
        } catch (err) {
            console.error('❌ Error logging call end:', err);
        }
    }
}

module.exports = { DeepgramBrowserHandler };
