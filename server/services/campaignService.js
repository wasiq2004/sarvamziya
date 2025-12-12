const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');

class CampaignService {
    constructor(mysqlPool, walletService, costCalculator) {
        this.mysqlPool = mysqlPool;
        this.walletService = walletService;
        this.costCalculator = costCalculator;
        this.activeCampaigns = new Map(); // Track running campaigns

        // Initialize Twilio client
        this.twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
    }

    /**
     * Create a new campaign
     */
    async createCampaign(userId, agentId, name, description = '') {
        try {
            const campaignId = uuidv4();

            await this.mysqlPool.execute(
                `INSERT INTO campaigns (id, user_id, agent_id, name, description, status)
         VALUES (?, ?, ?, ?, ?, 'draft')`,
                [campaignId, userId, agentId, name, description]
            );

            // Create default settings
            await this.mysqlPool.execute(
                `INSERT INTO campaign_settings (id, campaign_id)
         VALUES (?, ?)`,
                [uuidv4(), campaignId]
            );

            return { success: true, campaignId };
        } catch (error) {
            console.error('Error creating campaign:', error);
            throw error;
        }
    }

    /**
     * Add contacts to campaign (bulk)
     */
    async addContacts(campaignId, contacts) {
        try {
            const values = contacts.map(contact => [
                uuidv4(),
                campaignId,
                contact.phone_number,
                contact.name || null,
                contact.metadata ? JSON.stringify(contact.metadata) : null
            ]);

            await this.mysqlPool.query(
                `INSERT INTO campaign_contacts (id, campaign_id, phone_number, name, metadata)
         VALUES ?`,
                [values]
            );

            // Update total contacts count
            await this.mysqlPool.execute(
                `UPDATE campaigns SET total_contacts = (
          SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?
        ) WHERE id = ?`,
                [campaignId, campaignId]
            );

            return { success: true, added: contacts.length };
        } catch (error) {
            console.error('Error adding contacts:', error);
            throw error;
        }
    }

    /**
     * Start a campaign
     */
    async startCampaign(campaignId, userId) {
        try {
            // Check if user has sufficient balance
            const balanceCheck = await this.walletService.checkBalanceForCall(userId, 1.00);
            if (!balanceCheck.allowed) {
                throw new Error('Insufficient balance to start campaign. Minimum $1.00 required.');
            }

            // Update campaign status
            await this.mysqlPool.execute(
                `UPDATE campaigns SET status = 'running', started_at = NOW()
         WHERE id = ? AND status = 'draft'`,
                [campaignId]
            );

            // Start processing calls
            this.processCampaign(campaignId, userId);

            return { success: true, message: 'Campaign started' };
        } catch (error) {
            console.error('Error starting campaign:', error);
            throw error;
        }
    }

    /**
     * Process campaign - make calls to all contacts
     */
    async processCampaign(campaignId, userId) {
        try {
            console.log(`📞 Starting campaign ${campaignId}`);
            this.activeCampaigns.set(campaignId, { status: 'running' });

            // Get campaign details
            const [campaigns] = await this.mysqlPool.execute(
                `SELECT c.*, a.voiceId, a.identity, a.settings
         FROM campaigns c
         JOIN agents a ON c.agent_id = a.id
         WHERE c.id = ?`,
                [campaignId]
            );

            if (campaigns.length === 0) {
                throw new Error('Campaign not found');
            }

            const campaign = campaigns[0];
            const agentSettings = typeof campaign.settings === 'string'
                ? JSON.parse(campaign.settings)
                : campaign.settings;

            // Get campaign settings
            const [settings] = await this.mysqlPool.execute(
                'SELECT * FROM campaign_settings WHERE campaign_id = ?',
                [campaignId]
            );
            const campaignSettings = settings[0];

            // Get pending contacts
            const [contacts] = await this.mysqlPool.execute(
                `SELECT * FROM campaign_contacts 
         WHERE campaign_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
                [campaignId]
            );

            console.log(`📋 Found ${contacts.length} contacts to call`);

            // Process each contact
            for (const contact of contacts) {
                // Check if campaign is still running
                const campaignState = this.activeCampaigns.get(campaignId);
                if (!campaignState || campaignState.status !== 'running') {
                    console.log(`⏸️ Campaign ${campaignId} paused or stopped`);
                    break;
                }

                // Check user balance before each call
                const balanceCheck = await this.walletService.checkBalanceForCall(userId, 0.10);
                if (!balanceCheck.allowed) {
                    console.error(`❌ Insufficient balance, pausing campaign ${campaignId}`);
                    await this.pauseCampaign(campaignId);
                    break;
                }

                // Make the call
                await this.makeCall(campaignId, contact, campaign, agentSettings);

                // Wait between calls
                if (campaignSettings.call_interval_seconds > 0) {
                    await new Promise(resolve =>
                        setTimeout(resolve, campaignSettings.call_interval_seconds * 1000)
                    );
                }
            }

            // Mark campaign as completed
            await this.completeCampaign(campaignId);

        } catch (error) {
            console.error(`Error processing campaign ${campaignId}:`, error);
            await this.mysqlPool.execute(
                `UPDATE campaigns SET status = 'cancelled' WHERE id = ?`,
                [campaignId]
            );
        } finally {
            this.activeCampaigns.delete(campaignId);
        }
    }

    /**
     * Make a call to a contact
     */
    async makeCall(campaignId, contact, campaign, agentSettings) {
        try {
            console.log(`📞 Calling ${contact.phone_number} (${contact.name || 'Unknown'})`);

            // Update contact status
            await this.mysqlPool.execute(
                `UPDATE campaign_contacts 
         SET status = 'calling', attempts = attempts + 1, last_attempt_at = NOW()
         WHERE id = ?`,
                [contact.id]
            );

            // Get Twilio phone number for this user
            const [twilioNumbers] = await this.mysqlPool.execute(
                'SELECT phone_number FROM user_twilio_numbers WHERE user_id = ? AND is_active = TRUE LIMIT 1',
                [campaign.user_id]
            );

            if (twilioNumbers.length === 0) {
                throw new Error('No active Twilio number found');
            }

            const fromNumber = twilioNumbers[0].phone_number;

            // Create TwiML URL with campaign parameters
            const twimlUrl = `${process.env.BASE_URL || 'https://ziyavoice-production.up.railway.app'}/api/twilio/voice?` +
                `agentId=${campaign.agent_id}&` +
                `userId=${campaign.user_id}&` +
                `campaignId=${campaignId}&` +
                `contactId=${contact.id}`;

            // Make the call using Twilio
            const call = await this.twilioClient.calls.create({
                from: fromNumber,
                to: contact.phone_number,
                url: twimlUrl,
                statusCallback: `${process.env.BASE_URL || 'https://ziyavoice-production.up.railway.app'}/api/twilio/status`,
                statusCallbackEvent: ['completed'],
                statusCallbackMethod: 'POST'
            });

            console.log(`✅ Call initiated: ${call.sid}`);

            // Create call record
            const callId = uuidv4();
            await this.mysqlPool.execute(
                `INSERT INTO calls (id, user_id, agent_id, call_sid, from_number, to_number, status, call_type, started_at, timestamp, campaign_id)
         VALUES (?, ?, ?, ?, ?, ?, 'in-progress', 'outbound', NOW(), NOW(), ?)`,
                [callId, campaign.user_id, campaign.agent_id, call.sid, fromNumber, contact.phone_number, campaignId]
            );

            // Update contact with call ID
            await this.mysqlPool.execute(
                'UPDATE campaign_contacts SET call_id = ? WHERE id = ?',
                [callId, contact.id]
            );

            return { success: true, callSid: call.sid, callId };

        } catch (error) {
            console.error(`Error making call to ${contact.phone_number}:`, error);

            // Mark contact as failed
            await this.mysqlPool.execute(
                `UPDATE campaign_contacts 
         SET status = 'failed', error_message = ?, completed_at = NOW()
         WHERE id = ?`,
                [error.message, contact.id]
            );

            // Update campaign failed calls count
            await this.mysqlPool.execute(
                'UPDATE campaigns SET failed_calls = failed_calls + 1 WHERE id = ?',
                [campaignId]
            );

            return { success: false, error: error.message };
        }
    }

    /**
     * Pause a campaign
     */
    async pauseCampaign(campaignId) {
        await this.mysqlPool.execute(
            `UPDATE campaigns SET status = 'paused' WHERE id = ?`,
            [campaignId]
        );

        const campaignState = this.activeCampaigns.get(campaignId);
        if (campaignState) {
            campaignState.status = 'paused';
        }
    }

    /**
     * Complete a campaign
     */
    async completeCampaign(campaignId) {
        await this.mysqlPool.execute(
            `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = ?`,
            [campaignId]
        );
        console.log(`✅ Campaign ${campaignId} completed`);
    }

    /**
     * Get campaign details
     */
    async getCampaign(campaignId) {
        const [campaigns] = await this.mysqlPool.execute(
            `SELECT c.*, a.name as agent_name
       FROM campaigns c
       JOIN agents a ON c.agent_id = a.id
       WHERE c.id = ?`,
            [campaignId]
        );

        if (campaigns.length === 0) {
            throw new Error('Campaign not found');
        }

        return campaigns[0];
    }

    /**
     * Get all campaigns for a user
     */
    async getUserCampaigns(userId, limit = 50, offset = 0) {
        // Ensure limit and offset are integers
        const parsedLimit = parseInt(limit) || 50;
        const parsedOffset = parseInt(offset) || 0;

        const [campaigns] = await this.mysqlPool.execute(
            `SELECT c.*, a.name as agent_name
       FROM campaigns c
       JOIN agents a ON c.agent_id = a.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
            [userId, parsedLimit, parsedOffset]
        );

        return campaigns;
    }

    /**
     * Get campaign contacts
     */
    async getCampaignContacts(campaignId, status = null) {
        let query = 'SELECT * FROM campaign_contacts WHERE campaign_id = ?';
        const params = [campaignId];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        query += ' ORDER BY created_at ASC';

        const [contacts] = await this.mysqlPool.execute(query, params);
        return contacts;
    }

    /**
     * Update campaign contact after call completion
     */
    async updateContactAfterCall(contactId, callDuration, callCost, status = 'completed') {
        await this.mysqlPool.execute(
            `UPDATE campaign_contacts 
       SET status = ?, call_duration = ?, call_cost = ?, completed_at = NOW()
       WHERE id = ?`,
            [status, callDuration, callCost, contactId]
        );

        // Update campaign stats
        const [contacts] = await this.mysqlPool.execute(
            'SELECT campaign_id FROM campaign_contacts WHERE id = ?',
            [contactId]
        );

        if (contacts.length > 0) {
            const campaignId = contacts[0].campaign_id;

            await this.mysqlPool.execute(
                `UPDATE campaigns SET 
         completed_calls = completed_calls + 1,
         successful_calls = successful_calls + IF(? = 'completed', 1, 0),
         total_cost = total_cost + ?
         WHERE id = ?`,
                [status, callCost, campaignId]
            );
        }
    }
}

module.exports = CampaignService;
