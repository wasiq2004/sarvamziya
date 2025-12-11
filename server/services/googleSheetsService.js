const { google } = require('googleapis');

class GoogleSheetsService {
  constructor() {
    // Initialize Google Sheets API
    this.sheets = null;
    this.auth = null;
  }

  /**
   * Initialize Google Sheets with service account credentials
   */
  async initialize() {
    try {
      // Option 1: Using Service Account (Recommended for server-to-server)
      if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        this.auth = new google.auth.GoogleAuth({
          credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          },
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        this.sheets = google.sheets({ version: 'v4', auth: this.auth });
        console.log('Google Sheets initialized with service account');
        return true;
      }

      // Option 2: Using API Key (Limited functionality)
      if (process.env.GOOGLE_API_KEY) {
        this.sheets = google.sheets({
          version: 'v4',
          auth: process.env.GOOGLE_API_KEY
        });
        console.log('Google Sheets initialized with API key');
        return true;
      }

      console.warn('Google Sheets not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY or GOOGLE_API_KEY');
      return false;

    } catch (error) {
      console.error('Error initializing Google Sheets:', error);
      return false;
    }
  }

  /**
   * Extract spreadsheet ID from Google Sheets URL
   */
  extractSpreadsheetId(url) {
    if (!url) return null;

    // Match patterns like:
    // https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
    // https://docs.google.com/spreadsheets/d/SPREADSHEET_ID
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  /**
   * Validate that a spreadsheet exists and is accessible
   */
  async validateSpreadsheet(spreadsheetId) {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      if (!this.sheets) {
        throw new Error('Google Sheets API not initialized');
      }

      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId,
      });

      return {
        valid: true,
        title: response.data.properties.title,
      };
    } catch (error) {
      console.error('Error validating spreadsheet:', error);
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  /**
   * Initialize spreadsheet with headers if needed
   */
  async initializeHeaders(spreadsheetId, sheetName = 'Call Logs') {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      // Check if sheet exists
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId,
      });

      const sheet = spreadsheet.data.sheets.find(
        s => s.properties.title === sheetName
      );

      let sheetId;
      if (!sheet) {
        // Create new sheet
        const addSheetResponse = await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: sheetName,
                },
              },
            }],
          },
        });
        sheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;
      } else {
        sheetId = sheet.properties.sheetId;
      }

      // Check if headers exist
      const range = `${sheetName}!A1:K1`;
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: range,
      });

      // If no headers, add them
      if (!response.data.values || response.data.values.length === 0) {
        const headers = [
          'Timestamp',
          'Phone Number',
          'Call Status',
          'Call Duration (seconds)',
          'Call SID',
          'Recording URL',
          'Agent Name',
          'Campaign Name',
          'Retries',
          'Notes',
          'Metadata'
        ];

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A1:K1`,
          valueInputOption: 'RAW',
          resource: {
            values: [headers],
          },
        });

        // Format headers (bold)
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                },
                cell: {
                  userEnteredFormat: {
                    textFormat: {
                      bold: true,
                    },
                    backgroundColor: {
                      red: 0.9,
                      green: 0.9,
                      blue: 0.9,
                    },
                  },
                },
                fields: 'userEnteredFormat(textFormat,backgroundColor)',
              },
            }],
          },
        });
      }

      return { success: true, sheetName: sheetName };
    } catch (error) {
      console.error('Error initializing headers:', error);
      throw error;
    }
  }

  /**
   * Append call data to Google Sheet
   */
  async logCallData(spreadsheetId, callData, sheetName = 'Call Logs') {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      if (!this.sheets) {
        console.error('Google Sheets API not initialized');
        return { success: false, error: 'API not initialized' };
      }

      // Ensure headers exist
      await this.initializeHeaders(spreadsheetId, sheetName);

      // Prepare row data
      const row = [
        new Date().toISOString(),
        callData.phone || '',
        callData.callStatus || '',
        callData.duration || 0,
        callData.callSid || '',
        callData.recordingUrl || '',
        callData.agentName || '',
        callData.campaignName || '',
        callData.retries || 0,
        callData.notes || '',
        JSON.stringify(callData.metadata || {})
      ];

      // Append data
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:K`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [row],
        },
      });

      console.log('Call data logged to Google Sheets:', callData.phone);
      return {
        success: true,
        updatedRange: response.data.updates.updatedRange
      };

    } catch (error) {
      console.error('Error logging call data to Google Sheets:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update existing call record in sheet
   */
  async updateCallData(spreadsheetId, callSid, updateData, sheetName = 'Call Logs') {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      // Find the row with matching Call SID
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:K`,
      });

      const rows = response.data.values;
      if (!rows || rows.length <= 1) {
        console.log('No data rows found');
        return { success: false, error: 'No data found' };
      }

      // Find row index (skip header)
      let rowIndex = -1;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][4] === callSid) { // Column E (index 4) is Call SID
          rowIndex = i + 1; // +1 because sheets are 1-indexed
          break;
        }
      }

      if (rowIndex === -1) {
        console.log('Call SID not found in sheet');
        return { success: false, error: 'Call not found' };
      }

      // Update specific columns
      const updates = [];

      if (updateData.callStatus !== undefined) {
        updates.push({
          range: `${sheetName}!C${rowIndex}`,
          values: [[updateData.callStatus]],
        });
      }

      if (updateData.duration !== undefined) {
        updates.push({
          range: `${sheetName}!D${rowIndex}`,
          values: [[updateData.duration]],
        });
      }

      if (updateData.recordingUrl !== undefined) {
        updates.push({
          range: `${sheetName}!F${rowIndex}`,
          values: [[updateData.recordingUrl]],
        });
      }

      if (updateData.notes !== undefined) {
        updates.push({
          range: `${sheetName}!J${rowIndex}`,
          values: [[updateData.notes]],
        });
      }

      if (updates.length > 0) {
        await this.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: {
            data: updates,
            valueInputOption: 'RAW',
          },
        });

        console.log('Call data updated in Google Sheets');
        return { success: true };
      }

      return { success: true, message: 'No updates needed' };

    } catch (error) {
      console.error('Error updating call data:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Batch log multiple calls
   */
  async batchLogCalls(spreadsheetId, callsData, sheetName = 'Call Logs') {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      await this.initializeHeaders(spreadsheetId, sheetName);

      const rows = callsData.map(callData => [
        new Date().toISOString(),
        callData.phone || '',
        callData.callStatus || '',
        callData.duration || 0,
        callData.callSid || '',
        callData.recordingUrl || '',
        callData.agentName || '',
        callData.campaignName || '',
        callData.retries || 0,
        callData.notes || '',
        JSON.stringify(callData.metadata || {})
      ]);

      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:K`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: rows,
        },
      });

      console.log(`Batch logged ${rows.length} calls to Google Sheets`);
      return { success: true, count: rows.length };

    } catch (error) {
      console.error('Error batch logging calls:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * Append generic data to Google Sheet (for Tools integration)
   */
  async appendGenericRow(spreadsheetId, dataObject, sheetName = 'Data Collection') {
    try {
      if (!this.sheets) {
        await this.initialize();
      }

      if (!this.sheets) {
        return { success: false, error: 'Google Sheets API not initialized' };
      }

      // Check if sheet exists or create it
      // We'll reuse initializeHeaders logic but adapted for dynamic headers
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId,
      });

      const sheet = spreadsheet.data.sheets.find(
        s => s.properties.title === sheetName
      );

      let sheetId;
      if (!sheet) {
        const addSheetResponse = await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
        });
        sheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;
      } else {
        sheetId = sheet.properties.sheetId;
      }

      // Get existing headers
      let headers = [];
      const headerRange = `${sheetName}!1:1`;
      const headerResponse = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: headerRange,
      });

      if (headerResponse.data.values && headerResponse.data.values.length > 0) {
        headers = headerResponse.data.values[0];
      } else {
        // No headers exist, create them from data keys
        headers = ['Timestamp', ...Object.keys(dataObject)];

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'RAW',
          resource: { values: [headers] },
        });

        // Format headers
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: {
            requests: [{
              repeatCell: {
                range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat(textFormat)',
              },
            }],
          },
        });
      }

      // Align data with headers
      const row = headers.map(header => {
        if (header === 'Timestamp') return new Date().toISOString();
        // Case-insensitive match for convenience
        const key = Object.keys(dataObject).find(k => k.toLowerCase() === header.toLowerCase());
        return key ? dataObject[key] : '';
      });

      // Append row
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:A`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [row] },
      });

      console.log('Generic data appended to Google Sheet');
      return { success: true };

    } catch (error) {
      console.error('Error appending generic row:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new GoogleSheetsService();
