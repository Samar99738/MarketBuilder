Basic structure -----------------

Code base(current project) => MCP server (MCP can even work on tools like blender or other tools)

    || (MCP)
    \/

LLM => Claude desktop

The above MCP Usecase is been used to create a project where
i) I'll have trading functions in the MCP server
ii) Connect this to the frontend (currently iam using claude desktop), we call this the client.

Important Locations -------------------

Functions are in src/trading_utils/TokenUtils.ts
StrategyBuilder.ts has utils to build the strategies using these functions

Ordering of functions ----------------------

To create a strategy the mcp client has to order the existing functions
For that i have created another function that orders these functions using them as tools.
Each function is given an unique id
This id is passed as parameter and ordered in a way the user wants the strategy to execute

Connecting MCP client to server ---------------------------

Use src/trading_utils/index.ts to make the functions in mcp server acccessible
The Server is connected to calude desktop using the configuration as in the Information.md file
paste this in the claude desktop file/settings/developer/edit_config/claude_desktop_config
you can also find logs and other config files there

Optimizations needed for server-----------

Currently we are running the server using claude desktop in the local machine as a sub process
It would be better to deploy the code somewhere and fetch the result of the execution and other states from there
also deploy the functions somewhere else
Also deploy the mcp server in some cloud to retrieve and manage states better

Optimizations for client ------------------------

currently we are using claude desktop
shift it to a front end like website
We utilize the power of an LLM by sticking the api key of anthropic somewhere when configuring the website
