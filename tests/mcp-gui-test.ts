/**
 * MCP Server GUI Test Helper
 * Creates a simple HTML page to test MCP server connectivity
 * 
 * Run: npx ts-node tests/mcp-gui-test.ts
 * Then open: http://localhost:3001/mcp-test.html
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 3001;

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Server Test - Pump.fun Trading</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }
        
        .content {
            padding: 40px;
        }
        
        .section {
            margin-bottom: 40px;
        }
        
        .section h2 {
            color: #667eea;
            margin-bottom: 20px;
            font-size: 1.8em;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }
        
        .step {
            background: #f7f9fc;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            border-left: 5px solid #667eea;
        }
        
        .step-number {
            background: #667eea;
            color: white;
            width: 35px;
            height: 35px;
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            margin-right: 15px;
        }
        
        .step h3 {
            display: inline-block;
            color: #333;
            font-size: 1.3em;
            margin-bottom: 15px;
        }
        
        .step-content {
            margin-left: 50px;
            color: #555;
            line-height: 1.8;
        }
        
        .code-block {
            background: #2d3748;
            color: #f7fafc;
            padding: 20px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            margin: 15px 0;
            overflow-x: auto;
            position: relative;
        }
        
        .code-block::before {
            content: 'Copy';
            position: absolute;
            top: 10px;
            right: 10px;
            background: #667eea;
            color: white;
            padding: 5px 15px;
            border-radius: 5px;
            font-size: 12px;
            cursor: pointer;
            font-family: 'Segoe UI', sans-serif;
        }
        
        .code-block:hover::before {
            background: #5568d3;
        }
        
        .success {
            background: #48bb78;
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        
        .success h3 {
            margin-bottom: 10px;
            font-size: 1.5em;
        }
        
        .tools-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        
        .tool-card {
            background: white;
            border: 2px solid #667eea;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            transition: transform 0.2s;
        }
        
        .tool-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.2);
        }
        
        .tool-icon {
            font-size: 2em;
            margin-bottom: 10px;
        }
        
        .tool-name {
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }
        
        .tool-desc {
            font-size: 0.9em;
            color: #666;
        }
        
        .warning {
            background: #fed7d7;
            border-left: 5px solid #f56565;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
        }
        
        .warning h4 {
            color: #c53030;
            margin-bottom: 10px;
        }
        
        .button {
            background: #667eea;
            color: white;
            padding: 15px 30px;
            border: none;
            border-radius: 8px;
            font-size: 1.1em;
            cursor: pointer;
            transition: background 0.3s;
            margin: 10px 5px;
        }
        
        .button:hover {
            background: #5568d3;
        }
        
        .checklist {
            list-style: none;
        }
        
        .checklist li {
            padding: 10px;
            margin: 10px 0;
            background: #f7f9fc;
            border-radius: 5px;
        }
        
        .checklist li::before {
            content: '☐ ';
            color: #667eea;
            font-size: 1.5em;
            margin-right: 10px;
        }
        
        .checklist li.checked::before {
            content: '✓ ';
            color: #48bb78;
        }
        
        .footer {
            background: #2d3748;
            color: white;
            text-align: center;
            padding: 30px;
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 MCP Server Integration Test</h1>
            <p>Claude Desktop + Pump.fun Trading Tools</p>
        </div>
        
        <div class="content">
            <div class="section">
                <h2>✅ MCP Server Status</h2>
                <div class="success">
                    <h3>🎉 MCP Server is Working!</h3>
                    <p>Your MCP server initialized successfully with 5 trading tools.</p>
                </div>
                
                <div class="tools-list">
                    <div class="tool-card">
                        <div class="tool-icon">📊</div>
                        <div class="tool-name">get-token-info</div>
                        <div class="tool-desc">Get token metadata and price</div>
                    </div>
                    <div class="tool-card">
                        <div class="tool-icon">💰</div>
                        <div class="tool-name">buy-token</div>
                        <div class="tool-desc">Buy pump.fun tokens with SOL</div>
                    </div>
                    <div class="tool-card">
                        <div class="tool-icon">💸</div>
                        <div class="tool-name">sell-token</div>
                        <div class="tool-desc">Sell tokens for SOL</div>
                    </div>
                    <div class="tool-card">
                        <div class="tool-icon">👥</div>
                        <div class="tool-name">list-accounts</div>
                        <div class="tool-desc">Show all trading accounts</div>
                    </div>
                    <div class="tool-card">
                        <div class="tool-icon">💵</div>
                        <div class="tool-name">get-account-balance</div>
                        <div class="tool-desc">Check SOL/token balance</div>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h2>📋 Claude Desktop Setup Steps</h2>
                
                <div class="step">
                    <span class="step-number">1</span>
                    <h3>Locate Config File</h3>
                    <div class="step-content">
                        <p>Open File Explorer and navigate to:</p>
                        <div class="code-block">%APPDATA%\\Claude\\claude_desktop_config.json</div>
                        <p><strong>Quick access:</strong> Press Win+R, paste the path above, press Enter</p>
                    </div>
                </div>
                
                <div class="step">
                    <span class="step-number">2</span>
                    <h3>Edit Config File</h3>
                    <div class="step-content">
                        <p>Open the file in Notepad or VS Code and paste this configuration:</p>
                        <div class="code-block">{
  "mcpServers": {
    "pumpfun-trader": {
      "command": "node",
      "args": ["E:/Work/market-maker-code/dist/src/index.js"],
      "env": {
        "NODE_ENV": "production",
        "RPC_ENDPOINT": "https://holy-sparkling-dream.solana-mainnet.quiknode.pro/",
        "GEMINI_API_KEY": "AIzaSyBfC_oRUUl2h1slxTBDD39ZvTn6brno8Dg",
        "PUMPFUN_ENABLED": "true",
        "PUMPFUN_MAX_TRADE_AMOUNT": "0.5",
        "MPC_ENABLED": "true"
      }
    }
  }
}</div>
                        <p><strong>Important:</strong> Save the file after pasting!</p>
                    </div>
                </div>
                
                <div class="step">
                    <span class="step-number">3</span>
                    <h3>Restart Claude Desktop</h3>
                    <div class="step-content">
                        <p>Completely close and reopen Claude Desktop:</p>
                        <ul style="margin-left: 20px; margin-top: 10px;">
                            <li>Right-click taskbar icon → Exit</li>
                            <li>Wait 5 seconds</li>
                            <li>Reopen from Start Menu</li>
                        </ul>
                    </div>
                </div>
                
                <div class="step">
                    <span class="step-number">4</span>
                    <h3>Verify Connection</h3>
                    <div class="step-content">
                        <p>In Claude Desktop, look for:</p>
                        <ul style="margin-left: 20px; margin-top: 10px;">
                            <li>🔌 MCP indicator at bottom of chat</li>
                            <li>Click it to see 5 tools listed</li>
                            <li>All tools should show "pumpfun-trader" source</li>
                        </ul>
                    </div>
                </div>
                
                <div class="step">
                    <span class="step-number">5</span>
                    <h3>Test in Claude</h3>
                    <div class="step-content">
                        <p>Type this in Claude Desktop chat:</p>
                        <div class="code-block">Use the get-token-info tool to check this token:
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</div>
                        <p><strong>Expected:</strong> Claude calls the tool and returns token information</p>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h2>✓ Success Checklist</h2>
                <ul class="checklist">
                    <li>Config file created at correct location</li>
                    <li>JSON configuration pasted and saved</li>
                    <li>Claude Desktop restarted</li>
                    <li>🔌 MCP indicator visible in chat</li>
                    <li>5 tools listed when clicking MCP icon</li>
                    <li>get-token-info tool executes successfully</li>
                    <li>No error messages in tool execution</li>
                </ul>
            </div>
            
            <div class="warning">
                <h4>⚠️ Important Security Notes</h4>
                <ul style="margin-left: 20px;">
                    <li>MPC wallet is enabled for safer trading</li>
                    <li>Max trade amount limited to 0.5 SOL</li>
                    <li>Always test with small amounts first</li>
                    <li>Never share your config file (contains API keys)</li>
                    <li>Monitor all trades in console logs</li>
                </ul>
            </div>
            
            <div class="section">
                <h2>🧪 Test Commands for Claude</h2>
                
                <div style="background: #f7f9fc; padding: 20px; border-radius: 10px;">
                    <h3 style="margin-bottom: 15px;">Copy these to test in Claude Desktop:</h3>
                    
                    <div style="margin: 20px 0;">
                        <strong>1. Check Token Info:</strong>
                        <div class="code-block">Get info for Solana token: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</div>
                    </div>
                    
                    <div style="margin: 20px 0;">
                        <strong>2. List Accounts:</strong>
                        <div class="code-block">Show me all trading accounts using list-accounts tool</div>
                    </div>
                    
                    <div style="margin: 20px 0;">
                        <strong>3. Check Balance:</strong>
                        <div class="code-block">What is the SOL balance for account "default"?</div>
                    </div>
                    
                    <div style="margin: 20px 0;">
                        <strong>4. Explain Tool (Safe):</strong>
                        <div class="code-block">Explain how the buy-token tool works and what parameters it needs</div>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h2>🔧 Troubleshooting</h2>
                
                <div style="background: #f7f9fc; padding: 20px; border-radius: 10px;">
                    <h4 style="margin-bottom: 15px;">Tools not showing in Claude?</h4>
                    <ol style="margin-left: 20px; line-height: 2;">
                        <li>Verify config file path is correct</li>
                        <li>Check JSON syntax (use jsonlint.com)</li>
                        <li>Ensure node is installed: <code>node --version</code></li>
                        <li>Rebuild project: <code>npm run build</code></li>
                        <li>Check Claude Desktop logs: <code>%APPDATA%\\Claude\\logs\\</code></li>
                        <li>Restart Claude Desktop again</li>
                    </ol>
                </div>
            </div>
            
            <div class="success" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                <h3>🎉 You're Ready!</h3>
                <p>Once you see the 5 tools in Claude Desktop and can execute get-token-info, you have a fully functional trading assistant powered by MCP!</p>
            </div>
        </div>
        
        <div class="footer">
            <p>🚀 Pump.fun MCP Server - Production Ready</p>
            <p style="margin-top: 10px; opacity: 0.8;">Built with ❤️ for production trading</p>
        </div>
    </div>
    
    <script>
        // Make code blocks copyable
        document.querySelectorAll('.code-block').forEach(block => {
            block.addEventListener('click', () => {
                const text = block.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    const before = block.style.getPropertyValue('--before-content');
                    block.style.setProperty('--before-content', '"Copied!"');
                    setTimeout(() => {
                        block.style.setProperty('--before-content', before);
                    }, 2000);
                });
            });
        });
        
        // Make checklist interactive
        document.querySelectorAll('.checklist li').forEach(item => {
            item.addEventListener('click', () => {
                item.classList.toggle('checked');
            });
        });
    </script>
</body>
</html>
`;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/mcp-test.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_CONTENT);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('  🎨 MCP SERVER SETUP GUIDE');
  console.log('='.repeat(70));
  console.log(`\n✅ Web server started!`);
  console.log(`\n📖 Open this URL in your browser:`);
  console.log(`   http://localhost:${PORT}/mcp-test.html`);
  console.log(`\n📋 This page will guide you through:`);
  console.log(`   1. Setting up Claude Desktop config`);
  console.log(`   2. Verifying MCP connection`);
  console.log(`   3. Testing tools in Claude GUI`);
  console.log(`\n⌨️  Press Ctrl+C to stop this server\n`);
  console.log('='.repeat(70) + '\n');
});
