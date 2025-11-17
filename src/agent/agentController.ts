/**
 * Agent Controller
 * Main orchestrator for AI trading agent interactions
 * NOW WITH PUMP.FUN INTEGRATION & MCP SERVER!
 * 
 * Features:
 * - Natural language strategy parsing
 * - Real-time token detection and price info
 * - Pump.fun token routing and trading
 * - MCP (Model Context Protocol) server integration for advanced capabilities
 * - Session management and conversation history
 */

import { geminiClient, ChatMessage } from './geminiClient';
import { SYSTEM_PROMPTS } from './strategyPrompts';
import { strategyParser, ParsedStrategy } from './strategyParser';
import { strategyValidator } from './strategyValidator'; // AI-FIRST: Lightweight validator
import { createStrategyFromTemplate } from '../trading_utils/StrategyTemplates';
import { strategyBuilder } from '../trading_utils/StrategyBuilder';
import { strategyExecutionManager } from '../trading_utils/StrategyExecutionManager';
import { strategyExecutionTracker } from '../trading_utils/StrategyExecutionTracker';
import { awsLogger } from '../aws/logger';
import { getUnifiedTrading } from '../trading_utils/UnifiedTrading';
import { getPumpFunAPI } from '../trading_utils/PumpFunAPI';
import { getMCPServer } from './MCPServer';
import { Connection, PublicKey } from '@solana/web3.js';
import { TRADING_CONFIG } from '../trading_utils/config';
import { MCPToolExecutor, ToolRequest, ToolResult } from '../../MCPServer/Mcptoolexecutor';
import { Tool } from '@google/generative-ai';
import type { Server as SocketServer } from 'socket.io';



export interface AgentSession {
  sessionId: string;
  conversationHistory: ChatMessage[];
  currentStrategy?: ParsedStrategy;
  walletConnected: boolean;
  walletAddress?: string;
  createdAt: number;
  lastActivity: number;
  isFreshSession?: boolean;
  pendingConfirmation?: {
    tool: string;
    params: any;
    timestamp: number;
    message: string;
  };
  enabledTools?: string[]; // List of enabled MCP tools from frontend
}

export interface AgentResponse {
  message: string;
  suggestedStrategy?: ParsedStrategy;
  requiresWallet?: boolean;
  requiresConfirmation?: boolean;
  actions?: string[];
  strategyId?: string; // ID of running strategy if simulation started
}

export class AgentController {
  private sessions: Map<string, AgentSession> = new Map();
  private priceCache: { price: number; timestamp: number } | null = null;
  private readonly PRICE_CACHE_TTL = 60000; // 1 minute
  // MCP Tool Executor instance
  private mcpToolExecutor: MCPToolExecutor;
  // WebSocket IO for real-time updates
  private io: SocketServer | null = null;

  constructor() {
    // Initialize MCP Tool Executor
    const connection = new Connection(
      TRADING_CONFIG.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.mcpToolExecutor = new MCPToolExecutor(connection);

    console.log('AgentController initialized with MCP Tool Executor');
  }

  /**
   * Set WebSocket IO for real-time updates
   */
  setSocketIO(io: SocketServer): void {
    this.io = io;
    console.log('AgentController: WebSocket IO configured');
  }

  /**
   * Get or create session
   */
  getSession(sessionId: string): AgentSession {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        conversationHistory: [],
        walletConnected: false,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        isFreshSession: true
      });

      geminiClient.clearHistory();
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session;
  }

  /**
   * Process user message and generate response
   * NOW WITH PUMP.FUN TOKEN DETECTION!
   */
  async processMessage(
    sessionId: string,
    userMessage: string,
    walletAddress?: string,
    enabledTools?: string[]
  ): Promise<AgentResponse> {
    try {
      const session = this.getSession(sessionId);

      // Store enabled tools in session for tool execution filtering
      if (enabledTools) {
        session.enabledTools = enabledTools;
      }

      // Update wallet connection status
      if (walletAddress) {
        session.walletConnected = true;
        session.walletAddress = walletAddress;
      }

      // Check for pending confirmation FIRST
      if (session.pendingConfirmation) {
        const confirmation = this.detectConfirmation(userMessage);

        if (confirmation === 'confirm') {
          console.log(` User confirmed pending action`);

          // Execute the pending tool
          const toolRequest = {
            tool: session.pendingConfirmation.params.actualTool,
            params: session.pendingConfirmation.params
          };

          // Remove actualTool from params as it's not a valid parameter
          delete toolRequest.params.actualTool;

          // clear pending confirmation
          session.pendingConfirmation = undefined;

          // Execute the tool
          const toolResponse = await this.executeToolAndFormat(toolRequest, sessionId);

          // Add to conversation history
          session.conversationHistory.push({
            role: 'user',
            content: userMessage,
            timestamp: Date.now()
          });

          session.conversationHistory.push({
            role: 'assistant',
            content: toolResponse,
            timestamp: Date.now()
          });

          await awsLogger.info('Confirmed action executed', {
            metadata: {
              sessionId,
              tool: toolRequest.tool,
              params: toolRequest.params,
            }
          });

          return {
            message: toolResponse,
            requiresWallet: false,
            requiresConfirmation: false,
            actions: []
          };
        } else if (confirmation === 'cancel') {
          console.log(` User Cancelled pending action`);

          // clear pending confirmation
          session.pendingConfirmation = undefined;

          const cancelMessage = ` **Action Cancelled**\n\nThe transaction has been cancelled. No funds were moved.`;
          // ADD to conversation history
          session.conversationHistory.push({
            role: 'user',
            content: userMessage,
            timestamp: Date.now()
          });

          session.conversationHistory.push({
            role: 'assistant',
            content: cancelMessage,
            timestamp: Date.now()
          });

          return {
            message: cancelMessage,
            requiresWallet: false,
            requiresConfirmation: false,
            actions: []
          };
        } else {
          // User said something else while confirmation is pending
          const reminderMessage = `⚠️ You have a pending action: "${session.pendingConfirmation.message}". Please confirm or cancel this action before proceeding with other requests.`;

          return {
            message: reminderMessage,
            requiresWallet: false,
            requiresConfirmation: true,
            actions: []
          };
        }
      }

      // Users must use the "Activate" button - verbal activation is disabled for safety
      // If user says "activate it", the AI will respond telling them to use the button

      //  Guide users to button if they try verbal activation
      const verbalActivationAttempt = /^(activate|execute|run|start|deploy|go ahead|do it|proceed|let's do it|lets do it|activate it|run it|execute it)/i.test(userMessage.trim());
      if (verbalActivationAttempt && session.currentStrategy) {
        console.log(' User attempted verbal activation - guiding to button');

        const guidanceMessage = `To activate your strategy, please use the **Activate button** shown below the strategy card.\n\nThis ensures you're making a conscious, confirmed decision to start trading. The button will ask for final confirmation before execution begins. 🔒`;

        session.conversationHistory.push({
          role: 'user',
          content: userMessage,
          timestamp: Date.now()
        });

        session.conversationHistory.push({
          role: 'assistant',
          content: guidanceMessage,
          timestamp: Date.now()
        });

        return {
          message: guidanceMessage,
          requiresWallet: false,
          requiresConfirmation: true, // Keep button visible
          suggestedStrategy: session.currentStrategy, // Keep strategy visible
          actions: []
        };
      }

      // PRIORITY 1: Check if user is asking about a specific token FIRST (PUMP.FUN INTEGRATION)
      // This must come BEFORE MCP tool detection for better formatting

      // Check for strategy keywords that indicate this is NOT just a token query
      const hasStrategyKeywordsForToken = /\b(buy|sell|trade|when|mirror|match|follow|dca|limit|stop|exact amount|same amount|people|activity)\b/i.test(userMessage);
      
      const tokenQuery = this.detectTokenQuery(userMessage);

      if (tokenQuery.isTokenQuery && tokenQuery.tokenMint && !hasStrategyKeywordsForToken) {
        console.log(` Token query detected for: ${tokenQuery.tokenMint}`);

        // Try to get token info using the tool (will return null if disabled)
        const tokenInfo = await this.getTokenInfo(tokenQuery.tokenMint, sessionId);

        // If tool is disabled (returns null), let AI handle with web search
        if (tokenInfo === null) {
          console.log(` Get-token-info tool DISABLED - letting AI use web search`);
          // Fall through to normal AI processing below
        } else {
          console.log(` Using FULL token info formatting (MCP tool enabled)`);

          session.conversationHistory.push({
            role: 'user',
            content: userMessage,
            timestamp: Date.now()
          });

          session.conversationHistory.push({
            role: 'assistant',
            content: tokenInfo,
            timestamp: Date.now()
          });

          await awsLogger.info('Token query processed', {
            metadata: {
              tokenMint: tokenQuery.tokenMint,
              sessionId
            }
          });

          return {
            message: tokenInfo,
            requiresWallet: false,
            requiresConfirmation: false,
            actions: []
          };
        }
      } else if (tokenQuery.isTokenQuery && hasStrategyKeywordsForToken) {
        console.log(` Token detected but message has strategy keywords - proceeding to strategy parsing`);
      }

      // PRIORITY 2: Check for MCP tool requests (buy, sell, balance, portfolio, etc.)
      // Token info queries are handled above for better formatting
      // BUT - skip this if the message contains strategy keywords

      console.log(` Checking for MCP tool requests (buy, sell, balance, portfolio)...`);
      const toolRequest = this.detectToolRequest(userMessage);
      
      // If tool detected but message has strategy keywords, skip tool execution and proceed to strategy parsing
      // EXCEPTION: If it's a SELL request with strategy keywords, it might be a strategy definition, not a direct sell
      const isSellRequestWithStrategy = toolRequest?.tool === 'sell' && hasStrategyKeywordsForToken;
      
      if (toolRequest && hasStrategyKeywordsForToken && isSellRequestWithStrategy) {
        console.log(` Sell request detected with strategy context - treating as strategy definition, not direct execution`);
      } else if (toolRequest && hasStrategyKeywordsForToken) {
        console.log(` MCP tool detected but message has strategy keywords - skipping tool execution`);
      } else if (toolRequest) {
        // Skip getTokenInfo tool as it's handled by detectTokenQuery above
        if (toolRequest.tool === 'getTokenInfo') {
          console.log(`⏭ Skipping MCP getTokenInfo - already handled by detectTokenQuery`);
          // Fall through to normal processing
        } else {
          // Handle confirmation requirements
          if (toolRequest.tool === 'requireConfirmation') {
            console.log(` Confirmation required, storing pending action`);

            session.pendingConfirmation = {
              tool: toolRequest.params.actualTool,
              params: toolRequest.params,
              timestamp: Date.now(),
              message: toolRequest.params.message
            };

            // Add to conversation history
            session.conversationHistory.push({
              role: 'user',
              content: userMessage,
              timestamp: Date.now()
            });

            session.conversationHistory.push({
              role: 'assistant',
              content: toolRequest.params.message,
              timestamp: Date.now()
            });

            return {
              message: toolRequest.params.message,
              requiresWallet: false,
              requiresConfirmation: true,
              actions: ['awaiting_confirmation']
            };
          }

          // Normal tool execution (no confirmation needed)
          console.log(` MCP tool detected, executing...`);

          // Execute the tool and get formatted response
          const toolResponse = await this.executeToolAndFormat(toolRequest, sessionId);

          // Add to conversation history 
          session.conversationHistory.push({
            role: 'user',
            content: userMessage,
            timestamp: Date.now()
          });

          session.conversationHistory.push({
            role: 'assistant',
            content: toolResponse,
            timestamp: Date.now()
          });

          await awsLogger.info('MCP tool executed via agent', {
            metadata: {
              sessionId,
              tool: toolRequest.tool,
              params: toolRequest.params,
              success: !toolResponse.includes('Error')
            }
          });

          // Return formatted response
          return {
            message: toolResponse,
            requiresWallet: false,
            requiresConfirmation: false,
            actions: []
          };
        }
      }
      console.log(` No token query or MCP tool detected, continuing with normal AI processing...`);

      // STEP 2: Check if user is EXPLICITLY asking about SOL price
      const lowerMessage = userMessage.toLowerCase();
      const isPriceQuery = (
        (lowerMessage.includes('what') && lowerMessage.includes('price') && lowerMessage.includes('sol')) ||
        (lowerMessage.includes('current price') && lowerMessage.includes('sol')) ||
        (lowerMessage.includes('sol price')) ||
        (lowerMessage.includes('price of sol')) ||
        (lowerMessage.includes('what is sol'))
      );

      let currentSolPrice: string | null = null;
      if (isPriceQuery) {
        try {
          const price = await this.getSolPrice();
          if (price) {
            currentSolPrice = `$${price.toFixed(2)}`;
            console.log(` Current SOL price: ${currentSolPrice}`);
          }
        } catch (error: any) {
          console.error(' [PRICE] Failed to fetch SOL price:', error.message);
        }
      }

      // Build context-aware system prompt
      const systemPrompt = this.buildSystemPrompt(session, userMessage, currentSolPrice, isPriceQuery);

      if (isPriceQuery) {
        console.log(` Price query detected, adding real-time SOL price to prompt`);
        if (currentSolPrice) {
          console.log(` Using real-time SOL price: ${currentSolPrice}`);
        } else {
          console.log(` Failed to fetch real-time SOL price, AI will use knowledge`);
        }
      }

      // Add user message to conversation history
      session.conversationHistory.push({
        role: 'user',
        content: userMessage,
        timestamp: Date.now()
      });

      // Clear old strategy if user starts a genuinely new conversation or chooses a different strategy type
      const isGreeting = /^(hi|hii|hey|hello|howdy|what's up|whats up|yo|greetings)[\s!.?,]*$/i.test(userMessage.trim());
      const isUnrelatedQuery = !(/strategy|buy|sell|trade|dca|grid|stop|loss|profit|confirm|activate|cancel/i.test(userMessage));
      const isChoosingNewStrategy = /i'll go with|i will go with|let's do|lets do|i want to (create|build|setup|try)|give me|show me.*strategy/i.test(userMessage);

      // Also clear if user is providing NEW strategy parameters (starting fresh DCA/Grid/etc)
      const isProvidingNewStrategyParams = /i want to buy.*for every|buy.*every.*seconds|sell.*every.*minutes|repeat this trade/i.test(userMessage);

      // Detect when user chooses strategy type or provides parameters
      const isChoosingStrategyType_clearing = /i('ll| will) go with|i choose|i pick|let's do|lets do/i.test(userMessage.toLowerCase());
      const isProvidingParameters_clearing = /(\d+\.?\d*)\s*(?:sol|token)|every.*(?:second|minute|hour)|repeat.*times/i.test(userMessage);

      // Check if current strategy is the default custom one
      const hasDefaultCustomStrategy = session.currentStrategy?.template === 'custom' &&
                                       session.currentStrategy?.confidence === 0.8 &&
                                       session.currentStrategy?.config?.description?.includes('Advanced custom');

      if (isGreeting ||
        (isUnrelatedQuery && session.currentStrategy) ||
        isChoosingNewStrategy ||
        isProvidingNewStrategyParams ||
        (isChoosingStrategyType_clearing && hasDefaultCustomStrategy) ||  
        (isProvidingParameters_clearing && hasDefaultCustomStrategy)) {  
          console.log(` [CLEAR] Clearing old strategy`);
          session.currentStrategy = undefined;

        }
      // Mark session as no longer fresh after first interaction
      if (session.isFreshSession) {
        session.isFreshSession = false;
      }

      // Get AI response
      const aiResponse = await geminiClient.chat(userMessage, systemPrompt);

      // Post-process response to fix any cached price issues
      const processedResponse = this.postProcessResponse(aiResponse.text, currentSolPrice);

      // Add PROCESSED response to conversation history
      session.conversationHistory.push({
        role: 'assistant',
        content: processedResponse,
        timestamp: Date.now()
      });

      // Parse for strategy configuration
      const strategyKeywords = ['strategy', 'dca', 'grid', 'buy', 'sell', 'trade', 'invest', 'profit', 'loss', 'stop'];
      const hasStrategyKeywords = strategyKeywords.some(keyword =>
        userMessage.toLowerCase().includes(keyword) || aiResponse.text.toLowerCase().includes(keyword)
      );

      // Detect activation phrases to prevent overwriting existing strategy
      const isActivationPhrase = /^(activate|simulate|run|execute|start|deploy|launch)(\s+the|\s+this|\s+my)?(\s+strategy)?/i.test(userMessage.trim());

      if (isActivationPhrase && session.currentStrategy) {
        console.log(' [PROTECT] Activation phrase detected - preserving existing strategy:', {
          userMessage,
          existingStrategy: session.currentStrategy.template,
          action: 'DO NOT PARSE'
        });
      }

      let parsedStrategy = null;
      // Only parse if strategy keywords present AND it's NOT an activation phrase
      if (hasStrategyKeywords && !isActivationPhrase) {
        
        // AI-FIRST APPROACH: Try to extract strategy from AI's JSON response first
        console.log(' [AI-FIRST] Attempting to extract strategy from AI response...');
        let strategyConfig = strategyValidator.extractStrategyFromResponse(aiResponse.text);
        
        if (strategyConfig) {
          // AI generated a strategy config - validate it
          const validation = strategyValidator.validateStrategy(strategyConfig);
          
          console.log(' [AI-FIRST] Strategy extracted from AI:', {
            strategyType: strategyConfig.strategyType,
            isValid: validation.isValid,
            isComplete: validation.isComplete,
            confidence: validation.confidence,
            missingFields: validation.missingFields,
            errors: validation.errors,
            warnings: validation.warnings
          });

          if (validation.isValid) {
            // Convert AI config to ParsedStrategy format
            parsedStrategy = {
              template: 'custom' as const,
              config: strategyConfig,
              confidence: validation.confidence,
              requiresConfirmation: !validation.isComplete
            };

            console.log(` [AI-FIRST] Successfully extracted strategy from AI (confidence: ${(validation.confidence * 100).toFixed(1)}%)`);
            
            // If incomplete, AI should have already asked for missing params
            if (!validation.isComplete) {
              console.log(' [AI-FIRST] Strategy incomplete, AI should ask for:', validation.missingFields);
            }
          } else {
            console.error(' [AI-FIRST] Strategy validation failed:', validation.errors);
            parsedStrategy = null; // Will fall back to parser
          }
        } else {
          console.log(' [AI-FIRST] No JSON found in AI response, will try parser fallback');
        }

        // If AI-first didn't work, use parser as backup
        if (!parsedStrategy) {
          console.log(' [FALLBACK] AI-first failed, trying parser...');
          
          const hasStrategyParameters = /(\d+\.?\d*)\s*(?:sol|token)|every.*(?:second|minute|hour)|repeat.*times/i.test(userMessage);
          
          parsedStrategy = strategyParser.parseStrategy(userMessage);

          if (!parsedStrategy && hasStrategyParameters) {
            // Try harder when parameters detected
            console.log(' [FALLBACK] User provided parameters but no strategy parsed. Trying AI response with parser...');
            parsedStrategy = strategyParser.parseStrategy(aiResponse.text);
          } else if (!parsedStrategy) {
            parsedStrategy = strategyParser.parseStrategy(aiResponse.text);
          }

          if (parsedStrategy) {
            console.log(` [FALLBACK] Parser successfully extracted strategy (confidence: ${(parsedStrategy.confidence * 100).toFixed(1)}%)`);
          } else {
            console.log(' [FALLBACK] Parser also failed to extract strategy');
          }
        }

        // Log what was parsed (regardless of method)
        if (parsedStrategy) {
          console.log(` [FINAL] Strategy available:`, {
            method: strategyConfig ? 'AI-FIRST' : 'PARSER-FALLBACK',
            template: parsedStrategy.template,
            strategyType: parsedStrategy.config.strategyType,
            confidence: parsedStrategy.confidence,
            isComplete: parsedStrategy.config.isComplete,
            currentStrategy: session.currentStrategy?.template
          });
        } else {
          console.log(' [FINAL] No strategy could be extracted from user input or AI response');
        }
      }

      // Check if user is explicitly switching strategies
      const isStrategySwitch = this.detectStrategySwitch(userMessage);

      // Update session if strategy found OR if user explicitly wants to switch
      if (parsedStrategy || isStrategySwitch) {
        if (parsedStrategy) {
          const isDifferentStrategy = !session.currentStrategy || 
                                      parsedStrategy.template !== session.currentStrategy.template || 
                                      parsedStrategy.config.id !== session.currentStrategy.config?.id || 
                                      parsedStrategy.config.side !== session.currentStrategy.config?.side;

          // Check if this is the SAME strategy but NOW complete (user provided missing params)
          const isSameStrategyNowComplete = session.currentStrategy &&
                                            parsedStrategy.config.id === session.currentStrategy.config?.id &&
                                            session.currentStrategy.config?.isComplete === false &&
                                            parsedStrategy.config.isComplete === true;

          // Check if replacing default custom strategy
          const isHigherConfidence = parsedStrategy.confidence > (session.currentStrategy?.confidence || 0);
          const isReplacingDefault = session.currentStrategy?.template === 'custom' && 
                                     session.currentStrategy?.confidence === 0.8 &&
                                     session.currentStrategy?.config?.description?.includes('Advanced custom');
          
          // NEVER update strategy on activation phrases
          const shouldUpdate = !isActivationPhrase && 
                              (isDifferentStrategy || 
                               isSameStrategyNowComplete || // Allow update if strategy became complete
                               (isHigherConfidence && !isDifferentStrategy) || 
                               isStrategySwitch || 
                               isReplacingDefault);

          console.log(` [UPDATE CHECK]:`, {
            isDifferentStrategy,
            isSameStrategyNowComplete,
            newTemplate: parsedStrategy.template,
            oldTemplate: session.currentStrategy?.template,
            newConfidence: parsedStrategy.confidence,
            oldConfidence: session.currentStrategy?.confidence || 0,
            newIsComplete: parsedStrategy.config.isComplete,
            oldIsComplete: session.currentStrategy?.config?.isComplete,
            isHigherConfidence,
            isReplacingDefault,
            isStrategySwitch,
            isActivationPhrase,
            shouldUpdate
          });

          if (shouldUpdate) {
            session.currentStrategy = parsedStrategy;
            console.log(` [UPDATE] Updated current strategy: ${parsedStrategy.template}`);
            
            // Check if strategy is COMPLETE
            const isComplete = this.isStrategyConfigComplete(parsedStrategy);
            console.log(` [COMPLETENESS] Strategy complete: ${isComplete}`, {
              template: parsedStrategy.template,
              hasTokenAddress: !!parsedStrategy.config.tokenAddress,
              hasTrigger: !!parsedStrategy.config.trigger,
              hasSide: !!parsedStrategy.config.side,
              isMarkedComplete: parsedStrategy.config.isComplete
            });
            
            // If complete, AUTO-START simulation
            if (isComplete) {
              console.log(` [AUTO-SIM] Starting automatic paper trading simulation...`);
              console.log(` [AUTO-SIM] Strategy config:`, JSON.stringify(parsedStrategy, null, 2));
              
              try {
                // Start paper trading in background and AWAIT it
                console.log(` [AUTO-SIM] Calling startPaperTradingSimulationAsync...`);
                const simulationResult = await this.startPaperTradingSimulationAsync(sessionId, parsedStrategy, walletAddress);
                
                console.log(` [AUTO-SIM] Simulation result:`, simulationResult);
                
                if (simulationResult && simulationResult.success) {
                  console.log(` [AUTO-SIM] Simulation started successfully:`, {
                    strategyId: simulationResult.strategyId,
                    paperSessionId: simulationResult.sessionId
                  });
                  
                  // Return with simulation started status
                  // AI already included JSON in response, don't duplicate it
                  return {
                    message: processedResponse + '\n\n **Simulation is now running!** Check the Strategy Execution panel on the right for live updates.',
                    suggestedStrategy: parsedStrategy,
                    requiresWallet: false,
                    requiresConfirmation: false,
                    actions: ['simulation_running'],
                    strategyId: simulationResult.strategyId
                  };
                } else {
                  console.error(` [AUTO-SIM] Simulation failed:`, simulationResult?.error || 'Unknown error');
                  // Fall through to normal response with activate button
                }
              } catch (error) {
                console.error(' [AUTO-SIM] Exception during simulation:',error);
                // Fall through to normal response
              }
            }
          } else {
            console.log(` Keeping existing strategy (higher confidence or same config)`);
          }
        } else if (isStrategySwitch) {
          console.log(` User wants to switch strategies, clearing current`);
          session.currentStrategy = undefined;
        }
      }

      // Determine required actions
      const actions = this.determineActions(session, userMessage, aiResponse.text);

      // Check if strategy is complete and requires confirmation
      const strategyRequiresConfirmation = session.currentStrategy?.requiresConfirmation === true;

      const lowerUserMessage = userMessage.toLowerCase();

      // Check if user is ASKING FOR parameters (not ready yet) vs PROVIDING final parameters (ready)
      const isAskingForParameters = lowerUserMessage.includes('what') ||
        lowerUserMessage.includes('how') ||
        lowerUserMessage.includes('tell me') ||
        lowerUserMessage.includes('which') ||
        lowerUserMessage.includes('should i');

      const isProvidingFinalParameters = /would be|will be|want.*to be|should be/i.test(userMessage);

      //  Check if user is just choosing a strategy type (not providing parameters yet)
      const isChoosingStrategyType = /i'll go with|i will go with|let's do|lets do|i choose|i pick|give me.*dca|give me.*grid|show me/i.test(userMessage);

      // Check if this message is strategy-related (not a greeting or unrelated query)
      const isGreetingOnly = /^(hi|hii|hey|hello|howdy|what's up|whats up|yo|greetings)[\s!.?,]*$/i.test(userMessage.trim());
      const isStrategyRelated = /strategy|buy|sell|trade|dca|grid|stop|loss|profit|confirm|activate|token|sol|invest|price|market/i.test(userMessage);

      // Check if the strategy has complete configuration
      const hasCompleteStrategyConfig = session.currentStrategy &&
        session.currentStrategy.config &&
        this.isStrategyConfigComplete(session.currentStrategy);

      const isInitialStrategyRequest = /i want (to )?(build|create|make|setup).*strategy/i.test(userMessage) &&
        !hasCompleteStrategyConfig;

      // Check if user is providing complete parameters with numbers
      const hasNumbersInMessage = /\d+\.?\d*/.test(userMessage);
      const hasTimeInterval = /second|minute|hour|day/i.test(userMessage);
      const isProvidingCompleteParameters = hasNumbersInMessage && (hasTimeInterval || /times?|repeat|count/i.test(userMessage));

      // strategy exists, requires confirmation, user PROVIDED final values, AND conversation is strategy-related
      const shouldShowActivateButton = strategyRequiresConfirmation &&
        session.currentStrategy &&
        hasCompleteStrategyConfig &&
        !isAskingForParameters &&
        !isGreetingOnly &&
        !isChoosingStrategyType &&
        !isInitialStrategyRequest &&
        isStrategyRelated &&
        (isProvidingFinalParameters ||
          isProvidingCompleteParameters ||  // Show if complete params provided
          !(lowerUserMessage.includes('i want to') ||
            lowerUserMessage.includes('let\'s') ||
            lowerUserMessage.includes('how do')));

      console.log(' Confirmation check:', {
        strategyRequiresConfirmation,
        isAskingForParameters,
        isProvidingFinalParameters,
        isProvidingCompleteParameters,  
        hasCompleteStrategyConfig,      
        isChoosingStrategyType,
        isGreetingOnly,
        isStrategyRelated,
        shouldShowActivateButton,
        currentStrategy: session.currentStrategy?.template
      });

      // Log interaction
      await awsLogger.info('Agent interaction', {
        metadata: {
          sessionId,
          userMessage: userMessage.substring(0, 100),
          hasStrategy: !!parsedStrategy,
          requiresConfirmation: shouldShowActivateButton,
          actions
        }
      });

      return {
        message: processedResponse,
        suggestedStrategy: session.currentStrategy,
        requiresWallet: actions.includes('connect_wallet'),
        requiresConfirmation: shouldShowActivateButton, // Use calculated value
        actions
      };
    } catch (error: any) {
      await awsLogger.error('Agent message processing failed', {
        metadata: { error: error.message, sessionId }
      });

      return {
        message: `I encountered an error: ${error.message}. Please try again or rephrase your question.`,
        actions: ['error']
      };
    }
  }

  /**
   *  Check if strategy has all required configuration
   *  UNIVERSAL: Works with ALL strategy types by trusting AI's isComplete flag
   *  and doing smart validation based on what fields are present
   *  FIX #1: Enhanced validation for DCA sell, reactive, and contrarian strategies
   */
  private isStrategyConfigComplete(strategy: ParsedStrategy): boolean {
    if (!strategy || !strategy.config) {
      console.log(' [isStrategyConfigComplete] No strategy or config');
      return false;
    }
    
    const config = strategy.config;
    
    console.log(' [isStrategyConfigComplete] Checking:', {
      template: strategy.template,
      strategyType: config.strategyType,
      isComplete: config.isComplete,
      hasTokenAddress: !!config.tokenAddress,
      hasTrigger: !!config.trigger,
      hasSide: !!config.side,
      configKeys: Object.keys(config)
    });
    
    // PRIORITY 1: Trust AI's explicit isComplete flag (for all custom strategies)
    if (config.isComplete === true) {
      console.log(' [isStrategyConfigComplete] AI marked as complete - trusting AI judgment');
      return true;
    }
    
    if (config.isComplete === false) {
      console.log(' [isStrategyConfigComplete] AI marked as INCOMPLETE - needs more info');
      return false;
    }
    
    // PRIORITY 2: If no explicit flag, do smart validation based on what we have
    console.log(' [isStrategyConfigComplete] No explicit isComplete flag, checking fields...');
    
    switch (strategy.template) {
      case 'custom':
        // For custom strategies, check based on strategyType if available
        if (config.strategyType) {
          console.log(` [isStrategyConfigComplete] Custom strategy type: ${config.strategyType}`);
          
          // FIX #1: Enhanced validation for reactive strategies
          if (config.strategyType === 'reactive') {
            const hasReactiveFields = !!(
              config.id &&
              config.tokenAddress &&
              config.trigger &&
              config.side
            );
            console.log(` [isStrategyConfigComplete] Reactive validation: ${hasReactiveFields}`);
            return hasReactiveFields;
          }
          
          // FIX #1: Enhanced validation for contrarian_volatility strategies
          if (config.strategyType === 'contrarian_volatility') {
            const hasContrarianFields = !!(
              config.tokenAddress &&
              config.sellTriggerPercentage !== undefined &&
              config.buyTriggerPercentage !== undefined &&
              config.sellAmountTokens !== undefined &&
              config.buyAmountSOL !== undefined
            );
            console.log(` [isStrategyConfigComplete] Contrarian validation: ${hasContrarianFields}`);
            return hasContrarianFields;
          }
          
          // Universal validation: Does it have the basic fields needed for ANY strategy?
          const hasBasicFields = !!(
            config.id &&
            config.strategyType &&
            config.tokenAddress
          );
          
          // Check if it has at least one action field (buy/sell/amount/trigger/etc)
          const hasActionFields = !!(
            config.amountPerTrade ||
            config.buyAmountSOL ||
            config.sellAmountSOL ||
            config.buyAmountTokens ||
            config.sellAmountTokens ||
            config.amount ||
            config.trigger ||
            config.sellTriggerPercentage ||
            config.buyTriggerPercentage ||
            config.gridLevels ||
            config.levels
          );
          
          // Check if it has timing/trigger fields
          const hasTimingFields = !!(
            config.interval ||
            config.intervalMinutes ||
            config.trigger ||
            config.sellTriggerPercentage ||
            config.buyTriggerPercentage ||
            config.priceRangeLow ||
            config.priceRangeHigh
          );
          
          const isComplete = hasBasicFields && hasActionFields && hasTimingFields;
          
          console.log(` [isStrategyConfigComplete] Universal validation:`, {
            hasBasicFields,
            hasActionFields,
            hasTimingFields,
            isComplete,
            strategyType: config.strategyType
          });
          
          return isComplete;
        }
        
        // Fallback for truly custom strategies without strategyType
        const hasDescription = !!config.description;
        const hasComponents = config.components?.length > 0;
        console.log(` [isStrategyConfigComplete] Generic custom: desc=${hasDescription}, components=${hasComponents}`);
        return hasDescription && hasComponents;
        
      case 'dca':
        // FIX #1: Enhanced DCA validation for both BUY and SELL sides
        const hasDCAAmount = (config.buyAmountSOL && config.buyAmountSOL > 0) ||
          (config.sellAmountSOL && config.sellAmountSOL > 0);
        const hasDCAInterval = config.intervalMinutes && config.intervalMinutes > 0;
        const hasDCASide = config.side === 'buy' || config.side === 'sell';
        const hasDCAToken = !!config.tokenAddress;
        
        const isDCAComplete = hasDCAAmount && hasDCAInterval && hasDCASide && hasDCAToken;

        console.log(' DCA completeness check:', {
          hasDCAAmount,
          hasDCAInterval,
          hasDCASide,
          hasDCAToken,
          isDCAComplete,
          buyAmount: config.buyAmountSOL,
          sellAmount: config.sellAmountSOL,
          interval: config.intervalMinutes,
          side: config.side,
          tokenAddress: config.tokenAddress
        });
        
        return isDCAComplete;

      case 'grid':
        // Grid requires: minPrice, maxPrice, levels, and amountPerLevel
        const hasGridParams = config.minPrice > 0 &&
          config.maxPrice > 0 &&
          config.levels > 0 &&
          config.amountPerLevel > 0 &&
          config.maxPrice > config.minPrice;

        console.log(' Grid completeness check:', {
          hasGridParams,
          config
        });
        return hasGridParams;

      case 'stop_loss':
        // stop loss requires: entryPrice and stopLossPrice and amount
        const hasStopLossParams = config.entryPrice > 0 &&
          config.stopLossPrice > 0 &&
          config.amountInSol > 0;

        console.log(' Stop-Loss completeness check:', {
          hasStopLossParams,
          config
        });
        return hasStopLossParams;

      case 'momentum':
        // momentum requires: triggerPrice, amount, and direction
        const hasMomentumParams = config.triggerPrice > 0 &&
          config.amountInSol > 0 &&
          (config.direction === 'above' || config.direction === 'below');

        console.log(' Momentum completeness check:', {
          hasMomentumParams,
          config
        });
        return hasMomentumParams;

      case 'reactive_mirror':
        // reactive_mirror requires: tokenAddress, trigger, side, and sizingRule
        const hasReactiveParams = !!(
          config.tokenAddress &&
          config.trigger &&
          config.side &&
          (config.side === 'buy' || config.side === 'sell')
        );

        console.log(' Reactive Mirror completeness check:', {
          hasReactiveParams,
          hasTokenAddress: !!config.tokenAddress,
          hasTrigger: !!config.trigger,
          hasSide: !!config.side,
          side: config.side,
          config
        });
        return hasReactiveParams;

      default:
        console.log(' Unknown Strategy template:', strategy.template);
        // Even for unknown templates, check if AI marked it complete
        return config.isComplete === true;
    }
  }

  /**
   * Detect confirmation or cancellation responses
   */
  private detectConfirmation(message: string): 'confirm' | 'cancel' | null {
    const lower = message.toLowerCase().trim();

    // STRICT confirmation - only accept explicit confirmation phrases
    const explicitConfirmations = [
      'confirm', 'i confirm', 'yes confirm', 'confirm it',
      'confirm dca', 'confirm strategy', 'yes, confirm'
    ];

    // NOT confirmation - user is still building/configuring strategy
    const stillConfiguringPhrases = [
      'create the strategy', 'now create', 'build the strategy', 'make the strategy',
      'setup the strategy', 'activate the strategy', 'start the strategy'
    ];

    // Check if user is still configuring (NOT ready to confirm yet)
    if (stillConfiguringPhrases.some(phrase => lower.includes(phrase))) {
      return null; // Not a confirmation, user is still setting up
    }

    // cancellation keywords
    const cancellationKeywords = [
      'no', 'nope', 'cancel', 'stop', 'abort', 'cancelled', 'never mind', 'nevermind',
      'don\'t', 'dont', 'wait'
    ];

    // Check for exact confirmation phrases
    if (explicitConfirmations.some(phrase => lower === phrase || lower.includes(phrase))) {
      return 'confirm';
    }

    if (cancellationKeywords.some(keyword => lower === keyword || lower.includes(keyword))) {
      return 'cancel';
    }

    return null;
  }

  /**
   * Detect if user is asking about a specific token
   * ENHANCED: Now catches "what is this: [address]" queries
   * FIXED: Ignores when user is providing parameters (not asking for info)
   */
  private detectTokenQuery(message: string): { isTokenQuery: boolean; tokenMint?: string } {
    const lowerMessage = message.toLowerCase();

    // Enhanced: Check for token address pattern (Solana addresses are base58, 32-44 characters)
    const tokenAddressRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
    const matches = message.match(tokenAddressRegex);

    // CRITICAL: Check if user is PROVIDING parameters (not asking for info)
    const isProvidingParameters = 
      /^\d+\./.test(message.trim()) || // Starts with "1.", "2.", "3." (numbered list)
      lowerMessage.includes('token address:') || // "Token Address: xxx"
      lowerMessage.includes('amount:') ||
      lowerMessage.includes('interval:') ||
      lowerMessage.includes('total trades:') ||
      lowerMessage.includes('amountpertrade:') ||
      /^(1|2|3|4|5|6|7|8|9)\.\s/i.test(message); // Numbered list format

    // If user is providing parameters, don't treat as token query
    if (isProvidingParameters) {
      console.log(' [detectTokenQuery] User is providing parameters, NOT querying token info');
      return { isTokenQuery: false };
    }

    //  EXPANDED: Comprehensive token query keywords with natural language patterns
    const tokenQueryKeywords = [
      // Direct queries
      'tell me about',
      'what is this',
      'what is',
      'info about',
      'information about',
      'details about',
      'details on',
      'explain',
      'explain this',

      // Question patterns
      'can you tell',
      'can you show',
      'could you tell',
      'what\'s this',
      'whats this',
      'what about',
      'how about',
      'what\'s up with',
      'whats up with',

      // Help patterns
      'help me with',
      'help with',
      'show me',
      'tell me',
      'give me info',
      'get info',

      // Analysis patterns
      'analyze',
      'analyze this',
      'check out',
      'review',
      'review this',
      'investigate',
      'research',

      // Status queries
      'is this good',
      'is this safe',
      'should i buy',
      'worth buying',
      'worth it',
      'any good',
      'legit'
    ];

    // Check if message contains any token query pattern
    const isTokenQuery = tokenQueryKeywords.some(keyword => lowerMessage.includes(keyword));

    // Enhanced: Also detect if message is just a token address (common pattern)
    const isJustTokenAddress = matches && matches.length === 1 && message.trim().length <= 50;

    if ((isTokenQuery || isJustTokenAddress) && matches && matches.length > 0) {
      return {
        isTokenQuery: true,
        tokenMint: matches[0]
      };
    }

    return { isTokenQuery: false };
  }

  /**
   * Execute a detected tool and format response for the user
   */
  private async executeToolAndFormat(
    toolRequest: ToolRequest,
    sessionId: string
  ): Promise<string> {
    try {
      console.log(` Executing tool: ${toolRequest.tool}`);

      // Get session to access wallet address
      const session = this.getSession(sessionId);
      const walletAddress = session.walletAddress;

      // Execute the tool with wallet context
      const result = await this.mcpToolExecutor.executeTool(
        toolRequest.tool,
        toolRequest.params,
        sessionId,
        walletAddress
      );

      // Format the response based on the tool
      if (!result.success) {
        // Enhanced error formatting with codes and suggestions
        let errorResponse = `${result.error || '❌ **Error occurred**'}`;

        if (result.data) {
          if (result.data.code) {
            errorResponse += `\n\n**Error Code**: \`${result.data.code}\``;
          }
          if (result.data.suggestion) {
            errorResponse += `\n\n💡 **Suggestion**: ${result.data.suggestion}`;
          }
          if (result.data.details) {
            errorResponse += `\n\n📝 **Details**: ${result.data.details}`;
          }
          // Show funding address if insufficient balance
          if (result.data.fundingAddress) {
            errorResponse += `\n\n💸 **Fund your wallet**:\n\`${result.data.fundingAddress}\``;
          }
          // Show links if available
          if (result.data.links) {
            errorResponse += `\n\n🔗 **Links**:`;
            if (result.data.links.solscan) errorResponse += `\n• [Solscan](${result.data.links.solscan})`;
            if (result.data.links.dexscreener) errorResponse += `\n• [DexScreener](${result.data.links.dexscreener})`;
            if (result.data.links.birdeye) errorResponse += `\n• [Birdeye](${result.data.links.birdeye})`;
          }
        }

        return errorResponse;
      }

      // Format response based on tool type
      switch (toolRequest.tool) {
        case 'getTokenInfo':
          return this.formatTokenInfoResponse(result.data);

        case 'buyToken':
          return this.formatBuyResponse(result.data);

        case 'sellToken':
          return this.formatSellResponse(result.data);

        case 'getAccountBalance':
          return this.formatBalanceResponse(result.data);

        case 'listAccounts':
          return this.formatAccountsResponse(result.data);

        case 'createAccount':
          return this.formatCreateAccountResponse(result.data);

        case 'importAccount':
          return this.formatImportAccountResponse(result.data);

        case 'getTransactionHistory':
          return this.formatTransactionHistoryResponse(result.data);

        case 'getPortfolioSummary':
          return this.formatPortfolioSummaryResponse(result.data);

        default:
          return `**Success**: ${JSON.stringify(result.data, null, 2)}`;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return ` **Execution Failed**: ${errorMessage}`;
    }
  }

  /**
   * Format token info response with rich details
   */
  private formatTokenInfoResponse(data: any): string {
    // Extract values with proper validation
    const priceUSD = (data.priceUSD && !isNaN(data.priceUSD) && data.priceUSD > 0)
      ? data.priceUSD
      : null;
    const priceSOL = (data.price && !isNaN(data.price) && data.price > 0)
      ? data.price
      : null;

    const marketCap = (data.marketCap && !isNaN(data.marketCap) && data.marketCap > 0)
      ? data.marketCap
      : (data.marketCapUSD && !isNaN(data.marketCapUSD) && data.marketCapUSD > 0)
        ? data.marketCapUSD
        : null;

    const volume24h = (data.volume24h && !isNaN(data.volume24h) && data.volume24h > 0)
      ? data.volume24h
      : null;

    const trades24h = (data.trades24h && !isNaN(data.trades24h) && data.trades24h > 0)
      ? data.trades24h
      : null;

    const priceChange24h = (data.priceChange24h && !isNaN(data.priceChange24h))
      ? data.priceChange24h
      : null;

    // Bonding curve data
    const realSolReserves = (data.bondingCurve?.realSolReserves !== undefined && !isNaN(data.bondingCurve.realSolReserves))
      ? data.bondingCurve.realSolReserves
      : null;

    const tokenSupply = (data.bondingCurve?.totalSupply !== undefined && !isNaN(data.bondingCurve.totalSupply))
      ? data.bondingCurve.totalSupply
      : (data.bondingCurve?.tokenTotalSupply !== undefined && !isNaN(data.bondingCurve.tokenTotalSupply))
        ? data.bondingCurve.tokenTotalSupply
        : null;

    const bondingProgress = (data.bondingCurve?.bondingProgress !== undefined && !isNaN(data.bondingCurve.bondingProgress))
      ? data.bondingCurve.bondingProgress
      : null;

    const isGraduated = data.isGraduated || data.bondingCurve?.complete || false;
    const isActive = data.isActive !== undefined ? data.isActive : !isGraduated;

    // Build response
    let response = `� **Token Information**\n\n`;

    response += `**Address**: \`${data.mint}\`\n`;
    response += `**Type**: 🚀 Pump.fun Token\n\n`;

    // Token Details
    if (data.name || data.symbol) {
      response += `🏆 **Pump.fun Details:**\n`;
      if (data.name && data.name !== 'Unknown') response += `• Name: ${data.name}\n`;
      if (data.symbol && data.symbol !== 'Unknown' && data.symbol !== 'UNKNOWN') response += `• Symbol: ${data.symbol}\n`;
      if (data.description && data.description !== 'No description' && data.description.length > 0) {
        const desc = data.description.substring(0, 150);
        response += `• Description: ${desc}${data.description.length > 150 ? '...' : ''}\n`;
      } else {
        response += `• Data Source: On-chain bonding curve\n`;
      }
      response += `\n`;
    }

    // Price Information
    response += `💰 **Price**\n`;
    if (priceUSD !== null) {
      response += `• Current Price: $${priceUSD.toFixed(8)} USD\n`;
    }
    if (priceSOL !== null) {
      response += `• Price in SOL: ${priceSOL.toFixed(9)} SOL\n`;
    }
    if (priceChange24h !== null) {
      const changeEmoji = priceChange24h >= 0 ? '📈' : '📉';
      const changeColor = priceChange24h >= 0 ? '+' : '';
      response += `• 24h Change: ${changeEmoji} ${changeColor}${priceChange24h.toFixed(2)}%\n`;
    }
    if (priceUSD === null && priceSOL === null) {
      response += `• Price data fetching...\n`;
    }
    response += `\n`;

    // Market Data
    response += `� **Market Data**\n`;
    if (marketCap !== null) {
      if (marketCap >= 1000000) {
        response += `• Market Cap: $${(marketCap / 1000000).toFixed(2)}M\n`;
      } else if (marketCap >= 1000) {
        response += `• Market Cap: $${(marketCap / 1000).toFixed(2)}K\n`;
      } else {
        response += `• Market Cap: $${marketCap.toFixed(2)}\n`;
      }
    }
    if (volume24h !== null) {
      if (volume24h >= 1000000) {
        response += `• 24h Volume: $${(volume24h / 1000000).toFixed(2)}M\n`;
      } else if (volume24h >= 1000) {
        response += `• 24h Volume: $${(volume24h / 1000).toFixed(2)}K\n`;
      } else {
        response += `• 24h Volume: $${volume24h.toFixed(2)}\n`;
      }
    }
    if (trades24h !== null) {
      response += `• 24h Trades: ${trades24h.toLocaleString()}\n`;
    }
    if (marketCap === null && volume24h === null && trades24h === null) {
      response += `• Market data unavailable\n`;
    }
    response += `\n`;

    // Bonding Curve
    response += `🔥 **Bonding Curve**\n`;
    if (realSolReserves !== null) {
      response += `• SOL Reserves: ${realSolReserves.toFixed(2)} SOL\n`;
      if (realSolReserves === 0) {
        response += `  ⚠️ Warning: Zero reserves detected\n`;
      }
    }
    if (tokenSupply !== null) {
      const supplyFormatted = tokenSupply >= 1000000
        ? `${(tokenSupply / 1000000).toFixed(2)}M`
        : tokenSupply >= 1000
          ? `${(tokenSupply / 1000).toFixed(2)}K`
          : tokenSupply.toFixed(2);
      response += `• Token Supply: ${supplyFormatted}\n`;
    }
    if (bondingProgress !== null) {
      response += `• Bonding Progress: ${bondingProgress.toFixed(1)}%\n`;
    }
    response += `• Status: ${isActive ? '🟢 Active' : isGraduated ? '✅ Graduated' : '⚪ Unknown'}\n`;
    response += `\n`;

    // Links
    response += `� **View on:**\n`;
    response += `• [Pump.fun](https://pump.fun/${data.mint})\n`;
    response += `• [DexScreener](https://dexscreener.com/solana/${data.mint})\n`;
    response += `• [Birdeye](https://birdeye.so/token/${data.mint}?chain=solana)\n`;

    if (data.website || data.twitter || data.telegram) {
      response += `\n🌐 **Social Links**\n`;
      if (data.website) response += `• [Website](${data.website})\n`;
      if (data.twitter) response += `• [Twitter](${data.twitter})\n`;
      if (data.telegram) response += `• [Telegram](${data.telegram})\n`;
    }

    response += `\n✅ **Status**: ${isActive ? 'Active pump.fun token' : isGraduated ? 'Graduated to Raydium' : 'Token status unknown'}\n`;

    response += `\n💡 **How to Trade:**\n`;
    response += `You can trade this token directly! Just say:\n`;
    response += `• "Buy 0.1 SOL of this token"\n`;
    response += `• "Create a DCA strategy for ${data.mint.substring(0, 8)}..."\n`;

    response += `\n⚠️ **Risk Warning**: Pump.fun tokens are speculative and high-risk. Only invest what you can afford to lose. Always DYOR (Do Your Own Research)!\n`;

    return response.trim();
  }

  /**
   * Format buy response with transaction details
   */
  private formatBuyResponse(data: any): string {
    return `
**Purchase Successful!**

🎯 **Trade Details**
• Token: ${data.tokenName} (${data.tokenSymbol})
• Amount Spent: ${data.solSpent} SOL
• Tokens Received: ${data.tokensMinted.toLocaleString()}
• Price per Token: ${data.pricePerToken.toFixed(8)} SOL

⚙️ **Settings**
• Slippage: ${data.slippage}%
• Priority Fee: ${data.priorityFee} SOL
• Account: ${data.account}

🔍 **Transaction**
[View on Solscan](${data.explorer})

Transaction ID: \`${data.transaction}\`
  `.trim();
  }

  /**
   * Format sell response with transaction details
   */
  private formatSellResponse(data: any): string {
    return `
✅ **Sale Successful!**

💰 **Trade Details**
• Tokens Sold: ${data.tokensSold.toLocaleString()}
• SOL Received: ${data.solReceived.toFixed(4)} SOL
• Percentage Sold: ${data.percentage}%

⚙️ **Settings**
• Slippage: ${data.slippage}%
• Priority Fee: ${data.priorityFee} SOL
• Account: ${data.account}

🔍 **Transaction**
[View on Solscan](${data.explorer})

Transaction ID: \`${data.transaction}\`
  `.trim();
  }

  /**
   * Format balance response
   * ENHANCED: Shows status indicators and warnings
   */
  private formatBalanceResponse(data: any): string {
    if (data.currency === 'SOL') {
      let response = `💰 **Wallet Balance**\n\n`;
      response += `• Account: **${data.account}**\n`;
      response += `• Balance: **${data.formatted?.balance || `${data.balance.toFixed(4)} SOL`}**\n`;

      if (data.formatted?.fiat) {
        response += `• Estimated: ${data.formatted.fiat}\n`;
      }

      if (data.status) {
        const statusEmoji = data.status === 'healthy' ? '💚' : data.status === 'low' ? '⚠️' : '⚪';
        response += `• Status: ${statusEmoji} **${data.status}**\n`;
      }

      if (data.warning) {
        response += `\n${data.warning}\n`;
      }

      if (data.fundingInstructions) {
        response += `\n💸 **Fund your wallet**: \`${data.publicKey}\`\n`;
      }

      response += `\n• Public Key: \`${data.publicKey}\``;

      return response.trim();
    } else {
      const tokenName = data.tokenInfo?.name || 'Unknown';
      const tokenSymbol = data.tokenInfo?.symbol || 'N/A';

      let response = `💰 **Token Balance**\n\n`;
      response += `• Account: **${data.account}**\n`;
      response += `• Token: ${tokenName} (${tokenSymbol})\n`;
      response += `• Balance: **${data.balance.toLocaleString()}**\n`;

      if (data.formatted) {
        if (data.formatted.valueInSOL) response += `• Value: ${data.formatted.valueInSOL}\n`;
        if (data.formatted.valueInUSD) response += `• USD Value: ${data.formatted.valueInUSD}\n`;
      }

      response += `• Public Key: \`${data.publicKey}\`\n`;
      response += `• Token Mint: \`${data.mint}\``;

      return response.trim();
    }
  }

  /**
   * Format accounts list response
   * Shows status indicators and summary
   */
  private formatAccountsResponse(data: any): string {
    if (data.accounts.length === 0) {
      return `📭 **${data.message || 'No Accounts Found'}**\n\n${data.suggestion || 'Create a new account with: "create account named myaccount"'}`;
    }

    let response = `👛 **Your Accounts**\n\n`;

    if (data.summary) {
      response += `**Summary**: ${data.summary.formattedTotal}\n`;
      response += `**Status**: ${data.summary.healthy} healthy, ${data.summary.lowBalance} low balance, ${data.summary.empty} empty\n\n`;
    }

    const accountsList = data.accounts
      .map((acc: any, i: number) => {
        const statusEmoji = acc.status === 'healthy' ? '💚' : acc.status === 'low' ? '⚠️' : acc.status === 'empty' ? '⚪' : '❌';
        const defaultBadge = acc.isDefault ? ' **(default)**' : '';
        return `${i + 1}. ${statusEmoji} **${acc.name}**${defaultBadge}\n   • Balance: ${acc.formatted?.balance || `${acc.balance.toFixed(4)} SOL`}${acc.formatted?.approximate ? ` (${acc.formatted.approximate})` : ''}\n   • Address: \`${acc.publicKey}\``;
      })
      .join('\n\n');

    return `📋 **Your Accounts** (${data.count} total)\n\n${accountsList}`;
  }

  /**
   * Format create account response
   */
  private formatCreateAccountResponse(data: any): string {
    let response = ` **${data.message || 'Account Created Successfully!'}**\n\n`;
    response += `• Name: **${data.name}**\n`;
    response += `• Public Key: \`${data.publicKey}\`\n`;
    response += `• Current Balance: ${data.balance.toFixed(4)} SOL\n`;

    if (data.warning) {
      response += `\n${data.warning}\n`;
    }

    if (data.fundingInstructions) {
      response += `\n**Funding Instructions**:\n`;
      response += `• Send SOL to: \`${data.fundingInstructions.address}\`\n`;
      response += `• Recommended: ${data.fundingInstructions.minimumRecommended}\n`;
    }

    if (data.nextSteps) {
      response += `\n**Next Steps**:\n`;
      data.nextSteps.forEach((step: string, i: number) => {
        response += `${i + 1}. ${step}\n`;
      });
    }

    return response.trim();
  }

  /**
   * Format import account response
   */
  private formatImportAccountResponse(data: any): string {
    let response = ` **${data.message || 'Account Imported Successfully!'}**\n\n`;
    response += `• Name: **${data.name}**\n`;
    response += `• Public Key: \`${data.publicKey}\`\n`;
    response += `• Balance: ${data.formatted?.balance || `${data.balance.toFixed(4)} SOL`}\n`;
    response += `• Status: **${data.status}**\n`;

    if (data.warning) {
      response += `\n${data.warning}\n`;
    }

    if (data.fundingInstructions && data.status !== 'healthy') {
      response += `\n**Funding Instructions**:\n`;
      response += `• Send SOL to: \`${data.fundingInstructions.address}\`\n`;
      response += `• Recommended: ${data.fundingInstructions.minimumRecommended}\n`;
    }

    return response.trim();
  }

  /**
   * Format transaction history response
   */
  private formatTransactionHistoryResponse(data: any): string {
    if (data.transactions.length === 0) {
      return `📭 **No Transactions Found**\n\n${data.suggestion || 'Start trading to see your transaction history!'}`;
    }

    let response = `📊 **Transaction History**\n\n`;
    response += `**Stats**: ${data.stats.successful} successful, ${data.stats.failed} failed (${data.stats.buys} buys, ${data.stats.sells} sells)\n\n`;

    data.transactions.slice(0, 10).forEach((tx: any, i: number) => {
      const statusEmoji = tx.status === 'success' ? '✅' : '❌';
      const typeEmoji = tx.type === 'buy' ? '🟢' : '🔴';
      response += `${i + 1}. ${statusEmoji} ${typeEmoji} **${tx.type.toUpperCase()}**\n`;
      response += `   • Token: \`${tx.token.substring(0, 8)}...${tx.token.substring(tx.token.length - 4)}\`\n`;
      response += `   • Amount: ${tx.amount}\n`;
      if (tx.price) response += `   • Price: ${tx.price.toFixed(8)} SOL\n`;
      response += `   • Time: ${new Date(tx.timestamp).toLocaleString()}\n`;
      if (tx.explorer) response += `   • [View on Solscan](${tx.explorer})\n`;
      if (tx.error) response += `   • Error: ${tx.error}\n`;
      response += `\n`;
    });

    if (data.transactions.length > 10) {
      response += `\n_Showing 10 of ${data.transactions.length} transactions_`;
    }

    return response.trim();
  }

  /**
   * Format portfolio summary response
   */
  private formatPortfolioSummaryResponse(data: any): string {
    if (data.accounts.length === 0) {
      return `📭 **${data.message || 'No Accounts Found'}**\n\n${data.suggestion || 'Create an account to get started!'}`;
    }

    let response = `💼 **Portfolio Summary**\n\n`;
    response += `**Total Value**: ${data.summary.formatted}\n`;
    response += `**Accounts**: ${data.summary.totalAccounts} total, ${data.summary.healthyAccounts} healthy\n\n`;

    response += `**Accounts**:\n`;
    data.accounts.forEach((acc: any, i: number) => {
      const statusEmoji = acc.status === 'healthy' ? '💚' : acc.status === 'low' ? '⚠️' : acc.status === 'empty' ? '⚪' : '❌';
      const defaultBadge = acc.isDefault ? ' **(default)**' : '';
      response += `${i + 1}. ${statusEmoji} **${acc.accountName}**${defaultBadge}\n`;
      response += `   • Balance: ${acc.solBalance.toFixed(4)} SOL (~$${acc.usdValue.toFixed(2)})\n`;
      response += `   • Address: \`${acc.publicKey}\`\n`;
      if (acc.error) response += `   • Error: ${acc.error}\n`;
      response += `\n`;
    });

    if (data.recentActivity && data.recentActivity.transactions.length > 0) {
      response += `\n**Recent Activity** (last ${data.recentActivity.transactions.length} trades):\n`;
      data.recentActivity.transactions.forEach((tx: any) => {
        const emoji = tx.type === 'buy' ? '🟢' : '🔴';
        response += `• ${emoji} ${tx.type.toUpperCase()} - ${new Date(tx.timestamp).toLocaleDateString()}\n`;
      });
    }

    return response.trim();
  }

  /**
   * Enhanced Get token information using pump.fun integration
   * IMPROVED: Better data display with proper formatting
   * NEW: Returns null if tool is disabled (for web search fallback)
   */
  private async getTokenInfo(tokenMint: string, sessionId?: string): Promise<string | null> {
    // Check if getTokenInfo tool is enabled (if session provided)
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session?.enabledTools && !session.enabledTools.includes('getTokenInfo')) {
        console.log('🔧 Get-token-info tool is DISABLED - returning null for web search fallback');
        return null;
      }
    }

    try {
      const connection = new Connection(TRADING_CONFIG.RPC_ENDPOINT || '', 'confirmed');
      const trading = getUnifiedTrading(connection);
      const pumpAPI = getPumpFunAPI(connection);

      // FIRST: Try to get pump.fun metadata directly (more reliable)
      const pumpMetadata = await pumpAPI.getTokenMetadata(tokenMint);

      // If pump.fun API returns data, it's definitely a pump.fun token
      let isPumpFunToken = false;
      if (pumpMetadata && (pumpMetadata.mint || pumpMetadata.name || pumpMetadata.symbol)) {
        isPumpFunToken = true;
        console.log('✅ Confirmed pump.fun token via API');
      }

      // Get token type and basic info from router
      const tokenInfo = await trading.getTokenInfo(tokenMint);

      // Override detection if pump API confirmed it
      if (isPumpFunToken) {
        tokenInfo.type = 'PUMP_FUN' as any;
        tokenInfo.isValid = true;
      }

      // Check if we have any valid information
      if (!tokenInfo.isValid && !isPumpFunToken) {
        return `❌ **Token Not Found**\n\n` +
          `I couldn't find any information about this token on the Solana blockchain.\n\n` +
          `**Address**: \`${tokenMint}\`\n\n` +
          `**Possible reasons:**\n` +
          `• The token address might be incorrect or misspelled\n` +
          `• The token doesn't exist on Solana mainnet\n` +
          `• The token was removed or burned\n` +
          `• The pump.fun bonding curve might have been closed\n\n` +
          `**What you can do:**\n` +
          `1. Double-check the token address for typos\n` +
          `2. Visit [pump.fun](https://pump.fun) to find active tokens\n` +
          `3. Copy a token address from the pump.fun website\n` +
          `4. Try checking on [Solscan](https://solscan.io/token/${tokenMint})\n\n` +
          `**Need help finding tokens?**\n` +
          `You can ask me: "Show me how to find pump.fun tokens" or visit https://pump.fun directly!\n\n` +
          `💡 **Tip**: Active pump.fun tokens usually have "pump" at the end of their address!`;
      }

      let response = `🔍 **Token Information**\n\n`;
      response += `**Address**: \`${tokenMint}\`\n`;

      // Use pump.fun detection from API if available
      const finalTokenType = isPumpFunToken ? 'PUMP_FUN' : tokenInfo.type;
      response += `**Type**: ${finalTokenType === 'PUMP_FUN' ? '🚀 Pump.fun Token' : '💎 Standard Solana Token'}\n`;

      if (tokenInfo.symbol || pumpMetadata?.symbol) {
        response += `**Symbol**: ${pumpMetadata?.symbol || tokenInfo.symbol}\n`;
      }
      if (tokenInfo.name || pumpMetadata?.name) {
        response += `**Name**: ${pumpMetadata?.name || tokenInfo.name}\n`;
      }
      if (tokenInfo.decimals) {
        response += `**Decimals**: ${tokenInfo.decimals}\n`;
      }

      // Get pump.fun specific data if it's a pump token
      if (finalTokenType === 'PUMP_FUN' || isPumpFunToken) {
        response += `\n🏆 **Pump.fun Details:**\n`;

        // Use the metadata we already fetched
        const metadata = pumpMetadata;

        // If metadata is null or empty, try to get on-chain bonding curve data
        let bondingCurveData = null;
        if (!metadata || Object.keys(metadata).length === 0) {
          try {
            const { PumpFunIntegration } = await import('../trading_utils/PumpFunIntegration');
            const pumpIntegration = new PumpFunIntegration(connection);
            const mintPubkey = new PublicKey(tokenMint);
            // Get comprehensive token info including on-chain data
            bondingCurveData = await pumpIntegration.getComprehensiveTokenInfo(mintPubkey);
            console.log(' Retrieved on-chain bonding curve data');
          } catch (error) {
            console.error(' Failed to get on-chain bonding curve data:', error);
          }
        }

        if (metadata || bondingCurveData) {
          // Combine data from API metadata and on-chain bonding curve
          const name = metadata?.name || bondingCurveData?.name || tokenInfo.name;
          const symbol = metadata?.symbol || bondingCurveData?.symbol || tokenInfo.symbol;
          const description = metadata?.description || bondingCurveData?.description;

          // Price fields (try multiple formats from API or on-chain)
          const priceUSD = metadata?.price || metadata?.priceUsd || metadata?.price_usd || bondingCurveData?.currentPrice;
          const marketCap = metadata?.usd_market_cap || metadata?.usdMarketCap || metadata?.market_cap || metadata?.marketCap || bondingCurveData?.marketCapUSD;
          const volume24h = metadata?.volume_24h || metadata?.volume24h || metadata?.volume || bondingCurveData?.volume24h;
          const trades24h = metadata?.txns_24h || metadata?.txns24h || metadata?.trades_24h;

          // Reserves (try multiple formats from API or on-chain)
          const solReserves = metadata?.virtual_sol_reserves || metadata?.virtualSolReserves || bondingCurveData?.virtualSolReserves;
          const tokenReserves = metadata?.virtual_token_reserves || metadata?.virtualTokenReserves || bondingCurveData?.virtualTokenReserves;

          // Other data
          const bondingProgress = metadata?.bonding_curve_progress || metadata?.bondingCurveProgress || metadata?.complete || (bondingCurveData?.isGraduated ? 1 : 0);
          const status = bondingCurveData?.isGraduated ? 'Graduated to Raydium' : 'Active';

          // NAME & SYMBOL (Display first!)
          if (name && name !== 'Unknown' && name !== `Token ${tokenMint.substring(0, 8)}`) {
            response += `• **Name**: ${name}\n`;
          }
          if (symbol && symbol !== 'Unknown' && symbol !== 'UNKNOWN') {
            response += `• **Symbol**: ${symbol}\n`;
          }

          // Data source indicator (only show if helpful)
          if ((!name || name === 'Unknown') && (!description || description === 'No description' || description.length === 0)) {
            const dataSource = metadata ? 'Pump.fun API' : 'On-chain bonding curve';
            response += `• **Data Source**: ${dataSource}\n`;
          }

          // DESCRIPTION
          if (description && description !== 'No description' && description.length > 0) {
            const shortDesc = description.length > 200
              ? description.substring(0, 200) + '...'
              : description;
            response += `• **Description**: ${shortDesc}\n`;
          }

          // CURRENT PRICE (MOST IMPORTANT!)
          response += `\n💰 **Price**\n`;
          let calculatedPriceUSD = priceUSD ? Number(priceUSD) : null;
          let calculatedPriceSOL: number | null = null;

          // If we have direct price, use it
          if (calculatedPriceUSD) {
            response += `• **Current Price**: $${calculatedPriceUSD.toFixed(8)} USD\n`;

            const solPrice = await this.getSolPrice();
            if (solPrice) {
              calculatedPriceSOL = calculatedPriceUSD / solPrice;
              response += `• **Price in SOL**: ${calculatedPriceSOL.toFixed(9)} SOL\n`;
            }
          }
          // Otherwise, calculate from reserves if available
          else if (solReserves && tokenReserves) {
            const sol = Number(solReserves) / 1e9; // Convert lamports to SOL
            const tokens = Number(tokenReserves) / 1e6; // Adjust for typical pump.fun decimals
            calculatedPriceSOL = sol / tokens;

            const solPrice = await this.getSolPrice();
            if (solPrice) {
              calculatedPriceUSD = calculatedPriceSOL * solPrice;

              response += `• **Current Price**: $${calculatedPriceUSD.toFixed(8)} USD\n`;
              response += `• **Price in SOL**: ${calculatedPriceSOL.toFixed(9)} SOL\n`;
            } else {
              response += `• **Price in SOL**: ${calculatedPriceSOL.toFixed(9)} SOL\n`;
            }
          } else {
            response += `• **Price**: N/A\n`;
          }

          // MARKET DATA
          response += `\n📊 **Market Data**\n`;

          if (marketCap && Number(marketCap) > 0) {
            response += `• **Market Cap**: $${this.formatNumber(Number(marketCap))}\n`;
          }

          if (volume24h && Number(volume24h) > 0) {
            response += `• **24h Volume**: $${this.formatNumber(Number(volume24h))}\n`;
          }

          if (trades24h && Number(trades24h) > 0) {
            response += `• **24h Trades**: ${this.formatNumber(Number(trades24h))}\n`;
          }

          // Only show "unavailable" if all fields are empty
          if ((!marketCap || Number(marketCap) === 0) && (!volume24h || Number(volume24h) === 0) && (!trades24h || Number(trades24h) === 0)) {
            response += `• Market data updating...\n`;
          }

          // BONDING CURVE
          response += `\n🔥 **Bonding Curve**\n`;

          const realSolRes = bondingCurveData?.realSolReserves;
          const totalSup = bondingCurveData?.totalSupply;
          const bondProg = bondingCurveData?.bondingProgress;

          if (realSolRes !== undefined && realSolRes !== null) {
            response += `• **SOL Reserves**: ${Number(realSolRes).toFixed(2)} SOL\n`;
            if (Number(realSolRes) === 0) {
              response += `  ⚠️ Warning: Zero reserves detected\n`;
            }
          } else if (solReserves) {
            const solRes = Number(solReserves) / 1e9;
            response += `• **SOL Reserves**: ${solRes.toFixed(2)} SOL\n`;
            if (solRes === 0) {
              response += `  ⚠️ Warning: Zero reserves detected\n`;
            }
          }

          if (totalSup && Number(totalSup) > 0) {
            const supplyNum = Number(totalSup);
            const supplyFormatted = supplyNum >= 1000000
              ? `${(supplyNum / 1000000).toFixed(2)}M`
              : supplyNum >= 1000
                ? `${(supplyNum / 1000).toFixed(2)}K`
                : supplyNum.toFixed(2);
            response += `• **Token Supply**: ${supplyFormatted}\n`;
          }

          if (bondProg !== undefined && bondProg !== null && Number(bondProg) > 0) {
            response += `• **Bonding Progress**: ${Number(bondProg).toFixed(1)}%\n`;
          }

          response += `• **Status**: ${status}\n`;

          // LINKS
          response += `\n🔗 **Links**\n`;
          response += `• **Contract**: ${tokenMint}\n`;

          // TRADING LINKS
          response += `\n🔗 **View on:**\n`;
          response += `• [Pump.fun](https://pump.fun/${tokenMint})\n`;
          response += `• [DexScreener](https://dexscreener.com/solana/${tokenMint})\n`;
          response += `• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)\n`;
        } else {
          // If both API and on-chain data failed, provide basic info
          response += `\n⚠️ **Limited Data Available**\n\n`;
          response += `The pump.fun API is currently unavailable and on-chain bonding curve data couldn't be fetched. This could be due to:\n`;
          response += `• Cloudflare protection on pump.fun API\n`;
          response += `• Network connectivity issues\n`;
          response += `• Token bonding curve has completed\n\n`;
          response += `**However, the token IS valid and active!**\n\n`;
          response += `**🔗 View detailed information on:**\n`;
          response += `• [Pump.fun](https://pump.fun/${tokenMint}) - See real-time price and trading\n`;
          response += `• [DexScreener](https://dexscreener.com/solana/${tokenMint}) - View charts and analytics\n`;
          response += `• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana) - Comprehensive token data\n`;
        }

        // STATUS CHECK
        response += `\n**✅ Status**: Active pump.fun token\n`;

        // HOW TO TRADE
        response += `\n**💡 How to Trade:**\n`;
        response += `You can trade this token directly! Just say:\n`;
        response += `• "Buy 0.1 SOL of this token"\n`;
        response += `• "Create a DCA strategy for ${tokenMint.substring(0, 8)}..."\n`;

        // RISK WARNING
        response += `\n**⚠️ Risk Warning**: Pump.fun tokens are speculative and high-risk. Only invest what you can afford to lose. Always DYOR (Do Your Own Research)!\n`;
      } else {
        // Standard token - provide basic info
        response += `\n**ℹ️ Standard Token Info:**\n`;
        response += `This is a standard Solana token that can be traded on Jupiter aggregator.\n`;
        response += `\n**🔗 View on:**\n`;
        response += `• [DexScreener](https://dexscreener.com/solana/${tokenMint})\n`;
        response += `• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)\n`;
        response += `• [Jupiter](https://jup.ag/swap/SOL-${tokenMint})\n`;
      }

      return response;
    } catch (error: any) {
      console.error(' [TOKEN_INFO] Error:', error);
      // Even on error, try to provide some basic info
      return `I encountered an error fetching detailed information about this token.\n\n` +
        `**Address**: \`${tokenMint}\`\n\n` +
        `You can still view this token on:\n` +
        `• [Pump.fun](https://pump.fun/${tokenMint})\n` +
        `• [DexScreener](https://dexscreener.com/solana/${tokenMint})\n` +
        `• [Birdeye](https://birdeye.so/token/${tokenMint}?chain=solana)\n\n` +
        `Error details: ${error.message}`;
    }
  }

  /**
   * Helper: Format large numbers with K, M, B suffixes
   */
  private formatNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
  }

  /**
   * Helper: Get current SOL price in USD with caching
   */
  private async getSolPrice(): Promise<number | null> {
    try {
      // Check cache first
      if (this.priceCache && Date.now() - this.priceCache.timestamp < this.PRICE_CACHE_TTL) {
        console.log(` Using cached SOL price: $${this.priceCache.price.toFixed(2)}`);
        return this.priceCache.price;
      }

      // Try DexScreener first (no rate limits, faster, more reliable)
      try {
        const dexResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        if (dexResponse.ok) {
          const dexData: any = await dexResponse.json();
          if (dexData.pairs && dexData.pairs.length > 0) {
            const solPrice = parseFloat(dexData.pairs[0].priceUsd);
            if (solPrice && !isNaN(solPrice) && solPrice > 0) {
              this.priceCache = { price: solPrice, timestamp: Date.now() };
              console.log(` Fetched SOL price from DexScreener: $${solPrice.toFixed(2)}`);
              return solPrice;
            }
          }
        }
      } catch (dexError) {
        console.warn(' DexScreener failed, trying CoinGecko...');
      }

      // Fallback to CoinGecko (has rate limits but still good backup)
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        if (response.ok) {
          const data = await response.json() as { solana?: { usd?: number } };
          if (data.solana && data.solana.usd) {
            const price = data.solana.usd;
            this.priceCache = { price, timestamp: Date.now() };
            console.log(` Fetched SOL price from CoinGecko: $${price.toFixed(2)}`);
            return price;
          }
        } else if (response.status === 429) {
          console.error(' CoinGecko rate limit exceeded (429). Using fallback...');
        }
      } catch (cgError) {
        console.error(' CoinGecko failed:', cgError instanceof Error ? cgError.message : 'Unknown error');
      }

      // Last resort: return cached value even if expired
      if (this.priceCache) {
        console.warn(' Using expired cache as fallback');
        return this.priceCache.price;
      }

      return null;
    } catch (error) {
      console.error(' Failed to fetch SOL price:', error);
      // Try to use cached value even if expired
      if (this.priceCache) {
        console.warn(' Using expired cache due to error');
        return this.priceCache.price;
      }
      return null;
    }
  }

  /**
   * Execute the current strategy for a session
   */
  async executeStrategy(
    sessionId: string,
    walletAddress?: string,
    paperTradingMode: 'paper' | 'live' = 'paper',
    paperTradingSessionId?: string,
    userId?: string, // User identifier for multi-user isolation
    resourceLimits?: {
      maxConcurrentStrategies?: number;
      maxDailyExecutions?: number;
      maxPositionSize?: number;
    }
  ): Promise<{ success: boolean; message: string; strategyId?: string }> {
    try {
      const session = this.getSession(sessionId);

      if (!session.currentStrategy) {
        return {
          success: false,
          message: 'No strategy has been configured yet. Please describe what you want to trade first.'
        };
      }

      const validation = strategyParser.validateParsedStrategy(session.currentStrategy);

      if (!validation.valid) {
        return {
          success: false,
          message: `Strategy validation failed: ${validation.errors.join(', ')}`
        };
      }

      const strategyId = session.currentStrategy.config.id;

      // Check if strategy is already running
      const runningStrategies = strategyExecutionManager.listRunningStrategies();
      const runningStrategy = runningStrategies.find(s =>
        s.strategyId === strategyId && (s.status === 'running' || s.status === 'paused')
      );

      if (runningStrategy) {
        console.log(` [EXECUTE] Strategy ${strategyId} is already running (${runningStrategy.id}), stopping it first`);
        await strategyExecutionManager.stopStrategy(runningStrategy.id);
      }

      // Check if strategy definition exists
      const existingStrategy = strategyBuilder.getStrategy(strategyId);
      if (existingStrategy) {
        console.log(` [EXECUTE] Deleting existing strategy definition: ${strategyId}`);
        strategyBuilder.deleteStrategy(strategyId);
      }

      // Create strategy
      console.log(` [EXECUTE] Creating strategy from template:`, {
        template: session.currentStrategy.template,
        config: session.currentStrategy.config,
        fullStrategy: session.currentStrategy
      });

      const strategy = createStrategyFromTemplate(
        session.currentStrategy.template,
        session.currentStrategy.config
      );

      console.log(` [EXECUTE] Strategy created:`, {
        id: strategy.id,
        name: strategy.name,
        description: strategy.description
      });

      await awsLogger.info('Strategy created via AI agent', {
        metadata: {
          sessionId,
          strategyId: strategy.id,
          template: session.currentStrategy.template,
          walletAddress,
          userId,
          paperTradingMode,
          paperTradingSessionId
        }
      });

      // Start strategy execution with user context and resource limits
      const runningStrategyId = await strategyExecutionManager.startStrategy(
        strategy.id,
        5000,
        true,
        10, // Initial paper trading balance: 10 SOL for testing
        paperTradingMode,
        paperTradingSessionId,
        userId || walletAddress, // Use userId or fallback to walletAddress
        walletAddress,
        resourceLimits
      );

      const strategyName = this.getStrategyDisplayName(session.currentStrategy);
      const modeLabel = paperTradingMode === 'paper' ? 'PAPER TRADING' : 'LIVE TRADING';

      // EMIT WebSocket event to UI to show active strategy
      console.log(` [EXECUTE] Emitting strategy:started event to UI`);
      if (this.io) {
        this.io.emit('strategy:started', {
          strategyId: runningStrategyId,
          strategy: {
            ...session.currentStrategy,
            name: strategyName,
          },
          mode: paperTradingMode,
          sessionId: paperTradingSessionId,
          timestamp: Date.now()
        });
        console.log(` [EXECUTE] WebSocket event emitted successfully`);
      } else {
        console.warn(` [EXECUTE] No WebSocket IO available to emit events`);
      }

      return {
        success: true,
        strategyId: runningStrategyId,
        message: `✅ Strategy "${strategyName}" is now ACTIVE in ${modeLabel} mode! Monitor it on your dashboard.`
      };
    } catch (error: any) {
      await awsLogger.error('Strategy execution failed', {
        metadata: { error: error.message, sessionId }
      });

      return {
        success: false,
        message: `Failed to create strategy: ${error.message}`
      };
    }
  }

  /**
   * Post-process AI response to fix cached price issues
   */
  private postProcessResponse(response: string, currentSolPrice?: string | null): string {
    if (response.includes('231.50') || response.includes('$231.50')) {
      console.log(`⚠️ Detected cached price (231.50) in AI response`);

      if (currentSolPrice) {
        let correctedResponse = response.replace(/\$231\.50/g, currentSolPrice);
        correctedResponse = correctedResponse.replace(/231\.50/g, currentSolPrice.replace('$', ''));

        console.log(` Corrected cached price to real-time price: ${currentSolPrice}`);
        return correctedResponse;
      } else {
        console.log(` Cannot correct cached price - no real-time price available`);
      }
    }

    return response;
  }

  /**
   * Build context-aware system prompt
   * Adds MCP tools status
   */
  private buildSystemPrompt(session: AgentSession, userMessage: string, currentSolPrice?: string | null, isPriceQuery: boolean = false): string {
    let prompt = SYSTEM_PROMPTS.TRADING_AGENT;

    // Add this to the system prompt when user asks to build a strategy
    if (session.currentStrategy === undefined &&
      (userMessage.toLowerCase().includes('build') ||
        userMessage.toLowerCase().includes('create'))) {

      prompt += `\n\nIMPORTANT: The user is asking to BUILD a strategy but hasn't specified the details yet. 
                DO NOT create a default strategy configuration. Instead:
                1. Ask what TYPE of strategy they want (DCA, Grid Trading, Stop-Loss, etc.)
                2. Explain each option briefly
                3. Wait for them to choose before asking for specific parameters

                DO NOT show activation buttons or suggest executing anything until they've provided all parameters.`;
    }

    // Add MCP tools status
    if (session.enabledTools) {
      const toolsEnabled = session.enabledTools.length > 0;
      const disabledTools = [
        'getTokenInfo', 'buyToken', 'sellToken', 'listAccounts',
        'getAccountBalance', 'createAccount', 'importAccount',
        'getTransactionHistory', 'getPortfolioSummary'
      ].filter(tool => !session.enabledTools?.includes(tool));

      if (disabledTools.length > 0) {
        prompt += `\n\n🔧 **MCP TOOLS STATUS**:`;
        prompt += `\nThe following tools are DISABLED by user:`;
        disabledTools.forEach(tool => {
          prompt += `\n• ${tool}`;
        });

        // Special instruction for getTokenInfo
        if (disabledTools.includes('getTokenInfo')) {
          prompt += `\n\n⚠️ **IMPORTANT - Get-token-info is DISABLED**:`;
          prompt += `\nWhen user asks about a token, you MUST use web search instead of the getTokenInfo tool.`;
          prompt += `\nProvide general information about the token from web results.`;
          prompt += `\nExplain that you're using web search because the direct token lookup tool is currently disabled.`;
          prompt += `\nSuggest visiting pump.fun, DexScreener, or Solscan for detailed real-time data.`;
        }

        prompt += `\n\nFor disabled tools, politely explain they are turned off and suggest alternatives.`;
      } else if (session.enabledTools.length === 9) {
        prompt += `\n\n✅ All MCP tools are ENABLED and available for use.`;
      }
    }

    // Add price info if price query
    if (currentSolPrice && isPriceQuery) {
      prompt = `🎨 USER ASKED FOR CURRENT SOL PRICE 🎨
                **CURRENT REAL-TIME SOL PRICE: ${currentSolPrice}**
                Data Source: Live market feed
                Fetched: ${new Date().toISOString()}

                IMPORTANT: Use this real-time price: ${currentSolPrice}
                DO NOT use cached prices.` + prompt;
    }

    // Add wallet status
    if (session.walletConnected) {
      prompt += `\n\nUser's Phantom wallet is connected: ${session.walletAddress}`;
    } else {
      prompt += `\n\nUser's wallet is NOT connected yet.`;
    }

    // Add current strategy context
    if (session.currentStrategy) {
      prompt += `\n\nCurrent strategy: ${session.currentStrategy.template} with config: ${JSON.stringify(session.currentStrategy.config)}`;
      prompt += `\n\nIMPORTANT: If user wants to switch strategies, help them with the NEW strategy.`;
    }

    // Add conversation history
    if (session.conversationHistory.length > 0) {
      const recentHistory = session.conversationHistory.slice(-8);

      prompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      prompt +=           `\nCONVERSATION HISTORY:`;
      prompt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

      recentHistory.forEach((msg) => {
        const role = msg.role === 'user' ? 'USER' : 'YOU';
        prompt += `\n${role}: ${msg.content}\n`;
      });

      prompt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      prompt += `\n\n🔴 CRITICAL: Continue naturally from the conversation above. Don't ask for information already provided.`;
    }

    return prompt;
  }

  /**
   * Detect if user message requires a tool execution
   * Analyzes natural language to identify tool calls
   */
  /**
   * Enhanced tool request detection with comprehensive natural language patterns
   */
  private detectToolRequest(message: string): ToolRequest | null {
    const lower = message.toLowerCase();

    // TOKEN INFO DETECTION - Enhanced with more patterns
    if (
      lower.includes('info') ||
      lower.includes('tell me about') ||
      lower.includes('what is') ||
      lower.includes('details about') ||
      lower.includes('details on') ||
      lower.includes('show me') ||
      lower.includes('information on') ||
      lower.includes('check out') ||
      lower.includes('analyze') ||
      lower.includes('review') ||
      lower.includes('research') ||
      lower.includes('investigate') ||
      lower.includes('look up') ||
      lower.includes('lookup') ||
      lower.includes('find info') ||
      lower.includes('explain')
    ) {
      // Extract token mint address (Solana addresses are 32-44 chars base58)
      const mintMatch = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (mintMatch) {
        console.log(` Detected token info request for ${mintMatch[0]}`);
        return {
          tool: 'getTokenInfo',
          params: { mint: mintMatch[0] }
        };
      }
    }

    // BUY TOKEN DETECTION - Enhanced with more patterns
    if (
      lower.includes('buy') ||
      lower.includes('purchase') ||
      lower.includes('get some') ||
      lower.includes('invest in') ||
      lower.includes('buy some') ||
      lower.includes('acquire') ||
      lower.includes('grab') ||
      lower.includes('snag') ||
      lower.includes('ape into') ||
      lower.includes('ape in') ||
      lower.includes('enter position') ||
      lower.includes('open position') ||
      lower.includes('long')
    ) {
      const mintMatch = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      const amountMatch = message.match(/(\d+\.?\d*)\s*(sol)?/i);

      if (mintMatch && amountMatch) {
        const amount = parseFloat(amountMatch[1]);

        // Extract slippage if specified
        const slippageMatch = message.match(/(\d+)%?\s*slippage/i);
        const slippage = slippageMatch ? parseFloat(slippageMatch[1]) : 5;

        // Extract priority fee if specified
        const priorityMatch = message.match(/priority\s*(?:fee)?\s*(\d+\.?\d*)/i);
        const priorityFee = priorityMatch ? parseFloat(priorityMatch[1]) : 0.0001;

        console.log(` Detected: Buy Request - ${amount} SOL of ${mintMatch[0]}`);

        // Check if amount requires confirmation
        const LARGE_TRADE_THRESHOLD = 1.0; // 1 SOL
        if (amount >= LARGE_TRADE_THRESHOLD) {
          console.log(` large trade detected (${amount} SOL > ${LARGE_TRADE_THRESHOLD} SOL), requiring confirmation`);

          return {
            tool: 'requireConfirmation',
            params: {
              actualTool: 'buyToken',
              mint: mintMatch[0],
              amount: amount,
              slippage: slippage,
              priorityFee: priorityFee,
              accountName: 'default',
              message: `You are about to buy ${amount} SOL worth of the token with mint address ${mintMatch[0]} with a slippage of ${slippage}%. Please confirm to proceed.`
            }
          }
        }

        return {
          tool: 'buyToken',
          params: {
            mint: mintMatch[0],
            amount: amount,
            slippage: slippage,
            priorityFee: priorityFee,
            accountName: 'default'
          }
        };
      }
    }

    // SELL TOKEN DETECTION - Enhanced with more patterns
    if (
      lower.includes('sell') ||
      lower.includes('dump') ||
      lower.includes('exit position') ||
      lower.includes('close position') ||
      lower.includes('take profit') ||
      lower.includes('cash out') ||
      lower.includes('liquidate') ||
      lower.includes('get out') ||
      lower.includes('sell off') ||
      lower.includes('unload') ||
      lower.includes('short')
    ) {
      const mintMatch = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);

      if (mintMatch) {
        // Extract percentage to sell if specified (enhanced patterns)
        const percentMatch = message.match(/(\d+)%|all|everything|entire|whole|full|half|quarter|third/i);
        let percentage = 100; // Default to selling all

        if (percentMatch) {
          const match = percentMatch[0].toLowerCase();
          if (match === 'half') {
            percentage = 50;
          } else if (match === 'quarter') {
            percentage = 25;
          } else if (match === 'third') {
            percentage = 33;
          } else if (match === 'all' || match === 'everything' || match === 'entire' || match === 'whole' || match === 'full') {
            percentage = 100;
          } else if (percentMatch[1]) {
            percentage = parseFloat(percentMatch[1]);
          }
        }

        // Extract slippage if specified
        const slippageMatch = message.match(/(\d+)%?\s*slippage/i);
        const slippage = slippageMatch ? parseFloat(slippageMatch[1]) : 5;

        console.log(` Detected: Sell Request - ${percentage}% of ${mintMatch[0]}`);

        // Required confirmation for selling everything
        if (percentage === 100) {
          console.log(` Full position sell detected (${percentage}%)`);

          return {
            tool: 'requireConfirmation',
            params: {
              actualTool: 'sellToken',
              mint: mintMatch[0],
              percentage: percentage,
              slippage: slippage,
              message: `You are about to sell ${percentage}% of your position in token ${mintMatch[0]}. Please confirm to proceed.`
            }
          };
        }

        return {
          tool: 'sellToken',
          params: {
            mint: mintMatch[0],
            percentage: percentage,
            slippage: slippage
          }
        };
      }
    }

    // PORTFOLIO DETECTION - Enhanced with more patterns
    if (
      lower.includes('portfolio') ||
      lower.includes('my tokens') ||
      lower.includes('my holdings') ||
      lower.includes('what do i own') ||
      lower.includes('my positions') ||
      lower.includes('show portfolio') ||
      lower.includes('show holdings') ||
      lower.includes('my assets') ||
      lower.includes('total value') ||
      lower.includes('net worth') ||
      lower.includes('summary') ||
      (lower.includes('show') && (lower.includes('all') || lower.includes('everything')))
    ) {
      console.log(` Detected: Portfolio Summary Request`);
      return {
        tool: 'getPortfolioSummary',
        params: { accountName: undefined } // Show all accounts
      };
    }

    // TRANSACTION HISTORY DETECTION - New
    if (
      lower.includes('history') ||
      lower.includes('transactions') ||
      lower.includes('my trades') ||
      lower.includes('past trades') ||
      lower.includes('recent trades') ||
      lower.includes('trade history') ||
      lower.includes('transaction log') ||
      lower.includes('what did i trade') ||
      lower.includes('my activity')
    ) {
      // Check if filtering by type
      let type: 'buy' | 'sell' | undefined = undefined;
      if (lower.includes('buy') || lower.includes('purchases')) {
        type = 'buy';
      } else if (lower.includes('sell') || lower.includes('sales')) {
        type = 'sell';
      }

      // Extract limit if specified
      const limitMatch = message.match(/(?:last|recent|past)\s*(\d+)/i);
      const limit = limitMatch ? parseInt(limitMatch[1]) : 50;

      console.log(` Detected: Transaction History Request (type: ${type || 'all'}, limit: ${limit})`);
      return {
        tool: 'getTransactionHistory',
        params: {
          accountName: undefined,
          limit: limit,
          type: type
        }
      };
    }

    // BALANCE CHECK - Enhanced with more patterns
    if (
      lower.includes('balance') ||
      lower.includes('how much sol') ||
      lower.includes('what do i have') ||
      lower.includes('my sol') ||
      lower.includes('wallet balance') ||
      lower.includes('check balance') ||
      lower.includes('show balance') ||
      lower.includes('how much do i have') ||
      lower.includes('how much money')
    ) {
      // check if asking about specific token
      const mintMatch = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);

      console.log(` Detected: Balance Check${mintMatch ? ' for token' : ''}`);

      return {
        tool: 'getAccountBalance',
        params: {
          accountName: 'default',
          mint: mintMatch ? mintMatch[0] : undefined
        }
      };
    }

    // LIST ACCOUNTS - Enhanced with more patterns
    if (
      lower.includes('list accounts') ||
      lower.includes('show accounts') ||
      lower.includes('my wallets') ||
      lower.includes('my wallet') ||
      lower.includes('which accounts') ||
      lower.includes('all accounts') ||
      lower.includes('list wallets') ||
      lower.includes('list wallet') ||
      lower.includes('show wallets') ||
      lower.includes('show wallet') ||
      lower.includes('what wallets') ||
      lower.includes('what wallet') ||
      lower.includes('my accounts') ||
      lower.includes('my account') ||
      lower.includes('account list') ||
      lower.includes('wallet list') ||
      lower.includes('wallet info') ||
      lower.includes('account info')
    ) {
      console.log(` Detected: List Accounts Request`);

      return {
        tool: 'listAccounts',
        params: {}
      };
    }

    // CREATE ACCOUNT - Enhanced with more patterns
    if (
      lower.includes('create account') ||
      lower.includes('new wallet') ||
      lower.includes('generate keypair') ||
      lower.includes('make account') ||
      lower.includes('create wallet') ||
      lower.includes('new account') ||
      lower.includes('add account') ||
      lower.includes('add wallet') ||
      lower.includes('set up wallet') ||
      lower.includes('setup wallet') ||
      lower.includes('generate wallet')
    ) {
      // Enhanced name extraction patterns
      const nameMatch = message.match(/(?:name(?:d)?|called?)\s+["']?(\w+)["']?/i) ||
        message.match(/["'](\w+)["']\s+(?:account|wallet)/i) ||
        message.match(/(?:account|wallet)\s+["']?(\w+)["']?/i);
      const name = nameMatch ? nameMatch[1] : 'default';

      console.log(` Detected: Create Account - ${name}`);

      return {
        tool: 'createAccount',
        params: { name }
      };
    }

    // IMPORT ACCOUNT - Enhanced (but still restricted for security)
    if (
      lower.includes('import account') ||
      lower.includes('import wallet') ||
      lower.includes('load keypair') ||
      lower.includes('import keypair') ||
      lower.includes('restore wallet') ||
      lower.includes('restore account') ||
      lower.includes('add existing wallet') ||
      lower.includes('add existing account')
    ) {
      // This would need the secret key, which should be handled carefully
      console.log(` Detected: Import Account Request (security-restricted)`);

      // for security, we might want to handle this differently
      // perhaps redirect to a secure input method
      return null; // Don't auto-detect import for security
    }

    // no tool detected
    return null;
  }

  /**
   * Detect if user is explicitly switching strategies
   */
  private detectStrategySwitch(userMessage: string): boolean {
    const lowerMessage = userMessage.toLowerCase();
    const switchKeywords = ['switch', 'change', 'instead', 'rather', 'actually', 'no wait', 'i want to', 'different'];
    const strategyKeywords = ['dca', 'grid', 'momentum', 'stop loss', 'strategy'];

    return switchKeywords.some(k => lowerMessage.includes(k)) &&
      strategyKeywords.some(k => lowerMessage.includes(k));
  }

  /**
   * Get display name for strategy
   */
  private getStrategyDisplayName(strategy: ParsedStrategy): string {
    if (strategy.template === 'custom') {
      const config = strategy.config;
      if (config.description) {
        const lines = config.description.split('\n');
        const firstLine = lines[0].trim();
        if (firstLine.length > 0 && firstLine.length < 100) {
          return firstLine;
        }
      }
      return `Custom Strategy`;
    }

    const templateNames: { [key: string]: string } = {
      'dca': 'Dollar Cost Averaging',
      'grid': 'Grid Trading',
      'stop_loss': 'Stop-Loss Strategy',
      'momentum': 'Momentum Trading'
    };

    return templateNames[strategy.template] || strategy.template;
  }

  /**
   * Determine what actions are needed
   */
  private determineActions(session: AgentSession, userMessage: string, aiResponse: string): string[] {
    const actions: string[] = [];
    const lowerMessage = userMessage.toLowerCase();
    const lowerResponse = aiResponse.toLowerCase();

    if (lowerMessage.includes('execute') || lowerMessage.includes('deploy') ||
      lowerMessage.includes('start') || lowerMessage.includes('run')) {

      if (!session.walletConnected) {
        actions.push('connect_wallet');
      } else if (session.currentStrategy) {
        actions.push('confirm_execution');
      }
    }

    if (session.currentStrategy && session.currentStrategy.requiresConfirmation) {
      actions.push('confirm_strategy');
    }

    if (lowerResponse.includes('?') || lowerResponse.includes('clarif')) {
      actions.push('awaiting_input');
    }

    return actions;
  }

  /**
   * Format "strategy detected" message
   */
  private formatStrategyDetectedMessage(strategy: ParsedStrategy): string {
    const config = strategy.config;
    
    let message = '🎯 **Strategy Detected!**\n\n';
    message += `📊 **${this.getStrategyDisplayName(strategy)}**\n`;
    
    if (config.description) {
      message += `📝 ${config.description}\n`;
    }
    
    message += '\n**Configuration:**\n';
    
    if (config.tokenAddress) {
      message += `• Token: ${config.tokenAddress.slice(0, 8)}...${config.tokenAddress.slice(-6)}\n`;
    }
    
    if (config.supply) {
      message += `• Supply: ${(config.supply / 1000000).toFixed(2)}M tokens\n`;
    }
    
    if (config.side) {
      message += `• Action: ${config.side.toUpperCase()}\n`;
    }
    
    if (config.trigger) {
      message += `• Trigger: ${config.trigger.replace(/_/g, ' ')}\n`;
    }
    
    if (config.intervalMinutes) {
      message += `• Interval: Every ${config.intervalMinutes} minutes\n`;
    }
    
    if (config.buyAmountSOL) {
      message += `• Buy Amount: ${config.buyAmountSOL} SOL per trade\n`;
    }
    
    if (config.sellAmountSOL) {
      message += `• Sell Amount: ${config.sellAmountSOL} SOL per trade\n`;
    }
    
    message += '\n⚡ **Starting Paper Trading Simulation...**\n';
    message += 'Executing your strategy now with real-time market data.\n';
    
    return message;
  }

  /**
   * Format strategy as clean JSON for display
   */
  private formatStrategyAsJson(strategy: ParsedStrategy): string {
    const strategyJson = {
      id: strategy.config.id,
      strategyType: strategy.config.strategyType || strategy.template,
      description: strategy.config.description || this.getStrategyDisplayName(strategy),
      tokenAddress: strategy.config.tokenAddress,
      initialSupply: strategy.config.supply,
      trigger: strategy.config.trigger,
      side: strategy.config.side,
      sizingRule: strategy.config.sizingRule || 'mirror_buy_volume',
      components: strategy.config.components || [],
    };
    return '\n```json\n' + JSON.stringify(strategyJson, null, 2) + '\n```';
  }

  /**
   * Start paper trading simulation asynchronously
   * FIXED: Actually executes the strategy with paper trading
   */
  private async startPaperTradingSimulationAsync(
    sessionId: string,
    strategy: ParsedStrategy,
    walletAddress?: string
  ): Promise<any> {
    console.log(` [SIMULATION] Starting REAL paper trading simulation`);
    console.log(` [SIMULATION] Session ID: ${sessionId}`);
    console.log(` [SIMULATION] Wallet: ${walletAddress || 'None (paper mode)'}`);
    console.log(` [SIMULATION] Strategy template: ${strategy.template}`);
    console.log(` [SIMULATION] Strategy config:`, JSON.stringify(strategy.config, null, 2));
    
    try {
      // Create paper trading session
      const paperSessionId = `paper-ui-${sessionId}-${Date.now()}`;
      console.log(` [SIMULATION] Created paper session ID: ${paperSessionId}`);
      
      // Execute the strategy in paper mode
      console.log(` [SIMULATION] Calling executeStrategy...`);
      const executionResult = await this.executeStrategy(
        sessionId,
        walletAddress,
        'paper',
        paperSessionId
      );
      
      console.log(` [SIMULATION] Execute result:`, {
        success: executionResult.success,
        strategyId: executionResult.strategyId,
        message: executionResult.message
      });
      
      if (executionResult.success) {
        console.log(` [SIMULATION] Paper trading simulation started successfully!`);
        console.log(` [SIMULATION] Strategy ID: ${executionResult.strategyId}`);
        console.log(` [SIMULATION] Paper Session ID: ${paperSessionId}`);
        
        return {
          success: true,
          sessionId: paperSessionId,
          strategyId: executionResult.strategyId,
          message: executionResult.message,
          strategy
        };
      } else {
        console.error(` [SIMULATION] Failed to start:`, executionResult.message);
        return {
          success: false,
          error: executionResult.message,
          strategy
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(` [SIMULATION] Exception:`, errorMsg);
      console.error(` [SIMULATION] Stack:`, error instanceof Error ? error.stack : 'No stack');
      return {
        success: false,
        error: errorMsg,
        strategy
      };
    }
  }

  /**
   * Clear session data
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    geminiClient.clearHistory();
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clean up old sessions (older than specified time)
   */
  cleanupOldSessions(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > maxAgeMs) {
        this.sessions.delete(sessionId);
        console.log(` Cleaned up old session: ${sessionId}`);
      }
    }
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }
}

// Export singleton
export const agentController = new AgentController();

// Auto-cleanup old sessions every hour
setInterval(() => {
  agentController.cleanupOldSessions();
  console.log(` Session cleanup completed. Active sessions: ${agentController.getActiveSessionCount()}`);
}, 60 * 60 * 1000);