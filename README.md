# Strategy Templates

The `StrategyBuilder` class provides static methods to generate reusable trading strategy templates:

## DCA (Dollar Cost Averaging) Strategy

```
StrategyBuilder.generateDCAStrategyTemplate(
  id: string,
  name: string,
  description: string,
  buyIntervalsMs: number[],
  buyAmountsSol: number[],
  riskLimits?: Partial<RiskLimits>
): Strategy
```

**Example:**
```ts
const dcaStrategy = StrategyBuilder.generateDCAStrategyTemplate(
  'dca1',
  'DCA Example',
  'Buy at regular intervals',
  [60000, 120000, 180000],
  [0.1, 0.2, 0.3]
);
```

---

## Grid Trading Strategy

```
StrategyBuilder.generateGridStrategyTemplate(
  id: string,
  name: string,
  description: string,
  gridLevels: number,
  lowerPrice: number,
  upperPrice: number,
  amountPerLevel: number,
  riskLimits?: Partial<RiskLimits>
): Strategy
```

**Example:**
```ts
const gridStrategy = StrategyBuilder.generateGridStrategyTemplate(
  'grid1',
  'Grid Example',
  'Buy/sell at grid levels',
  5,
  10,
  20,
  0.5
);
```

---

## Stop-Loss Strategy

```
StrategyBuilder.generateStopLossStrategyTemplate(
  id: string,
  name: string,
  description: string,
  entryPrice: number,
  stopLossPrice: number,
  amountInSol: number,
  riskLimits?: Partial<RiskLimits>
): Strategy
```

**Example:**
```ts
const stopLossStrategy = StrategyBuilder.generateStopLossStrategyTemplate(
  'sl1',
  'Stop-Loss Example',
  'Buy and sell at stop-loss',
  100,
  90,
  1
);
```

---

See the `StrategyBuilder.ts` source and tests for more details and advanced usage.
# Strategy Builder MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-%23FF9900.svg?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/)

A Model Context Protocol (MCP) server for executing automated trading strategies using Claude Desktop as the client. This server provides real-time trading capabilities, price monitoring, and time-based operations for Solana token trading.

## 🚀 What is MCP?

The Model Context Protocol (MCP) is an open standard that enables AI applications to securely access external data and tools. This server implements MCP to allow Claude Desktop to interact with trading functions, monitor prices, and execute trades autonomously.

## Features

- Real-time token price monitoring
- Automated buy/sell execution
- **Counter functions for time-based operations** ⭐ NEW
- WebSocket support for real-time communication
- REST API endpoints for trading operations
- Price caching for efficient API usage
- AWS deployment ready

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template and configure your variables:
   ```bash
   cp .env.example .env
   ```
4. Edit `.env` with your configuration:
   - Add your wallet private key
   - Set your token address
   - Configure trading parameters
   - Set RPC endpoint

## Development

Run the development server:

```bash
npm run dev
```

## Production

Build and run the production server:

```bash
npm run build
npm start
```

## Counter Functions

The server includes counter functions for time-based operations:

- `startCounter` - Start a counter that increments by 10 every second
- `getCounterValue` - Get current counter value and status
- `stopCounter` - Stop the running counter
- `resetCounter` - Reset counter to initial state

For detailed documentation, see [COUNTER_FUNCTIONS.md](./COUNTER_FUNCTIONS.md).

## API Endpoints

### REST API

- `POST /api/trade/buy` - Buy tokens

  ```json
  {
    "targetWalletAddress": "wallet_address",
    "amountInSol": 0.1
  }
  ```

- `POST /api/trade/sell` - Sell tokens

  ```json
  {
    "targetWalletAddress": "wallet_address",
    "reason": "take_profit",
    "amountToSell": 1000
  }
  ```

- `GET /api/price` - Get current token price

### WebSocket Events

- `trade:buy` - Buy tokens
- `trade:sell` - Sell tokens
- `trade:price` - Get current price

## Using with Claude Desktop

The server is designed to work with Claude Desktop as an MCP client. Claude can:

1. Monitor token prices
2. Execute trades based on price conditions
3. Manage trading strategies
4. **Use counter functions for time-based operations** ⭐ NEW
5. Handle error cases and retries

## AWS Deployment

This MCP server is designed for AWS deployment using the included infrastructure:

- Dockerized for container deployment
- ECS/Fargate ready
- Health checks included
- Environment variable configuration

The counter functions work seamlessly in the AWS environment and maintain state during the container lifecycle.

## Security

- Never commit your `.env` file
- Keep your wallet private key secure
- Use appropriate slippage settings
- Monitor transaction confirmations

## License

MIT
