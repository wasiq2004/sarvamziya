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
        let queryParams = [userId];

        // Add optional filters
        if (agentId) {
            whereConditions.push('c.agent_id = ?');
            queryParams.push(agentId);
        }

        if (callType) {
            whereConditions.push('c.call_type = ?');
            queryParams.push(callType);
        }

        if (startDate) {
            whereConditions.push('c.timestamp >= ?');
            queryParams.push(startDate);
        }

        if (endDate) {
            whereConditions.push('c.timestamp <= ?');
            queryParams.push(endDate);
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count
        const [countResult] = await mysqlPool.execute(
            `SELECT COUNT(*) as total FROM calls c WHERE ${whereClause}`,
            queryParams
        );
        const total = countResult[0].total;

        // Get paginated results with agent name
        const query = `
            SELECT 
                c.id,
                c.user_id,
                c.call_sid,
                c.from_number,
                c.to_number,
                c.status,
                c.call_type,
                c.started_at,
                c.ended_at,
                c.duration,
                c.recording_url,
                c.agent_id,
                a.name as agent_name
            FROM calls c
            LEFT JOIN agents a ON c.agent_id = a.id
            WHERE ${whereClause}
            ORDER BY c.started_at DESC
            LIMIT ? OFFSET ?
        `;

        queryParams.push(parseInt(limit), parseInt(offset));

        const [calls] = await mysqlPool.execute(query, queryParams);

        // Format response
        const formattedCalls = calls.map(call => ({
            id: call.id,
            callSid: call.call_sid,
            fromNumber: call.from_number,
            toNumber: call.to_number,
            direction: null, // Column doesn't exist in production
            status: call.status,
            callType: call.call_type || 'web_call',
            timestamp: call.started_at, // Use started_at as timestamp
            startedAt: call.started_at,
            endedAt: call.ended_at,
            duration: call.duration || 0,
            recordingUrl: call.recording_url,
            agentId: call.agent_id,
            agentName: call.agent_name || 'Unknown Agent'
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
