const express = require('express');
const router = express.Router();

/**
 * Get call history for a specific user
 * GET /api/calls/:userId
 * Query params: limit, offset, agentId, callType, startDate, endDate
 */
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const {
            limit = 50,
            offset = 0,
            agentId,
            callType,
            startDate,
            endDate
        } = req.query;

        const mysqlPool = req.app.get('mysqlPool');

        // Build WHERE clause with user isolation
        let whereConditions = ['c.user_id = ?'];
        let filterParams = [userId];

        // Add optional filters
        if (agentId) {
            whereConditions.push('c.agent_id = ?');
            filterParams.push(agentId);
        }

        if (callType) {
            whereConditions.push('c.call_type = ?');
            filterParams.push(callType);
        }

        if (startDate) {
            whereConditions.push('c.started_at >= ?');
            filterParams.push(startDate);
        }

        if (endDate) {
            whereConditions.push('c.started_at <= ?');
            filterParams.push(endDate);
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count
        const countQuery = `SELECT COUNT(*) as total FROM calls c WHERE ${whereClause}`;
        const [countResult] = await mysqlPool.execute(countQuery, filterParams);
        const total = countResult[0].total;

        // Create params array for SELECT query: just filters (LIMIT/OFFSET interpolated)
        const selectParams = [...filterParams];

        // Ensure limit/offset are numbers to prevent injection
        const limitNum = parseInt(limit) || 50;
        const offsetNum = parseInt(offset) || 0;

        const selectQuery = `
            SELECT 
                c.id,
                c.user_id,
                c.agent_id,
                c.call_sid,
                c.from_number,
                c.to_number,
                c.status,
                c.call_type,
                c.started_at,
                c.ended_at,
                c.duration,
                c.provider,
                c.model,
                c.voice_id,
                a.name as agent_name
            FROM calls c
            LEFT JOIN agents a ON c.agent_id = a.id
            WHERE ${whereClause}
            ORDER BY c.started_at DESC
            LIMIT ${limitNum} OFFSET ${offsetNum}
        `;

        const [calls] = await mysqlPool.execute(selectQuery, selectParams);

        // Format response
        const formattedCalls = calls.map(call => ({
            id: call.id,
            callSid: call.call_sid,
            fromNumber: call.from_number,
            toNumber: call.to_number,
            direction: null,
            status: call.status,
            callType: call.call_type || 'web_call',
            timestamp: call.started_at,
            startedAt: call.started_at,
            endedAt: call.ended_at,
            duration: call.duration || 0,
            recordingUrl: null,
            agentId: call.agent_id,
            agentName: call.agent_name || 'Unknown Agent',
            provider: call.provider,
            model: call.model,
            voiceId: call.voice_id
        }));

        res.json({
            success: true,
            calls: formattedCalls,
            pagination: {
                total,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: (parseInt(offset) + parseInt(limit)) < total
            }
        });

    } catch (error) {
        console.error('Error fetching call history:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call history',
            error: error.message
        });
    }
});

module.exports = router;
