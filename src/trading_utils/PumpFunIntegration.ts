/**
 * Pump.fun Pool Integration
 * 
 * Handles token swaps through pump.fun bonding curve pools on Solana.
 * Supports buying any SPL token from pump.fun pools with full transaction reporting.
 * Includes comprehensive token information fetching from pump.fun API.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getMint,
} from '@solana/spl-token';
import BN from 'bn.js';

/**
 * Pump.fun program ID on Solana mainnet
 */
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/**
 * Pump.fun global state account
 */
export const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/**
 * Pump.fun event authority
 */
export const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

/**
 * Pump.fun fee recipient
 */
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

/**
 * Token swap parameters
 */
export interface PumpFunSwapParams {
  /** Token mint address to buy */
  tokenMint: PublicKey;
  /** Amount of SOL to spend */
  solAmount: number;
  /** Slippage tolerance in basis points (e.g., 100 = 1%) */
  slippageBps: number;
  /** Maximum priority fee in lamports */
  priorityFeeLamports?: number;
  /** Compute unit limit */
  computeUnitLimit?: number;
}

/**
 * Transaction execution result
 */
export interface PumpFunSwapResult {
  success: boolean;
  signature?: string;
  tokenAmount?: number;
  error?: string;
  logs?: string[];
  blockTime?: number;
  slot?: number;
}

/**
 * Pump.fun bonding curve account structure
 */
interface BondingCurveAccount {
  virtualTokenReserves: BN;
  virtualSolReserves: BN;
  realTokenReserves: BN;
  realSolReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
}

/**
 * Token details from pump.fun API
 */
export interface PumpFunTokenDetails {
  name: string;
  symbol: string;
  description: string;
  image_uri: string;
  metadata_uri: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  created_timestamp: number;
  raydium_pool?: string;
  complete: boolean;
  total_supply: string;
  decimals: number;
  mint: string;
  bonding_curve: string;
  associated_bonding_curve: string;
  creator: string;
  market_cap?: number;
  usd_market_cap?: number;
  price?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  real_sol_reserves?: number;
  real_token_reserves?: number;
  price_change_24h?: number;
  volume_24h?: number;
  king_of_the_hill_timestamp?: number;
  reply_count?: number;
}

/**
 * Trading data for a token
 */
export interface TokenTradingData {
  price: number;
  priceInSOL: number;
  priceInUSD?: number;
  marketCapSOL?: number;
  marketCapUSD?: number;
  volume24h?: number;
  priceChange24h?: number;
  liquidity?: number;
}

/**
 * Comprehensive token information
 */
export interface ComprehensiveTokenInfo {
  // Basic Info
  name: string;
  symbol: string;
  address: string;
  description: string;
  image: string;
  
  // Status
  isGraduated: boolean;
  poolAddress?: string;
  isActive: boolean;
  
  // Trading Data
  currentPrice?: number;
  priceInSOL?: number;
  marketCap?: number;
  marketCapUSD?: number;
  priceChange24h?: number;
  volume24h?: number;
  
  // Liquidity
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  realSolReserves?: number;
  realTokenReserves?: number;
  liquidity?: number; // USD liquidity
  bondingProgress?: number; // Bonding curve progress %
  
  // Social Links
  twitter?: string;
  telegram?: string;
  website?: string;
  
  // Additional
  creator: string;
  createdAt: Date;
  totalSupply: string;
  decimals: number;
}

/**
 * Pump.fun Integration Class
 */
export class PumpFunIntegration {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Derive bonding curve PDA for a token
   */
  private async getBondingCurvePDA(tokenMint: PublicKey): Promise<PublicKey> {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
    return bondingCurve;
  }

  /**
   * Derive associated bonding curve account for a token
   */
  private async getAssociatedBondingCurve(tokenMint: PublicKey): Promise<PublicKey> {
    const bondingCurve = await this.getBondingCurvePDA(tokenMint);
    return getAssociatedTokenAddress(tokenMint, bondingCurve, true);
  }

  /**
   * Fetch bonding curve state
   */
  private async getBondingCurveState(bondingCurve: PublicKey): Promise<BondingCurveAccount | null> {
    try {
      const accountInfo = await this.connection.getAccountInfo(bondingCurve);
      if (!accountInfo) {
        return null;
      }

      // Parse bonding curve account data
      const data = accountInfo.data;

      return {
        virtualTokenReserves: new BN(data.slice(8, 16), 'le'),
        virtualSolReserves: new BN(data.slice(16, 24), 'le'),
        realTokenReserves: new BN(data.slice(24, 32), 'le'),
        realSolReserves: new BN(data.slice(32, 40), 'le'),
        tokenTotalSupply: new BN(data.slice(40, 48), 'le'),
        complete: data[48] === 1,
      };
    } catch (error) {
      console.error('Error fetching bonding curve state:', error);
      return null;
    }
  }

  /**
   * Calculate token output amount based on bonding curve
   */
  private calculateTokenOutput(
    solIn: BN,
    virtualSolReserves: BN,
    virtualTokenReserves: BN
  ): BN {
    // Constant product formula: x * y = k
    // tokenOut = virtualTokenReserves - (k / (virtualSolReserves + solIn))
    const k = virtualSolReserves.mul(virtualTokenReserves);
    const newSolReserves = virtualSolReserves.add(solIn);
    const newTokenReserves = k.div(newSolReserves);
    const tokenOut = virtualTokenReserves.sub(newTokenReserves);

    return tokenOut;
  }

  /**
   * Calculate SOL output amount based on token input (for selling)
   */
  private calculateSolOutput(tokenIn: BN, virtualSolReserves: BN, virtualTokenReserves: BN): BN {
    const k = virtualSolReserves.mul(virtualTokenReserves);
    const newTokenReserves = virtualTokenReserves.add(tokenIn);
    const newSolReserves = k.div(newTokenReserves);
    const solOut = virtualSolReserves.sub(newSolReserves);
    return solOut;
  }

  /**
   * Build buy instruction for pump.fun
   */
  private async buildBuyInstruction(
    params: PumpFunSwapParams,
    buyer: PublicKey,
    buyerTokenAccount: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey
  ): Promise<TransactionInstruction> {
    // Get bonding curve state
    const curveState = await this.getBondingCurveState(bondingCurve);
    if (!curveState) {
      throw new Error('Failed to fetch bonding curve state');
    }

    if (curveState.complete) {
      throw new Error('Bonding curve is complete, token has migrated to Raydium');
    }

    // Calculate expected token output
    const solInLamports = new BN(params.solAmount * 1e9);
    const tokenOut = this.calculateTokenOutput(
      solInLamports,
      curveState.virtualSolReserves,
      curveState.virtualTokenReserves
    );

    // Apply slippage tolerance
    const minTokenOut = tokenOut.mul(new BN(10000 - params.slippageBps)).div(new BN(10000));

    // Build instruction data
    // Instruction discriminator for "buy" is typically first 8 bytes
    const instructionData = Buffer.alloc(24);
    instructionData.writeUInt8(0x66, 0); // Buy instruction discriminator
    instructionData.writeBigUInt64LE(BigInt(tokenOut.toString()), 8);
    instructionData.writeBigUInt64LE(BigInt(minTokenOut.toString()), 16);

    // Build accounts array
    const keys = [
      { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.tokenMint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: PUMP_FUN_PROGRAM_ID,
      data: instructionData,
    });
  }

  /**
   * Execute token buy on pump.fun
   */
  async buyToken(
    params: PumpFunSwapParams,
    buyerPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<PumpFunSwapResult> {
    try {
  // Starting pump.fun token purchase (logging removed for production)

      // Derive accounts
      const bondingCurve = await this.getBondingCurvePDA(params.tokenMint);
      const associatedBondingCurve = await this.getAssociatedBondingCurve(params.tokenMint);
      const buyerTokenAccount = await getAssociatedTokenAddress(
        params.tokenMint,
        buyerPublicKey
      );

  // Bonding Curve and Buyer Token Account (logging removed)

      // Check if buyer token account exists
      const tokenAccountInfo = await this.connection.getAccountInfo(buyerTokenAccount);

      // Build transaction
      const transaction = new Transaction();

      // Add compute budget instructions for optimization
      const computeUnitLimit = params.computeUnitLimit || 400000;
      const priorityFee = params.priorityFeeLamports || 10000;

      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
      );

      // Create associated token account if it doesn't exist
      if (!tokenAccountInfo) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            buyerPublicKey,
            buyerTokenAccount,
            buyerPublicKey,
            params.tokenMint
          )
        );
      }

      // Add buy instruction
      const buyInstruction = await this.buildBuyInstruction(
        params,
        buyerPublicKey,
        buyerTokenAccount,
        bondingCurve,
        associatedBondingCurve
      );
      transaction.add(buyInstruction);

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = buyerPublicKey;

  // Signing transaction (logging removed)
      const signedTransaction = await signTransaction(transaction);

  // Sending transaction (logging removed)
      const signature = await this.connection.sendRawTransaction(
        signedTransaction.serialize(),
        {
          skipPreflight: false,
          maxRetries: 3,
        }
      );

  // Transaction sent and confirming (logging removed)

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      // Fetch transaction details
      const txDetails = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

  // Transaction confirmed (logging removed)

      return {
        success: true,
        signature,
        logs: txDetails?.meta?.logMessages || [],
        blockTime: txDetails?.blockTime || undefined,
        slot: txDetails?.slot,
      };
    } catch (error: any) {
  // Error buying token
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Execute token sell on pump.fun
   */
  async sellToken(
    params: {
      tokenMint: PublicKey;
      tokenAmount: number;
      slippageBps: number;
      priorityFeeLamports?: number;
      computeUnitLimit?: number;
    },
    sellerPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<PumpFunSwapResult> {
    try {
  // Starting pump.fun token sell (logging removed)

      const bondingCurve = await this.getBondingCurvePDA(params.tokenMint);
      const associatedBondingCurve = await this.getAssociatedBondingCurve(params.tokenMint);
      const sellerTokenAccount = await getAssociatedTokenAddress(
        params.tokenMint,
        sellerPublicKey
      );

      // Build sell instruction (discriminator: 0x33 for sell)
      const curveState = await this.getBondingCurveState(bondingCurve);
      if (!curveState) {
        throw new Error('Failed to fetch bonding curve state');
      }

      const tokenInAmount = new BN(params.tokenAmount * 1e6); // assuming 6 decimals
      const solOut = this.calculateSolOutput(
        tokenInAmount,
        curveState.virtualSolReserves,
        curveState.virtualTokenReserves
      );

      const minSolOut = solOut.mul(new BN(10000 - params.slippageBps)).div(new BN(10000));

      const instructionData = Buffer.alloc(24);
      instructionData.writeUInt8(0x33, 0); // Sell instruction discriminator
      instructionData.writeBigUInt64LE(BigInt(tokenInAmount.toString()), 8);
      instructionData.writeBigUInt64LE(BigInt(minSolOut.toString()), 16);

      const transaction = new Transaction();

      // Add compute budget instructions for optimization
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit || 400000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: params.priorityFeeLamports || 10000 })
      );

      // Add sell instruction
      const keys = [
        { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: params.tokenMint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: sellerPublicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      transaction.add(new TransactionInstruction({
        keys,
        programId: PUMP_FUN_PROGRAM_ID,
        data: instructionData,
      }));

      // Get recent blockhash and sign
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = sellerPublicKey;

      const signedTx = await signTransaction(transaction);
      const signature = await this.connection.sendRawTransaction(signedTx.serialize());
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      const solReceived = solOut.toNumber() / 1e9;

      return {
        success: true,
        signature,
        tokenAmount: solReceived,
        blockTime: Date.now(),
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get trending pump.fun tokens
   */
  async getTrendingTokens(limit: number = 10): Promise<any[]> {
    try {
      const response = await fetch('https://frontend-api.pump.fun/coins/trending?limit=' + limit);
      if (!response.ok) return [];
      return await response.json() as any[];
    } catch {
      return [];
    }
  }

  /**
   * Get comprehensive token information from pump.fun API
   */
  async getTokenDetails(tokenMint: PublicKey): Promise<PumpFunTokenDetails | null> {
    try {
      const response = await fetch(
        `https://frontend-api.pump.fun/coins/${tokenMint.toString()}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
        }
      );
      
      if (!response.ok) {
    // Failed to fetch token details from API, falling back to on-chain data only
        
        // Fallback: Get basic info from on-chain data
        return await this.getTokenDetailsFromChain(tokenMint);
      }
      
      const data = await response.json();
      return data as PumpFunTokenDetails;
    } catch (error) {
     // Error fetching token details from API, falling back to on-chain data only
      
      // Fallback: Get basic info from on-chain data
      return await this.getTokenDetailsFromChain(tokenMint);
    }
  }

  /**
   * Get token details from on-chain data (fallback when API is down)
   */
  private async getTokenDetailsFromChain(tokenMint: PublicKey): Promise<PumpFunTokenDetails | null> {
    try {
  // Fetching on-chain data for token
      
      // Get bonding curve PDA
      const bondingCurve = await this.getBondingCurvePDA(tokenMint);
      
      // Get bonding curve state
      const curveState = await this.getBondingCurveState(bondingCurve);
      if (!curveState) {
    // No bonding curve found for this token
        return null;
      }

      // Get token metadata from on-chain
      const mintInfo = await getMint(this.connection, tokenMint);
      
      // Calculate price from bonding curve
      const priceInSOL = curveState.virtualSolReserves.toNumber() / curveState.virtualTokenReserves.toNumber();

  // Successfully fetched on-chain data

      // Return minimal data structure compatible with PumpFunTokenDetails
      return {
        mint: tokenMint.toString(),
        name: `Token ${tokenMint.toString().substring(0, 8)}`,
        symbol: 'UNKNOWN',
        description: 'Token metadata unavailable (fetched from on-chain data)',
        image_uri: '',
        metadata_uri: '',
        twitter: undefined,
        telegram: undefined,
        website: undefined,
        bonding_curve: bondingCurve.toString(),
        associated_bonding_curve: '',
        creator: '',
        created_timestamp: 0,
        raydium_pool: undefined,
        complete: curveState.complete,
        virtual_sol_reserves: curveState.virtualSolReserves.toNumber(),
        virtual_token_reserves: curveState.virtualTokenReserves.toNumber(),
        real_sol_reserves: curveState.realSolReserves.toNumber(),
        real_token_reserves: curveState.realTokenReserves.toNumber(),
        total_supply: curveState.tokenTotalSupply.toString(),
        decimals: mintInfo.decimals,
        usd_market_cap: 0,
        price_change_24h: 0,
        volume_24h: 0,
        price: priceInSOL,
      } as PumpFunTokenDetails;
    } catch (error) {
  // Error fetching on-chain token data
      return null;
    }
  }

  /**
   * Get token trading data (price, volume, market cap)
   */
  async getTokenTradingData(tokenMint: PublicKey): Promise<TokenTradingData | null> {
    try {
      // First get token details for bonding curve data
      const details = await this.getTokenDetails(tokenMint);
      if (!details) return null;

      // Calculate current price from bonding curve
      const bondingCurvePubkey = new PublicKey(details.bonding_curve);
      const curveState = await this.getBondingCurveState(bondingCurvePubkey);
      
      if (!curveState) return null;

      // Price calculation: virtualSolReserves / virtualTokenReserves
      const priceInSOL = curveState.virtualSolReserves.toNumber() / curveState.virtualTokenReserves.toNumber();

      // Calculate market cap (circulating supply * price)
      const circulatingSupply = curveState.tokenTotalSupply.toNumber() / Math.pow(10, details.decimals);
      const marketCapSOL = circulatingSupply * priceInSOL;

      return {
        price: priceInSOL,
        priceInSOL: priceInSOL,
        marketCapSOL: marketCapSOL,
        marketCapUSD: details.usd_market_cap,
        priceChange24h: details.price_change_24h,
        volume24h: details.volume_24h,
      };
    } catch (error) {
  // Error fetching trading data
      return null;
    }
  }

  /**
   * Get comprehensive token information including market data
   */
  async getComprehensiveTokenInfo(tokenMint: PublicKey): Promise<ComprehensiveTokenInfo | null> {
    try {
  // Fetching token info for token
      
      // Try to get basic details from pump.fun API (for metadata only)
      const details = await this.getTokenDetails(tokenMint);
      
      // Get FRESH on-chain bonding curve data
      const bondingCurvePDA = await this.getBondingCurvePDA(tokenMint);
      const freshCurveState = await this.getBondingCurveState(bondingCurvePDA);
      
      // Get ACCURATE price data from DexScreener
      let dexData: any = null;
      try {
        const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint.toString()}`);
        if (dexResponse.ok) {
          const dexJson: any = await dexResponse.json();
          if (dexJson.pairs && dexJson.pairs.length > 0) {
            dexData = dexJson.pairs[0]; // Get first pair (usually most liquid)
            // DexScreener data found for token
          }
        }
      } catch (error) {
  // DexScreener fetch failed, using on-chain data only
      }
      
      // Use DexScreener for accurate price/market data, fallback to on-chain calculations
      let currentPriceUSD = dexData?.priceUsd ? parseFloat(dexData.priceUsd) : null;
      let marketCapUSD = dexData?.marketCap || null;
      let volume24h = dexData?.volume?.h24 || null;
      let priceChange24h = dexData?.priceChange?.h24 || null;
      let liquidity = dexData?.liquidity?.usd || null;
      
      // Get name and symbol from DexScreener if available (more accurate)
      const name = dexData?.baseToken?.name || details?.name || `Token ${tokenMint.toString().substring(0, 8)}`;
      const symbol = dexData?.baseToken?.symbol || details?.symbol || 'UNKNOWN';
      
      // Calculate on-chain data for reserves
      let realSolReserves = 0;
      let realTokenReserves = 0;
      let virtualSolReserves = 0;
      let virtualTokenReserves = 0;
      let currentPriceSOL = 0;
      let marketCapSOL = 0;
      let decimals = 6;
      let totalSupply = 0;
      let bondingProgress = 0;

      if (freshCurveState) {
        decimals = details?.decimals || 6;
        
        // Fresh reserves from blockchain
        realSolReserves = freshCurveState.realSolReserves.toNumber() / 1e9;
        realTokenReserves = freshCurveState.realTokenReserves.toNumber() / Math.pow(10, decimals);
        virtualSolReserves = freshCurveState.virtualSolReserves.toNumber() / 1e9;
        virtualTokenReserves = freshCurveState.virtualTokenReserves.toNumber() / Math.pow(10, decimals);
        totalSupply = freshCurveState.tokenTotalSupply.toNumber() / Math.pow(10, decimals);
        
        // Calculate price in SOL from bonding curve with NaN protection
        if (virtualTokenReserves > 0 && virtualSolReserves > 0) {
          currentPriceSOL = virtualSolReserves / virtualTokenReserves;
          // Calculate market cap in SOL
          marketCapSOL = totalSupply * currentPriceSOL;
        } else {
          // Reserves are 0, price cannot be calculated
          currentPriceSOL = 0;
          marketCapSOL = 0;
          console.warn(`⚠️ Token ${tokenMint.toString()} has zero reserves, cannot calculate price`);
        }
        
        // Calculate bonding curve progress (pump.fun graduates at ~85 SOL)
        bondingProgress = (realSolReserves / 85) * 100;
        
  // On-chain reserves and bonding progress
      }

      return {
        // Basic Info (prefer DexScreener for accuracy)
        name: name,
        symbol: symbol,
        address: tokenMint.toString(),
        description: details?.description || '',
        image: details?.image_uri || dexData?.info?.imageUrl || '',
        
        // Status
        isGraduated: details?.complete || false,
        poolAddress: details?.raydium_pool,
        isActive: !details?.complete,
        
        // Trading Data (DexScreener is source of truth for price)
        currentPrice: currentPriceUSD ?? undefined,
        priceInSOL: currentPriceSOL,
        marketCap: marketCapSOL,
        marketCapUSD: marketCapUSD ?? undefined,
        priceChange24h: priceChange24h ?? undefined,
        volume24h: volume24h ?? undefined,
        liquidity: liquidity ?? undefined,
        bondingProgress: bondingProgress,
        
        // Liquidity (FRESH from chain)
        virtualSolReserves: virtualSolReserves,
        virtualTokenReserves: virtualTokenReserves,
        realSolReserves: realSolReserves,
        realTokenReserves: realTokenReserves,
        
        // Social Links
        twitter: details?.twitter || dexData?.info?.twitter,
        telegram: details?.telegram,
        website: details?.website || dexData?.info?.websites?.[0],
        
        // Additional
        creator: details?.creator || '',
        createdAt: details ? new Date(details.created_timestamp) : new Date(),
        totalSupply: totalSupply.toString(),
        decimals: decimals,
      };
    } catch (error) {
  // Error getting comprehensive token info
      return null;
    }
  }

  /**
   * Get token metadata (alias for getTokenDetails for backwards compatibility)
   */
  async getTokenMetadata(tokenMint: PublicKey): Promise<PumpFunTokenDetails | null> {
    return this.getTokenDetails(tokenMint);
    
  }

  /**
   * Validate token mint and pool
   */
  async validateToken(tokenMint: PublicKey): Promise<{ valid: boolean; reason?: string }> {
    try {
      // Check if token mint exists
      const mintInfo = await this.connection.getAccountInfo(tokenMint);
      if (!mintInfo) {
        return { valid: false, reason: 'Token mint does not exist' };
      }

      // Check if bonding curve exists
      const bondingCurve = await this.getBondingCurvePDA(tokenMint);
      const bondingCurveInfo = await this.connection.getAccountInfo(bondingCurve);
      if (!bondingCurveInfo) {
        return { valid: false, reason: 'Bonding curve not found for this token' };
      }

      // Check bonding curve state
      const curveState = await this.getBondingCurveState(bondingCurve);
      if (!curveState) {
        return { valid: false, reason: 'Failed to fetch bonding curve state' };
      }

      if (curveState.complete) {
        return { valid: false, reason: 'Bonding curve is complete, token has graduated to Raydium' };
      }

      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: error.message || 'Validation error' };
    }
  }

  /**
   * Get token price from bonding curve
   */
  async getTokenPrice(tokenMint: PublicKey): Promise<number | null> {
    try {
      const bondingCurve = await this.getBondingCurvePDA(tokenMint);
      const curveState = await this.getBondingCurveState(bondingCurve);

      if (!curveState) {
        return null;
      }

      // Price = virtualSolReserves / virtualTokenReserves
      const price = curveState.virtualSolReserves.toNumber() / curveState.virtualTokenReserves.toNumber();
      return price;
    } catch (error) {
  // Error getting token price
      return null;
    }
  }
}