below is the config for the mcp server
{
"mcpServers": {
"solanaTrade": {
"command": "npx",
"args": [
"-y",
"ts-node",
"C:\\Users\\minee\\Code\\strategy_builder\\src\\index.ts"
],
"disabled": false,
"autoApprove": ["buyTokens", "sellTokens", "getTokenPrice", "deployCounterToAWS", "getCounterValueFromAWS", "stopCounterInAWS", "removeCounterFromAWS", "listDeployedCounters", "debugCounterInAWS"]
}
}
}
