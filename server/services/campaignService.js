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
    async createCampaign(userId, agentId = null, name, description = '', phoneNumberId = null) {
        try {
            const campaignId = uuidv4();

            // Insert campaign with only existing columns
            await this.mysqlPool.execute(
                `INSERT INTO campaigns (id, user_id, agent_id, name, status)
         VALUES (?, ?, ?, ?, 'draft')`,
                [campaignId, userId, agentId, name]
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
            // Check if campaign is already running
            if (this.activeCampaigns.has(campaignId)) {
                throw new Error('Campaign is already running');
            }

            // Get campaign details to check phone_number_id and agent_id
            const [campaigns] = await this.mysqlPool.execute(
                'SELECT * FROM campaigns WHERE id = ? AND user_id = ?',
                [campaignId, userId]
            );

            if (campaigns.length === 0) {
                throw new Error('Campaign not found');
            }

            const campaign = campaigns[0];

            // Validate phone_number_id and agent_id
            if (!campaign.phone_number_id || !campaign.agent_id) {
                // Try to auto-assign from user's first available phone number
                const [phoneNumbers] = await this.mysqlPool.execute(
                    'SELECT id, agent_id FROM user_twilio_numbers WHERE user_id = ? AND agent_id IS NOT NULL LIMIT 1',
                    [userId]
                );

                if (phoneNumbers.length === 0) {
                    throw new Error('Please set a caller phone number with an assigned agent before starting the campaign. Go to campaign settings and click "Set Caller Phone".');
                }

                // Auto-assign the first available phone number
                await this.mysqlPool.execute(
                    'UPDATE campaigns SET phone_number_id = ?, agent_id = ? WHERE id = ?',
                    [phoneNumbers[0].id, phoneNumbers[0].agent_id, campaignId]
                );

                console.log(`✅ Auto-assigned phone number ${phoneNumbers[0].id} to campaign ${campaignId}`);
            }

            // Check if user has sufficient balance
            const balanceCheck = await this.walletService.checkBalanceForCall(userId, 1.00);
            if (!balanceCheck.allowed) {
                throw new Error('Insufficient balance to start campaign. Minimum $1.00 required.');
            }

            // Update campaign status (only if not already running)
            const [result] = await this.mysqlPool.execute(
                `UPDATE campaigns SET status = 'running', started_at = NOW()
         WHERE id = ? AND status IN ('draft', 'paused')`,
                [campaignId]
            );

            if (result.affectedRows === 0) {
                throw new Error('Campaign is already running or does not exist');
            }

            // Mark as active in memory (processCampaign will be called from server.js)
            this.activeCampaigns.set(campaignId, { status: 'running' });

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
                `SELECT c.*, a.voice_id, a.identity, a.settings
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
            const campaignSettings = settings[0] || { call_interval_seconds: 5 };

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
                if (campaignSettings && campaignSettings.call_interval_seconds > 0) {
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
                'SELECT phone_number FROM user_twilio_numbers WHERE user_id = ? LIMIT 1',
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

            // Create comprehensive call record for call history
            const callId = uuidv4();
            await this.mysqlPool.execute(
                `INSERT INTO calls (
                    id, user_id, agent_id, call_sid, from_number, to_number, 
                    status, call_type, started_at, campaign_id, phone_number_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
                [
                    callId,
                    campaign.user_id,
                    campaign.agent_id,
                    call.sid,
                    fromNumber,
                    contact.phone_number,
                    'initiated',  // Initial status
                    'twilio_outbound',   // Must match ENUM: 'twilio_inbound', 'twilio_outbound', 'web_call'
                    campaignId,
                    campaign.phone_number_id || null  // Use campaign's phone_number_id
                ]
            );

            console.log(`📝 Call record created: ${callId} for contact ${contact.phone_number}`);

            // Update contact with call ID
            await this.mysqlPool.execute(
                'UPDATE campaign_contacts SET call_id = ?, status = \'calling\' WHERE id = ?',
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
       LEFT JOIN agents a ON c.agent_id = a.id
       WHERE c.id = ?`,
            [campaignId]
        );

        if (campaigns.length === 0) {
            throw new Error('Campaign not found');
        }

        return campaigns[0];
    }

    /**
     * Get campaign details with contact records
     */
    async getCampaignWithRecords(campaignId, userId) {
        // Get campaign details
        const [campaigns] = await this.mysqlPool.execute(
            `SELECT c.*, a.name as agent_name
       FROM campaigns c
       LEFT JOIN agents a ON c.agent_id = a.id
       WHERE c.id = ? AND c.user_id = ?`,
            [campaignId, userId]
        );

        if (campaigns.length === 0) {
            return null;
        }

        const campaign = campaigns[0];

        // Get campaign contacts/records
        const [records] = await this.mysqlPool.execute(
            `SELECT * FROM campaign_contacts 
       WHERE campaign_id = ?
       ORDER BY created_at DESC`,
            [campaignId]
        );

        // Map database fields to frontend-expected fields
        const mappedRecords = records.map(record => ({
            ...record,
            phone: record.phone_number,  // Map phone_number to phone
            callStatus: record.status     // Map status to callStatus
        }));

        return {
            campaign,
            records: mappedRecords
        };
    }

    /**
     * Get all campaigns for a user
     */
    async getUserCampaigns(userId) {
        const [campaigns] = await this.mysqlPool.execute(
            `SELECT c.*, a.name as agent_name
       FROM campaigns c
       LEFT JOIN agents a ON c.agent_id = a.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC`,
            [userId]
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

        // Get contact and campaign details for Google Sheets logging
        const [contacts] = await this.mysqlPool.execute(
            `SELECT cc.*, c.name as campaign_name, c.user_id, c.agent_id 
             FROM campaign_contacts cc
             JOIN campaigns c ON cc.campaign_id = c.id
             WHERE cc.id = ?`,
            [contactId]
        );

        if (contacts.length > 0) {
            const contact = contacts[0];
            const campaignId = contact.campaign_id;

            // Update campaign stats
            await this.mysqlPool.execute(
                `UPDATE campaigns SET 
         completed_calls = completed_calls + 1,
         successful_calls = successful_calls + IF(? = 'completed', 1, 0),
         total_cost = total_cost + ?
         WHERE id = ?`,
                [status, callCost, campaignId]
            );

            // Log to Google Sheets if configured
            try {
                await this.logToGoogleSheets(contact, callDuration, callCost, status);
            } catch (error) {
                console.error('Failed to log to Google Sheets:', error.message);
                // Don't fail the whole operation if Google Sheets logging fails
            }
        }
    }

    /**
     * Log call data to Google Sheets
     */
    async logToGoogleSheets(contact, callDuration, callCost, status) {
        try {
            // Get agent settings to find Google Sheets URL
            const [agents] = await this.mysqlPool.execute(
                'SELECT settings FROM agents WHERE id = ?',
                [contact.agent_id]
            );

            if (agents.length === 0) {
                console.log('No agent found for Google Sheets logging');
                return;
            }

            const agentSettings = typeof agents[0].settings === 'string'
                ? JSON.parse(agents[0].settings)
                : agents[0].settings;

            const googleSheetsUrl = agentSettings?.googleSheetsUrl || agentSettings?.google_sheets_url;

            if (!googleSheetsUrl) {
                console.log('No Google Sheets URL configured for this agent');
                return;
            }

            // Extract spreadsheet ID from URL
            const spreadsheetIdMatch = googleSheetsUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
            if (!spreadsheetIdMatch) {
                console.error('Invalid Google Sheets URL format');
                return;
            }

            const spreadsheetId = spreadsheetIdMatch[1];

            // Prepare data row
            const timestamp = new Date().toISOString();
            const rowData = [
                timestamp,
                contact.campaign_name || 'N/A',
                contact.name || 'Unknown',
                contact.phone_number,
                status,
                callDuration || 0,
                callCost || 0,
                contact.metadata ? JSON.stringify(contact.metadata) : ''
            ];

            // Use Google Sheets API with credentials from environment
            const { google } = require('googleapis');

            let auth;
            if (process.env.GOOGLE_CREDENTIALS_BASE64) {
                // Railway/Production: Use base64 encoded credentials
                const credentials = JSON.parse(
                    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
                );
                auth = new google.auth.GoogleAuth({
                    credentials: credentials,
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
            } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                // Local: Use credentials file
                auth = new google.auth.GoogleAuth({
                    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
            } else {
                console.error('No Google credentials configured');
                return;
            }

            const sheets = google.sheets({ version: 'v4', auth });

            // Append row to sheet
            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'Sheet1!A:H', // Adjust sheet name if needed
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [rowData]
                }
            });

            console.log(`✅ Logged call to Google Sheets: ${contact.phone_number}`);
        } catch (error) {
            console.error('Error logging to Google Sheets:', error.message);
            throw error;
        }
    }
    /**
     * Set caller phone and agent for a campaign
     */
    async setCallerPhone(campaignId, userId, phoneNumberId, agentId) {
        try {
            await this.mysqlPool.execute(
                `UPDATE campaigns SET phone_number_id = ?, agent_id = ? WHERE id = ? AND user_id = ?`,
                [phoneNumberId, agentId, campaignId, userId]
            );
            return this.getCampaign(campaignId);
        } catch (error) {
            console.error('Error setting caller phone:', error);
            throw error;
        }
    }

    /**
     * Delete a campaign
     */
    async deleteCampaign(campaignId, userId) {
        try {
            // Verify campaign belongs to user before deleting
            const [campaigns] = await this.mysqlPool.execute(
                'SELECT id FROM campaigns WHERE id = ? AND user_id = ?',
                [campaignId, userId]
            );

            if (campaigns.length === 0) {
                throw new Error('Campaign not found or access denied');
            }

            // Delete campaign (cascade will handle contacts and settings)
            await this.mysqlPool.execute(
                'DELETE FROM campaigns WHERE id = ? AND user_id = ?',
                [campaignId, userId]
            );

            return { success: true, message: 'Campaign deleted successfully' };
        } catch (error) {
            console.error('Error deleting campaign:', error);
            throw error;
        }
    }

    /**
     * Delete a record/contact from a campaign
     */
    async deleteRecord(recordId, campaignId, userId) {
        try {
            // Verify the campaign belongs to the user
            const [campaigns] = await this.mysqlPool.execute(
                'SELECT id FROM campaigns WHERE id = ? AND user_id = ?',
                [campaignId, userId]
            );

            if (campaigns.length === 0) {
                throw new Error('Campaign not found or access denied');
            }

            // Delete the contact record
            const [result] = await this.mysqlPool.execute(
                'DELETE FROM campaign_contacts WHERE id = ? AND campaign_id = ?',
                [recordId, campaignId]
            );

            if (result.affectedRows === 0) {
                return null; // Record not found
            }

            // Update total contacts count
            await this.mysqlPool.execute(
                `UPDATE campaigns SET total_contacts = (
          SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?
        ) WHERE id = ?`,
                [campaignId, campaignId]
            );

            return { success: true, message: 'Record deleted successfully' };
        } catch (error) {
            console.error('Error deleting record:', error);
            throw error;
        }
    }

    /**
     * Update a campaign
     */
    async updateCampaign(campaignId, userId, campaignData) {
        try {
            const updates = [];
            const values = [];

            if (campaignData.name) {
                updates.push('name = ?');
                values.push(campaignData.name);
            }
            if (campaignData.description !== undefined) {
                updates.push('description = ?');
                values.push(campaignData.description);
            }
            if (campaignData.agent_id) {
                updates.push('agent_id = ?');
                values.push(campaignData.agent_id);
            }
            if (campaignData.phone_number_id) {
                updates.push('phone_number_id = ?');
                values.push(campaignData.phone_number_id);
            }

            if (updates.length === 0) {
                throw new Error('No fields to update');
            }

            values.push(campaignId, userId);

            await this.mysqlPool.execute(
                `UPDATE campaigns SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
                values
            );

            return this.getCampaign(campaignId);
        } catch (error) {
            console.error('Error updating campaign:', error);
            throw error;
        }
    }

    /**
     * Stop/pause a campaign
     */
    async stopCampaign(campaignId, userId) {
        try {
            await this.mysqlPool.execute(
                `UPDATE campaigns SET status = 'paused' WHERE id = ? AND user_id = ?`,
                [campaignId, userId]
            );

            // Update in-memory state
            const campaignState = this.activeCampaigns.get(campaignId);
            if (campaignState) {
                campaignState.status = 'paused';
            }

            return { success: true, message: 'Campaign paused' };
        } catch (error) {
            console.error('Error stopping campaign:', error);
            throw error;
        }
    }
}


module.exports = CampaignService;
