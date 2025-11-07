/**
 * Gemini AI Client
 * Handles communication with Google's Gemini API for conversational strategy building
 */

import { aiModelManager } from './aiModelManager';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface GeminiResponse {
  text: string;
  rawResponse: any;
}

export class GeminiClient {
  private conversationHistory: ChatMessage[] = [];
  private lastStrategy: string | null = null;
  private userPreferences: { [key: string]: any } = {};

  constructor() {
    // No need to initialize specific model - AIModelManager handles this
  }

  /**
   * Send a message to AI with intelligent model fallbacks
   */
  async chat(userMessage: string, systemPrompt?: string): Promise<GeminiResponse> {
    try {
      // System prompt already contains full conversation context from agentController
      // Don't duplicate it here to avoid confusion
      
      // Build the full prompt - just system prompt + current user message
      const fullPrompt = systemPrompt 
        ? `${systemPrompt}\n\nUser: ${userMessage}\n\nAssistant:` 
        : `User: ${userMessage}\n\nAssistant:`;

      // Use AI Model Manager for intelligent fallbacks
      const aiResponse = await aiModelManager.generateResponse(fullPrompt);

      // Add to internal history AFTER getting response
      // This maintains geminiClient's own history tracking
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
        timestamp: Date.now()
      });
      
      this.conversationHistory.push({
        role: 'assistant',
        content: aiResponse.text,
        timestamp: Date.now()
      });

      return {
        text: aiResponse.text,
        rawResponse: aiResponse.rawResponse
      };
    } catch (error: any) {
  throw new Error(`AI API error: ${error.message}`);
    }
  }

  /**
   * Get conversation history
   */
  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Set conversation history (for session restoration)
   */
  setHistory(history: ChatMessage[]): void {
    this.conversationHistory = history;
  }

  /**
   * Get last N messages
   */
  getRecentHistory(count: number = 5): ChatMessage[] {
    return this.conversationHistory.slice(-count);
  }

  /**
   * Add conversation context and memory to the prompt
   */
  private addConversationContext(prompt: string, currentMessage: string): string {
    const lowerMessage = currentMessage.toLowerCase();
    
    // Track what user wants (but only if they're not switching)
    if (!lowerMessage.includes('switch') && !lowerMessage.includes('change') && !lowerMessage.includes('instead')) {
      if (lowerMessage.includes('dca')) this.lastStrategy = 'dca';
      if (lowerMessage.includes('grid')) this.lastStrategy = 'grid';
      if (lowerMessage.includes('momentum') || lowerMessage.includes('trend')) this.lastStrategy = 'momentum';
      if (lowerMessage.includes('stop')) this.lastStrategy = 'stop_loss';
    }
    
    // Add context about what user previously wanted
    let contextualPrompt = prompt;
    
    if (this.lastStrategy && (lowerMessage.includes('not') || lowerMessage.includes("don't") || lowerMessage.includes('wrong'))) {
      contextualPrompt += `\n\nIMPORTANT CONTEXT: The user is correcting a mistake. They previously mentioned wanting a ${this.lastStrategy} strategy, but the last response was wrong. They want ${this.lastStrategy}, not what was just suggested.`;
    }
    
    // Handle strategy switching
    if (lowerMessage.includes('switch') || lowerMessage.includes('change') || lowerMessage.includes('instead') || lowerMessage.includes('actually')) {
      contextualPrompt += `\n\nIMPORTANT CONTEXT: The user is switching strategies. They want to abandon the previous strategy and work on a new one. Focus on the NEW strategy they mentioned, not the old one.`;
    }
    
    if (this.conversationHistory.length > 2) {
      contextualPrompt += `\n\nCONVERSATION CONTEXT: This is an ongoing conversation. The user has been discussing trading strategies. Be conversational and reference previous messages when appropriate.`;
    }
    
    return contextualPrompt;
  }
}

// Export singleton instance
export const geminiClient = new GeminiClient();

