import dotenv from "dotenv";
import path from "path";

// Load environment variables first - try multiple possible locations
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") }); // From src/trading_utils to root
dotenv.config({ path: path.join(process.cwd(), ".env") }); // From current working directory

export const TRADING_CONFIG = {
  // Wallet configuration - handle both comma-separated and base58 formats
  WALLET_PRIVATE_KEY: (() => {
    const key = process.env.WALLET_PRIVATE_KEY || "";
    if (!key) return "";

    // If it contains commas, it's in array format - convert to Uint8Array
    if (key.includes(",")) {
      try {
        const keyArray = key.split(",").map((num) => parseInt(num.trim()));
        return new Uint8Array(keyArray);
      } catch (error) {
        console.error("Error parsing comma-separated private key:", error);
        return "";
      }
    }

    // Otherwise assume it's base58 format
    return key;
  })(),

  // RPC endpoint
  RPC_ENDPOINT:
    process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",

  // Token configuration
  TOKEN_ADDRESS:
    process.env.TOKEN_ADDRESS || "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", // Default to Trump

  // Trading parameters
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || "0.1"),
  MIN_SELL_AMOUNT: parseFloat(process.env.MIN_SELL_AMOUNT || "0.000001"),
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "100"), // 1%

  // Transaction parameters
  DYNAMIC_COMPUTE_UNIT_LIMIT: true,
  PRIORITY_FEE_LAMPORTS: parseInt(process.env.PRIORITY_FEE_LAMPORTS || "1000"),
} as const;
