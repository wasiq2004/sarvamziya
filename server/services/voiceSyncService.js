const nodeFetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

class VoiceSyncService {
    constructor(pool) {
        this.pool = pool;
        this.cache = {
            data: null,
            timestamp: null,
            ttl: 30 * 60 * 1000 // 30 minutes
        };
    }


    async syncAllProviders() {
        console.log('[VoiceSync] Starting sync for all providers...');

        const results = {
            success: true,
            synced: 0,
            errors: []
        };

        try {
            // Sync ElevenLabs voices
            const elevenLabsResult = await this.syncElevenLabsVoices();
            results.synced += elevenLabsResult.count;
            if (!elevenLabsResult.success) {
                results.errors.push(`ElevenLabs: ${elevenLabsResult.error}`);
            }
        } catch (error) {
            console.error('[VoiceSync] ElevenLabs sync failed:', error);
            results.errors.push(`ElevenLabs: ${error.message}`);
        }

        try {
            // Sync Sarvam voices
            const sarvamResult = await this.syncSarvamVoices();
            results.synced += sarvamResult.count;
            if (!sarvamResult.success) {
                results.errors.push(`Sarvam: ${sarvamResult.error}`);
            }
        } catch (error) {
            console.error('[VoiceSync] Sarvam sync failed:', error);
            results.errors.push(`Sarvam: ${error.message}`);
        }

        // Clear cache after sync
        this.cache.data = null;
        this.cache.timestamp = null;

        console.log(`[VoiceSync] Sync complete. Total synced: ${results.synced}, Errors: ${results.errors.length}`);

        return results;
    }

    async syncElevenLabsVoices() {
        console.log('[VoiceSync] Fetching ElevenLabs voices...');

        try {
            const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY;

            if (!apiKey) {
                return {
                    success: false,
                    count: 0,
                    error: 'ElevenLabs API key not configured'
                };
            }

            const response = await nodeFetch('https://api.elevenlabs.io/v1/voices', {
                method: 'GET',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`ElevenLabs API error: ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            const voices = data.voices || [];

            console.log(`[VoiceSync] Received ${voices.length} voices from ElevenLabs`);

            let syncedCount = 0;
            for (const rawVoice of voices) {
                try {
                    const voiceDTO = this.normalizeElevenLabsVoice(rawVoice);
                    await this.upsertVoice(voiceDTO);
                    syncedCount++;
                } catch (error) {
                    console.error(`[VoiceSync] Error upserting ElevenLabs voice ${rawVoice.voice_id}:`, error.message);
                }
            }

            return {
                success: true,
                count: syncedCount
            };

        } catch (error) {
            console.error('[VoiceSync] ElevenLabs sync error:', error);
            return {
                success: false,
                count: 0,
                error: error.message
            };
        }
    }

    async syncSarvamVoices() {
        console.log('[VoiceSync] Fetching Sarvam voices...');

        try {
            const apiKey = process.env.SARVAM_API_KEY;

            if (!apiKey) {
                console.log('[VoiceSync] Sarvam API key not configured, skipping...');
                return {
                    success: true,
                    count: 0
                };
            }

            // Note: Sarvam may not have a voices list API
            // For now, we'll create voices based on known speakers
            const sarvamVoices = [
                { speaker: 'anushka', language: 'en-IN', gender: 'female' },
                { speaker: 'abhilash', language: 'en-IN', gender: 'male' },
                { speaker: 'chitra', language: 'ta-IN', gender: 'female' },
                { speaker: 'meera', language: 'hi-IN', gender: 'female' },
                { speaker: 'arvind', language: 'hi-IN', gender: 'male' },
                { speaker: 'manisha', language: 'hi-IN', gender: 'female' },
                { speaker: 'vidya', language: 'en-IN', gender: 'female' },
                { speaker: 'arya', language: 'en-IN', gender: 'female' },
                { speaker: 'karun', language: 'en-IN', gender: 'male' },
                { speaker: 'hitesh', language: 'en-IN', gender: 'male' }
            ];

            console.log(`[VoiceSync] Creating ${sarvamVoices.length} Sarvam voices from known speakers`);

            let syncedCount = 0;
            for (const rawVoice of sarvamVoices) {
                try {
                    const voiceDTO = this.normalizeSarvamVoice(rawVoice);
                    await this.upsertVoice(voiceDTO);
                    syncedCount++;
                } catch (error) {
                    console.error(`[VoiceSync] Error upserting Sarvam voice ${rawVoice.speaker}:`, error.message);
                }
            }

            return {
                success: true,
                count: syncedCount
            };

        } catch (error) {
            console.error('[VoiceSync] Sarvam sync error:', error);
            return {
                success: false,
                count: 0,
                error: error.message
            };
        }
    }

  
    normalizeElevenLabsVoice(rawVoice) {
        return {
            provider: 'elevenlabs',
            providerVoiceId: rawVoice.voice_id,
            displayName: rawVoice.name,
            languageCode: rawVoice.labels?.language || 'en-US',
            gender: rawVoice.labels?.gender || null,
            sampleRate: null,
            locale: rawVoice.labels?.accent || null,
            isPreviewAvailable: !!rawVoice.preview_url,
            meta: {
                category: rawVoice.category,
                description: rawVoice.description,
                previewUrl: rawVoice.preview_url,
                labels: rawVoice.labels,
                settings: rawVoice.settings
            }
        };
    }


    normalizeSarvamVoice(rawVoice) {
        return {
            provider: 'sarvam',
            providerVoiceId: rawVoice.speaker,
            displayName: rawVoice.speaker.charAt(0).toUpperCase() + rawVoice.speaker.slice(1),
            languageCode: rawVoice.language || 'en-IN',
            gender: rawVoice.gender || null,
            sampleRate: null,
            locale: rawVoice.language || 'en-IN',
            isPreviewAvailable: true,
            meta: {
                speaker: rawVoice.speaker,
                supportedLanguages: [rawVoice.language]
            }
        };
    }


    async upsertVoice(voiceDTO) {
        try {
            const id = uuidv4();
            const metaJson = JSON.stringify(voiceDTO.meta || {});

            // Try to insert, on duplicate key update
            await this.pool.execute(
                `INSERT INTO voices 
                (id, provider, provider_voice_id, display_name, language_code, gender, sample_rate, locale, is_preview_available, meta)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                language_code = VALUES(language_code),
                gender = VALUES(gender),
                sample_rate = VALUES(sample_rate),
                locale = VALUES(locale),
                is_preview_available = VALUES(is_preview_available),
                meta = VALUES(meta),
                updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    voiceDTO.provider,
                    voiceDTO.providerVoiceId,
                    voiceDTO.displayName,
                    voiceDTO.languageCode,
                    voiceDTO.gender,
                    voiceDTO.sampleRate,
                    voiceDTO.locale,
                    voiceDTO.isPreviewAvailable,
                    metaJson
                ]
            );

            console.log(`[VoiceSync] Upserted voice: ${voiceDTO.provider}/${voiceDTO.providerVoiceId} - ${voiceDTO.displayName}`);

        } catch (error) {
            console.error('[VoiceSync] Error upserting voice:', error);
            throw error;
        }
    }


    async getVoices(provider = 'all') {
        try {
            // Check cache first
            if (this.cache.data && Date.now() - this.cache.timestamp < this.cache.ttl) {
                console.log('[VoiceSync] Returning cached voices');
                return this.filterVoicesByProvider(this.cache.data, provider);
            }

            // Fetch from database
            const [rows] = await this.pool.execute(
                'SELECT * FROM voices ORDER BY provider, display_name'
            );

            // Parse meta JSON (MySQL might return it as object or string depending on driver)
            const voices = rows.map(row => ({
                ...row,
                meta: typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta || {})
            }));

            // Update cache
            this.cache.data = voices;
            this.cache.timestamp = Date.now();

            console.log(`[VoiceSync] Fetched ${voices.length} voices from database`);

            return this.filterVoicesByProvider(voices, provider);

        } catch (error) {
            console.error('[VoiceSync] Error fetching voices:', error);
            throw error;
        }
    }


    filterVoicesByProvider(voices, provider) {
        if (provider === 'all') {
            return voices;
        }
        return voices.filter(v => v.provider === provider);
    }

    async getVoiceById(id) {
        try {
            // First try to find by UUID (id field)
            let [rows] = await this.pool.execute(
                'SELECT * FROM voices WHERE id = ?',
                [id]
            );

            // If not found, try to find by provider_voice_id (for backward compatibility)
            if (rows.length === 0) {
                [rows] = await this.pool.execute(
                    'SELECT * FROM voices WHERE provider_voice_id = ?',
                    [id]
                );
            }

            if (rows.length === 0) {
                return null;
            }

            const voice = rows[0];
            return {
                ...voice,
                meta: typeof voice.meta === 'string' ? JSON.parse(voice.meta) : (voice.meta || {})
            };

        } catch (error) {
            console.error('[VoiceSync] Error fetching voice by ID:', error);
            throw error;
        }
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.data = null;
        this.cache.timestamp = null;
        console.log('[VoiceSync] Cache cleared');
    }
}

module.exports = VoiceSyncService;
