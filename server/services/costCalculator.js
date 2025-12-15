const { v4: uuidv4 } = require('uuid');

/**
 * Cost Calculator Service
 * Calculates costs for various services based on usage
 */
class CostCalculator {
    constructor(mysqlPool, walletService) {
        this.mysqlPool = mysqlPool;
        this.walletService = walletService;
        this.pricingCache = new Map();
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = 0;
    }

    /**
     * Get pricing for all services (with caching)
     */
    async getPricing() {
        const now = Date.now();
        if (now - this.lastCacheUpdate > this.cacheExpiry) {
            const [pricing] = await this.mysqlPool.execute(
                'SELECT * FROM service_pricing'
            );

            this.pricingCache.clear();
            pricing.forEach(p => {
                this.pricingCache.set(p.service_type, {
                    costPerUnit: parseFloat(p.cost_per_unit),
                    unitType: p.unit_type
                });
            });

            this.lastCacheUpdate = now;
        }

        return this.pricingCache;
    }

    /**
     * Calculate cost for a specific service
     */
    async calculateServiceCost(serviceType, unitsUsed) {
        await this.getPricing();

        const pricing = this.pricingCache.get(serviceType);
        if (!pricing) {
            console.warn(`No pricing found for service: ${serviceType}`);
            return 0;
        }

        const cost = pricing.costPerUnit * parseFloat(unitsUsed);
        return parseFloat(cost.toFixed(6));
    }

    /**
     * Calculate total cost for a call based on all services used
     * @param {Object} usage - Object containing usage for each service
     * @returns {Object} - Breakdown of costs
     */
    async calculateCallCost(usage) {
        const costs = {};
        let totalCost = 0;

        for (const [service, units] of Object.entries(usage)) {
            if (units > 0) {
                const cost = await this.calculateServiceCost(service, units);
                costs[service] = {
                    units: parseFloat(units),
                    cost: cost
                };
                totalCost += cost;
            }
        }

        return {
            breakdown: costs,
            totalCost: parseFloat(totalCost.toFixed(4))
        };
    }

    /**
     * Estimate cost for ElevenLabs TTS
     * @param {string} text - Text to be synthesized
     * @returns {number} - Estimated cost
     */
    async estimateElevenLabsCost(text) {
        const characters = text.length;
        return await this.calculateServiceCost('elevenlabs', characters);
    }

    /**
     * Estimate cost for Sarvam TTS
     * @param {string} text - Text to be synthesized
     * @returns {number} - Estimated cost
     */
    async estimateSarvamCost(text) {
        const characters = text.length;
        return await this.calculateServiceCost('sarvam', characters);
    }

    /**
     * Estimate cost for Deepgram STT
     * @param {number} durationSeconds - Audio duration in seconds
     * @returns {number} - Estimated cost
     */
    async estimateDeepgramCost(durationSeconds) {
        return await this.calculateServiceCost('deepgram', durationSeconds);
    }

    /**
     * Estimate cost for Gemini
     * @param {number} tokens - Number of tokens (input + output)
     * @returns {number} - Estimated cost
     */
    async estimateGeminiCost(tokens) {
        return await this.calculateServiceCost('gemini', tokens);
    }

    /**
     * Estimate cost for Twilio
     * @param {number} durationSeconds - Call duration in seconds
     * @returns {number} - Estimated cost
     */
    async estimateTwilioCost(durationSeconds) {
        const minutes = durationSeconds / 60;
        return await this.calculateServiceCost('twilio', minutes);
    }

    /**
     * Check if user has sufficient balance for estimated cost
     * @param {string} userId - User ID
     * @param {number} estimatedCost - Estimated cost
     * @returns {boolean} - True if sufficient balance
     */
    async checkSufficientBalance(userId, estimatedCost) {
        try {
            const balance = await this.walletService.getBalance(userId);
            return balance >= estimatedCost;
        } catch (error) {
            console.error('Error checking balance:', error);
            return false;
        }
    }

    /**
     * Record usage and charge user
     * @param {string} userId - User ID
     * @param {string} callId - Call ID
     * @param {Object} usage - Usage breakdown by service
     * @returns {Object} - Result with total charged
     */
    async recordAndCharge(userId, callId, usage) {
        try {
            const costBreakdown = await this.calculateCallCost(usage);

            // Check if user has sufficient balance
            const hasSufficientBalance = await this.checkSufficientBalance(
                userId,
                costBreakdown.totalCost
            );

            if (!hasSufficientBalance) {
                throw new Error('Insufficient balance');
            }

            // Record each service usage
            const usageRecords = [];
            for (const [service, data] of Object.entries(costBreakdown.breakdown)) {
                const usageId = uuidv4();
                await this.mysqlPool.execute(
                    `INSERT INTO service_usage 
          (id, user_id, call_id, service_type, units_used, cost_per_unit, total_cost, metadata) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        usageId,
                        userId,
                        callId,
                        service,
                        data.units,
                        this.pricingCache.get(service).costPerUnit,
                        data.cost,
                        JSON.stringify({ timestamp: new Date().toISOString() })
                    ]
                );
                usageRecords.push({ service, ...data });
            }

            // Deduct total cost from wallet
            const description = `Call ${callId.substring(0, 8)} - ${Object.keys(costBreakdown.breakdown).join(', ')}`;
            await this.walletService.deductCredits(
                userId,
                costBreakdown.totalCost,
                'call_usage',
                description,
                callId,
                { breakdown: costBreakdown.breakdown }
            );

            return {
                success: true,
                totalCharged: costBreakdown.totalCost,
                breakdown: costBreakdown.breakdown,
                usageRecords
            };
        } catch (error) {
            console.error('Error recording and charging:', error);
            throw error;
        }
    }

    /**
     * Get cost summary for a date range
     * @param {string} userId - User ID
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {Object} - Cost summary
     */
    async getCostSummary(userId, startDate, endDate) {
        try {
            const [results] = await this.mysqlPool.execute(
                `SELECT 
          service_type,
          SUM(units_used) as total_units,
          SUM(total_cost) as total_cost,
          COUNT(*) as usage_count
        FROM service_usage
        WHERE user_id = ? AND created_at BETWEEN ? AND ?
        GROUP BY service_type`,
                [userId, startDate, endDate]
            );

            const summary = {
                totalCost: 0,
                services: {}
            };

            results.forEach(row => {
                const cost = parseFloat(row.total_cost);
                summary.totalCost += cost;
                summary.services[row.service_type] = {
                    units: parseFloat(row.total_units),
                    cost: cost,
                    count: parseInt(row.usage_count)
                };
            });

            summary.totalCost = parseFloat(summary.totalCost.toFixed(4));

            return summary;
        } catch (error) {
            console.error('Error getting cost summary:', error);
            throw error;
        }
    }
}

module.exports = CostCalculator;
