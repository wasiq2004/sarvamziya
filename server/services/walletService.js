const { v4: uuidv4 } = require('uuid');

class WalletService {
  constructor(mysqlPool) {
    this.mysqlPool = mysqlPool;
  }

  /**
   * Get or create user wallet
   */
  async getOrCreateWallet(userId) {
    try {
      // Check if wallet exists
      const [wallets] = await this.mysqlPool.execute(
        'SELECT * FROM user_wallets WHERE user_id = ?',
        [userId]
      );

      if (wallets.length > 0) {
        return wallets[0];
      }

      // Create new wallet with initial balance (optional)
      const walletId = uuidv4();
      const initialBalance = 0.00;

      await this.mysqlPool.execute(
        'INSERT INTO user_wallets (id, user_id, balance) VALUES (?, ?, ?)',
        [walletId, userId, initialBalance]
      );

      return {
        id: walletId,
        user_id: userId,
        balance: initialBalance,
        currency: 'USD',
        created_at: new Date(),
        updated_at: new Date()
      };
    } catch (error) {
      console.error('Error getting/creating wallet:', error);
      throw error;
    }
  }

  /**
   * Get wallet balance
   */
  async getBalance(userId) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      return parseFloat(wallet.balance);
    } catch (error) {
      console.error('Error getting balance:', error);
      throw error;
    }
  }

  /**
   * Add credits to wallet (admin only)
   */
  async addCredits(userId, amount, description, adminId = null) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const newBalance = parseFloat(wallet.balance) + parseFloat(amount);

      // Update wallet balance
      await this.mysqlPool.execute(
        'UPDATE user_wallets SET balance = ?, updated_at = NOW() WHERE user_id = ?',
        [newBalance, userId]
      );

      // Record transaction
      const transactionId = uuidv4();
      await this.mysqlPool.execute(
        `INSERT INTO wallet_transactions 
        (id, user_id, transaction_type, amount, balance_after, service_type, description, created_by) 
        VALUES (?, ?, 'credit', ?, ?, 'admin_adjustment', ?, ?)`,
        [transactionId, userId, amount, newBalance, description, adminId]
      );

      return {
        success: true,
        newBalance: newBalance,
        transaction: {
          id: transactionId,
          amount: amount,
          type: 'credit'
        }
      };
    } catch (error) {
      console.error('Error adding credits:', error);
      throw error;
    }
  }

  /**
   * Deduct credits from wallet
   */
  async deductCredits(userId, amount, serviceType, description, callId = null, metadata = null) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const currentBalance = parseFloat(wallet.balance);

      if (currentBalance < amount) {
        throw new Error('Insufficient balance');
      }

      const newBalance = currentBalance - parseFloat(amount);

      // Update wallet balance
      await this.mysqlPool.execute(
        'UPDATE user_wallets SET balance = ?, updated_at = NOW() WHERE user_id = ?',
        [newBalance, userId]
      );

      // Record transaction
      const transactionId = uuidv4();
      await this.mysqlPool.execute(
        `INSERT INTO wallet_transactions 
        (id, user_id, transaction_type, amount, balance_after, service_type, call_id, description, metadata) 
        VALUES (?, ?, 'debit', ?, ?, ?, ?, ?, ?)`,
        [
          transactionId, 
          userId, 
          amount, 
          newBalance, 
          serviceType, 
          callId, 
          description,
          metadata ? JSON.stringify(metadata) : null
        ]
      );

      return {
        success: true,
        newBalance: newBalance,
        deducted: amount,
        transaction: {
          id: transactionId,
          amount: amount,
          type: 'debit'
        }
      };
    } catch (error) {
      console.error('Error deducting credits:', error);
      throw error;
    }
  }

  /**
   * Get service pricing
   */
  async getServicePricing() {
    try {
      const [pricing] = await this.mysqlPool.execute(
        'SELECT * FROM service_pricing'
      );
      return pricing;
    } catch (error) {
      console.error('Error getting service pricing:', error);
      throw error;
    }
  }

  /**
   * Calculate cost for service usage
   */
  async calculateCost(serviceType, unitsUsed) {
    try {
      const [pricing] = await this.mysqlPool.execute(
        'SELECT cost_per_unit FROM service_pricing WHERE service_type = ?',
        [serviceType]
      );

      if (pricing.length === 0) {
        throw new Error(`Pricing not found for service: ${serviceType}`);
      }

      const costPerUnit = parseFloat(pricing[0].cost_per_unit);
      const totalCost = costPerUnit * parseFloat(unitsUsed);

      return {
        costPerUnit: costPerUnit,
        unitsUsed: unitsUsed,
        totalCost: parseFloat(totalCost.toFixed(6))
      };
    } catch (error) {
      console.error('Error calculating cost:', error);
      throw error;
    }
  }

  /**
   * Record service usage and deduct cost
   */
  async recordUsageAndCharge(userId, callId, serviceType, unitsUsed, metadata = null) {
    try {
      // Calculate cost
      const { costPerUnit, totalCost } = await this.calculateCost(serviceType, unitsUsed);

      // Record usage
      const usageId = uuidv4();
      await this.mysqlPool.execute(
        `INSERT INTO service_usage 
        (id, user_id, call_id, service_type, units_used, cost_per_unit, total_cost, metadata) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          usageId,
          userId,
          callId,
          serviceType,
          unitsUsed,
          costPerUnit,
          totalCost,
          metadata ? JSON.stringify(metadata) : null
        ]
      );

      // Deduct from wallet
      const description = `${serviceType} usage: ${unitsUsed} ${this.getUnitType(serviceType)}`;
      await this.deductCredits(userId, totalCost, serviceType, description, callId, metadata);

      return {
        success: true,
        usageId: usageId,
        charged: totalCost,
        units: unitsUsed
      };
    } catch (error) {
      console.error('Error recording usage:', error);
      throw error;
    }
  }

 /**
 * Get transaction history
 */
async getTransactions(userId, limit = 50, offset = 0) {
  try {
    // Ensure limit and offset are safe integers
    const limitInt = Math.max(1, Math.min(parseInt(limit) || 50, 1000)); // Cap at 1000
    const offsetInt = Math.max(0, parseInt(offset) || 0);
    
    // Validate userId
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    // Use string interpolation for LIMIT/OFFSET to avoid MySQL2 bug
    const [transactions] = await this.mysqlPool.execute(
      `SELECT * FROM wallet_transactions 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ${limitInt} OFFSET ${offsetInt}`,
      [userId]  // Only userId as parameter
    );

    return transactions.map(t => ({
      id: t.id,
      type: t.transaction_type,
      amount: parseFloat(t.amount),
      balanceAfter: parseFloat(t.balance_after),
      service: t.service_type,
      description: t.description,
      createdAt: t.created_at
    }));
  } catch (error) {
    console.error('Error getting transactions:', error);
    throw error;
  }
}
  
 //Get usage statistics
 
async getUsageStats(userId, startDate = null, endDate = null) {
  try {
    let query = `
      SELECT 
        service_type,
        SUM(units_used) as total_units,
        SUM(total_cost) as total_cost,
        COUNT(*) as usage_count
      FROM service_usage
      WHERE user_id = ?
    `;
    
    const params = [userId];

    if (startDate) {
      query += ' AND created_at >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND created_at <= ?';
      params.push(endDate);
    }

    query += ' GROUP BY service_type';

    const [stats] = await this.mysqlPool.execute(query, params);

    return stats.map(s => ({
      service: s.service_type,
      totalUnits: parseFloat(s.total_units || 0),
      totalCost: parseFloat(s.total_cost || 0),
      usageCount: parseInt(s.usage_count || 0)
    }));
  } catch (error) {
    console.error('Error getting usage stats:', error);
    throw error;
  }
}

  /**
   * Helper: Get unit type for service
   */
  getUnitType(serviceType) {
     const units = {
      'elevenlabs': 'characters',
      'deepgram': 'seconds',
      'gemini': 'tokens',
      'sarvam': 'characters',
      'twilio': 'minutes'
    };
    return units[serviceType] || 'units';
  }

  /**
   * Update service pricing (admin only)
   */
  async updatePricing(serviceType, costPerUnit, adminId = null) {
    try {
      await this.mysqlPool.execute(
        `UPDATE service_pricing 
        SET cost_per_unit = ?, updated_at = NOW(), updated_by = ? 
        WHERE service_type = ?`,
        [costPerUnit, adminId, serviceType]
      );

      return { success: true };
    } catch (error) {
      console.error('Error updating pricing:', error);
      throw error;
    }
  }

  /**
   * Check if user has sufficient balance
   */
  async hasSufficientBalance(userId, requiredAmount) {
    try {
      const balance = await this.getBalance(userId);
      return balance >= requiredAmount;
    } catch (error) {
      console.error('Error checking balance:', error);
      return false;
    }
  }
}

module.exports = WalletService;
