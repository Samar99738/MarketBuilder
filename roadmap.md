Creating a strategy builder by integrating the trading tools codebase with the client's UI or a frontend using MCP.

Example Prompt
1st Stage ------>
"Buy trump token"
Done ✅

2nd Stage ------>
"Buy a trump token,wait till there is a trump token buy of more than 1 sol and sell"
MCP can't do that ❌
Can i code a function that does that and ask mcp to use those functions ?
let's add a subscribe to price and return when the price crosses the given parameter
Now lets add a function to deploy this strategy to a cloud provider
The strategy is to buy tokens , wait till price increases by 1% and then sell the tokens

29th target
Create a function that arranges these tool functions as specified in prompt

Changes:

3rd Stage ------>
"Create a telegram bot that after using /start command will first buy a trump token, then wait for a 1 sol buy of trump token and will sell"

Let's build a file with crypto trading functions here
Functions
Now

- buy_token
- sell_token
- extract_buyer_wallets
- check_wallet_age
- check_wallet_transaction_count_more_than_x(int x), check_wallet_tx_count
- check_wallet_balance
- subscribe to the wallet txs
- subscribe to the token txs
- subscribe to the program txs
  specify and map the different programs to their id's

Later phases

- check for project's twitter, instagram, linkedin etc.
- check current time
- check token's market cap
- sell at specific price
- buy at specific price

Advanced

- buy at a specific twitter handle's post
