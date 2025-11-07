/**
 * Network Utilities
 * 
 * Provides utilities for making network requests with timeout and error handling
 */

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 3,
  timeoutMs: number = 10000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      
      // If successful response, return it
      if (response.ok) {
        return response;
      }

      // If rate limited (429), apply exponential backoff and retry
      if (response.status === 429 && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(` [fetchWithRetry] Rate limited (429), backing off for ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // If other error status and not last attempt, retry
      if (!response.ok && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
        console.log(` [fetchWithRetry] HTTP ${response.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // If last attempt or successful (non-ok), return response
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If it's a timeout or network error and not the last attempt, retry
      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(` [fetchWithRetry] Network error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries}): ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // If last attempt, throw the error
      throw lastError;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Fetch failed after retries');
}

export async function fetchJSON<T = any>(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<T> {
  const response = await fetchWithTimeout(url, options, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json() as T;
}

export async function fetchJSONWithRetry<T = any>(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 3,
  timeoutMs: number = 10000
): Promise<T> {
  const response = await fetchWithRetry(url, options, maxRetries, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json() as T;
}
