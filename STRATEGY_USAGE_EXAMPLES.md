# Strategy Builder Usage Examples

Now that your MCP server includes strategy builder tools, Claude Desktop can create and execute complex trading strategies through natural language commands.

## Available Strategy Tools

Claude now has access to these strategy tools:

- `createStrategy` - Create a new strategy
- `addStrategyStep` - Add steps to a strategy
- `executeStrategy` - Execute a strategy
- `listStrategies` - List all strategies
- `getStrategy` - Get strategy details
- `deleteStrategy` - Delete a strategy

## Example Usage Through Claude Desktop

### 1. Simple Buy and Hold Strategy

**You can say to Claude:**

> "Create a buy and hold strategy that buys 0.1 SOL worth of tokens, waits for the price to reach $0.002, then sells all tokens"

**Claude will execute:**

```
1. createStrategy(id: "buy-hold-1", name: "Buy and Hold", description: "...")
2. addStrategyStep(strategyId: "buy-hold-1", step: {id: "buy", type: "buy", amountInSol: 0.1, onSuccess: "wait"})
3. addStrategyStep(strategyId: "buy-hold-1", step: {id: "wait", type: "waitPriceAbove", targetPrice: 0.002, onSuccess: "sell"})
4. addStrategyStep(strategyId: "buy-hold-1", step: {id: "sell", type: "sell", amountToSell: -1})
5. executeStrategy(strategyId: "buy-hold-1")
```

### 2. Dollar Cost Averaging Strategy

**You can say:**

> "Create a DCA strategy that buys 0.05 SOL worth of tokens every 60 seconds, 5 times total"

**Claude will create:**

- Multiple buy steps with wait steps in between
- Proper flow control between steps

### 3. Stop Loss Strategy

**You can say:**

> "Create a stop loss strategy: buy 0.1 SOL worth, sell if price drops below $0.0005 or rises above $0.003"

**Claude will create:**

- Buy step
- Price monitoring with conditions
- Sell triggers for both stop loss and take profit

### 4. Custom Complex Strategy

**You can say:**

> "Create a strategy that waits for price to drop below $0.0008, then buys 0.1 SOL worth, waits 30 seconds, buys another 0.05 SOL worth, then waits for price to go above $0.0015 and sells everything"

**Claude will:**

- Break down your requirements into individual steps
- Create proper flow control between steps
- Set up the strategy and execute it

## Strategy Management

### List Your Strategies

> "Show me all my trading strategies"

### Get Strategy Details

> "Show me the details of my 'buy-hold-1' strategy"

### Execute Existing Strategy

> "Execute my 'dca-strategy' strategy"

### Delete Strategy

> "Delete my 'old-strategy' strategy"

## Strategy Step Types Available

- **buy** - Purchase tokens with SOL
- **sell** - Sell tokens (use -1 for all tokens)
- **waitPriceAbove** - Wait for price to go above target
- **waitPriceBelow** - Wait for price to go below target
- **getPrice** - Get current token price
- **getSolPrice** - Get current SOL price
- **wait** - Wait for specified time
- **condition** - Check conditions and branch

## Flow Control

Each step can specify:

- **onSuccess** - Next step if successful
- **onFailure** - Next step if failed

This allows for complex branching logic and error handling.

## Example Natural Language Commands

- "Create a scalping strategy that does quick buy/sell cycles"
- "Make a strategy that only buys when price drops 10% from current level"
- "Create a strategy that monitors price for 5 minutes and buys if it stays stable"
- "Build a strategy that sells 50% of tokens at 2x price and holds the rest"
- "Create a strategy with stop loss at -20% and take profit at +50%"

Claude will interpret your natural language and create the appropriate strategy steps with proper flow control!
