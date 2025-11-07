/**
 * Debug Logger Utility
 * FIX #6: Prevents excessive debug logging in production
 */

import { ENV_CONFIG } from "../config/environment";

export class DebugLogger {
  private static isDebugEnabled(): boolean {
    const logLevel = process.env.LOG_LEVEL || ENV_CONFIG.LOG_LEVEL || 'INFO';
    return logLevel === 'DEBUG';
  }

  /**
   * Log debug message only if LOG_LEVEL=DEBUG
   */
  static debug(message: string, ...args: any[]): void {
    if (this.isDebugEnabled()) {
      console.log(message, ...args);
    }
  }

  /**
   * Always log info messages
   */
  static info(message: string, ...args: any[]): void {
    console.log(message, ...args);
  }

  /**
   * Always log warnings
   */
  static warn(message: string, ...args: any[]): void {
    console.warn(message, ...args);
  }

  /**
   * Always log errors
   */
  static error(message: string, ...args: any[]): void {
    console.error(message, ...args);
  }
}
