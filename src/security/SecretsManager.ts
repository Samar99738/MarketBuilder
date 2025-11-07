/**
 * AWS Secrets Manager Integration
 * Secure storage and retrieval of sensitive credentials
 * 
 * CRITICAL SECURITY: Never store private keys in environment variables in production!
 */

import { 
  SecretsManagerClient, 
  GetSecretValueCommand,
  UpdateSecretCommand,
  CreateSecretCommand,
  DescribeSecretCommand
} from '@aws-sdk/client-secrets-manager';
import { awsLogger } from '../aws/logger';

// Cache for secrets to minimize AWS API calls
const secretCache = new Map<string, { value: any; timestamp: number }>();
const CACHE_TTL = 300000; // 5 minutes

export interface SecretConfig {
  secretName: string;
  region?: string;
  versionId?: string;
  versionStage?: string;
}

/**
 * Secrets Manager for secure credential storage
 */
export class SecretsManager {
  private client: SecretsManagerClient;
  private region: string;

  constructor(region: string = process.env.AWS_REGION || 'us-east-1') {
    this.region = region;
    this.client = new SecretsManagerClient({ region: this.region });
  }

  /**
   * Get secret value from AWS Secrets Manager
   * Uses caching to minimize API calls
   */
  async getSecret(secretName: string, useCache: boolean = true): Promise<any> {
    try {
      // Check cache first
      if (useCache) {
        const cached = secretCache.get(secretName);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          console.log(`[SecretsManager] Using cached secret: ${secretName}`);
          return cached.value;
        }
      }

      // Fetch from AWS
      console.log(`[SecretsManager] Fetching secret from AWS: ${secretName}`);
      const command = new GetSecretValueCommand({ SecretId: secretName });
      const response = await this.client.send(command);

      let secretValue: any;
      if (response.SecretString) {
        secretValue = JSON.parse(response.SecretString);
      } else if (response.SecretBinary) {
        // Handle binary secrets if needed
        secretValue = Buffer.from(response.SecretBinary).toString('utf-8');
      } else {
        throw new Error('Secret has no value');
      }

      // Cache the secret
      secretCache.set(secretName, {
        value: secretValue,
        timestamp: Date.now()
      });

      await awsLogger.info('Secret retrieved successfully', {
        metadata: { secretName, cached: false }
      });

      return secretValue;
    } catch (error: any) {
      await awsLogger.error('Failed to retrieve secret', {
        metadata: { 
          secretName, 
          error: error.message,
          code: error.code 
        }
      });
      throw new Error(`Failed to retrieve secret ${secretName}: ${error.message}`);
    }
  }

  /**
   * Get wallet private key from Secrets Manager
   */
  async getWalletPrivateKey(): Promise<string> {
    const secretName = process.env.WALLET_SECRET_NAME || 'trading-bot/wallet-private-key';
    
    try {
      const secret = await this.getSecret(secretName);
      
      if (!secret.privateKey) {
        throw new Error('Private key not found in secret');
      }

      return secret.privateKey;
    } catch (error: any) {
      // Fallback to environment variable in development only
      if (process.env.NODE_ENV === 'development' && process.env.WALLET_PRIVATE_KEY) {
        console.warn('⚠️  Using private key from environment variable (development only)');
        return process.env.WALLET_PRIVATE_KEY;
      }
      
      throw error;
    }
  }

  /**
   * Get API key from Secrets Manager
   */
  async getApiKey(keyName: string): Promise<string> {
    const secretName = process.env.API_SECRETS_NAME || 'trading-bot/api-keys';
    
    try {
      const secrets = await this.getSecret(secretName);
      
      if (!secrets[keyName]) {
        throw new Error(`API key ${keyName} not found in secrets`);
      }

      return secrets[keyName];
    } catch (error: any) {
      // Fallback to environment variable
      const envKey = process.env[keyName];
      if (envKey) {
        console.warn(`⚠️  Using ${keyName} from environment variable`);
        return envKey;
      }
      
      throw error;
    }
  }

  /**
   * Update secret value in AWS Secrets Manager
   * Use this for key rotation
   */
  async updateSecret(secretName: string, secretValue: any): Promise<void> {
    try {
      const command = new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: JSON.stringify(secretValue)
      });

      await this.client.send(command);
      
      // Invalidate cache
      secretCache.delete(secretName);

      await awsLogger.info('Secret updated successfully', {
        metadata: { secretName }
      });
    } catch (error: any) {
      await awsLogger.error('Failed to update secret', {
        metadata: { 
          secretName, 
          error: error.message 
        }
      });
      throw new Error(`Failed to update secret ${secretName}: ${error.message}`);
    }
  }

  /**
   * Create a new secret in AWS Secrets Manager
   */
  async createSecret(secretName: string, secretValue: any, description?: string): Promise<void> {
    try {
      const command = new CreateSecretCommand({
        Name: secretName,
        Description: description || `Created by trading bot at ${new Date().toISOString()}`,
        SecretString: JSON.stringify(secretValue)
      });

      await this.client.send(command);

      await awsLogger.info('Secret created successfully', {
        metadata: { secretName }
      });
    } catch (error: any) {
      await awsLogger.error('Failed to create secret', {
        metadata: { 
          secretName, 
          error: error.message 
        }
      });
      throw new Error(`Failed to create secret ${secretName}: ${error.message}`);
    }
  }

  /**
   * Check if secret exists
   */
  async secretExists(secretName: string): Promise<boolean> {
    try {
      const command = new DescribeSecretCommand({ SecretId: secretName });
      await this.client.send(command);
      return true;
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Clear secret cache
   * Use after key rotation or when you need fresh values
   */
  clearCache(secretName?: string): void {
    if (secretName) {
      secretCache.delete(secretName);
      console.log(`[SecretsManager] Cache cleared for: ${secretName}`);
    } else {
      secretCache.clear();
      console.log('[SecretsManager] All cache cleared');
    }
  }

  /**
   * Rotate wallet private key
   * IMPORTANT: This should be done carefully with proper backup
   */
  async rotateWalletKey(newPrivateKey: string, backupOldKey: boolean = true): Promise<void> {
    const secretName = process.env.WALLET_SECRET_NAME || 'trading-bot/wallet-private-key';
    
    try {
      // Backup old key if requested
      if (backupOldKey) {
        const oldSecret = await this.getSecret(secretName, false);
        await this.createSecret(
          `${secretName}-backup-${Date.now()}`,
          oldSecret,
          'Backup before key rotation'
        );
      }

      // Update with new key
      await this.updateSecret(secretName, { privateKey: newPrivateKey });

      await awsLogger.info('Wallet key rotated successfully', {
        metadata: { secretName, backedUp: backupOldKey }
      });
    } catch (error: any) {
      await awsLogger.error('Failed to rotate wallet key', {
        metadata: { error: error.message }
      });
      throw error;
    }
  }
}

/**
 * Singleton instance
 */
export const secretsManager = new SecretsManager();

/**
 * Helper function to check if Secrets Manager is enabled
 */
export function isSecretsManagerEnabled(): boolean {
  // Explicitly check the USE_SECRETS_MANAGER flag first
  if (process.env.USE_SECRETS_MANAGER === 'false') {
    return false;
  }
  
  // Enable by default in production unless explicitly disabled
  return process.env.USE_SECRETS_MANAGER === 'true' || 
         (process.env.NODE_ENV === 'production' && process.env.USE_SECRETS_MANAGER !== 'false');
}

/**
 * Initialize secrets on startup
 */
export async function initializeSecrets(): Promise<void> {
  if (!isSecretsManagerEnabled()) {
    console.log('ℹ️  Secrets Manager disabled - using environment variables');
    return;
  }

  try {
    console.log('🔐 Initializing AWS Secrets Manager...');
    
    // Test connection and retrieve secrets
    await secretsManager.getWalletPrivateKey();
    
    console.log('✅ Secrets Manager initialized successfully');
  } catch (error: any) {
    console.error('❌ Failed to initialize Secrets Manager:', error.message);
    
    // Only throw error if explicitly enabled, not just because of production mode
    if (process.env.USE_SECRETS_MANAGER === 'true') {
      throw new Error('Cannot start with USE_SECRETS_MANAGER=true when Secrets Manager is not configured');
    }
    
    console.warn('⚠️  Continuing with environment variables (NOT RECOMMENDED FOR PRODUCTION)');
  }
}
