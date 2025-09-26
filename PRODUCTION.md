# 🚀 PRODUCTION DEPLOYMENT GUIDE

This guide helps you safely deploy our Market Maker Trading Platform to production with proper environment management and security.

## SECURITY FIRST

**⚠️ CRITICAL SECURITY REMINDERS:**
- Never commit your `.env` file containing private keys
- Use premium RPC endpoints for production reliability
- Start with small trading amounts
- Always test on devnet first
- Monitor your trades actively

## 📋 DEPLOYMENT CHECKLIST

### ✅ Pre-Deployment
- [ ] Tested thoroughly on devnet
- [ ] Verified wallet private key format
- [ ] Configured production RPC endpoints
- [ ] Set appropriate trading limits
- [ ] Funded wallet with sufficient SOL
- [ ] Set up monitoring/alerts

### ✅ Environment Setup
- [ ] Copied `.env.example` to `.env.production`
- [ ] Configured all required variables
- [ ] Validated configuration
- [ ] Tested connectivity

## 🔧 ENVIRONMENT CONFIGURATION

### 1. Initialize Environment Files

```bash
# Copy example configuration
npm run env:init

# Create production environment
cp .env.example .env.production
```

### 2. Configure Production Environment

Edit `.env.production` with your production settings:

```bash
# PRODUCTION ENVIRONMENT
NODE_ENV=production

# WALLET (CRITICAL - Keep secure!)
WALLET_PRIVATE_KEY=your_actual_base58_private_key

# NETWORK (Use premium RPC for best performance)
RPC_ENDPOINT=https://your-premium-rpc-endpoint.com
# Options:
# - https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY
# - https://rpc.helius.xyz/?api-key=YOUR_API_KEY  
# - https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# TRADING CONFIGURATION
TOKEN_ADDRESS=your_target_token_address
BUY_AMOUNT_SOL=0.1
SLIPPAGE_BPS=300
MAX_SLIPPAGE_BPS=1000

# SECURITY
ENABLE_RATE_LIMITING=true
MAX_REQUESTS_PER_MINUTE=100
```

### 3. Validate Configuration

```bash
# Validate your configuration
npm run env:validate

# Test connectivity
node -e "
const { Connection } = require('@solana/web3.js');
require('dotenv').config({ path: '.env.production' });
const conn = new Connection(process.env.RPC_ENDPOINT);
conn.getVersion().then(v => console.log('✅ Connected:', v));
"
```

## 🚀 DEPLOYMENT METHODS

### Method 1: Automated Deployment (Recommended)

```bash
# Deploy to development (safe testing)
npm run deploy:dev

# Deploy to production (real money!)
npm run deploy:prod
```

### Method 2: Manual Deployment

```bash
# 1. Build application
npm run build

# 2. Set environment
export NODE_ENV=production

# 3. Start application
npm start
```

## 🔐 ENVIRONMENT-SPECIFIC CONFIGURATIONS

### Development Environment
- **Network**: Devnet (safe testing)
- **Trading**: Small amounts
- **RPC**: Free endpoints OK
- **Monitoring**: Debug level logging

### Production Environment  
- **Network**: Mainnet (real money!)
- **Trading**: Your actual amounts
- **RPC**: Premium endpoints recommended
- **Monitoring**: Info level logging
- **Security**: Rate limiting enabled

## 📊 MONITORING & MAINTENANCE

### Performance Monitoring

Your application includes built-in performance monitoring:

```bash
# Check system performance
curl http://localhost:3000/api/performance

# Monitor network status
curl http://localhost:3000/api/price
```

### Key Metrics to Monitor:
- Transaction success rate
- Average latency
- Network congestion levels
- RPC endpoint performance
- Wallet balance

### Log Monitoring

```bash
# View real-time logs
tail -f logs/trading.log

# Monitor errors
grep "ERROR" logs/trading.log

# Check performance metrics
grep "Performance" logs/trading.log
```

## 🛠️ TROUBLESHOOTING

### Common Issues

**1. Configuration Errors**
```bash
# Validate configuration
npm run env:validate

# Check for missing variables
node -e "console.log(process.env)" | grep undefined
```

**2. Network Connectivity**
```bash
# Test RPC endpoint
curl -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
  YOUR_RPC_ENDPOINT
```

**3. Wallet Issues**
```bash
# Verify wallet format
node -e "
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');
try {
  const wallet = Keypair.fromSecretKey(bs58.decode('YOUR_PRIVATE_KEY'));
  console.log('✅ Wallet valid:', wallet.publicKey.toString());
} catch (e) {
  console.log('❌ Invalid wallet format');
}
"
```

**4. Performance Issues**
- Switch to premium RPC endpoint
- Increase priority fees
- Reduce transaction frequency
- Check network congestion

## ⚡ PERFORMANCE OPTIMIZATION

### Production RPC Endpoints (Recommended)

```bash
# Alchemy (Fast & Reliable)
RPC_ENDPOINT=https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Helius (High Performance)
RPC_ENDPOINT=https://rpc.helius.xyz/?api-key=YOUR_API_KEY

# QuickNode (Enterprise Grade)  
RPC_ENDPOINT=https://YOUR_SUBDOMAIN.solana-mainnet.quiknode.pro/YOUR_TOKEN/
```

### Priority Fee Optimization

Your platform automatically adjusts priority fees based on network conditions:

- **Low Congestion**: 1,000 lamports
- **Medium Congestion**: 5,000 lamports  
- **High Congestion**: 10,000 lamports
- **Extreme Congestion**: 50,000 lamports

## 🔧 ADVANCED CONFIGURATION

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | development | Environment mode |
| `WALLET_PRIVATE_KEY` | - | Your wallet private key (Base58) |
| `TOKEN_ADDRESS` | - | Target token contract address |
| `RPC_ENDPOINT` | - | Solana RPC endpoint |
| `BUY_AMOUNT_SOL` | 0.1 | Default buy amount in SOL |
| `SLIPPAGE_BPS` | 300 | Default slippage (3%) |
| `MAX_SLIPPAGE_BPS` | 1000 | Maximum slippage (10%) |
| `PRIORITY_FEE_LAMPORTS` | 5000 | Base priority fee |
| `ENABLE_RATE_LIMITING` | true | Enable API rate limiting |
| `MAX_REQUESTS_PER_MINUTE` | 100 | API rate limit |

## 🚨 EMERGENCY PROCEDURES

### Stop Trading Immediately
```bash
# Kill the process
pkill -f "node dist/index.js"

# Or use Ctrl+C in the terminal
```

### Emergency Wallet Recovery
1. Stop the application immediately
2. Export your private key from `.env`
3. Import into Phantom/Solflare wallet
4. Manually execute emergency trades if needed

## 📞 SUPPORT & RESOURCES

- **Documentation**: See project README.md
- **Performance Monitoring**: http://localhost:3000/api/performance
- **Health Check**: http://localhost:3000/health
- **Logs**: Check console output and log files

---

## ⚠️ FINAL PRODUCTION REMINDERS

**BEFORE GOING LIVE:**
1. ✅ Test everything on devnet
2. ✅ Verify all configurations  
3. ✅ Start with small amounts
4. ✅ Monitor actively
5. ✅ Have emergency plan ready

**YOUR MONEY IS AT RISK - TRADE RESPONSIBLY!**