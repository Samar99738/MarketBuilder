import { TRADING_CONFIG } from "./config";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  JupiterQuoteResponse,
  JupiterSwapResponse,
  TradeResponse,
  JupiterPriceResponse,
  BirdeyePriceResponse,
  DexscreenerPriceResponse,
} from "./types";

// Initialize wallet and connection with error handling
let wallet: Keypair;
let connection: Connection;

try {
  // Require private key for real trading
  if (
    !TRADING_CONFIG.WALLET_PRIVATE_KEY ||
    (typeof TRADING_CONFIG.WALLET_PRIVATE_KEY === "string" &&
      TRADING_CONFIG.WALLET_PRIVATE_KEY.length === 0)
  ) {
    throw new Error(
      "WALLET_PRIVATE_KEY is required in .env file for real trading"
    );
  }

  // Handle both Uint8Array and base58 string formats
  if (TRADING_CONFIG.WALLET_PRIVATE_KEY instanceof Uint8Array) {
    wallet = Keypair.fromSecretKey(TRADING_CONFIG.WALLET_PRIVATE_KEY);
  } else {
    wallet = Keypair.fromSecretKey(
      bs58.decode(TRADING_CONFIG.WALLET_PRIVATE_KEY)
    );
  }

  // Initialize connection
  connection = new Connection(
    TRADING_CONFIG.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com"
  );

  process.stderr.write(`Wallet initialized: ${wallet.publicKey.toString()}\n`);
} catch (error) {
  console.error("Error initializing wallet or connection:", error);
  throw error; // Stop execution if wallet setup fails
}

// Price caching - reduced cache time for more frequent updates
let cachedTokenPriceUSD: { price: number; source: string } | null = null;
let lastPriceFetchTime = 0;
const PRICE_CACHE_TTL = 5000; // Reduced to 5 seconds for more frequent updates

// Buy tokens using Jupiter
async function buyTokens(
  amountInSol: number = TRADING_CONFIG.BUY_AMOUNT_SOL
): Promise<string> {
  try {
    const amountInLamports = amountInSol * LAMPORTS_PER_SOL;

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${TRADING_CONFIG.TOKEN_ADDRESS}&amount=${amountInLamports}&slippageBps=${TRADING_CONFIG.SLIPPAGE_BPS}`
    );
    const quoteData = (await quoteResponse.json()) as JupiterQuoteResponse;

    if (!quoteData || (!quoteData.data && !quoteData.outAmount)) {
      throw new Error(`Failed to get quote: ${JSON.stringify(quoteData)}`);
    }

    let wrapUnwrapSol =
      !quoteData.data?.swapMode || quoteData.data?.swapMode !== "ExactIn";

    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData.data || quoteData,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: wrapUnwrapSol,
      }),
    });

    const swapData = (await swapResponse.json()) as JupiterSwapResponse;
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, "base64")
    );

    transaction.sign([wallet]);
    const signature = await connection.sendTransaction(transaction);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    return signature;
  } catch (error) {
    console.error("Error in buyTokens:", error);
    throw error; // Re-throw error for proper handling
  }
}

// Sell tokens using Jupiter
async function sellTokens(amountToSell: number | null = null): Promise<string> {
  try {
    // Require explicit amount - don't sell anything if no amount specified
    if (amountToSell === null || amountToSell === undefined) {
      throw new Error(
        "Amount to sell must be specified. Use -1 to sell all tokens, or specify a positive amount."
      );
    }

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(TRADING_CONFIG.TOKEN_ADDRESS) }
    );

    if (tokenAccounts.value.length === 0) {
      throw new Error("No token accounts found");
    }

    const tokenAccount = tokenAccounts.value[0];
    const tokenBalance =
      tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    const tokenDecimals =
      tokenAccount.account.data.parsed.info.tokenAmount.decimals;

    let tokensToSell: number;

    // Check if user wants to sell all tokens
    if (amountToSell === -1) {
      tokensToSell = tokenBalance;
      process.stderr.write(`Selling ALL tokens: ${tokensToSell}\n`);
    } else if (amountToSell > 0) {
      tokensToSell = amountToSell;
      process.stderr.write(`Selling specified amount: ${tokensToSell}\n`);
    } else {
      throw new Error(
        "Invalid amount. Use -1 to sell all tokens, or specify a positive amount."
      );
    }

    if (tokensToSell <= 0) {
      throw new Error("No tokens to sell - token balance is zero");
    }

    if (tokensToSell > tokenBalance) {
      throw new Error(
        `Insufficient token balance. Requested: ${tokensToSell}, Available: ${tokenBalance}`
      );
    }

    if (tokensToSell < TRADING_CONFIG.MIN_SELL_AMOUNT) {
      throw new Error(
        `Token amount too small to sell: ${tokensToSell}. Minimum: ${TRADING_CONFIG.MIN_SELL_AMOUNT}`
      );
    }

    const sellAmount = Math.floor(tokensToSell * 10 ** tokenDecimals);

    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${TRADING_CONFIG.TOKEN_ADDRESS}&outputMint=So11111111111111111111111111111111111111112&amount=${sellAmount}&slippageBps=${TRADING_CONFIG.SLIPPAGE_BPS}`
    );
    const quoteData = (await quoteResponse.json()) as JupiterQuoteResponse;

    if (!quoteData || (!quoteData.data && !quoteData.outAmount)) {
      throw new Error(`Failed to get quote: ${JSON.stringify(quoteData)}`);
    }

    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData.data || quoteData,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: TRADING_CONFIG.DYNAMIC_COMPUTE_UNIT_LIMIT,
        prioritizationFeeLamports: TRADING_CONFIG.PRIORITY_FEE_LAMPORTS,
      }),
    });

    const swapData = (await swapResponse.json()) as JupiterSwapResponse;
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, "base64")
    );

    transaction.sign([wallet]);
    const signature = await connection.sendTransaction(transaction);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    return signature;
  } catch (error) {
    console.error("Error in sellTokens:", error);
    throw error; // Re-throw error for proper handling
  }
}

// Get token price in USD - uses Jupiter API only (fallbacks commented out for consistency)
async function getTokenPriceUSD(): Promise<{ price: number; source: string }> {
  try {
    const currentTime = Date.now();

    // Return cached price if still valid (optional - can be disabled by setting TTL to 0)
    if (
      cachedTokenPriceUSD !== null &&
      currentTime - lastPriceFetchTime < PRICE_CACHE_TTL
    ) {
      return cachedTokenPriceUSD;
    }

    const tokenAddressStr = TRADING_CONFIG.TOKEN_ADDRESS;

    // Only use Jupiter API for consistency with trading platform
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // Updated to use Jupiter Price API v2
      const endpoint = `https://lite-api.jup.ag/price/v2?ids=${tokenAddressStr}`;
      const response = await fetch(endpoint, { signal: controller.signal });
      const data = (await response.json()) as any; // v2 API response format

      clearTimeout(timeoutId);

      // Updated response parsing for v2 API format
      if (data?.data?.[tokenAddressStr]?.price) {
        const result = {
          price: parseFloat(data.data[tokenAddressStr].price),
          source: "Jupiter",
        };
        cachedTokenPriceUSD = result;
        lastPriceFetchTime = currentTime;
        return result;
      } else {
        throw new Error("Jupiter price data not available");
      }
    } catch (jupiterError) {
      console.error(`Error with Jupiter price API:`, jupiterError);
      throw new Error("Price fetch failed - Jupiter API unavailable");
    }

    // Fallback APIs commented out for trading consistency
    // const apiEndpoints = [
    //   {
    //     url: "https://public-api.birdeye.so/public/price",
    //     timeout: 5000,
    //     name: "Birdeye",
    //   },
    //   {
    //     url: "https://api.dexscreener.com/latest/dex/tokens",
    //     timeout: 5000,
    //     name: "DexScreener",
    //   },
    // ];

    // // Try each fallback API
    // for (const api of apiEndpoints) {
    //   try {
    //     const controller = new AbortController();
    //     const timeoutId = setTimeout(() => controller.abort(), api.timeout);

    //     let endpoint = api.url;
    //     let response;

    //     if (api.url.includes("birdeye.so")) {
    //       endpoint = `${api.url}?address=${tokenAddressStr}`;
    //       response = await fetch(endpoint, {
    //         signal: controller.signal,
    //         headers: { "x-chain": "solana" },
    //       });
    //       const data = (await response.json()) as BirdeyePriceResponse;
    //       if (data?.data?.value) {
    //         clearTimeout(timeoutId);
    //         const result = { price: data.data.value, source: api.name };
    //         cachedTokenPriceUSD = result;
    //         lastPriceFetchTime = currentTime;
    //         return result;
    //       }
    //     } else if (api.url.includes("dexscreener")) {
    //       endpoint = `${api.url}/${tokenAddressStr}`;
    //       response = await fetch(endpoint, { signal: controller.signal });
    //       const data = (await response.json()) as DexscreenerPriceResponse;
    //       if (data?.pairs?.[0]?.priceUsd) {
    //         clearTimeout(timeoutId);
    //         const result = { price: parseFloat(data.pairs[0].priceUsd), source: api.name };
    //         cachedTokenPriceUSD = result;
    //         lastPriceFetchTime = currentTime;
    //         return result;
    //       }
    //     }

    //     clearTimeout(timeoutId);
    //   } catch (apiError) {
    //     console.error(`Error with price API ${api.url}:`, apiError);
    //   }
    // }

    // throw new Error("All price APIs failed");
  } catch (error) {
    console.error("Error getting token price:", error);
    // Return cached price as fallback, or throw error if no cache
    if (cachedTokenPriceUSD !== null) {
      return cachedTokenPriceUSD;
    }
    throw error;
  }
}

// Get SOL price in USD
async function getSolPriceUSD(): Promise<number> {
  try {
    const solMintAddress = "So11111111111111111111111111111111111111112";

    // Try multiple APIs with fallbacks
    const apiEndpoints = [
      { url: "https://lite-api.jup.ag/price/v2", timeout: 5000 },
      { url: "https://api.coingecko.com/api/v3/simple/price", timeout: 5000 },
      { url: "https://public-api.birdeye.so/public/price", timeout: 5000 },
    ];

    // Try each API until one works
    for (const api of apiEndpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), api.timeout);

        let endpoint = api.url;
        let response;

        if (api.url.includes("jup.ag")) {
          endpoint = `${api.url}?ids=${solMintAddress}`;
          response = await fetch(endpoint, { signal: controller.signal });
          const data = (await response.json()) as any; // v2 API response format
          if (data?.data?.[solMintAddress]?.price) {
            clearTimeout(timeoutId);
            return parseFloat(data.data[solMintAddress].price);
          }
        } else if (api.url.includes("coingecko")) {
          endpoint = `${api.url}?ids=solana&vs_currencies=usd`;
          response = await fetch(endpoint, { signal: controller.signal });
          const data = (await response.json()) as { solana?: { usd?: number } };
          if (data?.solana?.usd) {
            clearTimeout(timeoutId);
            return data.solana.usd;
          }
        } else if (api.url.includes("birdeye.so")) {
          endpoint = `${api.url}?address=${solMintAddress}`;
          response = await fetch(endpoint, {
            signal: controller.signal,
            headers: { "x-chain": "solana" },
          });
          const data = (await response.json()) as BirdeyePriceResponse;
          if (data?.data?.value) {
            clearTimeout(timeoutId);
            return data.data.value;
          }
        }

        clearTimeout(timeoutId);
      } catch (apiError) {
        console.error(`Error with SOL price API ${api.url}:`, apiError);
      }
    }

    throw new Error("All SOL price APIs failed");
  } catch (error) {
    console.error("Error getting SOL price:", error);
    throw error;
  }
}

// Wait for token price to go above target price
async function waitForPriceAbove(
  targetPrice: number,
  checkIntervalMs: number = 5000,
  timeoutMs: number = 300000 // 5 minutes default timeout
): Promise<{ success: boolean; currentPrice: number; message: string }> {
  try {
    const startTime = Date.now();
    process.stderr.write(
      `Starting price monitoring (ABOVE). Target: $${targetPrice}, Check interval: ${checkIntervalMs}ms\n`
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        const currentPrice = await getTokenPriceUSD();
        process.stderr.write(
          `Current token price: $${currentPrice.price} (from ${currentPrice.source}), Target (ABOVE): $${targetPrice}\n`
        );

        if (currentPrice.price >= targetPrice) {
          return {
            success: true,
            currentPrice: currentPrice.price,
            message: `Price went ABOVE target! Current: $${currentPrice.price} (from ${currentPrice.source}), Target: $${targetPrice}`,
          };
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      } catch (priceError) {
        process.stderr.write(
          `Error fetching price during monitoring: ${priceError}\n`
        );
        // Continue monitoring even if one price fetch fails
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      }
    }

    // Timeout reached
    const finalPrice = await getTokenPriceUSD();
    return {
      success: false,
      currentPrice: finalPrice.price,
      message: `Timeout reached after ${timeoutMs}ms. Final price: $${finalPrice.price} (from ${finalPrice.source}), Target (ABOVE): $${targetPrice}`,
    };
  } catch (error) {
    process.stderr.write(`Error in waitForPriceAbove: ${error}\n`);
    throw error;
  }
}

// Wait for token price to go below target price
async function waitForPriceBelow(
  targetPrice: number,
  checkIntervalMs: number = 5000,
  timeoutMs: number = 300000 // 5 minutes default timeout
): Promise<{ success: boolean; currentPrice: number; message: string }> {
  try {
    const startTime = Date.now();
    process.stderr.write(
      `Starting price monitoring (BELOW). Target: $${targetPrice}, Check interval: ${checkIntervalMs}ms\n`
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        const currentPrice = await getTokenPriceUSD();
        process.stderr.write(
          `Current token price: $${currentPrice.price} (from ${currentPrice.source}), Target (BELOW): $${targetPrice}\n`
        );

        if (currentPrice.price <= targetPrice) {
          return {
            success: true,
            currentPrice: currentPrice.price,
            message: `Price went BELOW target! Current: $${currentPrice.price} (from ${currentPrice.source}), Target: $${targetPrice}`,
          };
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      } catch (priceError) {
        process.stderr.write(
          `Error fetching price during monitoring: ${priceError}\n`
        );
        // Continue monitoring even if one price fetch fails
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      }
    }

    // Timeout reached
    const finalPrice = await getTokenPriceUSD();
    return {
      success: false,
      currentPrice: finalPrice.price,
      message: `Timeout reached after ${timeoutMs}ms. Final price: $${finalPrice.price} (from ${finalPrice.source}), Target (BELOW): $${targetPrice}`,
    };
  } catch (error) {
    process.stderr.write(`Error in waitForPriceBelow: ${error}\n`);
    throw error;
  }
}

// Get token price specifically from Jupiter (for trading consistency)
async function getJupiterTokenPrice(): Promise<{
  price: number;
  source: string;
}> {
  try {
    const tokenAddressStr = TRADING_CONFIG.TOKEN_ADDRESS;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Updated to use Jupiter Price API v2
    const endpoint = `https://lite-api.jup.ag/price/v2?ids=${tokenAddressStr}`;
    const response = await fetch(endpoint, { signal: controller.signal });
    const data = (await response.json()) as any; // v2 API response format

    clearTimeout(timeoutId);

    if (data?.data?.[tokenAddressStr]?.price) {
      return {
        price: parseFloat(data.data[tokenAddressStr].price),
        source: "Jupiter (Trading Platform)",
      };
    } else {
      throw new Error("Jupiter price data not available");
    }
  } catch (error) {
    process.stderr.write(`Error getting Jupiter price: ${error}\n`);
    throw error;
  }
}

export {
  buyTokens,
  sellTokens,
  getTokenPriceUSD,
  getJupiterTokenPrice, // For trading consistency
  getSolPriceUSD,
  waitForPriceAbove,
  waitForPriceBelow,
  type TradeResponse,
};
